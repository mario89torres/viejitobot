// Etapa 5: versión del cálculo de features (score_version).
// v1 = picks con f_linea saturada (bug: 82% de los picks tenían el valor 1.0)
// v2 = f_linea reescalada con compresión suave, sin saturación (2026-07-22)
// Idempotente. Los picks existentes se marcan como v1.
const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, '..', 'snapshots.db'));

function addColumn(table, col, def) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (cols.includes(col)) {
    console.log(`= ${table}.${col} ya existe`);
    return;
  }
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
  console.log(`+ ${table}.${col} agregada`);
}

addColumn('picks', 'score_version', 'INTEGER');
const info = db.prepare(`UPDATE picks SET score_version = 1 WHERE score_version IS NULL`).run();
console.log(`${info.changes} picks marcados como score_version = 1 (features de la versión con f_linea saturada).`);

const dist = db.prepare(`SELECT score_version v, COUNT(*) n FROM picks GROUP BY v`).all();
console.log('Distribución:', JSON.stringify(dist));
console.log('Migración etapa 5 completada.');
