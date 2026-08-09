/**
 * Lo que apareció al medir H1/H2 y no era la pregunta: entre TRAIN y TEST el
 * stake medio casi se dobló (1.24u -> 2.36u) mientras el acierto caía
 * (75.8% -> 64.7%). Kelly dimensiona con `conf`, así que si `conf` se infla
 * sin que el acierto la acompañe, el bot apuesta MÁS justo cuando acierta
 * MENOS. Este script comprueba si eso es lo que pasó.
 *
 * Tres preguntas, en orden:
 *   1. ¿Se movió la distribución de `conf` con el tiempo? (deriva)
 *   2. ¿`conf` sigue ordenando el resultado? (poder discriminante)
 *   3. ¿`conf` acierta en nivel? (calibración: conf declarada vs WR real)
 *
 * Y la consecuencia práctica: qué habría rendido cada política de staking
 * sobre el mismo conjunto de picks, fuera de muestra.
 *
 * Excluye source='global_draw' (features hardcodeadas; ver firewall.js).
 *
 * Uso: node scripts/analyze-calibration-drift.js
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const Database = require('better-sqlite3');
const { firewallVerdict } = require('../src/firewall');
const { kellyFraction } = require('../src/confidence');

const db = new Database(path.join(__dirname, '..', 'snapshots.db'), { readonly: true });
const rows = db.prepare(`
  SELECT ts, market, selection, odd_decimal, conf, conf_heuristic, conf_learned,
         edge, result, stake, f_avance, f_situacion, f_linea
  FROM picks
  WHERE result IN ('win','loss') AND f_avance IS NOT NULL AND conf IS NOT NULL
    AND (source IS NULL OR source != 'global_draw')
  ORDER BY ts
`).all();

const picks = rows.map(r => ({
  oddDecimal: r.odd_decimal, conf: r.conf, edge: r.edge, result: r.result,
  ts: r.ts, day: r.ts.slice(0, 10), stake: r.stake == null ? 1 : r.stake,
  confH: r.conf_heuristic, confL: r.conf_learned,
  progress: r.f_avance, scoreFactor: r.f_situacion, lineFactor: r.f_linea,
  market: r.market, selection: r.selection,
  marketType: /^total/i.test(r.market || '') ? 'total' : null,
})).filter(p => !firewallVerdict(p).blocked);

const sgn = v => (v >= 0 ? '+' : '') + v.toFixed(1);
const wrOf = l => (l.filter(p => p.result === 'win').length / l.length) * 100;
const meanOf = (l, f) => l.reduce((a, p) => a + f(p), 0) / l.length;

// ── 1. Deriva temporal ──────────────────────────────────────────────────────
console.log('=== 1. DERIVA: conf declarada vs acierto real, por día ===');
console.log('  día         N   conf_media   WR real   gap(conf-WR)   stake/pick');
const byDay = new Map();
for (const p of picks) (byDay.get(p.day) || byDay.set(p.day, []).get(p.day)).push(p);
for (const [day, list] of [...byDay].sort()) {
  if (list.length < 15) continue; // días con muy pocos picks no dicen nada
  const conf = meanOf(list, p => p.conf) * 100;
  const wr = wrOf(list);
  console.log(`  ${day}  ${String(list.length).padStart(3)}   ${conf.toFixed(1).padStart(6)}%   ${wr.toFixed(1).padStart(5)}%   `
    + `${sgn(conf - wr).padStart(7)}pp   ${meanOf(list, p => p.stake).toFixed(2)}u`);
}

// ── 2. Poder discriminante y calibración, TRAIN vs TEST ─────────────────────
const cut = Math.floor(picks.length * 0.6);
const sets = [['TRAIN', picks.slice(0, cut)], ['TEST ', picks.slice(cut)]];

console.log('\n=== 2. ¿`conf` ORDENA el resultado? (WR por decil de conf) ===');
console.log('  Si conf funciona, el WR debe SUBIR de D1 a D10. Plano = no discrimina.');
for (const [label, set] of sets) {
  const sorted = [...set].sort((a, b) => a.conf - b.conf);
  const per = Math.floor(sorted.length / 10);
  const wrs = [];
  for (let i = 0; i < 10; i++) {
    const slice = sorted.slice(i * per, i === 9 ? sorted.length : (i + 1) * per);
    wrs.push(wrOf(slice));
  }
  console.log(`  ${label}  ${wrs.map(w => w.toFixed(0).padStart(3)).join(' ')}   (D1..D10, %)`);
  // Spearman entre conf y resultado (0/1): mide orden, no nivel.
  const n = set.length;
  const rank = arr => { const s = [...arr].map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]); const r = new Array(n); s.forEach(([, i], k) => { r[i] = k + 1; }); return r; };
  const rc = rank(set.map(p => p.conf));
  const rr = rank(set.map(p => (p.result === 'win' ? 1 : 0)));
  const mc = (n + 1) / 2;
  const cov = rc.reduce((a, v, i) => a + (v - mc) * (rr[i] - mc), 0);
  const sd = Math.sqrt(rc.reduce((a, v) => a + (v - mc) ** 2, 0) * rr.reduce((a, v) => a + (v - mc) ** 2, 0));
  console.log(`  ${label}  Spearman(conf, acierto) = ${(cov / sd).toFixed(3)}`);
}

console.log('\n=== 3. CALIBRACIÓN: conf declarada vs WR observado ===');
for (const [label, set] of sets) {
  console.log(`  --- ${label} ---`);
  for (const [lo, hi] of [[0.70, 0.72], [0.72, 0.74], [0.74, 0.76], [0.76, 0.80], [0.80, 1.01]]) {
    const b = set.filter(p => p.conf >= lo && p.conf < hi);
    if (b.length < 20) continue;
    const conf = meanOf(b, p => p.conf) * 100, wr = wrOf(b);
    console.log(`   conf [${(lo * 100).toFixed(0)},${(hi * 100).toFixed(0)}%)  N=${String(b.length).padStart(4)}  `
      + `declara ${conf.toFixed(1)}%  logra ${wr.toFixed(1)}%  -> ${sgn(conf - wr)}pp de exceso`);
  }
}

// ── 4. Consecuencia: políticas de staking sobre el MISMO conjunto ───────────
console.log('\n=== 4. POLÍTICAS DE STAKING, mismo conjunto de picks (fuera de muestra) ===');
const TEST = picks.slice(cut);
const SCALE = 20;
const capOf = odd => (odd >= 1.70 ? 2.5 : odd >= 1.50 ? 3.5 : 5);
const clamp = (u, odd) => Math.min(capOf(odd), Math.max(0.1, Math.round(u * 10) / 10));

const policies = {
  'actual (medio Kelly, conf cruda)': p => p.stake,
  'plano 1u                        ': () => 1,
  'plano 2u                        ': () => 2,
  'cuarto de Kelly                 ': p => clamp(kellyFraction(p.conf, p.oddDecimal) / 4 * SCALE, p.oddDecimal),
  'medio Kelly con conf −5pp       ': p => clamp(kellyFraction(Math.max(0.5, p.conf - 0.05), p.oddDecimal) / 2 * SCALE, p.oddDecimal),
  'medio Kelly con conf −10pp      ': p => clamp(kellyFraction(Math.max(0.5, p.conf - 0.10), p.oddDecimal) / 2 * SCALE, p.oddDecimal),
};
console.log('  política                            P/L      apostado   ROI/stake   maxDD');
for (const [name, stakeOf] of Object.entries(policies)) {
  let pl = 0, staked = 0, peak = 0, dd = 0, run = 0;
  for (const p of TEST) {
    const s = stakeOf(p);
    staked += s;
    run += p.result === 'win' ? s * (p.oddDecimal - 1) : -s;
    peak = Math.max(peak, run);
    dd = Math.max(dd, peak - run);
  }
  pl = run;
  console.log(`  ${name}  ${sgn(pl).padStart(7)}u  ${staked.toFixed(0).padStart(7)}u   ${sgn(staked ? (pl / staked) * 100 : 0).padStart(6)}%   ${dd.toFixed(1).padStart(6)}u`);
}
