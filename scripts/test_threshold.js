const { isBlockedMarket } = require('../src/confidence');

const testCases = [
  { label: 'Menos de 2.5 (DEBE PASAR)',      r: { event: 'A vs B', market: 'Total 2.5', selection: 'Menos de 2.5', marketType: 'total', sport: 'Fútbol' } },
  { label: 'Menos de 3.5 (DEBE PASAR)',      r: { event: 'A vs B', market: 'Total 3.5', selection: 'Menos de 3.5', marketType: 'total', sport: 'Fútbol' } },
  { label: 'Menos de 4.5 (DEBE PASAR)',      r: { event: 'A vs B', market: 'Total 4.5', selection: 'Menos de 4.5', marketType: 'total', sport: 'Fútbol' } },
  { label: 'Menos de 5.0 (DEBE PASAR)',      r: { event: 'A vs B', market: 'Total 5.0', selection: 'Menos de 5.0', marketType: 'total', sport: 'Fútbol' } },
  { label: 'Menos de 5.5 (DEBE BLOQUEARSE)', r: { event: 'A vs B', market: 'Total 5.5', selection: 'Menos de 5.5', marketType: 'total', sport: 'Fútbol' } },
  { label: 'Menos de 6.5 (DEBE BLOQUEARSE)', r: { event: 'A vs B', market: 'Total 6.5', selection: 'Menos de 6.5', marketType: 'total', sport: 'Fútbol' } },
  { label: 'Más de 3.5 (DEBE PASAR)',        r: { event: 'A vs B', market: 'Total 3.5', selection: 'Más de 3.5',   marketType: 'total', sport: 'Fútbol' } },
  { label: 'Más de 4.5 (DEBE BLOQUEARSE)',   r: { event: 'A vs B', market: 'Total 4.5', selection: 'Más de 4.5',   marketType: 'total', sport: 'Fútbol' } },
  { label: 'Más de 5.5 (DEBE BLOQUEARSE)',   r: { event: 'A vs B', market: 'Total 5.5', selection: 'Más de 5.5',   marketType: 'total', sport: 'Fútbol' } },
];

let allPassed = true;
testCases.forEach(tc => {
  const blocked = isBlockedMarket(tc.r);
  const expectedBlocked = tc.label.includes('BLOQUEARSE');
  const ok = blocked === expectedBlocked;
  if (!ok) allPassed = false;
  console.log(`${ok ? '✅' : '❌'} ${blocked ? 'BLOQUEADO' : 'PASA    '} | ${tc.label}`);
});
console.log(allPassed ? '\n✅ Todos los casos pasan correctamente.' : '\n❌ HAY CASOS QUE FALLAN.');
