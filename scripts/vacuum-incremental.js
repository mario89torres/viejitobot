// Conversion UNICA a auto_vacuum=INCREMENTAL + VACUUM completo.
//
// Por que hace falta un VACUUM completo aqui, si el pedido era "por partes":
// auto_vacuum solo cambia de modo cuando se reescribe el archivo entero
// (asi lo documenta SQLite). Esta es la unica vez que se paga el costo
// completo — de aqui en adelante, `PRAGMA incremental_vacuum(N)` libera
// paginas en lotes chicos sin bloquear tanto ni reescribir todo el archivo.
//
// Uso: node scripts/vacuum-incremental.js
// (correr con el bot y el dashboard APAGADOS — ninguna otra conexion debe
// tener el archivo abierto)
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DB_FILE = process.env.DB_PATH || path.join(__dirname, '..', 'snapshots.db');

function fmtGB(bytes) { return (bytes / 1e9).toFixed(2) + ' GB'; }

const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');

const pageSize = db.pragma('page_size', { simple: true });
const pageCountAntes = db.pragma('page_count', { simple: true });
const freelistAntes = db.pragma('freelist_count', { simple: true });
const autoVacuumAntes = db.pragma('auto_vacuum', { simple: true });

console.log(`[vacuum] archivo: ${DB_FILE}`);
console.log(`[vacuum] auto_vacuum actual: ${autoVacuumAntes} (0=NONE, 1=FULL, 2=INCREMENTAL)`);
console.log(`[vacuum] antes: ${pageCountAntes} paginas, ${freelistAntes} libres, tamano real ${fmtGB(pageCountAntes * pageSize)}, reclamable ${fmtGB(freelistAntes * pageSize)}`);

if (autoVacuumAntes === 2) {
  console.log('[vacuum] ya esta en modo INCREMENTAL, no hace falta convertir. Usa incremental-vacuum-step.js');
  db.close();
  process.exit(0);
}

db.pragma('auto_vacuum = INCREMENTAL');
console.log('[vacuum] auto_vacuum = INCREMENTAL solicitado, ejecutando VACUUM completo (unica vez)...');

const t0 = Date.now();
db.exec('VACUUM;');
const ms = Date.now() - t0;

const pageCountDespues = db.pragma('page_count', { simple: true });
const freelistDespues = db.pragma('freelist_count', { simple: true });
const autoVacuumDespues = db.pragma('auto_vacuum', { simple: true });

console.log(`[vacuum] listo en ${(ms / 1000).toFixed(1)}s`);
console.log(`[vacuum] despues: ${pageCountDespues} paginas, ${freelistDespues} libres, tamano real ${fmtGB(pageCountDespues * pageSize)}`);
console.log(`[vacuum] auto_vacuum ahora: ${autoVacuumDespues}`);
console.log(`[vacuum] archivo en disco: ${fmtGB(fs.statSync(DB_FILE).size)}`);

db.close();
