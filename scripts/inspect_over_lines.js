require('dotenv').config();
const { db } = require('../src/db');
const { parsePick } = require('../src/markets');

console.log('=== Inspeccionando líneas de picks "Más de" (Over) en la base de datos ===');

const overPicks = db.prepare(`
  SELECT id, ts, event, sport, market, selection, odd_decimal, conf, result, final_score, stake
  FROM picks
  WHERE selection LIKE '%Más de%' OR selection LIKE '%Mas de%' OR market LIKE '%Total%'
`).all();

console.log(`Total picks con Over/Total: ${overPicks.length}`);

const parsedOver = overPicks.map(p => {
  const parsed = parsePick(p);
  return { ...p, parsed };
}).filter(p => p.parsed && p.parsed.type === 'total' && p.parsed.over);

console.log(`Total picks de tipo Over (Más de): ${parsedOver.length}`);

const lineDistribution = {};
for (const p of parsedOver) {
  const line = p.parsed.line;
  lineDistribution[line] = (lineDistribution[line] || 0) + 1;
}

console.log('\nDistribución por línea de Total (Más de):');
console.table(lineDistribution);

console.log('\nDesglose de resultados por rango de línea para Over:');
const range1 = parsedOver.filter(p => p.parsed.line < 4.5);
const range2 = parsedOver.filter(p => p.parsed.line >= 4.5);

const winRate = arr => arr.length ? (100 * arr.filter(p => p.result === 'win').length / arr.length).toFixed(1) + '%' : '0%';

console.log(`Líneas < 4.5 (ej. Over 0.5, 1.5, 2.5, 3.5): N=${range1.length} | Win Rate: ${winRate(range1)}`);
console.log(`Líneas >= 4.5 (ej. Over 4.5, 5.5, 6.5, 7.5, ...): N=${range2.length} | Win Rate: ${winRate(range2)}`);
