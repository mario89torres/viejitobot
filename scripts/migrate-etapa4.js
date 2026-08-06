// Etapa 4: momio sharp de referencia, edge estimado y estado del matching.
// (sharp_closing_odd ya existe desde la Etapa 0). Idempotente.
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

addColumn('picks', 'sharp_entry_odd', 'REAL');
addColumn('picks', 'sharp_source', 'TEXT');
addColumn('picks', 'sharp_event_id', 'TEXT');    // "<sport_key>|<event_id>" de The Odds API
addColumn('picks', 'sharp_closing_market', 'TEXT'); // JSON {bookmaker, target, outcomes:[{name,price}], idx}
addColumn('picks', 'sharp_match', 'TEXT');       // matched | unmatched | no_key | no_coverage | unsupported_market
addColumn('picks', 'edge', 'REAL');              // conf·odd_decimal − 1 al momento de emitir

console.log('Migración etapa 4 completada.');
