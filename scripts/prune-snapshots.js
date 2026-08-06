// Poda snapshots con más de RETENTION_DAYS (default 7), conservando SIEMPRE
// los de eventos que tienen picks (sus mercados de entrada/cierre alimentan el
// CLV histórico). El espacio liberado se reutiliza (el archivo no encoge sin
// VACUUM, pero deja de crecer). Se puede correr a mano o desde el bot (diario).
const { pruneSnapshots } = require('../src/db');

const days = Number(process.env.RETENTION_DAYS || 7);
const { deleted, cutoff } = pruneSnapshots(days);
console.log(`Poda: ${deleted} snapshots anteriores a ${cutoff} eliminados (retención ${days} días, eventos con picks preservados).`);
