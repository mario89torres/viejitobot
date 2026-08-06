require('dotenv').config();
const { db } = require('../src/db');
const { execSync } = require('child_process');

console.log('=== Eliminando registros solicitados ===');

const p1 = db.prepare("SELECT * FROM picks WHERE event LIKE '%Kufu Hayate%'").all();
const p2 = db.prepare("SELECT * FROM picks WHERE event LIKE '%Stian Klaassen%'").all();

console.log('Pick 1 encontrado:', p1);
console.log('Pick 2 encontrado:', p2);

const stmt = db.prepare('DELETE FROM picks WHERE id = ?');

for (const r of p1) {
  stmt.run(r.id);
  console.log(`Eliminado Pick ID ${r.id}: ${r.event} - ${r.selection}`);
}

for (const r of p2) {
  stmt.run(r.id);
  console.log(`Eliminado Pick ID ${r.id}: ${r.event} - ${r.selection}`);
}

console.log('\nExportando dataset.csv limpio...');
try {
  const out = execSync('node scripts/export-dataset.js', { encoding: 'utf8' });
  console.log(out);
} catch (e) {
  console.error('Error exportando dataset:', e.message);
}

console.log('Proceso de eliminación completado exitosamente.');
