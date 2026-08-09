/**
 * Compacta snapshots.db a un archivo nuevo via VACUUM INTO, SIN tocar el
 * original ni bloquear al bot en vivo.
 *
 * Se abre en modo readonly a propósito: VACUUM INTO solo LEE el origen y
 * ESCRIBE el destino, así que no necesita el lock de escritura. Bajo WAL,
 * lectores y el escritor en vivo coexisten sin bloquearse mutuamente — a
 * diferencia de la poda de hoy, que congeló el bot 57 min porque corrió
 * DENTRO del mismo proceso/conexión que el sampler (single-threaded: nada más
 * podía correr mientras el DELETE síncrono tenía el hilo).
 *
 * No hace el swap final: eso requiere parar el bot un momento y se hace
 * aparte, después de verificar la copia.
 *
 * Uso: node scripts/vacuum-compact.js
 */
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const SRC = path.join(__dirname, '..', 'snapshots.db');
const DEST = path.join(__dirname, '..', 'snapshots_compact.db');

if (fs.existsSync(DEST)) {
  console.log(`Ya existe ${path.basename(DEST)} de una corrida anterior — se borra antes de empezar.`);
  fs.unlinkSync(DEST);
}

console.log(`Origen: ${SRC} (${(fs.statSync(SRC).size / 1e9).toFixed(2)} GB)`);
console.log('Abriendo en modo readonly (no compite por el lock de escritura)...');

const db = new Database(SRC, { readonly: true, timeout: 30000 });

const t0 = Date.now();
console.log('Iniciando VACUUM INTO — esto puede tardar, sin ETA confiable dado el I/O de hoy...');
db.exec(`VACUUM INTO '${DEST.replace(/\\/g, '/')}'`);
const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
console.log(`VACUUM INTO completo en ${elapsed}s`);

db.close();

// ── Verificación básica antes de proponer el swap ──
const orig = new Database(SRC, { readonly: true });
const compact = new Database(DEST, { readonly: true });

const tables = ['snapshots', 'picks', 'subscribers', 'sharp_budget', 'alerted_events'];
console.log('\nVerificación de conteos (origen vs compactado):');
let allMatch = true;
for (const t of tables) {
  const o = orig.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n;
  const c = compact.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n;
  const ok = o === c;
  if (!ok) allMatch = false;
  console.log(`  ${t.padEnd(16)} origen=${o.toLocaleString().padStart(12)}  compactado=${c.toLocaleString().padStart(12)}  ${ok ? 'OK' : '¡¡DIFIEREN!!'}`);
}
orig.close();
compact.close();

const destSize = fs.statSync(DEST).size;
console.log(`\nTamaño compactado: ${(destSize / 1e9).toFixed(2)} GB`);
console.log(allMatch
  ? '\n✅ Los conteos coinciden. Listo para el swap (ver scripts/swap-compact-db.js).'
  : '\n⚠️  LOS CONTEOS NO COINCIDEN. No usar este archivo — investigar antes de continuar.');
