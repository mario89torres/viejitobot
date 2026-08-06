require('dotenv').config();
const { db } = require('../src/db');
const { execSync } = require('child_process');

console.log('=== Buscando picks especificados para eliminación ===');

const p1 = db.prepare("SELECT * FROM picks WHERE event LIKE '%Persebaya Surabaya%'").all();
const p2 = db.prepare("SELECT * FROM picks WHERE event LIKE '%Tokio Yakult Swallows%'").all();

console.log('Pick 1 (Persebaya Surabaya):', p1);
console.log('Pick 2 (Tokio Yakult Swallows):', p2);

const stmt = db.prepare('DELETE FROM picks WHERE id = ?');

for (const r of p1) {
  stmt.run(r.id);
  console.log(`Eliminado Pick ID ${r.id}: ${r.event} - ${r.selection}`);
}

for (const r of p2) {
  stmt.run(r.id);
  console.log(`Eliminado Pick ID ${r.id}: ${r.event} - ${r.selection}`);
}

console.log('\n=== Re-exportando dataset.csv limpio ===');
try {
  const out = execSync('node scripts/export-dataset.js', { encoding: 'utf8' });
  console.log(out);
} catch (e) {
  console.error('Error exportando dataset:', e.message);
}

console.log('Proceso de eliminación completado.');
