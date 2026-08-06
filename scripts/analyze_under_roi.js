const { db } = require('../src/db');

// Analiza ROI histórico de picks "Menos de X" agrupado por línea
const rows = db.prepare(`
  SELECT
    market,
    selection,
    odd_decimal,
    stake,
    result,
    loss_minute
  FROM picks
  WHERE stake IS NOT NULL
    AND result IN ('win','loss','push')
    AND selection LIKE '%enos de%'
  ORDER BY market
`).all();

// Extraer línea del market o selection
function extractLine(row) {
  const txt = row.market + ' ' + row.selection;
  const m = txt.match(/(\d+(?:\.\d+)?)/g);
  if (!m) return null;
  // La línea suele ser el número más pequeño coherente con totales
  const nums = m.map(Number).filter(n => n >= 0.5 && n <= 15);
  return nums.length ? Math.min(...nums) : null;
}

const byLine = {};
for (const r of rows) {
  const line = extractLine(r);
  if (line == null) continue;
  const key = line.toFixed(1);
  if (!byLine[key]) byLine[key] = { line: key, n: 0, wins: 0, totalStake: 0, totalProfit: 0 };
  const g = byLine[key];
  g.n++;
  g.totalStake += r.stake;
  if (r.result === 'win') {
    g.wins++;
    g.totalProfit += r.stake * (r.odd_decimal - 1);
  } else if (r.result === 'loss') {
    g.totalProfit -= r.stake;
  }
}

const sorted = Object.values(byLine).sort((a, b) => parseFloat(a.line) - parseFloat(b.line));
console.log('\n📊 ROI histórico — picks "Menos de X" por línea:\n');
console.log('Línea  | n  | WR%    | Profit   | ROI%    | Acción');
console.log('-------|----|---------|---------|---------|---------');
for (const g of sorted) {
  const wr = g.n > 0 ? (g.wins / g.n * 100).toFixed(1) : '0.0';
  const roi = g.totalStake > 0 ? (g.totalProfit / g.totalStake * 100).toFixed(1) : '0.0';
  const profit = g.totalProfit.toFixed(2);
  const action = parseFloat(roi) > 0 ? '✅ emitir' : parseFloat(roi) > -10 ? '⚠️ neutro' : '🚫 bloquear';
  console.log(`  ${g.line.padEnd(5)} | ${String(g.n).padEnd(3)}| ${wr.padEnd(7)}| ${profit.padEnd(9)}| ${roi.padEnd(8)}| ${action}`);
}
