/**
 * Repara las etiquetas del grupo de control liquidadas ANTES DE TIEMPO.
 *
 * El bug (introducido el 2026-08-09, detectado el 2026-08-10):
 * settleRejectedGroup liquidaba en cuanto el evento salía del feed en vivo, sin
 * la espera que sí tienen los picks emitidos. Un evento desaparece del feed por
 * suspensiones y huecos del proveedor, no solo porque termine, así que el pick
 * se graduaba contra el marcador de ese instante — casi siempre de primer
 * tiempo.
 *
 *   45% de las filas se liquidó en menos de 20 min (un partido dura 90)
 *   '0-0' era el 18% de los marcadores, vs 5.7% en los picks emitidos
 *
 * Consecuencia: los rechazados por min_conf aparentaban +18.7% de ROI (+159u).
 * Pura fantasía — se comparaban contra marcadores incompletos.
 *
 * Esta reparación vuelve a graduar cada fila contra el ÚLTIMO marcador conocido
 * del evento, y solo si el evento lleva ya CONTROL_SETTLE_MIN minutos sin
 * aparecer (mismo criterio que ahora aplica results.js). Las filas cuyo evento
 * siga activo se dejan intactas.
 *
 * Uso:  node scripts/repair-control-labels.js           (simulacro)
 *       node scripts/repair-control-labels.js --apply   (escribe)
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const Database = require('better-sqlite3');
const { gradePick, parsePick } = require('../src/markets');

const APPLY = process.argv.includes('--apply');
const ESPERA_MIN = Number(process.env.CONTROL_SETTLE_MIN || 15);

const db = new Database(path.join(__dirname, '..', 'snapshots.db'));

// Misma lógica que resultFor() en results.js: distingue anulada de no calificable.
function resultFor(row, finalScore) {
  if (!finalScore) return 'unknown';
  const graded = gradePick(row, finalScore);
  if (graded) return graded;
  if (!/^\d+-\d+$/.test(String(finalScore)) || !parsePick(row)) return 'unknown';
  return 'push';
}

const rows = db.prepare(`
  SELECT rp.id, rp.event_id, rp.event, rp.sport, rp.market, rp.selection,
         rp.result, rp.final_score, rp.ts, rp.settled_ts,
         (SELECT score FROM snapshots s WHERE s.event_id = rp.event_id AND s.score != ''
           ORDER BY s.ts DESC LIMIT 1) AS score_actual,
         (SELECT MAX(ts) FROM snapshots s WHERE s.event_id = rp.event_id) AS ultimo_visto
  FROM rejected_picks rp
  WHERE rp.result IS NOT NULL
`).all();

const cambios = [];
let sinSnaps = 0, aunActivos = 0, iguales = 0;

for (const r of rows) {
  if (!r.score_actual || !r.ultimo_visto) { sinSnaps++; continue; }
  const minutosFuera = (Date.now() - Date.parse(r.ultimo_visto)) / 60000;
  if (minutosFuera < ESPERA_MIN) { aunActivos++; continue; }

  const row = { market: r.market, selection: r.selection, event: r.event, sport: r.sport };
  const nuevo = resultFor(row, r.score_actual);
  if (nuevo === r.result && r.score_actual === r.final_score) { iguales++; continue; }
  cambios.push({ ...r, nuevoResult: nuevo });
}

console.log(`Filas del grupo de control ya liquidadas: ${rows.length}`);
console.log(`  sin snapshots utilizables : ${sinSnaps}`);
console.log(`  evento aún activo (<${ESPERA_MIN}min fuera): ${aunActivos}`);
console.log(`  ya correctas              : ${iguales}`);
console.log(`  A CORREGIR               : ${cambios.length}`);

const porTransicion = {};
for (const c of cambios) {
  const k = `${c.result} -> ${c.nuevoResult}`;
  porTransicion[k] = (porTransicion[k] || 0) + 1;
}
console.log('\nCambios de resultado:');
for (const [k, n] of Object.entries(porTransicion).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(22)} ${n}`);
}

console.log('\nEjemplos:');
for (const c of cambios.slice(0, 6)) {
  console.log(`  #${c.id} ${String(c.selection).slice(0, 22).padEnd(22)} ${c.final_score} -> ${c.score_actual}  (${c.result} -> ${c.nuevoResult})`);
}

if (!APPLY) {
  console.log('\nSIMULACRO: no se escribió nada. Repite con --apply.');
  process.exit(0);
}

const upd = db.prepare(`UPDATE rejected_picks SET result = ?, final_score = ?, settled_ts = ? WHERE id = ?`);
const now = new Date().toISOString();
db.transaction(list => { for (const c of list) upd.run(c.nuevoResult, c.score_actual, now, c.id); })(cambios);

console.log(`\nAPLICADO: ${cambios.length} filas corregidas.`);
const post = db.prepare(`
  SELECT reject_rule, COUNT(*) n, SUM(result='win') w,
         SUM(CASE WHEN result='win' THEN odd_decimal-1 ELSE -1 END) pl
  FROM rejected_picks WHERE result IN ('win','loss') GROUP BY reject_rule ORDER BY n DESC
`).all();
console.log('\nGrupo de control DESPUÉS de reparar:');
for (const p of post) {
  console.log(`  ${p.reject_rule.padEnd(20)} N=${String(p.n).padStart(4)}  WR=${(p.w / p.n * 100).toFixed(1)}%  ROI=${(p.pl / p.n * 100 >= 0 ? '+' : '') + (p.pl / p.n * 100).toFixed(1)}%`);
}
