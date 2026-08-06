require('dotenv').config();
const { db } = require('../src/db');
const { execSync } = require('child_process');

console.log('=== Eliminando los 4 picks solicitados por el usuario ===');

const targets = [
  { event: 'Strasbourg vs. SV Elversberg', sel: 'Menos de 5.5' },
  { event: 'FC Sydkysten vs. Ishoej IF', sel: 'Ishoej IF' },
  { event: 'Rodina Moscow vs. Rubin Kazan', sel: 'Menos de 3.5' },
  { event: 'Mjällby vs. SK Slovan Bratislava', sel: 'Mjällby' },
];

const allPicks = db.prepare('SELECT id, ts, event, sport, market, selection, odd_decimal, result, stake FROM picks').all();

const matchedIds = [];
for (const t of targets) {
  const match = allPicks.find(p => p.event.includes(t.event.split(' vs. ')[0]) && (p.selection.includes(t.sel) || t.event.includes(p.event)));
  if (match) {
    matchedIds.push(match);
    console.log(`Encontrado Pick ID ${match.id}: ${match.event} | ${match.market} -> ${match.selection} @ ${match.odd_decimal} (${match.result})`);
  } else {
    console.log(`ADVERTENCIA: No se encontró coincidencia para ${t.event}`);
  }
}

if (matchedIds.length) {
  const stmt = db.prepare('DELETE FROM picks WHERE id = ?');
  for (const p of matchedIds) {
    stmt.run(p.id);
    console.log(`Eliminado con éxito Pick ID ${p.id}: ${p.event}`);
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
