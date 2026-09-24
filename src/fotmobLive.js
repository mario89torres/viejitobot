// Cruce EN VIVO playdoit <-> FotMob + pronostico (binomial negativa), en
// memoria y sin Chromium (fetch plano, ver fotmobScraper.js) — sobre lo que
// YA capturaron los dos pilotos en la BD. Reemplaza a src/sofaLive.js
// (SofaScore, suspendido el 2026-09-14). Extraido originalmente de
// src/server/dashboardApi.ts (el endpoint /api/fotmob-pilot) para poder
// REUSARLO desde bot.js: el dashboard lo llama por vista (cada
// auto-refresh), bot.js lo llama por ciclo del piloto de FotMob para
// PERSISTIR un snapshot del pronostico (ver saveForecastSnapshot en
// src/db.js) — antes de esto el pronostico solo existia "al vuelo", sin
// historial, asi que no habia forma de mostrar "que decia el modelo hace 20
// minutos" ni la cuota que tenia en ese momento.
const { teamsMatch } = require('./teamMatch');
const { probUnderNB, posteriorNB, nbParamsVigentes } = require('./matchStats');
const { minutoDeStatus } = require('./nbCalibrado');
const { devig, defaultMethod } = require('./devig');

// Mismo criterio que /api/stats-pilot: solo el mercado GLOBAL de corners (no
// por equipo, no de 1a mitad) — mezclar esos daria una "linea del partido"
// que no existe.
const esGlobalCorner = (m) => /^total\s+tiros?\s+de\s+esquina/i.test((m || '').trim());

function escaleraLineas(crudas) {
  const porLinea = new Map();
  for (const r of crudas) {
    if (!esGlobalCorner(r.market)) continue;
    if (!porLinea.has(r.linea)) porLinea.set(r.linea, { linea: r.linea });
    const par = porLinea.get(r.linea);
    // DESC + solo-si-falta: la primera vez que se ve cada (linea,lado) ya es
    // la mas reciente (recorriendo ts DESC), no pisarla despues.
    if (!par[r.lado]) par[r.lado] = { odd: r.odd_decimal, susp: !!r.suspended };
  }
  return [...porLinea.values()].sort((a, b) => a.linea - b.linea);
}

// BINOMIAL NEGATIVA CON CONTEO REAL: probUnderNB (src/matchStats.js) es el
// mismo scorer en sombra del piloto de playdoit, pero ahi corre sobre el
// conteo INFERIDO (17% de cobertura). Aqui usa el conteo REAL de FotMob.
function conModelo(lineasPlaydoit, conteoReal, minuto) {
  if (conteoReal == null || minuto == null) return lineasPlaydoit;
  return lineasPlaydoit.map((l) => {
    const pUnderModelo = probUnderNB(conteoReal, l.linea, minuto);
    if (pUnderModelo == null) return l;
    const pOverModelo = 1 - pUnderModelo;
    let pOverMercado = null, pUnderMercado = null;
    if (l.over && !l.over.susp && l.under && !l.under.susp) {
      const [po, pu] = devig([l.over.odd, l.under.odd], defaultMethod());
      pOverMercado = po; pUnderMercado = pu;
    }
    return {
      ...l,
      modelo: {
        pOver: +pOverModelo.toFixed(4), pUnder: +pUnderModelo.toFixed(4),
        edgeOver: pOverMercado != null ? +(pOverModelo - pOverMercado).toFixed(4) : null,
        edgeUnder: pUnderMercado != null ? +(pUnderModelo - pUnderMercado).toFixed(4) : null,
      },
    };
  });
}

// LINEA SUGERIDA: de las lineas con edge calculado, la de mayor edge
// POSITIVO. edgeOver y edgeUnder son espejo (uno es -el otro): NO son dos
// candidatos independientes, son la MISMA discrepancia vista desde cada
// lado. El lado con valor es el del signo positivo — edgeOver negativo
// significa que el value esta en Under, no en Over. pMercado se DERIVA del
// edge (pMercado = pModelo - edge) en vez de recalcular 100/odd — ese crudo
// lleva el margen de la casa adentro y es un numero DISTINTO del que de
// verdad decide el edge.
function elegirSugerida(lineasConModelo) {
  let sugerida = null;
  for (const l of lineasConModelo) {
    if (!l.modelo || l.modelo.edgeOver == null) continue;
    const c = l.modelo.edgeOver >= 0
      ? { lado: 'over', edge: l.modelo.edgeOver, linea: l.linea, pModelo: l.modelo.pOver, pMercado: l.modelo.pOver - l.modelo.edgeOver, odd: l.over?.odd ?? null }
      : { lado: 'under', edge: l.modelo.edgeUnder, linea: l.linea, pModelo: l.modelo.pUnder, pMercado: l.modelo.pUnder - l.modelo.edgeUnder, odd: l.under?.odd ?? null };
    if (!sugerida || c.edge > sugerida.edge) sugerida = c;
  }
  return sugerida;
}

