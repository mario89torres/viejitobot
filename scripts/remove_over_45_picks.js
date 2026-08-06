require('dotenv').config();
const { db } = require('../src/db');
const { parsePick } = require('../src/markets');
const { isOverPick } = require('../src/confidence');
const { execSync } = require('child_process');

console.log('=== Buscando picks "Más de" (Over) con línea >= 4.5 del día de hoy ===');

const todayPicks = db.prepare(`
  SELECT id, ts, event, sport, market, selection, odd_decimal, conf, result, final_score, stake
  FROM picks
  WHERE ts >= '2026-08-04T00:00:00.000Z'
`).all();

const targetPicks = todayPicks.filter(p => {
  const parsed = parsePick(p);
  if (parsed && parsed.type === 'total' && parsed.over) {
    if (parsed.line !== undefined && parsed.line !== null && parsed.line >= 4.5) {
      return true;
    }
  }
  return false;
});

console.log(`Se encontraron ${targetPicks.length} picks de hoy "Más de" con línea >= 4.5:`);
for (const p of targetPicks) {
  const parsed = parsePick(p);
  console.log(`ID: ${p.id} | ${p.ts} | ${p.event} (${p.sport})`);
  console.log(`   Mercado: ${p.market} -> ${p.selection} (Línea ${parsed.line}) @ ${p.odd_decimal} | Result: ${p.result} | Stake: ${p.stake}u`);
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

console.log('Proceso completado.');
