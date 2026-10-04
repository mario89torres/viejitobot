const test = require('node:test');
const assert = require('node:assert');
const { probs1X2, pMasDe25, justas } = require('../scripts/backtest-xg-filtro-patas');

test('probs1X2 suma 1 y favorece al de mayor lambda', () => {
  const [l, e, v] = probs1X2(2.0, 0.8);
  assert.ok(Math.abs(l + e + v - 1) < 1e-9);
  assert.ok(l > e && l > v);
  const [a, b, c] = probs1X2(1.2, 1.2);
  assert.ok(Math.abs(a - c) < 1e-9 && b > 0.2);
});
test('pMasDe25 crece con lambda y justas suma 1', () => {
  assert.ok(pMasDe25(3.0) > pMasDe25(2.0));
  assert.ok(Math.abs(pMasDe25(2.5) - 0.4562) < 0.005);
  assert.ok(Math.abs(justas([1.5, 3.0, 6.0]).reduce((a, b) => a + b, 0) - 1) < 1e-12);
});
