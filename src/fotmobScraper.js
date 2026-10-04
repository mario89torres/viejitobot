// PILOTO FotMob — reemplazo de src/sofaScraper.js (SofaScore, suspendido el
// 2026-09-14 con SOFA_SUSPENDIDO=1). Mismo rol: conteo de corners DIRECTO en
// vivo, mas estadisticas de equipo candidatas para el modelo, capturadas de
// solo lectura. No toca odds, no puntua, no emite.
//
// POR QUE FETCH PLANO Y NO CHROMIUM. SofaScore bloqueaba cualquier fetch
// plano con un 403 (fingerprint de navegador tipo Cloudflare), de ahi que el
// piloto anterior necesitara Chromium headless completo. FotMob no tiene esa
// proteccion: verificado en vivo el 2026-09-15 (fotmob_toolkit, ver
// Downloads/fotmob_toolkit/fotmob_fetcher.py) que responde 200 con datos
// reales a un fetch normal, sin resolver ningun challenge. Su libreria de
// referencia (fotmob-wrapper, Python) intenta ademas firmar cada request con
// un header "x-mas" obtenido de un proxy de terceros — probado en produccion
// que ESE proxy da 404 y el fallback SIN el header funciona igual (mismos
// datos, mismo status 200), asi que aqui se omite esa pieza por completo en
// vez de depender de un tercero mas que no aporta nada verificable.
//
// SIN CHROMIUM = SIN MUTEX NI IDLE-CLOSE. sofaScraper.js necesitaba un
// candado sobre una unica pagina de Chromium compartida entre el piloto y la
// liquidacion, mas un cierre por inactividad para no dejar ~350MB de RAM
// residentes. Aqui cada llamada es un fetch HTTP independiente y sin estado
// — no hay recurso compartido que proteger ni que cerrar.
//
// TIMEOUTS EXPLICITOS EN TODO FETCH: la leccion del incidente del bot mudo
// (un fetch sin timeout puede colgar el sampler para siempre) aplica igual
// aqui. AbortSignal.timeout() nativo (Node 22) corta la conexion de verdad,
// a diferencia del Promise.race usado en sofaScraper.js sobre page.evaluate
// (que no podia cancelar el trabajo dentro de Chromium, solo dejar de
// esperarlo).

const BASE_URL = 'https://www.fotmob.com/api';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://www.fotmob.com/',
};