// PARTIDOS CON DOS FUENTES, EN VIVO — cruce en memoria, sin Chromium.
//
// Distinto del emparejamiento REAL (src/fotmobMatch.js, usado para
// liquidar): eso barre el dia completo de FotMob. Aqui NO se llama a eso —
// se reusa solo teamsMatch (puro JS) sobre lo que YA capturaron los dos
// pilotos, asi que puede haber partidos que esta vista no encuentre pero el
// pilotaje real si.
function computeDosFuentes(db, { ventanaMin = 20 } = {}) {
  const desdeVivo = new Date(Date.now() - ventanaMin * 60 * 1000).toISOString();
  // GROUP BY event_id: stat_snapshots tiene una fila por (mercado,
  // seleccion) en el MISMO ts — sin agrupar, cada evento saldria duplicado
  // tantas veces como filas comparta ese instante.
  const pdVivos = db.prepare(`
    SELECT event_id, event, champ, MAX(minute) minute, MAX(ts) ts
    FROM stat_snapshots
    WHERE familia = 'corner' AND ts >= ?
    GROUP BY event_id
  `).all(desdeVivo);
  const fotmobVivos = db.prepare(`
    SELECT c.* FROM fotmob_corner_snapshots c
    JOIN (SELECT fotmob_event_id, MAX(ts) mts FROM fotmob_corner_snapshots
          WHERE ts >= ? GROUP BY fotmob_event_id) u
      ON c.fotmob_event_id = u.fotmob_event_id AND c.ts = u.mts
  `).all(desdeVivo);

  const lineasStmt = db.prepare(`
    SELECT market, selection, linea, lado, odd_decimal, suspended
    FROM stat_snapshots
    WHERE event_id = ? AND familia = 'corner' AND ts >= ?
    ORDER BY ts DESC
  `);

  const dosFuentes = [];
  for (const pd of pdVivos) {
    const partes = (pd.event || '').split(/\s+vs\.?\s+|\s+@\s+/i);
    if (partes.length < 2) continue;
    const [pdHome, pdAway] = partes;
    const s = fotmobVivos.find(s =>
      (teamsMatch(pdHome, s.home) && teamsMatch(pdAway, s.away)) ||
      (teamsMatch(pdHome, s.away) && teamsMatch(pdAway, s.home)));
    if (!s) continue;

    const crudas = lineasStmt.all(pd.event_id, desdeVivo);
    let lineasPlaydoit = escaleraLineas(crudas);

    const conteoReal = (s.corners_home != null && s.corners_away != null) ? s.corners_home + s.corners_away : null;
    // Con el NB calibrado (STATS_NB_CALIBRADO=on) el perfil de intensidad esta
    // medido en el RELOJ DE FOTMOB, y el conteo sale de ese mismo snapshot: el
    // minuto de FotMob es el que corresponde a ese conteo (el de playdoit puede
    // ser de otro instante). Sin calibracion, o sin minuto parseable, el de
    // playdoit de siempre.
    const params = nbParamsVigentes();
    const minuto = (params.calibrado ? minutoDeStatus(s.status) : null) ?? pd.minute;
    lineasPlaydoit = conModelo(lineasPlaydoit, conteoReal, minuto);

    // ESPERADOS: conteo real + la media POSTERIOR de lo que falta
    // (posteriorNB — el mismo posterior Gamma-Poisson que usa probUnderNB
    // por dentro), como referencia rapida sin leer la escalera linea por
    // linea.
    const post = (conteoReal != null && minuto != null) ? posteriorNB(conteoReal, minuto) : null;
    const esperados = post ? +(conteoReal + post.muRestante).toFixed(2) : null;

    const sugerida = elegirSugerida(lineasPlaydoit);

    dosFuentes.push({
      playdoit: { eventId: pd.event_id, event: pd.event, champ: pd.champ, minuto: pd.minute, ts: pd.ts, lineas: lineasPlaydoit },
      fotmob: {
        fotmobEventId: s.fotmob_event_id, home: s.home, away: s.away, tournament: s.tournament,
        cornersHome: s.corners_home, cornersAway: s.corners_away, status: s.status, ts: s.ts,
      },
      // La clave se deja como 'poisson' (no se renombra el contrato de la
      // API por un cambio de modelo en sombra) pero mu/r son los de la
      // binomial negativa desde stats-4.
      poisson: { esperados, mu: params.mu, r: params.r, calibrado: params.calibrado, minuto, sugerida },
    });
  }
  return dosFuentes;
}

module.exports = { esGlobalCorner, escaleraLineas, conModelo, elegirSugerida, computeDosFuentes };
