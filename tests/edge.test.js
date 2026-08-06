const test = require('node:test');
const assert = require('node:assert');
const { spearman, semaphore, healthEval, clvSharpForPick } = require('../src/metrics');

test('spearman: monotónica perfecta, inversa y sin varianza', () => {
  assert.ok(Math.abs(spearman([1, 2, 3, 4], [10, 20, 30, 40]) - 1) < 1e-12);
  assert.ok(Math.abs(spearman([1, 2, 3, 4], [40, 30, 20, 10]) + 1) < 1e-12);
  assert.strictEqual(spearman([1, 1, 1], [1, 2, 3]), null); // sin varianza en x
  assert.strictEqual(spearman([1, 2], [1, 2]), null);       // n < 3
  // no lineal pero monotónica → spearman 1 (a diferencia de pearson)
  assert.ok(Math.abs(spearman([1, 2, 3, 4], [1, 10, 100, 1000]) - 1) < 1e-12);
});

test('semáforo: las cuatro reglas exactas', () => {
  assert.strictEqual(
    semaphore(0.01, 0.05, 300),
    'EDGE PROBABLE: el sistema bate la línea de cierre; el ROI llegará con volumen.');
  assert.strictEqual(
    semaphore(-0.01, 0.05, 400),
    'PRECAUCIÓN: resultado positivo sin batir el cierre = probablemente varianza. No escalar.');
  assert.strictEqual(
    semaphore(0.01, -0.03, 150),
    'VARIANZA NEGATIVA: mantener proceso, revisar en +100 picks.');
  assert.strictEqual(semaphore(0.01, 0.02, 120), 'MUESTRA INSUFICIENTE (120/300).');
  assert.strictEqual(semaphore(null, null, 0), 'MUESTRA INSUFICIENTE (0/300).');
  // n>=300 sin batir cierre ni ROI: fallback explícito
  assert.strictEqual(semaphore(-0.01, -0.02, 350), 'SIN EDGE: no bate el cierre ni hay ROI positivo.');
});

test('healthEval detecta descalibración simulada (criterio de aceptación)', () => {
  // 200 picks con conf 0.85 pero tasa real 0.5 → ECE ≈ 0.35 > 0.05 → alerta
  const bad = [];
  for (let i = 0; i < 200; i++) bad.push({ conf: 0.85, y: i % 2 });
  const hBad = healthEval(bad);
  assert.ok(hBad.ece > 0.05);
  assert.strictEqual(hBad.alert, true);

  // 200 picks bien calibrados (conf 0.75, tasa 0.75) → sin alerta
  const good = [];
  for (let i = 0; i < 200; i++) good.push({ conf: 0.75, y: i % 4 === 0 ? 0 : 1 });
  const hGood = healthEval(good);
  assert.ok(hGood.ece <= 0.05);
  assert.strictEqual(hGood.alert, false);

  // muestra chica no alerta aunque esté descalibrada
  assert.strictEqual(healthEval(bad.slice(0, 20)).alert, false);
});

test('clvSharpForPick: guardas de datos inválidos', () => {
  assert.strictEqual(clvSharpForPick({ sharp_closing_market: null, ts: 'x' }), null);
  assert.strictEqual(clvSharpForPick({ sharp_closing_market: 'no-json', ts: 'x' }), null);
  assert.strictEqual(clvSharpForPick({
    sharp_closing_market: JSON.stringify({ idx: 5, outcomes: [{ name: 'A', price: 1.9 }, { name: 'B', price: 1.9 }] }),
    ts: 'x',
  }), null); // idx fuera de rango
});
