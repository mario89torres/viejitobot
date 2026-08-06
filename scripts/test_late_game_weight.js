require('dotenv').config();
const { db } = require('../src/db');
const { parsePick } = require('../src/markets');

console.log('=== Analizando picks "Menos de 3.5 / 2.5" por minuto de emisión ===');

const rows = db.prepare(`
  SELECT p.id, p.ts, p.event, p.sport, p.market, p.selection, p.odd_decimal, p.conf, p.result, p.final_score, p.stake, s.live_time
  FROM picks p
  LEFT JOIN snapshots s ON p.event_id = s.event_id AND p.market = s.market AND p.selection = s.selection
  WHERE p.sport = 'Fútbol' AND p.result IN ('win','loss')
  GROUP BY p.id
`).all();

const parseMin = lt => {
  if (!lt) return null;
  const m = String(lt).match(/^(\d+)/);
  return m ? Number(m[1]) : null;
};

const underPicks = rows.map(r => {
  const parsed = parsePick(r);
  const min = parseMin(r.live_time);
  return { ...r, parsed, min };
}).filter(r => r.parsed && r.parsed.type === 'total' && !r.parsed.over);

console.log(`Total picks Under en fútbol: ${underPicks.length}`);

// Desglose por minuto
const early = underPicks.filter(p => p.min !== null && p.min < 60);
const mid = underPicks.filter(p => p.min !== null && p.min >= 60 && p.min < 80);
const late = underPicks.filter(p => p.min !== null && p.min >= 80);

const stats = arr => {
  const n = arr.length;
  if (!n) return 'N=0';
  const wins = arr.filter(p => p.result === 'win').length;
  const staked = arr.reduce((s, p) => s + (p.stake || 1), 0);
  const profit = arr.reduce((s, p) => s + (p.result === 'win' ? (p.stake||1)*(p.odd_decimal-1) : -(p.stake||1)), 0);
  const roi = staked > 0 ? (100 * profit / staked).toFixed(1) + '%' : '0%';
  const wr = (100 * wins / n).toFixed(1) + '%';
  return `N=${n} | Wins: ${wins}/${n} (${wr}) | Profit: ${profit.toFixed(2)}u | ROI: ${roi}`;
};

console.log('Minuto < 60:   ', stats(early));
console.log('Minuto 60-79:  ', stats(mid));
console.log('Minuto >= 80:  ', stats(late));

console.log('\nPicks del minuto >= 80 con línea de Menos de 3.5 o 2.5:');
const lateThin = late.filter(p => p.parsed.line <= 3.5);
for (const p of lateThin) {
  console.log(`ID ${p.id} | Min ${p.min}' | ${p.event} | ${p.selection} @ ${p.odd_decimal} | Score: ${p.final_score} | Result: ${p.result}`);
}
