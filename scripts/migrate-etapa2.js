// Etapa 2: persistencia de los 4 factores crudos del score por pick y de los
// scores heurístico/aprendido (modo shadow). Idempotente.
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

addColumn('picks', 'f_prob_justa', 'REAL');
addColumn('picks', 'f_avance', 'REAL');
addColumn('picks', 'f_situacion', 'REAL');
addColumn('picks', 'f_linea', 'REAL');
addColumn('picks', 'conf_heuristic', 'REAL');
addColumn('picks', 'conf_learned', 'REAL');

console.log('Migración etapa 2 completada.');
