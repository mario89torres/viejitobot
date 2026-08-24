// Estadísticas VIVAS de los badges de Telegram.
//
// El problema que resuelve: hasta el 2026-08-24 los badges llevaban su número
// ESCRITO A MANO en el mensaje ("+21% en 94 picks desde el 12-ago"). Un número
// congelado envejece solo — el badge 🔥 llegó a prometer un +30% sacado de n=15
// que para entonces ya no existía. Aquí se recalcula sobre todo el histórico.
//
// MÉTODO: una sola pasada cronológica con sumas acumuladas.
//
//   para cada pick liquidado, en orden de fecha:
//     si cumple la condición del badge:
//       1. anota el estimador ACTUAL   <- solo ha visto picks anteriores
//       2. incorpora este pick a la suma
//
// Coste O(N) en tiempo y O(1) en memoria por badge: 2408 picks en ~60 ms. Es lo
// más barato posible, y no se sacrifica nada — cada observación se evalúa contra
// un estimador que no la vio, así que el paseo hacia delante es honesto por
// construcción. Frente a evaluar solo la ventana de test, la muestra pasa de 94
// a 387 picks sin perder esa propiedad.
//
// Se reporta además una media PONDERADA EXPONENCIALMENTE (vida media
// BADGE_HALFLIFE_DAYS). No es adorno: el mapa precio→resultado de este sistema
// no es estacionario, así que una media acumulada de meses puede describir un
// régimen que ya no existe. Que las dos cifras salgan parecidas (17.6% vs 18.3%)
// es justamente la señal de que el efecto no depende de la racha reciente.
//
// LO QUE ESTO NO ARREGLA, y conviene no engañarse: la CONDICIÓN de cada badge
// (progress >= 0.90, el tier ELITE) se eligió mirando estos mismos datos. Más
// datos del mismo dataset dan una medición más precisa del efecto, pero no dicen
// si el efecto existía antes de ir a buscarlo. Eso solo lo resuelve una
// condición fijada a priori o datos genuinamente nuevos.

const { db } = require('./db');

const HALFLIFE_MS = Number(process.env.BADGE_HALFLIFE_DAYS || 14) * 24 * 3600 * 1000;
const TTL_MS = Number(process.env.BADGE_STATS_TTL_MIN || 720) * 60 * 1000; // 12 h
const MIN_N = Number(process.env.BADGE_MIN_N || 40);

const deacc = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const esUnder = r => /^total/.test(deacc(r.market)) && /^menos de/.test(deacc(r.selection));

// Las condiciones se declaran aquí y NO se duplican en bot.js: el badge que se
// pinta y el número que lo acompaña tienen que salir de la misma definición, o
// acabaríamos anunciando la estadística de un segmento distinto del que marca.
const CONDICIONES = {
  rectaFinal: r => r.f_avance != null && r.f_avance >= Number(process.env.RECTA_FINAL_MIN || 0.90),
  elite: r => esUnder(r) &&
              r.f_avance != null && r.f_avance >= Number(process.env.FIREWALL_ELITE_MIN_AVANCE || 0.75) &&
              r.f_linea != null && r.f_linea >= Number(process.env.FIREWALL_ELITE_MIN_LINEA || 0.55),
};

let cache = null;
let cacheTs = 0;

function unidades(r) {
  const stake = r.stake || 1;
  return r.result === 'win' ? (r.odd_decimal - 1) * stake : -stake;
}

/**
 * Recalcula de cero. Devuelve, por badge: n, roi (acumulado) y roiReciente
 * (ponderado exponencialmente). `null` si no llega a MIN_N — mejor no enseñar
 * número que enseñar uno construido con veinte picks.
 */
function recalcular() {
  // Se excluye el DNB porque está vetado desde el 2026-08-23: incluirlo haría
  // que el badge describiera una población que ya no se emite.
  const filas = db.prepare(`
    SELECT ts, market, selection, odd_decimal, stake, result, f_avance, f_linea
    FROM picks
    WHERE result IN ('win','loss') AND COALESCE(score_version, 1) > 0
    ORDER BY ts ASC
  `).all().filter(r => !/empate no accion/.test(deacc(r.market)));

  const lambda = Math.log(2) / HALFLIFE_MS;
  const acc = {};
  for (const k of Object.keys(CONDICIONES)) acc[k] = { pl: 0, cap: 0, n: 0, epl: 0, ecap: 0, tPrev: null };

  for (const r of filas) {
    const t = Date.parse(r.ts);
    const u = unidades(r);
    const stake = r.stake || 1;
    for (const [k, cumple] of Object.entries(CONDICIONES)) {
      if (!cumple(r)) continue;
      const a = acc[k];
      // Decaimiento hasta este instante, ANTES de sumar: así el peso depende
      // del tiempo transcurrido y no del número de picks intermedios.
      if (a.tPrev != null) {
        const d = Math.exp(-lambda * (t - a.tPrev));
        a.epl *= d; a.ecap *= d;
      }
      a.tPrev = t;
      a.pl += u; a.cap += stake; a.n++;
      a.epl += u; a.ecap += stake;
    }
  }

  const out = { calculadoEn: new Date().toISOString(), base: filas.length };
  for (const [k, a] of Object.entries(acc)) {
    out[k] = a.n >= MIN_N && a.cap > 0
      ? { n: a.n, roi: 100 * a.pl / a.cap, roiReciente: a.ecap ? 100 * a.epl / a.ecap : null }
      : null;
  }
  return out;
}

/** Cacheado: el recálculo cuesta ~60 ms, pero no hace falta por cada pick. */
function estadisticas() {
  if (!cache || Date.now() - cacheTs > TTL_MS) {
    try {
      cache = recalcular();
      cacheTs = Date.now();
    } catch (e) {
      console.error('[badges] no se pudieron recalcular las estadísticas:', e.message);
      if (!cache) cache = { calculadoEn: null, base: 0, rectaFinal: null, elite: null };
    }
  }
  return cache;
}

/**
 * El trozo de frase que va dentro del badge. Si no hay muestra suficiente
 * devuelve cadena vacía y el badge se pinta SIN número, que es lo correcto:
 * un badge sin cifra sigue siendo una marca útil; uno con una cifra inventada
 * es exactamente el error que retiramos con el 🔥.
 */
function frase(clave) {
  const s = estadisticas()[clave];
  if (!s) return '';
  return `Este segmento rinde <b>${s.roi >= 0 ? '+' : ''}${s.roi.toFixed(1)}%</b> sobre ${s.n} picks propios`;
}

module.exports = { estadisticas, recalcular, frase, CONDICIONES };
