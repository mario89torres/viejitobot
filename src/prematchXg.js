// xG de temporada de ambos equipos de un evento pre-partido de Playdoit,
// pedido explicito del usuario el 2026-09-23 tras confirmar que FotMob expone
// xG a favor/en contra por equipo (via /data/teams?id=X), acumulado de
// temporada — no es una proyeccion del enfrentamiento puntual, pero permite
// construir una desde ambos lados sin esperar a que el mercado se mueva
// (a diferencia de steam) ni depender de otra casa de apuestas (a diferencia
// del escaneo sharp). Solo lectura, no decide ni emite nada.
const { db, getLeagueXg, saveLeagueXg } = require('./db');
const { scheduledToday, fetchMatchTeamIds, fetchTeamXG, fetchTablaXgLiga } = require('./fotmobScraper');
const { teamsMatch } = require('./teamMatch');

const TOLERANCIA_MS = 3 * 3600 * 1000; // mismo margen que prematchFotmob.js
const LIGA_TTL_MS = 6 * 3600 * 1000;   // el promedio de liga se mueve despacio: 1 request por liga cada 6 h

/**
 * xG esperado del enfrentamiento normalizado por el promedio de la liga:
 *   local  = ataque_local x defensa_visita / promedio_liga
 *   visita = ataque_visita x defensa_local / promedio_liga
 * (todo por partido). Es la forma estandar: un ataque 20% mejor que el promedio
 * contra una defensa 10% peor que el promedio da ~1.32x el promedio. El
 * "promedio simple" (ataque+defensa)/2 ignora en que liga se juega. Pura.
 * Devuelve null si falta algun dato.
 */
function xgNormalizado(home, away, ligaPorEquipoPartido) {
  const ok = (t) => t && t.played > 0 && Number.isFinite(t.xgFor) && Number.isFinite(t.xgAgainst);
  if (!ok(home) || !ok(away) || !(ligaPorEquipoPartido > 0)) return null;
  const local = (home.xgFor / home.played) * (away.xgAgainst / away.played) / ligaPorEquipoPartido;
  const visita = (away.xgFor / away.played) * (home.xgAgainst / home.played) / ligaPorEquipoPartido;
  return {
    local: Number(local.toFixed(2)), visita: Number(visita.toFixed(2)), total: Number((local + visita).toFixed(2)),
  };
}

// Promedio de xG de la liga: de la BD si es reciente, si no se descarga la tabla
// completa (1 request) y se guarda. Un fallo devuelve el valor viejo si lo hay.
async function promedioLiga(leagueId, seasonId, tablaXgUrl, ahora = Date.now()) {
  if (leagueId == null || !seasonId) return null;
  const guardado = getLeagueXg(leagueId, seasonId);
  if (guardado && ahora - Date.parse(guardado.updated_ts) < LIGA_TTL_MS) return guardado.xg_por_equipo_partido;
  if (!tablaXgUrl) return guardado ? guardado.xg_por_equipo_partido : null;
  try {
    const r = await fetchTablaXgLiga(tablaXgUrl);
    if (!r) return guardado ? guardado.xg_por_equipo_partido : null;
    saveLeagueXg({
      leagueId, seasonId: String(seasonId), leagueName: r.leagueName, nEquipos: r.nEquipos, xgTotal: r.xgTotal,
      partidosEquipo: r.partidosEquipo, xgPorEquipoPartido: r.xgPorEquipoPartido, updatedTs: new Date(ahora).toISOString(),
    });
    return r.xgPorEquipoPartido;
  } catch {
    return guardado ? guardado.xg_por_equipo_partido : null;
  }
}

