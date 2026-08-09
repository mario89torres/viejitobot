/**
 * Reetiqueta como 'push' los picks que quedaron en 'unknown' siendo ANULACIONES.
 *
 * `settleWith` hacía `result || 'unknown'`, y gradePick devuelve null con dos
 * significados distintos: apuesta anulada (empate en Empate No Acción, marcador
 * justo en la línea de un total, hándicap en cero) y mercado ininterpretable.
 * Al colapsarlos, 152 picks perfectamente conocidos quedaron marcados como si
 * no se supiera qué pasó.
 *
 * Solo toca filas donde parsePick SÍ entiende el mercado y hay marcador válido;
 * las de mercados no parseables ("Quinto Gol", "Primer gol 1"…) se quedan en
 * 'unknown', que es lo correcto para ellas.
 *
 * No cambia ninguna métrica de dinero: un push devuelve el stake, así que su
 * P/L era y sigue siendo 0. Lo que arregla es la HONESTIDAD de los datos —
 * distinguir "se anuló" de "no lo sé" — y que el dashboard pueda mostrarlas
 * como ⚪ NULO en vez de UNKNOWN.
 *
 * Uso:  node scripts/backfill-push-results.js          (simulacro)
 *       node scripts/backfill-push-results.js --apply  (escribe)
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const Database = require('better-sqlite3');
const { gradePick, parsePick } = require('../src/markets');

const APPLY = process.argv.includes('--apply');
const db = new Database(path.join(__dirname, '..', 'snapshots.db'));

const rows = db.prepare(`
  SELECT id, event, sport, market, selection, final_score
  FROM picks WHERE result = 'unknown'
`).all();

const push = [];
const sigueUnknown = {};
for (const r of rows) {
  const score = String(r.final_score || '');
  if (!/^\d+-\d+$/.test(score)) { sigueUnknown['sin marcador válido'] = (sigueUnknown['sin marcador válido'] || 0) + 1; continue; }
  if (!parsePick(r)) { sigueUnknown[r.market] = (sigueUnknown[r.market] || 0) + 1; continue; }
  // gradePick no-null aquí sería un bug distinto (se habría podido graduar);
  // se deja fuera para no reescribir resultados con criterio nuevo.
  if (gradePick(r, score) !== null) { sigueUnknown['graduable (revisar aparte)'] = (sigueUnknown['graduable (revisar aparte)'] || 0) + 1; continue; }
  push.push(r);
}

console.log(`picks en 'unknown': ${rows.length}`);
console.log(`  -> a reetiquetar como 'push': ${push.length}`);
console.log(`  -> se quedan en 'unknown'   : ${rows.length - push.length}`);
for (const [k, n] of Object.entries(sigueUnknown).sort((a, b) => b[1] - a[1]).slice(0, 8)) {
  console.log(`       ${String(n).padStart(4)}  ${k}`);
}

const porMercado = {};
for (const r of push) porMercado[r.market] = (porMercado[r.market] || 0) + 1;
console.log('\nreetiquetados por mercado:');
for (const [m, n] of Object.entries(porMercado).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(4)}  ${m}`);
}
console.log('\nejemplos:');
for (const r of push.slice(0, 3)) console.log(`  #${r.id}  ${r.event} | ${r.selection} | ${r.final_score}`);

if (!APPLY) {
  console.log('\nSIMULACRO: no se escribió nada. Repite con --apply para aplicar.');
  process.exit(0);
}

const upd = db.prepare(`UPDATE picks SET result = 'push' WHERE id = ?`);
const tx = db.transaction(list => { for (const r of list) upd.run(r.id); });
tx(push);

const check = db.prepare(`SELECT result, COUNT(*) n FROM picks GROUP BY result ORDER BY n DESC`).all();
console.log('\nAPLICADO. Reparto final de result:');
for (const c of check) console.log(`  ${String(c.result || '(null)').padEnd(10)} ${c.n}`);
