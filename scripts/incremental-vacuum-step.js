// Un lote de incremental_vacuum: libera hasta N paginas del freelist sin
// reescribir el archivo completo. Pensado para correrse periodicamente
// (cron / tarea programada) una vez que la DB ya esta en auto_vacuum=INCREMENTAL
// (ver vacuum-incremental.js, que hace la conversion unica).
//
// Uso: node scripts/incremental-vacuum-step.js [num_paginas=20000]
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DB_FILE = process.env.DB_PATH || path.join(__dirname, '..', 'snapshots.db');
const N = Number(process.argv[2]) || 20000; // ~80MB por lote a 4096 bytes/pagina

function fmtGB(bytes) { return (bytes / 1e9).toFixed(3) + ' GB'; }

const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 30000');

const autoVacuum = db.pragma('auto_vacuum', { simple: true });
if (autoVacuum !== 2) {
  console.error(`[incr-vacuum] auto_vacuum=${autoVacuum}, no es INCREMENTAL. Corre primero scripts/vacuum-incremental.js`);
  db.close();
  process.exit(1);
}

const pageSize = db.pragma('page_size', { simple: true });
const freelistAntes = db.pragma('freelist_count', { simple: true });
const pageCountAntes = db.pragma('page_count', { simple: true });

console.log(`[incr-vacuum] freelist antes: ${freelistAntes} paginas (${fmtGB(freelistAntes * pageSize)})`);
console.log(`[incr-vacuum] liberando hasta ${N} paginas...`);

const t0 = Date.now();
db.pragma(`incremental_vacuum(${N})`);
const ms = Date.now() - t0;

const freelistDespues = db.pragma('freelist_count', { simple: true });
const pageCountDespues = db.pragma('page_count', { simple: true });
const liberadas = pageCountAntes - pageCountDespues;

console.log(`[incr-vacuum] listo en ${ms}ms`);
console.log(`[incr-vacuum] paginas del archivo: ${pageCountAntes} -> ${pageCountDespues} (${liberadas} liberadas, ${fmtGB(liberadas * pageSize)})`);
console.log(`[incr-vacuum] freelist restante: ${freelistDespues} paginas (${fmtGB(freelistDespues * pageSize)})`);
console.log(`[incr-vacuum] archivo en disco: ${fmtGB(fs.statSync(DB_FILE).size)}`);

db.close();
