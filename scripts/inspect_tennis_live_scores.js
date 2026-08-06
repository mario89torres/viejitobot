require('dotenv').config();
const { db } = require('../src/db');

console.log('=== Muestra de marcadores en vivo de Tenis en snapshots.db ===');
const tennisSnapshots = db.prepare(`
  SELECT DISTINCT sport, score, market
  FROM snapshots
  WHERE (sport LIKE '%Tenis%' OR sport LIKE '%Tennis%') AND score != ''
  LIMIT 30
`).all();

for (const s of tennisSnapshots) {
  console.log(`Deporte: ${s.sport} | Marcador: "${s.score}" | Mercado: ${s.market}`);
}
