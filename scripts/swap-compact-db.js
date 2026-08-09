/**
 * Intercambia snapshots.db por la copia compactada (snapshots_compact.db).
 *
 * NO se ejecuta automáticamente al terminar vacuum-compact.js: requiere que
 * el bot esté detenido (el runner de scripts/run-bot.cmd lo relanzará solo,
 * así que basta con matar el proceso node del bot antes de correr esto).
 *
 * Pasos:
 *  1. Verifica que snapshots_compact.db exista y que vacuum-compact.js haya
 *     confirmado que los conteos coinciden (no lo revalida aquí — confía en
 *     que se corrió antes a mano).
 *  2. Mueve snapshots.db (+ -wal, -shm si existen) a snapshots_pre_vacuum_<ts>.db*
 *     como respaldo, NO se borra.
 *  3. Mueve snapshots_compact.db a snapshots.db.
 *
 * Uso: node scripts/swap-compact-db.js
 */
const path = require('path');
const fs = require('fs');

const DIR = path.join(__dirname, '..');
const LIVE = path.join(DIR, 'snapshots.db');
const COMPACT = path.join(DIR, 'snapshots_compact.db');

if (!fs.existsSync(COMPACT)) {
  console.error('No existe snapshots_compact.db. Corre primero scripts/vacuum-compact.js.');
  process.exit(1);
}

const ts = new Date().toISOString().replace(/[:.]/g, '-');
const backupBase = path.join(DIR, `snapshots_pre_vacuum_${ts}.db`);

console.log('Respaldando el archivo en vivo (NO se borra, queda como backup)...');
for (const ext of ['', '-wal', '-shm']) {
  const src = LIVE + ext;
  if (fs.existsSync(src)) {
    const dst = backupBase + ext;
    fs.renameSync(src, dst);
    console.log(`  ${path.basename(src)} -> ${path.basename(dst)}`);
  }
}

console.log('Colocando la copia compactada como snapshots.db...');
fs.renameSync(COMPACT, LIVE);

console.log('\n✅ Swap completo. El backup queda en:');
console.log(`   ${backupBase}(*)`);
console.log('Arranca el bot (run-bot.cmd ya debería relanzarlo si estaba corriendo bajo el loop).');
console.log('Una vez confirmado que todo funciona bien durante un rato, borra el backup a mano.');
