// xG de temporada de ambos equipos de un evento pre-partido de Playdoit,
// pedido explicito del usuario el 2026-09-23 tras confirmar que FotMob expone
// xG a favor/en contra por equipo (via /data/teams?id=X), acumulado de
// temporada — no es una proyeccion del enfrentamiento puntual, pero permite
// construir una desde ambos lados sin esperar a que el mercado se mueva
// (a diferencia de steam) ni depender de otra casa de apuestas (a diferencia
// del escaneo sharp). Solo lectura, no decide ni emite nada.
const { db } = require('./db');
const { scheduledToday, fetchMatchTeamIds, fetchTeamXG } = require('./fotmobScraper');
const { teamsMatch } = require('./teamMatch');

const TOLERANCIA_MS = 3 * 3600 * 1000; // mismo margen que prematchFotmob.js

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

  return {
    event: match.event, startDate: match.startDate, fotmobMatchId: match.fotmobMatchId,
    home, away,
    xgEsperadoLocal: Number(xgEsperadoLocal.toFixed(2)),
    xgEsperadoVisita: Number(xgEsperadoVisita.toFixed(2)),
    xgEsperadoTotal: Number((xgEsperadoLocal + xgEsperadoVisita).toFixed(2)),
  };
}

module.exports = { xgDeEvento };
