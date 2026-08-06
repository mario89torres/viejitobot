// Unidades de apuesta por pick (2026-07-29).
//
// Cada pick emitido guarda cuántas unidades se le asignan y con qué criterio.
// Los picks anteriores quedan con stake NULL: no se les inventa una unidad
// retroactiva porque nunca se decidió una, y rellenarla ensuciaría la
// comparación entre lo arriesgado y lo ganado.
const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, '..', 'snapshots.db'));

function addColumn(table, col, def) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (cols.includes(col)) { console.log(`= ${table}.${col} ya existe`); return; }
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
  console.log(`+ ${table}.${col} agregada`);
}

addColumn('picks', 'stake', 'REAL');        // unidades arriesgadas
addColumn('picks', 'stake_mode', 'TEXT');   // flat | kelly | half_kelly

const conStake = db.prepare('SELECT COUNT(*) n FROM picks WHERE stake IS NOT NULL').get().n;
const sinStake = db.prepare('SELECT COUNT(*) n FROM picks WHERE stake IS NULL').get().n;
console.log(`Picks con unidad asignada: ${conStake} | sin asignar (anteriores a hoy): ${sinStake}`);
console.log('Migración de unidades completada.');