async function fetchJson(path, { timeoutMs = 10000 } = {}) {
  const r = await fetch(`${BASE_URL}${path}`, {
    headers: HEADERS,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (r.status !== 200) throw new Error(`FotMob ${path} devolvio HTTP ${r.status}`);
  return r.json();
}

// Candidatos capturados junto a los corners, en JSON, SIN USAR por ahora —
// mismo espiritu que CAMPOS_EXTRA en sofaScraper.js (Fase 2 del modelo de
// corners): no decide nada, solo permite medir correlacion despues con
// historico real. A diferencia de SofaScore, se captura TODO stat de equipo
// que no sea Corners (en vez de una lista fija): los titulos que expone
// FotMob varian por liga y no se ha medido aun cual vale la pena, asi que
// restringir de entrada tiraria datos sin saber si sirven.
function extraerTeamStats(detail) {
  const bloques = detail?.content?.stats?.Periods?.All?.stats || [];
  let corners = null;
  const extra = {};
  for (const bloque of bloques) {
    for (const item of bloque.stats || []) {
      const vals = item.stats || [];
      const fila = { home: vals[0] ?? null, away: vals[1] ?? null };
      if (item.title === 'Corners') corners = fila;
      else if (item.title) extra[item.title] = fila;
    }
  }
  return { corners, extra };
}

function estadoDesde(status) {
  if (!status) return { statusType: 'notstarted', status: 'programado' };
  if (status.cancelled) return { statusType: 'cancelled', status: 'cancelado' };
  if (status.finished) {
    const razon = status.reason?.short;
    return { statusType: 'finished', status: razon || 'finalizado' };
  }
  if (status.started) {
    const liveShort = status.liveTime?.short;
    return { statusType: 'inprogress', status: liveShort || 'en curso' };
  }
  return { statusType: 'notstarted', status: 'programado' };
}

async function matchesPorFecha(fecha) {
  // FotMob espera YYYYMMDD; el resto del bot pasa 'YYYY-MM-DD' (ver
  // sofaMatch.js/fotmobMatch.js) — se acepta cualquiera de los dos.
  const yyyymmdd = fecha.replace(/-/g, '');
  const data = await fetchJson(`/data/matches?date=${yyyymmdd}&timezone=Europe/London&ccode3=GBR`, { timeoutMs: 15000 });
  return data?.leagues || [];
}

/**
 * Corners en vivo de todos los partidos que FotMob tenga en curso ahora
 * mismo, con estadisticas disponibles. Devuelve filas listas para
 * saveFotmobSnapshot; NO se guarda nada aqui, eso es responsabilidad del
 * llamador. Mismo contrato de salida que fetchLiveCorners() en
 * sofaScraper.js (fotmobEventId en vez de sofaEventId).
 *
 * LIMITACION CONOCIDA: solo mira el "hoy" de FotMob (fecha UTC actual), como
 * el fotmob_fetcher.py original. Un partido que arranco ayer y sigue vivo
 * pasada la medianoche UTC no aparece aqui — igual que el barrido de
 * SofaScore tenia su propio limite de cobertura, este es el de esta fuente.
 */
async function fetchLiveCorners() {
  const ts = new Date().toISOString();
  const hoy = new Date().toISOString().slice(0, 10);
  const leagues = await matchesPorFecha(hoy);

  const vivos = [];
  for (const liga of leagues) {
    for (const m of liga.matches || []) {
      const st = m.status || {};
      if (st.started && !st.finished && !st.cancelled) {
        vivos.push({ id: m.id, home: m.home?.name || null, away: m.away?.name || null, tournament: liga.name || null });
      }
    }
  }
  if (!vivos.length) return [];

  // EN PARALELO, no en serie — mismo motivo que sofaScraper.js: con decenas
  // de partidos en vivo, sumar un timeout por partido en serie puede superar
  // cualquier presupuesto razonable. Un fallo individual no tumba el resto.
  const filas = await Promise.all(vivos.map(async (v) => {
    try {
      const detail = await fetchJson(`/data/matchDetails?matchId=${v.id}`, { timeoutMs: 10000 });
      const { corners, extra } = extraerTeamStats(detail);
      if (!corners) return null;
      const { statusType, status } = estadoDesde(detail?.header?.status || detail?.general?.status);
      return {
        ts,
        fotmobEventId: v.id,
        home: v.home,
        away: v.away,
        tournament: v.tournament,
        cornersHome: corners.home != null ? Number(corners.home) : null,
        cornersAway: corners.away != null ? Number(corners.away) : null,
        status,
        statusType,
        extraStats: Object.keys(extra).length ? JSON.stringify(extra) : null,
      };
    } catch (err) {
      return null;
    }
  }));
  return filas.filter(Boolean);
}

/**
 * Estado final de UN partido puntual, preguntado a FotMob EN EL INSTANTE de
 * liquidar ese evento — igual que fetchEventFinal en sofaScraper.js.
 * fetchLiveCorners() solo ve partidos EN VIVO; uno que ya termino deja de
 * aparecer ahi, asi que hace falta preguntar directo por su matchId.
 */
async function fetchEventFinal(fotmobEventId) {
  const detail = await fetchJson(`/data/matchDetails?matchId=${fotmobEventId}`, { timeoutMs: 10000 });
  const { statusType, status } = estadoDesde(detail?.header?.status || detail?.general?.status);
  if (statusType !== 'finished') {
    return { statusType, status, cornersHome: null, cornersAway: null, extraStats: null };
  }
  const { corners, extra } = extraerTeamStats(detail);
  return {
    statusType, status,
    cornersHome: corners?.home != null ? Number(corners.home) : null,
    cornersAway: corners?.away != null ? Number(corners.away) : null,
    extraStats: Object.keys(extra).length ? JSON.stringify(extra) : null,
  };
}

/**
 * Marcador oficial de UN partido de FotMob (goles de local y visita segun
 * header.teams) y si ya termino. Para validar liquidaciones (src/validate.js):
 * un partido en curso o cancelado devuelve finished=false y NO debe usarse
 * como marcador final. Solo lectura.
 */
async function fetchMarcadorFinal(fotmobMatchId) {
  const detail = await fetchJson(`/data/matchDetails?matchId=${fotmobMatchId}`, { timeoutMs: 10000 });
  const st = detail?.header?.status;
  const tm = detail?.header?.teams || [];
  const home = tm[0]?.score, away = tm[1]?.score;
  return {
    finished: !!st?.finished && !st?.cancelled && Number.isInteger(home) && Number.isInteger(away),
    home: Number.isInteger(home) ? home : null,
    away: Number.isInteger(away) ? away : null,
  };
}

/**
 * Contexto PRE-PARTIDO de un partido de FotMob: estadio, arbitro (cuando lo
 * publican) y forma reciente de cada equipo. A diferencia de
 * fetchEventFinal, NO exige que el partido haya terminado — funciona igual
 * de bien para uno que todavia no arranca. Para el visor "Hoy (pre-partido)"
 * del dashboard (src/prematchFotmob.js). Solo lectura.
 */
async function fetchMatchFacts(fotmobMatchId) {
  const detail = await fetchJson(`/data/matchDetails?matchId=${fotmobMatchId}`, { timeoutMs: 10000 });
  const { statusType, status } = estadoDesde(detail?.header?.status || detail?.general?.status);
  const infoBox = detail?.content?.matchFacts?.infoBox || null;
  return {
    statusType, status,
    stadium: infoBox?.Stadium || null,
    referee: infoBox?.Referee?.text ? infoBox.Referee : null,
    teamForm: detail?.content?.matchFacts?.teamForm || null,
  };
}

/**
 * xG de TEMPORADA de un equipo de FotMob (a favor, en contra, partidos
 * jugados) — via /data/teams?id=X, que trae stats.teams (liga completa,
 * ranking por stat) y overview.table (partidos jugados por equipo). Solo
 * existe en ligas con seguimiento estadistico completo: friendlies/selecciones
 * y ligas menores devuelven null en xG.
 *
 * PRE-PARTIDO, no en vivo: es el acumulado ANTES de este partido (incluye
 * jornadas previas de la misma temporada), no una proyeccion del enfrentamiento
 * puntual. Para eso hay que combinar ambos equipos (ver src/prematchXg.js).
 */
async function fetchTeamXG(fotmobTeamId) {
  const d = await fetchJson(`/data/teams?id=${fotmobTeamId}`, { timeoutMs: 10000 });
  const teamStats = Object.values(d?.stats?.teams || {});
  const buscar = (re) => teamStats.find(s => re.test(s.header || ''))?.participant?.value ?? null;
  const xgFor = buscar(/^Expected goals$/i);
  const xgAgainst = buscar(/^xG conceded$/i);
  // Tabla COMPLETA de la liga para el promedio (ver fetchTablaXgLiga): la URL
  // viene en el propio stat, asi no se adivina el nombre del archivo.
  const tablaXgUrl = teamStats.find(s => /^Expected goals$/i.test(s.header || ''))?.fetchAllUrl ?? null;

  // "played" NO sale de overview.table: su forma varia por liga (tabla simple,
  // por conferencia como MLS, o inexistente en selecciones/friendlies) y
  // buscar por id ahi fallaba en silencio. Se cuenta directo de fixtures,
  // filtrado a la liga PRIMARIA del equipo (mismo scope que Expected
  // goals/xG conceded, que son de esa competicion, no de todas mezcladas).
  const primaryLeagueId = d?.stats?.primaryLeagueId ?? null;
  const fixtures = d?.fixtures?.allFixtures?.fixtures || [];
  const played = primaryLeagueId != null
    ? fixtures.filter(f => f.tournament?.leagueId === primaryLeagueId && f.notStarted === false).length
    : null;

  return {
    teamId: Number(fotmobTeamId),
    name: d?.details?.name || null,
    played: played || null,
    xgFor, xgAgainst,
    leagueId: primaryLeagueId,
    seasonId: d?.stats?.primarySeasonId != null ? String(d.stats.primarySeasonId) : null,
    tablaXgUrl,
  };
}

/**
 * Resume la tabla de xG de una liga (JSON de data.fotmob.com) a un promedio:
 * xG total / partidos-equipo. Pura (recibe el JSON ya descargado) para poder
 * probarla sin red. Ignora equipos sin partidos jugados; null si no hay datos.
 */
function resumirTablaXgLiga(json) {
  const lista = json?.TopLists?.[0]?.StatList || [];
  let xgTotal = 0, partidosEquipo = 0, nEquipos = 0;
  for (const t of lista) {
    const xg = Number(t.StatValue), pj = Number(t.MatchesPlayed);
    if (!Number.isFinite(xg) || !Number.isFinite(pj) || pj <= 0) continue;
    xgTotal += xg; partidosEquipo += pj; nEquipos++;
  }
  if (!partidosEquipo) return null;
  return {
    leagueName: json?.LeagueName || null, nEquipos, xgTotal: Number(xgTotal.toFixed(2)), partidosEquipo,
    xgPorEquipoPartido: Number((xgTotal / partidosEquipo).toFixed(4)),
  };
}

/** Descarga y resume la tabla de xG de una liga. data.fotmob.com, no /api. */
async function fetchTablaXgLiga(url) {
  const r = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(15000) });
  if (r.status !== 200) throw new Error(`FotMob tabla xG devolvio HTTP ${r.status}`);
  return resumirTablaXgLiga(await r.json());
}