// Busca el partido de FotMob equivalente a un event_id de Playdoit — misma
// logica que datosFotmobDeEvento en prematchFotmob.js, duplicada a proposito
// para no acoplar dos pilotos distintos a un solo modulo compartido.
async function emparejarConFotmob(eventId) {
  const ev = db.prepare(`
    SELECT event, start_date FROM prematch_snapshots WHERE event_id = ? ORDER BY ts DESC LIMIT 1
  `).get(eventId);
  if (!ev || !ev.start_date) return null;

  const partes = ev.event.split(/\s+vs\.?\s+/i);
  if (partes.length < 2) return null;
  const [home, away] = partes.map(s => s.trim());
  const kickoff = Date.parse(ev.start_date);

  const dia = ev.start_date.slice(0, 10);
  const diaAnterior = new Date(kickoff - 24 * 3600 * 1000).toISOString().slice(0, 10);
  const diaSiguiente = new Date(kickoff + 24 * 3600 * 1000).toISOString().slice(0, 10);
  const dias = [...new Set([diaAnterior, dia, diaSiguiente])];

  const eventos = [];
  for (const d of dias) {
    try { eventos.push(...await scheduledToday(d)); } catch { /* un dia fallido no tumba los demas */ }
  }

  let mejor = null, mejorDist = Infinity;
  for (const e of eventos) {
    if (!e.home || !e.away || !e.commenceTime) continue;
    if (!teamsMatch(home, e.home) || !teamsMatch(away, e.away)) continue;
    const dist = Math.abs(Date.parse(e.commenceTime) - kickoff);
    if (dist < mejorDist) { mejorDist = dist; mejor = e; }
  }
  if (!mejor || mejorDist > TOLERANCIA_MS) return null;
  return { fotmobMatchId: mejor.id, event: ev.event, startDate: ev.start_date };
}

/**
 * xG de temporada de ambos equipos de un evento pre-partido de Playdoit.
 * Devuelve null si no hay equivalente en FotMob o si la liga no publica xG
 * (friendlies, selecciones, ligas menores).
 */
async function xgDeEvento(eventId) {
  const match = await emparejarConFotmob(eventId);
  if (!match) return null;

  const ids = await fetchMatchTeamIds(match.fotmobMatchId);
  if (!ids) return null;

  const [home, away] = await Promise.all([
    fetchTeamXG(ids.homeId).catch(() => null),
    fetchTeamXG(ids.awayId).catch(() => null),
  ]);
  if (!home || !away || home.xgFor == null || away.xgFor == null || !home.played || !away.played) return null;

  // xG esperado del enfrentamiento: ataque de un lado contra defensa del otro,
  // promediado por partidos jugados de cada equipo (temporadas con distinto
  // numero de fechas jugadas no son directamente comparables sin normalizar).
  const xgForLocalPorPartido = home.xgFor / home.played;
  const xgEnContraVisitaPorPartido = away.xgAgainst != null ? away.xgAgainst / away.played : null;
  const xgForVisitaPorPartido = away.xgFor / away.played;
  const xgEnContraLocalPorPartido = home.xgAgainst != null ? home.xgAgainst / home.played : null;

  const xgEsperadoLocal = xgEnContraVisitaPorPartido != null
    ? (xgForLocalPorPartido + xgEnContraVisitaPorPartido) / 2
    : xgForLocalPorPartido;
  const xgEsperadoVisita = xgEnContraLocalPorPartido != null
    ? (xgForVisitaPorPartido + xgEnContraLocalPorPartido) / 2
    : xgForVisitaPorPartido;

  // Version normalizada por liga: SOLO si ambos equipos comparten liga primaria
  // y temporada. En copas o torneos internacionales cada uno viene de una liga
  // distinta y un unico promedio seria incorrecto — ahi queda en null y se usa
  // el promedio simple de arriba.
  const mismaLiga = home.leagueId != null && home.leagueId === away.leagueId && home.seasonId && home.seasonId === away.seasonId;
  const ligaAvg = mismaLiga ? await promedioLiga(home.leagueId, home.seasonId, home.tablaXgUrl) : null;
  const norm = ligaAvg ? xgNormalizado(home, away, ligaAvg) : null;

  return {
    event: match.event, startDate: match.startDate, fotmobMatchId: match.fotmobMatchId,
    home, away,
    xgEsperadoLocal: Number(xgEsperadoLocal.toFixed(2)),
    xgEsperadoVisita: Number(xgEsperadoVisita.toFixed(2)),
    xgEsperadoTotal: Number((xgEsperadoLocal + xgEsperadoVisita).toFixed(2)),
    // Liga primaria del LOCAL, se guarde o no la version normalizada: sirve de
    // marca de "ya procesado con liga" (y de clave para agrupar despues).
    leagueId: home.leagueId ?? null,
    seasonId: home.seasonId ?? null,
    leagueXgAvg: ligaAvg,
    xgNormLocal: norm ? norm.local : null,
    xgNormVisita: norm ? norm.visita : null,
    xgNormTotal: norm ? norm.total : null,
  };
}

module.exports = { xgDeEvento, xgNormalizado, promedioLiga };
