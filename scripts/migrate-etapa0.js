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

addColumn('snapshots', 'suspended', 'INTEGER NOT NULL DEFAULT 0');
addColumn('picks', 'result_source', 'TEXT');
addColumn('picks', 'closing_odd_decimal', 'REAL');
addColumn('picks', 'closing_ts', 'TEXT');
addColumn('picks', 'sharp_closing_odd', 'REAL'); // reservada para cierre "sharp" externo futuro

console.log('Migración etapa 0 completada.');
