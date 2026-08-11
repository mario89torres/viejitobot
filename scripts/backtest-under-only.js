/**
 * ¿Concentrar en Under mejora el resultado, y cuánto volumen cuesta?
 *
 * Origen de la hipótesis (medido el 2026-08-10 sobre 21 días, N=1318): todo el
 * beneficio del sistema viene de Under (+38.9u, ROI +7.0%); el otro 58% del
 * volumen suma −3.0u. Con IC95%, solo Under (+1.4%..+12.5%) y Over
 * (−39.9%..−4.6%) son distinguibles de cero — el resto cruza el cero.
 *
 * CAVEAT HONESTO Y CENTRAL: la hipótesis salió de mirar TODA la ventana, así
 * que ningún tramo es limpio de verdad. Un corte temporal aquí no "valida" en
 * el sentido fuerte; lo que sí hace es descartar que el efecto dependa de un
 * único periodo afortunado. Por eso además se mira semana a semana: una regla
 * que solo funciona en una semana es ruido, aunque el agregado luzca bien.
 *
 * Todo se simula con stake PLANO 1u, no con el stake histórico: es la política
 * vigente desde el 2026-08-09 (ver kelly-no-ordena-usar-plano) y así los
 * periodos son comparables entre sí.
 *
 * Excluye source='global_draw' (features fabricadas) y se evalúa SOLO sobre
 * picks que pasan el firewall actual — que es la población sobre la que
 * actuaría una regla nueva.
 *
 * Uso: node scripts/backtest-under-only.js [--days 21] [--split 0.6]
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const Database = require('better-sqlite3');
const { firewallVerdict } = require('../src/firewall');

const arg = (name, def) => {
  const i = process.argv.indexOf(name);
  return i > -1 ? Number(process.argv[i + 1]) : def;
};
const DAYS = arg('--days', 21);
const SPLIT = arg('--split', 0.6);

const db = new Database(path.join(__dirname, '..', 'snapshots.db'), { readonly: true });
const rows = db.prepare(`
  SELECT ts, sport, market, selection, odd_decimal, conf, edge, result,
         f_avance, f_situacion, f_linea
  FROM picks
  WHERE result IN ('win','loss') AND stake IS NOT NULL
    AND f_avance IS NOT NULL
    AND (source IS NULL OR source != 'global_draw')
    AND ts >= datetime('now', '-${DAYS} days')
  ORDER BY ts
`).all();

const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const lineOf = sel => {
  const m = String(sel).match(/([\d.]+)/);
  return m ? Number(m[1]) : null;
};

const picks = rows.map(r => ({
  ts: r.ts, market: r.market, selection: r.selection, oddDecimal: r.odd_decimal,
  conf: r.conf, edge: r.edge, result: r.result,
  progress: r.f_avance, scoreFactor: r.f_situacion, lineFactor: r.f_linea,
  marketType: /^total/i.test(r.market || '') ? 'total' : null,
  isUnder: /^total/i.test(r.market || '') && /^menos/.test(norm(r.selection)),
  isGanador: /resultado final/i.test(r.market || ''),
  line: lineOf(r.selection),
  // P/L con stake plano 1u
  pl: r.result === 'win' ? (r.odd_decimal - 1) : -1,
})).filter(p => !firewallVerdict(p).blocked);

// Las variantes a comparar. La base es "no cambiar nada".
const VARIANTES = {
  'BASE (todo, sin cambios)   ': () => true,
  'solo Under                 ': p => p.isUnder,
  'Under linea <= 4.5         ': p => p.isUnder && p.line != null && p.line <= 4.5,
  'Under linea <= 3.5         ': p => p.isUnder && p.line != null && p.line <= 3.5,
  'Under linea <= 2.5         ': p => p.isUnder && p.line != null && p.line <= 2.5,
  'Under + Ganador            ': p => p.isUnder || p.isGanador,
};

function stat(list, baseN) {
  if (!list.length) return { n: 0, wr: 0, roi: 0, pl: 0, vol: 0 };
  const w = list.filter(p => p.result === 'win').length;
  const pl = list.reduce((a, p) => a + p.pl, 0);
  return {
    n: list.length, wr: (w / list.length) * 100,
    roi: (pl / list.length) * 100, pl,
    vol: baseN ? (list.length / baseN) * 100 : 100,
  };
}
const sgn = (v, d = 1) => (v >= 0 ? '+' : '') + v.toFixed(d);
const fmt = s => `N=${String(s.n).padStart(4)}  WR=${s.wr.toFixed(1).padStart(5)}%  `
  + `ROI=${sgn(s.roi).padStart(6)}%  P/L=${sgn(s.pl).padStart(7)}u  vol=${s.vol.toFixed(0).padStart(3)}%`;

console.log(`Picks liquidados que PASAN el firewall (${DAYS}d, sin global_draw): ${picks.length}`);
console.log(`Rango: ${picks[0].ts.slice(0, 10)} -> ${picks[picks.length - 1].ts.slice(0, 10)}`);
console.log('Simulado con stake PLANO 1u (política vigente).\n');

const cut = Math.floor(picks.length * SPLIT);
const TRAIN = picks.slice(0, cut), TEST = picks.slice(cut);

for (const [label, set] of [['TRAIN (en muestra)', TRAIN], ['TEST  (fuera del corte)', TEST], ['TOTAL', picks]]) {
  console.log(`=== ${label} — ${set[0].ts.slice(0, 10)} a ${set[set.length - 1].ts.slice(0, 10)} ===`);
  const baseN = set.length;
  for (const [nombre, pred] of Object.entries(VARIANTES)) {
    console.log(`  ${nombre} ${fmt(stat(set.filter(pred), baseN))}`);
  }
  console.log('');
}

// ── Estabilidad semana a semana: lo que distingue señal de suerte ────────────
console.log('=== ESTABILIDAD POR SEMANA (ROI con stake plano) ===');
console.log('Una regla que solo gana en una semana es ruido, por bueno que luzca el agregado.\n');
const semanas = {};
for (const p of picks) {
  const d = new Date(p.ts);
  const wk = new Date(d.getTime() - ((d.getUTCDay() + 6) % 7) * 86400000).toISOString().slice(0, 10);
  (semanas[wk] = semanas[wk] || []).push(p);
}
const keys = Object.keys(semanas).sort();
const cab = keys.map(k => k.slice(5)).map(s => s.padStart(14)).join('');
console.log('  variante                  ' + cab);
for (const [nombre, pred] of Object.entries(VARIANTES)) {
  let linea = '  ' + nombre;
  for (const k of keys) {
    const s = stat(semanas[k].filter(pred), semanas[k].length);
    linea += (s.n ? `${sgn(s.roi, 0)}% (n=${s.n})` : '—').padStart(14);
  }
  console.log(linea);
}

console.log('\n--- Cómo leerlo ---');
console.log('Una variante solo merece adoptarse si su ROI supera al de BASE en TRAIN, en TEST');
console.log('y en la MAYORÍA de las semanas. Si gana en el total pero pierde en varias semanas,');
console.log('lo que se está midiendo es un tramo afortunado, no un edge.');
