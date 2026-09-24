/**
 * Crea el índice que falta en snapshots: (event_id, market, selection, ts).
 *
 * POR QUÉ. Los índices actuales son (ts) y (event_id, ts). Todas las consultas
 * calientes del sistema filtran por (event_id, market, selection): la cuota de
 * apertura y la tendencia de línea en scoreRow, y el estado en vivo de cada
 * pick en el dashboard. Con el índice actual SQLite busca el evento y luego
 * ESCANEA todas sus filas filtrando mercado y selección en memoria.
 *
 * Medido el 2026-08-28 sobre 113M filas / 18 GB:
 *   cuota de apertura   7.20 ms/llamada   (ya mitigado con un cache en memoria)
 *   tendencia de línea  3.99 ms/llamada   <- esto es lo que arregla el índice
 *   /api/live y /api/model-picks del panel hacen las mismas consultas
 *
 * CÓMO. CREATE INDEX toma un bloqueo de ESCRITURA durante todo el proceso. Con
 * el bot corriendo, sus escrituras fallarían o se quedarían esperando. Por eso
 * este script se niega a correr si detecta el bot vivo.
 *
 *   node scripts/crear-indice-snapshots.js          # comprueba y crea
 *   node scripts/crear-indice-snapshots.js --check  # solo diagnostica
 */
const { execSync } = require('child_process');
const path = require('path');
const Database = require('better-sqlite3');

const DB = path.join(__dirname, '..', 'snapshots.db');
const NOMBRE = 'idx_snapshots_ems';
const SQL = `CREATE INDEX ${NOMBRE} ON snapshots(event_id, market, selection, ts)`;
const soloCheck = process.argv.includes('--check');

function botVivo() {
  try {
    const out = execSync(
      'powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name=\'node.exe\'\\" | Where-Object { $_.CommandLine -like \'*bot.js*\' } | Measure-Object | Select-Object -ExpandProperty Count"',
      { encoding: 'utf8', timeout: 30000 });
    return Number(String(out).trim()) > 0;
  } catch {
    return null; // no se pudo comprobar: se avisa y se decide fuera
  }
}

const db = new Database(DB, { readonly: soloCheck });
const yaEsta = db.prepare(
  `SELECT 1 FROM sqlite_master WHERE type='index' AND name=?`).get(NOMBRE);

console.log('índices actuales en snapshots:');
for (const i of db.prepare(
  `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='snapshots'`).all()) {
  console.log('  ', i.name);
}

const plan = db.prepare(
  `EXPLAIN QUERY PLAN SELECT odd_decimal FROM snapshots
   WHERE event_id=1 AND market='x' AND selection='y' AND suspended=0 ORDER BY ts ASC`).all();
console.log('\nplan actual de la consulta caliente:');
plan.forEach(r => console.log('  ', r.detail));

if (yaEsta) { console.log(`\n${NOMBRE} ya existe. Nada que hacer.`); process.exit(0); }
if (soloCheck) { console.log(`\n${NOMBRE} NO existe. Ejecuta sin --check para crearlo.`); process.exit(0); }

const vivo = botVivo();
if (vivo === true) {
  console.error('\n⛔ El bot está corriendo. CREATE INDEX bloquearía sus escrituras.');
  console.error('   Párala primero (/reboot no basta: hay que dejarlo detenido) y reintenta.');
  process.exit(1);
}
if (vivo === null) console.warn('\n⚠️  No se pudo comprobar si el bot corre. Asegúrate de que está parado.');

console.log(`\ncreando ${NOMBRE}… (113M filas: esto tarda, no lo interrumpas)`);
const t0 = Date.now();
db.exec(SQL);
const min = ((Date.now() - t0) / 60000).toFixed(1);
console.log(`✓ creado en ${min} min`);

console.log('\nplan DESPUÉS:');
db.prepare(`EXPLAIN QUERY PLAN SELECT odd_decimal FROM snapshots
  WHERE event_id=1 AND market='x' AND selection='y' AND suspended=0 ORDER BY ts ASC`)
  .all().forEach(r => console.log('  ', r.detail));
console.log('\nRecuerda: ANALYZE ayuda al planificador a usarlo bien.');
db.exec('ANALYZE snapshots');
console.log('ANALYZE hecho.');