/**
 * Ids de FotMob de ambos equipos de un partido — para encadenar con
 * fetchTeamXG sin tener que volver a buscar el nombre en otro endpoint.
 */
async function fetchMatchTeamIds(fotmobMatchId) {
  const detail = await fetchJson(`/data/matchDetails?matchId=${fotmobMatchId}`, { timeoutMs: 10000 });
  const teams = detail?.header?.teams || [];
  if (teams.length < 2) return null;
  return { homeId: teams[0].id, awayId: teams[1].id, homeName: teams[0].name, awayName: teams[1].name };
}

/**
 * Todos los partidos programados de FotMob para una fecha (futbol), no solo
 * los que ya estan en vivo — la "segunda base de datos" para emparejar con
 * eventos de playdoit (ver src/fotmobMatch.js). Equivalente a
 * scheduledToday() en sofaScraper.js, pero MUCHO mas barato: FotMob devuelve
 * todas las ligas del dia en UNA sola llamada (/data/matches), mientras que
 * el barrido de SofaScore necesitaba una llamada POR TORNEO (hasta
 * MAX_TOURNAMENTS). Sin paginacion ni rate-limit manual porque no hace falta.
 *
 * Devuelve { id, home, away, tournament, commenceTime } — commenceTime en
 * ISO, mismo formato que esperaba matchEvent en teamMatch.js.
 */
async function scheduledToday(fecha = new Date().toISOString().slice(0, 10)) {
  const leagues = await matchesPorFecha(fecha);
  const eventos = [];
  for (const liga of leagues) {
    for (const m of liga.matches || []) {
      eventos.push({
        id: m.id,
        home: m.home?.name || null,
        away: m.away?.name || null,
        tournament: liga.name || null,
        commenceTime: m.status?.utcTime || null,
      });
    }
  }
  return eventos;
}

// Sin recurso persistente que cerrar (a diferencia de sofaScraper.js y su
// Chromium compartido) — se mantiene solo por compatibilidad de interfaz.
async function cerrar() {}

module.exports = {
  fetchLiveCorners, scheduledToday, fetchEventFinal, fetchMatchFacts, cerrar,
  fetchTeamXG, fetchMatchTeamIds, fetchMarcadorFinal, fetchTablaXgLiga, resumirTablaXgLiga,
  // Expuestos para scripts de analisis/backtest que necesitan el detalle crudo.
  fetchJson, extraerTeamStats, estadoDesde,
};
