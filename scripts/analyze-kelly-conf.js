/**
 * ¿Aguantan el histórico las dos hipótesis del reporte diario del 2026-08-09?
 *
 *   H1 "los momios altos (>1.75) están sobre-apostados" -> recortar Kelly ahí
 *   H2 "la banda de confianza 70-72% es mala"           -> filtrarla
 *
 * Las dos salieron de UN día (N=45). Este script las mide sobre los picks
 * liquidados, sobre la población que SOBREVIVE al firewall (que es donde
 * actuaría una regla nueva) y con corte temporal, porque una hipótesis nacida
 * de mirar datos solo significa algo si se valida en datos que no se miraron.
 *
 * Dos métricas distintas a propósito:
 *   - ROI plano  : (retorno − N) / N. Responde "¿este bucket es +EV?".
 *   - ROI/stake  : profit / apostado. Responde "¿estoy dimensionando bien?".
 * La pregunta de Kelly es la SEGUNDA. Un bucket puede ser +EV y aun así estar
 * sobre-apostado, y al revés.
 *
 * Excluye source='global_draw' (features hardcodeadas; ver firewall.js).
 *
 * Uso: node scripts/analyze-kelly-conf.js [--split 0.6]
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const Database = require('better-sqlite3');
const { firewallVerdict } = require('../src/firewall');

const splitArg = process.argv.indexOf('--split');
const SPLIT = splitArg > -1 ? Number(process.argv[splitArg + 1]) : 0.6;

const db = new Database(path.join(__dirname, '..', 'snapshots.db'), { readonly: true });
const rows = db.prepare(`
  SELECT ts, market, selection, odd_decimal, conf, edge, result, stake,
         f_avance, f_situacion, f_linea
  FROM picks
  WHERE result IN ('win','loss') AND f_avance IS NOT NULL AND conf IS NOT NULL
    AND (source IS NULL OR source != 'global_draw')
  ORDER BY ts
`).all();

const toPick = r => ({
  market: r.market, selection: r.selection, oddDecimal: r.odd_decimal,
  conf: r.conf, edge: r.edge, result: r.result, ts: r.ts,
  // stake histórico: puede faltar en picks viejos; se asume 1u (plano) ahí.
  stake: r.stake == null ? 1 : r.stake,
  progress: r.f_avance, scoreFactor: r.f_situacion, lineFactor: r.f_linea,
  marketType: /^total/i.test(r.market || '') ? 'total' : null,
});

const profit = p => (p.result === 'win' ? p.stake * (p.oddDecimal - 1) : -p.stake);

function stat(list) {
  if (!list.length) return { n: 0, wr: 0, roi: 0, roiStake: 0, staked: 0, pl: 0 };
  const w = list.filter(p => p.result === 'win').length;
  const ret = list.reduce((a, p) => a + (p.result === 'win' ? p.oddDecimal : 0), 0);
  const staked = list.reduce((a, p) => a + p.stake, 0);
  const pl = list.reduce((a, p) => a + profit(p), 0);
  return {
    n: list.length, wr: (w / list.length) * 100,
    roi: ((ret - list.length) / list.length) * 100,
    roiStake: staked ? (pl / staked) * 100 : 0,
    staked, pl,
  };
}
const sgn = v => (v >= 0 ? '+' : '') + v.toFixed(1);
const fmt = s => `N=${String(s.n).padStart(4)}  WR=${s.wr.toFixed(1).padStart(5)}%  `
  + `ROIplano=${sgn(s.roi).padStart(6)}%  ROI/stake=${sgn(s.roiStake).padStart(6)}%  `
  + `stake/pick=${(s.n ? s.staked / s.n : 0).toFixed(2)}u  P/L=${sgn(s.pl).padStart(7)}u`;

// Solo los que PASAN el firewall: es la población sobre la que actuaría una regla nueva.
const all = rows.map(toPick).filter(p => !firewallVerdict(p).blocked);
const cut = Math.floor(all.length * SPLIT);
const TRAIN = all.slice(0, cut);
const TEST = all.slice(cut);

console.log(`Picks liquidados que PASAN el firewall: ${all.length}`);
console.log(`  TRAIN ${TRAIN[0].ts.slice(0, 10)} -> ${TRAIN[cut - 1].ts.slice(0, 10)}  (N=${TRAIN.length})`);
console.log(`  TEST  ${TEST[0].ts.slice(0, 10)} -> ${TEST[TEST.length - 1].ts.slice(0, 10)}  (N=${TEST.length})`);
console.log(`\nreferencia global   TRAIN  ${fmt(stat(TRAIN))}`);
console.log(`referencia global   TEST   ${fmt(stat(TEST))}`);

function buckets(label, edges, keyOf, fmtKey) {
  console.log(`\n=== ${label} ===`);
  for (let i = 0; i < edges.length - 1; i++) {
    const [lo, hi] = [edges[i], edges[i + 1]];
    const sel = list => list.filter(p => keyOf(p) >= lo && keyOf(p) < hi);
    const tr = stat(sel(TRAIN)), te = stat(sel(TEST));
    if (!tr.n && !te.n) continue;
    console.log(`  ${fmtKey(lo, hi).padEnd(16)} TRAIN ${fmt(tr)}`);
    console.log(`  ${''.padEnd(16)} TEST  ${fmt(te)}`);
  }
}

buckets('H1 — POR MOMIO', [1.0, 1.35, 1.45, 1.55, 1.65, 1.75, 1.85, 3.01],
  p => p.oddDecimal, (lo, hi) => `[${lo.toFixed(2)},${hi.toFixed(2)})`);

buckets('H2 — POR CONFIANZA', [0, 0.70, 0.72, 0.74, 0.76, 1.01],
  p => p.conf, (lo, hi) => `[${(lo * 100).toFixed(0)}%,${(hi * 100).toFixed(0)}%)`);

// Corte directo de las dos hipótesis, tal como se propusieron.
console.log('\n=== LAS DOS HIPÓTESIS, TAL CUAL SE PROPUSIERON ===');
for (const [label, pred] of [
  ['H1  momio > 1.75', p => p.oddDecimal > 1.75],
  ['H2  conf 70-72%  ', p => p.conf >= 0.70 && p.conf < 0.72],
]) {
  console.log(`  ${label}  TRAIN ${fmt(stat(TRAIN.filter(pred)))}`);
  console.log(`  ${''.padEnd(label.length)}  TEST  ${fmt(stat(TEST.filter(pred)))}`);
}

// H1 es una pregunta de DIMENSIONAMIENTO: ¿mejora el P/L si recorto el stake
// en momios altos? Se simula sobre TEST reescalando el stake ya registrado.
console.log('\n=== H1 SIMULADA: recortar stake en momio > 1.75 (fuera de muestra) ===');
const base = stat(TEST);
for (const factor of [1.0, 0.75, 0.5, 0.25, 0]) {
  const sim = TEST.map(p => ({ ...p, stake: p.oddDecimal > 1.75 ? p.stake * factor : p.stake }));
  const s = stat(sim);
  const tag = factor === 1 ? '(actual)' : '';
  console.log(`  ×${factor.toFixed(2)}  P/L=${sgn(s.pl).padStart(7)}u  apostado=${s.staked.toFixed(1).padStart(6)}u  ROI/stake=${sgn(s.roiStake).padStart(6)}%  ${tag}`);
}
console.log(`  (P/L base = ${sgn(base.pl)}u. Recortar solo ayuda si el P/L SUBE al bajar el factor.)`);

// H2 es una pregunta de FILTRO: ¿mejora el ROI si dejo de emitir esa banda?
console.log('\n=== H2 SIMULADA: excluir conf 70-72% (fuera de muestra) ===');
const keep = TEST.filter(p => !(p.conf >= 0.70 && p.conf < 0.72));
const drop = TEST.filter(p => p.conf >= 0.70 && p.conf < 0.72);
console.log(`  se queda   ${fmt(stat(keep))}`);
console.log(`  se excluye ${fmt(stat(drop))}`);
console.log(`  (excluir aporta solo si lo excluido rinde PEOR que la referencia global de TEST:`);
console.log(`   ROIplano ${sgn(base.roi)}% / ROI-stake ${sgn(base.roiStake)}%.)`);
