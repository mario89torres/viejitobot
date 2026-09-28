// scripts/dry-run-report.js
// Muestra los resultados de bot_dry_run_log, agrupados por status y ventanas.
// Uso: node scripts/dry-run-report.js [dias=7]

'use strict';

require('dotenv').config();
const Database = require('better-sqlite3');
const path     = require('path');

const DB_FILE = process.env.DB_PATH || path.join(__dirname, '..', 'snapshots.db');
const db      = new Database(DB_FILE, { readonly: true, timeout: 5000 });
const dias    = Number(process.argv[2] || 7);
const desde   = new Date(Date.now() - dias * 86_400_000).toISOString();

const rows = db.prepare(
  `SELECT * FROM bot_dry_run_log WHERE ts >= ? ORDER BY ts DESC`
).all(desde);

if (!rows.length) {
  console.log(`Sin registros en los últimos ${dias} días.`);
  process.exit(0);
}

const n     = rows.length;
const ok    = rows.filter(r => r.status === 'ok');
const rej   = rows.filter(r => r.rechazo_regla);
const gone  = rows.filter(r => r.status === 'gone');
const susp  = rows.filter(r => r.status === 'suspended');
const tout  = rows.filter(r => r.status === 'timeout');
const err   = rows.filter(r => r.status === 'error');
const bloq  = rows.filter(r => String(r.status).startsWith('bloqueado') || r.status === 'ambiguo');

const p = (a) => a.length ? (100 * a.length / n).toFixed(1) + '%' : '—';
const avg = (arr, fn) => arr.length
  ? (arr.reduce((s, x) => s + fn(x), 0) / arr.length).toFixed(0) + ' ms'
  : '—';
const avgDrift = (arr) => arr.length
  ? (arr.reduce((s, x) => s + (x.odd_drift_pct || 0), 0) / arr.length).toFixed(2) + '%'
  : '—';

console.log(`\n── Dry-Run Report — últimos ${dias} días (n=${n}) ─────────────────────`);
console.log(`  ok           : ${ok.length} (${p(ok)})`);
console.log(`  odd_changed  : ${rej.length} (${p(rej)})  ← cuota bajó >${3}%`);
console.log(`  gone         : ${gone.length} (${p(gone)})`);
console.log(`  suspended    : ${susp.length} (${p(susp)})`);
console.log(`  timeout      : ${tout.length} (${p(tout)})`);
console.log(`  error        : ${err.length} (${p(err)})`);
console.log(`  bloqueado/ambiguo : ${bloq.length} (${p(bloq)})  ← el freno anti-apuesta actuó`);
console.log('');
console.log(`  Latencia DOM (avg ok) : ${avg(ok, r => r.latencia_dom_ms)}`);
console.log(`  Latencia click→betslip: ${avg(ok, r => r.latencia_click_ms)}`);
console.log(`  Latencia total (avg)  : ${avg(rows.filter(r => r.latencia_total_ms), r => r.latencia_total_ms)}`);
console.log(`  Latencia desde emisión (avg): ${avg(rows.filter(r => r.latencia_desde_emit_ms != null), r => r.latencia_desde_emit_ms)}`);
console.log('');
console.log(`  Drift promedio (ok)   : ${avgDrift(ok)}`);
console.log(`  Drift promedio (todos): ${avgDrift(rows.filter(r => r.odd_drift_pct != null))}`);

// Últimos 5
console.log('\n  Últimos 5 registros:');
const fmt = (r) =>
  `  [${r.ts.slice(0,19)}] status=${r.status.padEnd(12)} ` +
  `emit=${r.odd_emit} betslip=${r.odd_betslip ?? '—'} ` +
  `drift=${r.odd_drift_pct != null ? r.odd_drift_pct.toFixed(2)+'%' : '—'} ` +
  `total=${r.latencia_total_ms ?? '—'}ms pick=${r.pick_id ?? 'ad-hoc'}`;
rows.slice(0, 5).forEach(r => console.log(fmt(r)));
console.log('────────────────────────────────────────────────────────────────────\n');
