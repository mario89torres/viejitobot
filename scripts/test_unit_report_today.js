require('dotenv').config();
const { stakePicksByDate } = require('../src/metrics');

console.log('=== PROBANDO REPORTE DE UNIDADES DE HOY CON LA DOBLE CAPA ACTIVA (05-AGO) ===');

const res = stakePicksByDate('hoy');

console.log(`Fecha: ${res.date}`);
console.log(`Total Picks Filtro Emisión: ${res.n}`);
console.log(`Aciertos: ${res.wins}/${res.n} (${res.wr ? res.wr.toFixed(1) : 0}%)`);
console.log(`Unidades Apostadas: ${res.staked.toFixed(2)}u`);
console.log(`Ganancia Neta: ${res.profit >= 0 ? '+' : ''}${res.profit.toFixed(2)}u`);
console.log(`ROI: ${res.roi !== null ? (res.roi >= 0 ? '+' : '') + res.roi.toFixed(2) + '%' : 'N/A'}`);

console.log('\n--- PRIMEROS 15 PICKS DEL REPORTE (EMISIÓN TELEGRAM) ---');
for (const p of res.picks.slice(0, 15)) {
  const icon = p.result === 'win' ? '✅' : (p.result === 'loss' ? '❌' : '⏳');
  console.log(`${icon} ID ${p.id} | ${p.ts.slice(11, 16)} | ${p.event} (${p.sport})`);
  console.log(`   ${p.market}: ${p.selection} @ ${p.odd_decimal.toFixed(2)} | Stake: ${p.stake}u | Profit: ${p.profit >= 0 ? '+' : ''}${p.profit.toFixed(2)}u`);
}
