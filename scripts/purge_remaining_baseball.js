require('dotenv').config();
const { db } = require('../src/db');
const { execSync } = require('child_process');

console.log('=== Eliminando picks de Béisbol restantes de la base de datos ===');
const baseballPicks = db.prepare(`
  SELECT id, event, sport, market, selection
  FROM picks
  WHERE sport LIKE '%Béisbol%' OR sport LIKE '%Beisbol%' OR sport LIKE '%Baseball%'
`).all();

console.log(`Picks de Béisbol encontrados en BD: ${baseballPicks.length}`);

if (baseballPicks.length) {
  const stmt = db.prepare('DELETE FROM picks WHERE id = ?');
  for (const p of baseballPicks) {
    stmt.run(p.id);
    console.log(`Eliminado Pick ID ${p.id}: ${p.event} (${p.market})`);
  }
}

console.log('\nRe-exportando dataset.csv...');
try {
  const out = execSync('node scripts/export-dataset.js', { encoding: 'utf8' });
  console.log(out);
} catch (e) {
  console.error('Error exportando dataset:', e.message);
}

console.log('Proceso de purgado de Béisbol completado.');
