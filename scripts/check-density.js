const { db } = require('../src/db');
const rows = db.prepare(`
  SELECT ts, COUNT(DISTINCT sport) AS sports, COUNT(*) AS n
  FROM snapshots WHERE ts > datetime('now', '-4 minutes')
  GROUP BY ts ORDER BY ts
`).all();
for (const r of rows) console.log(`${r.ts} | ${r.sports} deportes | ${r.n} filas`);
const gaps = [];
for (let i = 1; i < rows.length; i++) {
  gaps.push((new Date(rows[i].ts) - new Date(rows[i - 1].ts)) / 1000);
}
if (gaps.length) console.log('Intervalos (s):', gaps.map(g => g.toFixed(0)).join(', '));
