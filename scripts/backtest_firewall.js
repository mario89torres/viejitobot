/**
 * Backtest del firewall de jugadas (src/firewall.js) sobre los picks ya
 * liquidados. Reproduce las reglas contra el histórico y, sobre todo, las
 * evalúa FUERA DE MUESTRA con corte temporal — que es la única cifra que
 * significa algo, porque los umbrales se derivaron mirando el histórico.
 *
 * Usa la MISMA función que corre en producción (firewallVerdict), así que si
 * alguien cambia un umbral en .env, este backtest lo refleja. Reconstruye el
 * pick desde las columnas de la BD:
 *   f_avance   -> progress    (la BD guarda progress crudo; ver nota en firewall.js)
 *   f_situacion-> scoreFactor
 *   f_linea    -> lineFactor
 *
 * Uso: node scripts/backtest_firewall.js [--split 0.6]
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const Database = require('better-sqlite3');
const { firewallVerdict, config } = require('../src/firewall');

const splitArg = process.argv.indexOf('--split');
const SPLIT = splitArg > -1 ? Number(process.argv[splitArg + 1]) : 0.6;

const db = new Database(path.join(__dirname, '..', 'snapshots.db'), { readonly: true });
// Se EXCLUYE source='global_draw' a propósito, y es importante:
// globalDrawScanner.ts inserta sus picks directo en la BD sin pasar por
// rankPicks, así que el firewall nunca los evalúa — contarlos aquí mide algo
// que en producción no ocurre. Peor: los inserta con features HARDCODEADAS
// (una única combinación f_prob_justa=0.72 / f_avance=0.85 / f_situacion=0.75 /
// f_linea=0.82 para las 184 filas), lo que creaba correlaciones falsas. R6
// nació de ese artefacto: capturaba el 100% de esos picks vía el 0.82 fijo y
// parecía una regla de "steam" cuando solo detectaba la huella del scanner.
const rows = db.prepare(`
  SELECT ts, sport, market, selection, odd_decimal, conf, edge, result,
         f_avance, f_situacion, f_linea
  FROM picks
  WHERE result IN ('win','loss') AND f_avance IS NOT NULL
    AND (source IS NULL OR source != 'global_draw')
  ORDER BY ts
`).all();

// Forma que espera el firewall (salida de scoreRow mezclada con la fila).
const toPick = r => ({
  market: r.market, selection: r.selection, oddDecimal: r.odd_decimal,
  conf: r.conf, edge: r.edge,
  progress: r.f_avance, scoreFactor: r.f_situacion, lineFactor: r.f_linea,
  marketType: /^total/i.test(r.market || '') ? 'total' : null,
  result: r.result,
});

function stat(list) {
  if (!list.length) return { n: 0, wr: 0, roi: 0 };
  const w = list.filter(r => r.result === 'win').length;
  const ret = list.reduce((a, r) => a + (r.result === 'win' ? r.oddDecimal : 0), 0);
  return { n: list.length, w, wr: (w / list.length) * 100, roi: ((ret - list.length) / list.length) * 100 };
}
const fmt = s => `N=${String(s.n).padStart(4)}  WR=${s.wr.toFixed(1).padStart(5)}%  ROI=${(s.roi >= 0 ? '+' : '') + s.roi.toFixed(1).padStart(5)}%`;

const picks = rows.map(toPick);
const cut = Math.floor(picks.length * SPLIT);
const sets = [
  ['TRAIN (en muestra — optimista por construcción)', picks.slice(0, cut), rows.slice(0, cut)],
  ['TEST  (FUERA DE MUESTRA — la cifra que cuenta)', picks.slice(cut), rows.slice(cut)],
];

console.log('Config activa:', JSON.stringify(config(), null, 0));
console.log(`\nPicks liquidados: ${picks.length}  |  corte temporal: ${(SPLIT * 100).toFixed(0)}%`);

for (const [label, set, raw] of sets) {
  const kept = set.filter(p => !firewallVerdict(p).blocked);
  const blocked = set.filter(p => firewallVerdict(p).blocked);
  console.log(`\n=== ${label} ===`);
  console.log(`  rango        : ${raw[0].ts.slice(0, 10)} -> ${raw[raw.length - 1].ts.slice(0, 10)}`);
  console.log(`  sin firewall : ${fmt(stat(set))}`);
  console.log(`  CON firewall : ${fmt(stat(kept))}   (retiene ${((kept.length / set.length) * 100).toFixed(0)}% del volumen)`);
  console.log(`  bloqueadas   : ${fmt(stat(blocked))}`);
}

// Aporte marginal: qué bloquea cada regla por su cuenta, fuera de muestra.
console.log('\n=== APORTE DE CADA REGLA (fuera de muestra) ===');
const test = picks.slice(cut);
const byRule = {};
for (const p of test) {
  for (const rule of firewallVerdict(p).rules) (byRule[rule] = byRule[rule] || []).push(p);
}
for (const [rule, list] of Object.entries(byRule).sort((a, b) => b[1].length - a[1].length)) {
  console.log(`  ${rule.padEnd(14)} bloquea ${fmt(stat(list))}`);
}

// Una regla solo se justifica si lo que bloquea rinde PEOR que dejar pasar todo.
const baseRoi = stat(test).roi;
console.log(`\n  (referencia: ROI global fuera de muestra = ${baseRoi.toFixed(1)}%. Una regla aporta`);
console.log('   si el ROI de lo que bloquea queda por DEBAJO de esa referencia.)');
