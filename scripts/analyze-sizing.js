/**
 * ¿Se puede mejorar el resultado apostando DIFERENCIALMENTE, sin subir el
 * riesgo total?
 *
 * Punto de partida: subir el stake de forma uniforme no mejora nada — es
 * apalancamiento puro. Medido, el ratio P/L:maxDD se queda en 3.33 tanto a 1u
 * como a 3u. Lo único que puede mejorar el rendimiento ajustado a riesgo es
 * poner MÁS donde el edge es mayor y MENOS donde no lo hay.
 *
 * La señal que se usa para escalonar NO es `conf`: está medido que conf no
 * ordena el resultado (Spearman 0.092, ver kelly-no-ordena-usar-plano), así que
 * dimensionar con ella reparte sobre ruido. Lo que sí discrimina es el MERCADO
 * y la LÍNEA (ver edge-concentrado-en-under), y sobre eso se escalona.
 *
 * COMPARACIÓN JUSTA: todos los esquemas se normalizan a la MISMA exposición
 * total que el plano 1u. Sin eso, un esquema que simplemente apuesta más
 * parecería mejor por apalancamiento y no por selección.
 *
 * Uso: node scripts/analyze-sizing.js [--days 21] [--split 0.6]
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const Database = require('better-sqlite3');
const { firewallVerdict } = require('../src/firewall');

const arg = (n, d) => { const i = process.argv.indexOf(n); return i > -1 ? Number(process.argv[i + 1]) : d; };
const DAYS = arg('--days', 21);
const SPLIT = arg('--split', 0.6);

const db = new Database(path.join(__dirname, '..', 'snapshots.db'), { readonly: true });
const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

const picks = db.prepare(`
  SELECT ts, market, selection, odd_decimal, conf, result, f_avance, f_situacion, f_linea
  FROM picks
  WHERE result IN ('win','loss') AND stake IS NOT NULL AND f_avance IS NOT NULL
    AND (source IS NULL OR source != 'global_draw')
    AND ts >= datetime('now','-${DAYS} days')
  ORDER BY ts
`).all().map(r => {
  const lm = String(r.selection).match(/([\d.]+)/);
  return {
    ts: r.ts, market: r.market, selection: r.selection, oddDecimal: r.odd_decimal,
    conf: r.conf, result: r.result, win: r.result === 'win',
    progress: r.f_avance, scoreFactor: r.f_situacion, lineFactor: r.f_linea,
    marketType: /^total/i.test(r.market) ? 'total' : null,
    isUnder: /^total/i.test(r.market) && /^menos/.test(norm(r.selection)),
    line: lm ? Number(lm[1]) : null,
  };
}).filter(p => !firewallVerdict(p).blocked);

// Esquemas de dimensionamiento. Devuelven un PESO relativo; luego todo se
// reescala para igualar la exposición total del plano 1u.
const ESQUEMAS = {
  'plano 1u (actual)        ': () => 1,
  'x2 en Under <= 2.5       ': p => (p.isUnder && p.line <= 2.5 ? 2 : 1),
  'x2 en Under <= 3.5       ': p => (p.isUnder && p.line <= 3.5 ? 2 : 1),
  'x3 en Under <= 2.5       ': p => (p.isUnder && p.line <= 2.5 ? 3 : 1),
  'escalonado 3/2/1 por linea': p => (p.isUnder && p.line <= 2.5 ? 3 : p.isUnder && p.line <= 3.5 ? 2 : 1),
  'x2 Under / x0.5 el resto ': p => (p.isUnder ? 2 : 0.5),
  // Control negativo: escalonar por conf, que sabemos que NO ordena. Si esto
  // "mejora" tanto como los de arriba, es que el test no distingue señal.
  'CONTROL: escalonado por conf': p => (p.conf >= 0.74 ? 2 : 1),
};

function sim(list, pesoFn, exposicionObjetivo) {
  const pesos = list.map(pesoFn);
  const sumaPesos = pesos.reduce((a, b) => a + b, 0);
  const k = exposicionObjetivo / sumaPesos; // normaliza a la misma exposición
  let run = 0, peak = 0, dd = 0, staked = 0;
  list.forEach((p, i) => {
    const s = pesos[i] * k;
    staked += s;
    run += p.win ? s * (p.oddDecimal - 1) : -s;
    peak = Math.max(peak, run);
    dd = Math.max(dd, peak - run);
  });
  return { pl: run, staked, dd, roi: (run / staked) * 100, ratio: dd > 0 ? run / dd : Infinity };
}

const sgn = (v, d = 1) => (v >= 0 ? '+' : '') + v.toFixed(d);

function bloque(label, list) {
  const expo = list.length; // exposición del plano 1u = N unidades
  console.log(`\n=== ${label} — N=${list.length}, exposición fija ${expo}u ===`);
  console.log('  esquema                      P/L      ROI     maxDD    P/L:maxDD');
  const base = sim(list, () => 1, expo);
  for (const [nombre, fn] of Object.entries(ESQUEMAS)) {
    const s = sim(list, fn, expo);
    const mejor = s.ratio > base.ratio ? ' *' : '';
    console.log(`  ${nombre} ${sgn(s.pl).padStart(7)}u  ${sgn(s.roi).padStart(6)}%  ${s.dd.toFixed(1).padStart(6)}u  ${s.ratio.toFixed(2).padStart(9)}${mejor}`);
  }
}

console.log(`Picks tras firewall (${DAYS}d, sin global_draw): ${picks.length}`);
console.log(`Rango: ${picks[0].ts.slice(0, 10)} -> ${picks[picks.length - 1].ts.slice(0, 10)}`);
console.log('Todos los esquemas normalizados a la MISMA exposición total.');
console.log('P/L:maxDD = cuánto se gana por cada unidad de caída máxima. Más alto es mejor.');

const cut = Math.floor(picks.length * SPLIT);
bloque('TRAIN (en muestra — optimista)', picks.slice(0, cut));
bloque('TEST (fuera del corte — la cifra que cuenta)', picks.slice(cut));
bloque('TOTAL', picks);

console.log('\n--- Cómo leerlo ---');
console.log('* marca los esquemas que superan al plano en P/L:maxDD.');
console.log('El CONTROL escalonado por conf debería NO mejorar: conf no ordena el resultado.');
console.log('Si el control mejora tanto como los demás, el test no está midiendo señal real.');
