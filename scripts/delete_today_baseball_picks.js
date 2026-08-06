require('dotenv').config();
const { db } = require('../src/db');
const { execSync } = require('child_process');

console.log('=== Buscando picks de Béisbol del día de hoy (2026-08-04) ===');

// Buscar picks del día de hoy en hora CDMX (2026-08-04)
const todayPicks = db.prepare(`
  SELECT id, ts, event, sport, market, selection, odd_decimal, conf, result, final_score, stake
  FROM picks
  WHERE (sport LIKE '%Béisbol%' OR sport LIKE '%Beisbol%' OR sport LIKE '%Baseball%')
    AND ts >= '2026-08-04T00:00:00.000Z'
`).all();

console.log(`Se encontraron ${todayPicks.length} picks de Béisbol de hoy:`);
for (const p of todayPicks) {
  console.log(`ID: ${p.id} | ${p.ts} | ${p.event} (${p.sport})`);
  console.log(`   Mercado: ${p.market} -> ${p.selection} @ ${p.odd_decimal} | Result: ${p.result} | Stake: ${p.stake}u`);
}

if (todayPicks.length) {
  const stmt = db.prepare('DELETE FROM picks WHERE id = ?');
  for (const p of todayPicks) {
    stmt.run(p.id);
    console.log(`Eliminado Pick ID ${p.id}: ${p.event}`);
  }
}

console.log('\n=== Re-exportando dataset.csv limpio ===');
try {
  const out = execSync('node scripts/export-dataset.js', { encoding: 'utf8' });
  console.log(out);
} catch (e) {
  console.error('Error exportando dataset:', e.message);
}

console.log('Proceso completado.');
