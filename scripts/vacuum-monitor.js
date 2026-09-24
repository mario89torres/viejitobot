// Monitorea un VACUUM en curso desde OTRO proceso: better-sqlite3 es
// sincrono, asi que el proceso que corre VACUUM no puede reportar su propio
// progreso mientras bloquea. SQLite construye el resultado del VACUUM en un
// archivo temporal junto al original (mismo directorio) y al final lo
// intercambia — este script solo mira cuanto ha crecido ese archivo temporal
// contra el tamano esperado.
//
// Uso: node scripts/vacuum-monitor.js [intervalo_ms]
const path = require('path');
const fs = require('fs');

const DB_FILE = process.env.DB_PATH || path.join(__dirname, '..', 'snapshots.db');
const DIR = path.dirname(DB_FILE);
const BASENAME = path.basename(DB_FILE);
const intervalMs = Number(process.argv[2]) || 3000;

let objetivoBytes = null;
try { objetivoBytes = fs.statSync(DB_FILE).size; } catch {}

function candidatosTemp() {
  return fs.readdirSync(DIR)
    .filter(f => f !== BASENAME && f !== `${BASENAME}-wal` && f !== `${BASENAME}-shm` && f !== `${BASENAME}-journal`)
    .filter(f => f.startsWith(BASENAME) || f.includes('etilqs') || f.endsWith('.db-vacuum'))
    .map(f => path.join(DIR, f));
}

console.log(`[monitor] vigilando ${DIR} cada ${intervalMs}ms (tamano original: ${(objetivoBytes / 1e9).toFixed(2)} GB)`);

const t0 = Date.now();
const timer = setInterval(() => {
  const candidatos = candidatosTemp();
  const transcurrido = ((Date.now() - t0) / 1000).toFixed(0);
  if (!candidatos.length) {
    console.log(`[monitor] +${transcurrido}s: sin archivo temporal visible todavia (o el VACUUM ya termino)`);
    return;
  }
  for (const c of candidatos) {
    try {
      const size = fs.statSync(c).size;
      const pct = objetivoBytes ? ((size / objetivoBytes) * 100).toFixed(1) : '?';
      console.log(`[monitor] +${transcurrido}s: ${path.basename(c)} = ${(size / 1e9).toFixed(2)} GB (~${pct}% del tamano original)`);
    } catch {}
  }
}, intervalMs);

process.on('SIGINT', () => { clearInterval(timer); process.exit(0); });
