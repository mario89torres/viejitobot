require('dotenv').config();
const { db } = require('../src/db');
const { stakePicksByDate } = require('../src/metrics');

console.log('=== Picks liquidados de hoy (stakePicksByDate) ===');
const res = stakePicksByDate('hoy');
console.log(`Fecha: ${res.date} | Picks: ${res.n} | Staked: ${res.staked}u | Profit: ${res.profit}u`);
for (const p of res.picks) {
  console.log(`ID: ${p.id} | ${p.ts} | ${p.event} (${p.sport}) | Market: ${p.market} | Result: ${p.result} | Stake: ${p.stake}u`);
}
