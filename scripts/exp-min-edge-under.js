// Medición del experimento MIN_EDGE_UNDER (arrancado 2026-08-02).
//
// Pregunta: ¿los "menos de X" de fútbol con edge por debajo de MIN_EDGE=0.02
// también son rentables, o el umbral está cortando donde debe?
//
// Antes del experimento esa zona era invisible: los picks nunca se emitían, así
// que no había forma de saberlo. Bajando el umbral SOLO para ese mercado, la
// zona ciega se vuelve medible sin alterar nada más.
//
// Identificación sin columna extra: un "menos de" de fútbol con edge < 0.02
// solo puede existir por el experimento. Todo lo demás sigue con el umbral
// normal, así que el grupo de control es el resto de los "menos de".
//
// Uso: node scripts/exp-min-edge-under.js
require('dotenv').config();
const { db } = require('../src/db');
const { parsePick } = require('../src/markets');

const UMBRAL = Number(process.env.MIN_EDGE || 0.02);

const roi = ps => ps.length ? 100 * ps.reduce((a, p) => a + (p.result === 'win' ? p.odd_decimal - 1 : -1), 0) / ps.length : null;
const wr = ps => ps.length ? 100 * ps.filter(p => p.result === 'win').length / ps.length : null;
const pl = ps => ps.reduce((a, p) => a + (p.result === 'win' ? p.odd_decimal - 1 : -1), 0);
const se = ps => {
  if (ps.length < 2) return null;
  const x = ps.map(p => p.result === 'win' ? p.odd_decimal - 1 : -1);
  const n = x.length, m = x.reduce((a, b) => a + b, 0) / n;
  return 100 * Math.sqrt(x.reduce((a, b) => a + (b - m) ** 2, 0) / (n - 1) / n);
};
const fmt = (v, d = 1) => (v >= 0 ? '+' : '') + v.toFixed(d);

const esUnderFutbol = p => {
  if (p.sport !== 'Fútbol') return false;
  const t = parsePick({ market: p.market, selection: p.selection, event: p.event });
  return !!(t && t.type === 'total' && !t.over);
};

const liq = db.prepare(`
  SELECT * FROM picks WHERE result IN ('win','loss') AND score_version = 2 AND edge IS NOT NULL
  ORDER BY ts
`).all();
const unders = liq.filter(esUnderFutbol);
const exp = unders.filter(p => p.edge < UMBRAL);      // solo existen por el experimento
const ctrl = unders.filter(p => p.edge >= UMBRAL);    // los que ya se emitían antes

console.log(`EXPERIMENTO MIN_EDGE_UNDER  (umbral normal: ${UMBRAL})`);
console.log(`Estado: ${process.env.MIN_EDGE_UNDER !== undefined && process.env.MIN_EDGE_UNDER !== '' ? 'ACTIVO (MIN_EDGE_UNDER=' + process.env.MIN_EDGE_UNDER + ')' : 'cerrado'}`);
console.log(`"Menos de X" de fútbol liquidados: ${unders.length}\n`);

if (!exp.length) {
  console.log('Todavía no hay picks del experimento (edge < ' + UMBRAL + ').');
  console.log('Se acumularán conforme el bot emita en esa zona. Vuelve a correr esto en unos días.');
  process.exit(0);
}

console.log('grupo                       n   acierto      ROI      ±ee      P&L');
console.log('-'.repeat(68));
for (const [lbl, ps] of [['EXPERIMENTO (edge < ' + UMBRAL + ')', exp], ['control (edge >= ' + UMBRAL + ')', ctrl]]) {
  const e = se(ps);
  console.log(
    lbl.padEnd(28) + String(ps.length).padStart(3) + '   ' +
    (wr(ps).toFixed(1) + '%').padStart(6) + '  ' +
    (fmt(roi(ps)) + '%').padStart(8) + '  ' +
    (e ? '±' + e.toFixed(1) : '  —').padStart(6) + '  ' +
    (fmt(pl(ps), 2) + 'u').padStart(8)
  );
}

const eExp = se(exp);
console.log();
if (eExp) {
  const t = roi(exp) / eExp;
  console.log(`t del grupo experimental: ${t.toFixed(2)} -> ${Math.abs(t) > 1.96 ? (t > 0 ? 'RENTABLE con significancia' : 'PIERDE con significancia') : 'aún no concluyente'}`);
}
if (exp.length < 40) {
  console.log(`\nAviso: con n=${exp.length} cualquier lectura es provisional. Apunta a 40+ antes de decidir.`);
} else {
  const dif = roi(exp) - roi(ctrl);
  const seDif = Math.sqrt(eExp ** 2 + se(ctrl) ** 2);
  console.log(`Diferencia con el control: ${fmt(dif)} pts ± ${seDif.toFixed(1)}  (t=${(dif / seDif).toFixed(2)})`);
  console.log(roi(exp) > 0
    ? '\n=> La zona bajo el umbral TAMBIÉN es rentable: bajar MIN_EDGE para este mercado gana volumen sin perder ventaja.'
    : '\n=> La zona bajo el umbral NO es rentable: el filtro estaba cortando donde debía. Cierra el experimento.');
}

// desglose por franja de edge, para ver si hay un punto de corte mejor
console.log('\nPor franja de edge (todos los "menos de" de fútbol):');
for (const [lo, hi] of [[-99, 0], [0, 0.01], [0.01, 0.02], [0.02, 0.04], [0.04, 99]]) {
  const b = unders.filter(p => p.edge >= lo && p.edge < hi);
  if (!b.length) continue;
  const et = lo < 0 ? 'negativo' : `${(100 * lo).toFixed(0)}-${hi > 1 ? '+' : (100 * hi).toFixed(0)}%`;
  console.log(`  edge ${et.padEnd(10)} n=${String(b.length).padStart(3)}  acierto=${wr(b).toFixed(0).padStart(3)}%  ROI=${(fmt(roi(b)) + '%').padStart(8)}  P&L=${(fmt(pl(b), 2) + 'u').padStart(8)}`);
}
