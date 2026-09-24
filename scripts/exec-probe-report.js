// Reporte del nivel 0 de apuesta directa: que tan ejecutables fueron los picks
// a +10/+30/+60 s (tabla pick_exec_probe, ver src/execProbe.js).
//
// Uso: node scripts/exec-probe-report.js [dias=7] [source=model|heur]
//
// ROI "ejecutable" = P/L del pick liquidado recalculado con la cuota que se
// habria conseguido, contando SOLO los que seguian disponibles. Los que
// desaparecen se cuentan aparte: en el analisis historico eran los mas
// ganadores, asi que ignorarlos infla el ROI.
const path = require('path');
const Database = require('better-sqlite3');
const db = new Database(process.env.DB_PATH || path.join(__dirname, '..', 'snapshots.db'), { readonly: true });

const dias = Number(process.argv[2] || 7);
const source = process.argv[3] || 'model';
const desde = new Date(Date.now() - dias * 864e5).toISOString();
const tabla = source === 'heur' ? 'picks' : 'model_picks';

const filas = db.prepare(`
  SELECT e.delay_s, e.status, e.odd_emit, e.odd_seen, e.real_delay_ms, p.result
  FROM pick_exec_probe e JOIN ${tabla} p ON p.id = e.pick_id
  WHERE e.source = ? AND e.emit_ts >= ?
`).all(source, desde);

const pl = (res, o) => res === 'win' ? o - 1 : -1;
const pct = (a, q) => a.length ? (100 * a[Math.min(a.length - 1, Math.floor(a.length * q))]).toFixed(1) + '%' : '-';
const wr = l => l.length ? (100 * l.filter(x => x.result === 'win').length / l.length).toFixed(1) + '%' : '-';
const roi = (l, f) => l.length ? (100 * l.reduce((s, x) => s + f(x), 0) / l.length).toFixed(2) + '%' : '-';

console.log(`source=${source} | ultimos ${dias} dias | sondeos: ${filas.length}`);
for (const delay of [10, 30, 60]) {
  const del = filas.filter(f => f.delay_s === delay);
  const liq = del.filter(f => f.result === 'win' || f.result === 'loss');
  if (!del.length) continue;
  const cnt = s => del.filter(f => f.status === s).length;
  const real = del.map(f => f.real_delay_ms).filter(x => x != null).sort((a, b) => a - b);
  console.log(`\n=== +${delay} s (real: p50 ${(real[Math.floor(real.length / 2)] / 1000).toFixed(1)}s, p90 ${(real[Math.floor(real.length * .9)] / 1000).toFixed(1)}s) ===`);
  console.log(`n=${del.length} | ok ${cnt('ok')} (${(100 * cnt('ok') / del.length).toFixed(1)}%) | susp ${cnt('susp')} | gone ${cnt('gone')} (${(100 * cnt('gone') / del.length).toFixed(1)}%) | error ${cnt('error')}`);

  const ok = liq.filter(f => f.status === 'ok' && f.odd_seen > 1);
  const noOk = liq.filter(f => f.status === 'gone' || f.status === 'susp');
  const drift = ok.map(f => (f.odd_seen - f.odd_emit) / f.odd_emit).sort((a, b) => a - b);
  console.log(`liquidados: ${liq.length} | deriva de cuota: p10 ${pct(drift, .1)} mediana ${pct(drift, .5)} p90 ${pct(drift, .9)} | bajo >3%: ${(100 * drift.filter(d => d < -.03).length / (drift.length || 1)).toFixed(1)}%`);
  console.log(`WR disponibles ${wr(ok)} | WR desaparecidos/suspendidos ${wr(noOk)} (n=${noOk.length})`);
  console.log(`ROI todos a cuota de emision ${roi(liq, f => pl(f.result, f.odd_emit))} | disponibles: emision ${roi(ok, f => pl(f.result, f.odd_emit))} -> ejecutable ${roi(ok, f => pl(f.result, f.odd_seen))}`);
  const acept = ok.filter(f => f.odd_seen >= f.odd_emit * 0.97);
  console.log(`regla "rechazar si bajo >3%": apuesta ${acept.length}/${liq.length} | ROI ejecutable ${roi(acept, f => pl(f.result, f.odd_seen))}`);
}
if (filas.length && filas.every(f => f.result == null)) console.log('\n(aun no hay picks liquidados con sondeo: vuelve a correr cuando terminen los partidos)');
