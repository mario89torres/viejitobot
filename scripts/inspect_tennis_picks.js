require('dotenv').config();
const { db } = require('../src/db');
const { gradePick, parsePick } = require('../src/markets');

console.log('=== Picks de Tenis en snapshots.db ===');
const tennisPicks = db.prepare(`
  SELECT id, ts, event, sport, market, selection, odd_decimal, conf, result, final_score, settled_ts
  FROM picks
  WHERE sport LIKE '%Tenis%' OR sport LIKE '%Tennis%'
  ORDER BY id DESC
  LIMIT 20
`).all();

if (!tennisPicks.length) {
  console.log('No se encontraron picks de Tenis en los últimos registros.');
} else {
  for (const p of tennisPicks) {
    console.log(`ID: ${p.id} | ${p.event} (${p.sport})`);
    console.log(`   Mercado: ${p.market} -> ${p.selection} @ ${p.odd_decimal}`);
    console.log(`   Result BD: ${p.result} | Final Score: "${p.final_score}"`);
    console.log(`   Parsed:`, parsePick(p));
    const regraded = gradePick(p, p.final_score);
    console.log(`   Regraded con gradePick:`, regraded);
    console.log('--------------------------------------------------');
  }
}
