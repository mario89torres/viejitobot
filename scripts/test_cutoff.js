require('dotenv').config();
const { db } = require('../src/db');
const { stakePicksByDate } = require('../src/metrics');

// 10:02 AM CDMX (UTC-6) = 16:02:00 UTC
const cutoffTs = '2026-08-04T16:02:00.000Z';
const res = stakePicksByDate('hoy');

const pre = res.picks.filter(p => p.ts < cutoffTs);
const post = res.picks.filter(p => p.ts >= cutoffTs);

console.log(`=== CORTE DE HOY 10:02 AM CDMX (16:02 UTC) ===`);
console.log(`Total Picks hoy: ${res.picks.length}`);
console.log(`Pre-corte (< 10:02 AM CDMX): ${pre.length} picks`);
console.log(`Post-corte (>= 10:02 AM CDMX - Nuevos 4 Ajustes): ${post.length} picks`);

for (const p of post) {
  console.log(`  POST: ID ${p.id} | ${p.ts} | ${p.event} | ${p.result} | Stake: ${p.stake}u | Profit: ${p.profit}u`);
}
