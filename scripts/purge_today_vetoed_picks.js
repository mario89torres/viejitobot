require('dotenv').config();
const { db } = require('../src/db');
const { isExcluded, excludedSports, isBlockedOver, isBlockedMarket } = require('../src/confidence');
const { execSync } = require('child_process');

console.log('=== Verificando todos los picks del día de hoy contra los vetos activos ===');

const excl = excludedSports();
const todayPicks = db.prepare(`
  SELECT id, ts, event, sport, market, selection, odd_decimal, conf, result, final_score, stake
  FROM picks
  WHERE ts >= '2026-08-04T00:00:00.000Z'
`).all();

console.log(`Total picks registrados hoy: ${todayPicks.length}`);

const targetPicks = todayPicks.filter(p => {
  if (isExcluded(p.sport, excl)) return true;
  if (isBlockedOver(p)) return true;
  if (isBlockedMarket(p)) return true;
  return false;
});

console.log(`Picks de hoy que violan alguna regla de veto: ${targetPicks.length}`);

for (const p of targetPicks) {
  console.log(`ID: ${p.id} | ${p.ts} | ${p.event} (${p.sport})`);
  console.log(`   Mercado: ${p.market} -> ${p.selection} @ ${p.odd_decimal} | Result: ${p.result} | Stake: ${p.stake}u`);
}

if (targetPicks.length) {
  const stmt = db.prepare('DELETE FROM picks WHERE id = ?');
  for (const p of targetPicks) {
    stmt.run(p.id);
    console.log(`Eliminado Pick ID ${p.id}: ${p.event} (${p.market}: ${p.selection})`);
  }
}

console.log('\n=== Re-exportando dataset.csv limpio ===');
try {
  const out = execSync('node scripts/export-dataset.js', { encoding: 'utf8' });
  console.log(out);
} catch (e) {
  console.error('Error exportando dataset:', e.message);
}

console.log('Proceso de purga del reporte de hoy completado.');
