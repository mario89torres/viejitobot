/**
 * Aporte MARGINAL de cada regla del firewall: se apaga una sola y se mide qué
 * pasa. Es distinto de "qué bloquea cada regla" — dos reglas pueden bloquear
 * casi el mismo conjunto (R1 y R2 lo hacen) y entonces la suma de sus bloqueos
 * exagera mucho lo que aportan de verdad.
 *
 * Todo con stake PLANO 1u (política vigente) para que los periodos sean
 * comparables, y excluyendo source='global_draw' (features fabricadas, y
 * además esos picks nunca pasan por el firewall en producción).
 *
 * Uso: node scripts/firewall-report.js [--days 21]
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const Database = require('better-sqlite3');

const i = process.argv.indexOf('--days');
const DAYS = i > -1 ? Number(process.argv[i + 1]) : 21;

const db = new Database(path.join(__dirname, '..', 'snapshots.db'), { readonly: true });
const rows = db.prepare(`
  SELECT ts, sport, market, selection, odd_decimal, conf, edge, result,
         f_avance, f_situacion, f_linea
  FROM picks
  WHERE result IN ('win','loss') AND stake IS NOT NULL AND f_avance IS NOT NULL
    AND (source IS NULL OR source != 'global_draw')
    AND ts >= datetime('now', '-${DAYS} days')
  ORDER BY ts
`).all();

const picks = rows.map(r => ({
  ts: r.ts, market: r.market, selection: r.selection, oddDecimal: r.odd_decimal,
  conf: r.conf, edge: r.edge, result: r.result,
  progress: r.f_avance, scoreFactor: r.f_situacion, lineFactor: r.f_linea,
  marketType: /^total/i.test(r.market || '') ? 'total' : null,
  pl: r.result === 'win' ? (r.odd_decimal - 1) : -1,
}));

// Se recarga el módulo con el env modificado en cada escenario, porque
// firewall.js lee process.env dentro de config() en cada llamada.
function verdictWith(env) {
  const prev = {};
  for (const [k, v] of Object.entries(env)) { prev[k] = process.env[k]; process.env[k] = v; }
  delete require.cache[require.resolve('../src/firewall')];
  const { firewallVerdict } = require('../src/firewall');
  const kept = picks.filter(p => !firewallVerdict(p).blocked);
  for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  return kept;
}

function stat(list) {
  if (!list.length) return { n: 0, wr: 0, roi: 0, pl: 0 };
  const w = list.filter(p => p.result === 'win').length;
  const pl = list.reduce((a, p) => a + p.pl, 0);
  return { n: list.length, wr: (w / list.length) * 100, roi: (pl / list.length) * 100, pl };
}
const sgn = (v, d = 1) => (v >= 0 ? '+' : '') + v.toFixed(d);

const SIN = { FIREWALL_ENABLED: 'false' };
const TODO = {};
const base = stat(picks);
const full = stat(verdictWith(TODO));

console.log(`Picks liquidados (${DAYS}d, sin global_draw): ${picks.length}`);
console.log(`Rango: ${picks[0].ts.slice(0, 10)} -> ${picks[picks.length - 1].ts.slice(0, 10)}`);
console.log('Stake plano 1u.\n');

console.log('=== EFECTO GLOBAL DEL FIREWALL ===');
console.log(`  SIN firewall : N=${String(base.n).padStart(4)}  WR=${base.wr.toFixed(1)}%  ROI=${sgn(base.roi)}%  P/L=${sgn(base.pl)}u`);
console.log(`  CON firewall : N=${String(full.n).padStart(4)}  WR=${full.wr.toFixed(1)}%  ROI=${sgn(full.roi)}%  P/L=${sgn(full.pl)}u`);
console.log(`  -> retiene ${(full.n / base.n * 100).toFixed(0)}% del volumen, mueve el ROI ${sgn(full.roi - base.roi)}pp y el P/L ${sgn(full.pl - base.pl)}u\n`);

// Leave-one-out: apagar UNA regla y ver cuánto se pierde.
const REGLAS = {
  'R1 bloquear Over        ': { FIREWALL_BLOCK_OVERS: 'false' },
  'R2 avance minimo (0.40) ': { FIREWALL_MIN_AVANCE: '0' },
  'R3 momio alto (>3.0)    ': { FIREWALL_MAX_ODDS: '0' },
  'R5 situacion >= 0.99    ': { FIREWALL_MAX_SITUACION: '0' },
  'R7 Under linea > 3.5    ': { FIREWALL_MAX_UNDER_LINE: '0' },
};

console.log('=== APORTE MARGINAL (se apaga SOLO esa regla) ===');
console.log('  regla                     N      WR      ROI      P/L     coste de apagarla');
for (const [nombre, env] of Object.entries(REGLAS)) {
  const s = stat(verdictWith(env));
  const dPl = full.pl - s.pl;      // lo que aporta tenerla encendida
  const dRoi = full.roi - s.roi;
  console.log(`  ${nombre} ${String(s.n).padStart(4)}  ${s.wr.toFixed(1).padStart(5)}%  ${sgn(s.roi).padStart(6)}%  ${sgn(s.pl).padStart(7)}u   `
    + `${dPl >= 0 ? 'aporta' : 'RESTA '} ${sgn(dPl).padStart(6)}u / ${sgn(dRoi).padStart(5)}pp`);
}

// R1 y R2 bloquean casi el mismo conjunto (Overs tardíos), así que apagar solo
// una no cambia nada: la otra los sigue atrapando. Su valor es CONJUNTO, y
// medirlas por separado lo esconde por completo.
console.log('\n=== GRUPOS (apagar varias a la vez) ===');
const GRUPOS = {
  'R1+R2 (Over y avance)   ': { FIREWALL_BLOCK_OVERS: 'false', FIREWALL_MIN_AVANCE: '0' },
  'R5+R7 (situacion y linea)': { FIREWALL_MAX_SITUACION: '0', FIREWALL_MAX_UNDER_LINE: '0' },
  'TODO apagado            ': SIN,
};
console.log('  escenario                  N      WR      ROI      P/L     vs firewall completo');
for (const [nombre, env] of Object.entries(GRUPOS)) {
  const s = stat(verdictWith(env));
  const dPl = full.pl - s.pl;
  console.log(`  ${nombre} ${String(s.n).padStart(4)}  ${s.wr.toFixed(1).padStart(5)}%  ${sgn(s.roi).padStart(6)}%  ${sgn(s.pl).padStart(7)}u   `
    + `${dPl >= 0 ? 'aportan' : 'RESTAN '} ${sgn(dPl).padStart(6)}u`);
}

console.log('\n=== QUÉ BLOQUEA CADA REGLA (puede solaparse) ===');
delete require.cache[require.resolve('../src/firewall')];
const { firewallVerdict } = require('../src/firewall');
const porRegla = {};
for (const p of picks) {
  for (const r of firewallVerdict(p).rules) (porRegla[r] = porRegla[r] || []).push(p);
}
console.log('  regla                  N     WR      ROI de lo bloqueado');
for (const [r, list] of Object.entries(porRegla).sort((a, b) => b[1].length - a[1].length)) {
  const s = stat(list);
  console.log(`  ${r.padEnd(22)} ${String(s.n).padStart(4)}  ${s.wr.toFixed(1).padStart(5)}%  ${sgn(s.roi).padStart(6)}%`);
}
console.log(`\n  (referencia: ROI sin firewall = ${sgn(base.roi)}%. Una regla aporta si lo que`);
console.log('   bloquea rinde por DEBAJO de esa referencia.)');
