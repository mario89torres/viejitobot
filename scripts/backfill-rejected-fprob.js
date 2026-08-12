/**
 * Rellena f_prob_justa en rejected_picks, que está NULL en TODAS las filas
 * desde que existe la tabla (2026-08-09).
 *
 * CAUSA RAÍZ (arreglada en bot.js): captureRejectedControls leía `r.fProbJusta`
 * del objeto que devuelve scoreRow, pero scoreRow devuelve esa probabilidad
 * como `base`, no `fProbJusta`. El nombre nunca hizo match -> undefined ->
 * NULL en la columna, siempre. Persiste en filas nuevas hasta que el bot
 * reinicie con el fix; este script recupera lo ya escrito.
 *
 * CÓMO SE RECUPERA: f_prob_justa es la probabilidad de-viggeada (Shin) de la
 * selección en el momento de la captura. Se puede recalcular desde snapshots
 * porque ahí están TODOS los outcomes del mercado — es la misma fuente que usa
 * devigProbAt() en metrics.js.
 *
 * Con un matiz: `rejected_picks.ts` es el instante en que bot.js procesó el
 * ciclo (`new Date().toISOString()`), NO el ts exacto de un snapshot — así que
 * devigProbAt(ts) nunca matchea directo (verificado: 0/20). Se usa el snapshot
 * MÁS CERCANO en el tiempo para ese evento+mercado en su lugar.
 *
 * Uso:  node scripts/backfill-rejected-fprob.js          (simulacro)
 *       node scripts/backfill-rejected-fprob.js --apply  (escribe)
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const Database = require('better-sqlite3');
const { devig } = require('../src/devig');

const APPLY = process.argv.includes('--apply');
const db = new Database(path.join(__dirname, '..', 'snapshots.db'));

// Acotado a una ventana de ±10 min alrededor de ts, para poder usar el índice
// (event_id, ts) en vez de escanear todos los snapshots del evento y ordenar
// por distancia — sin la ventana, esto tardaba minutos sobre 2500 filas.
//
// Los límites se calculan en JS y se pasan como strings ISO, en el MISMO
// formato que la columna `ts` ('...T15:52:12.080Z'). Dos intentos previos
// fallaron:
//   - datetime(?,'-10 minutes') devuelve 'AAAA-MM-DD HH:MM:SS' con ESPACIO en
//     vez de 'T': comparación de cadenas rota, 0 resultados siempre.
//   - julianday(ts) en el WHERE sí compara bien, pero aplicar una función
//     sobre la columna invalida el índice (event_id, ts) y vuelve a escanear
//     todo — lento otra vez.
// Con bounds ya en formato ISO, `ts BETWEEN ? AND ?` es una comparación de
// cadena pura sobre la columna cruda: usa el índice y es rápido.
const nearestTsStmt = db.prepare(`
  SELECT ts FROM snapshots
  WHERE event_id = ? AND market = ? AND ts BETWEEN ? AND ?
  ORDER BY ABS(julianday(ts) - julianday(?)) LIMIT 1
`);
function isoOffset(ts, minutes) {
  return new Date(Date.parse(ts) + minutes * 60000).toISOString();
}
const marketAtStmt = db.prepare(`
  SELECT selection, odd_decimal FROM snapshots
  WHERE event_id = ? AND market = ? AND ts = ? AND suspended = 0
`);

function fProbAt(eventId, market, ts, selection) {
  const nearest = nearestTsStmt.get(eventId, market, isoOffset(ts, -10), isoOffset(ts, 10), ts);
  if (!nearest) return null;
  const rows = marketAtStmt.all(eventId, market, nearest.ts);
  if (rows.length < 2) return null;
  const i = rows.findIndex(r => r.selection === selection);
  if (i < 0 || rows.some(r => !(r.odd_decimal > 1))) return null;
  return devig(rows.map(r => r.odd_decimal), 'shin')[i];
}

const rows = db.prepare(`
  SELECT id, event_id, market, selection, ts FROM rejected_picks WHERE f_prob_justa IS NULL
`).all();

let ok = 0, sinMercado = 0;
const updates = [];
for (const r of rows) {
  const p = fProbAt(r.event_id, r.market, r.ts, r.selection);
  if (p == null) { sinMercado++; continue; }
  updates.push({ id: r.id, p });
  ok++;
}

console.log(`Filas sin f_prob_justa: ${rows.length}`);
console.log(`  recuperables (mercado con >=2 outcomes en snapshots cercanos): ${ok}`);
console.log(`  sin datos suficientes (mercado de 1 solo lado, ej. Empate No Acción a veces): ${sinMercado}`);
console.log(`  cobertura: ${(ok / rows.length * 100).toFixed(1)}%`);

if (!APPLY) {
  console.log('\nSIMULACRO: no se escribió nada. Repite con --apply.');
  process.exit(0);
}

const upd = db.prepare(`UPDATE rejected_picks SET f_prob_justa = ? WHERE id = ?`);
db.transaction(list => { for (const u of list) upd.run(u.p, u.id); })(updates);
console.log(`\nAPLICADO: ${updates.length} filas actualizadas.`);

const check = db.prepare(`SELECT COUNT(*) n, SUM(f_prob_justa IS NOT NULL) conFp FROM rejected_picks`).get();
console.log(`Estado final: ${check.conFp} de ${check.n} filas con f_prob_justa.`);
