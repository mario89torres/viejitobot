const test = require('node:test');
const assert = require('node:assert');
const { brierScore, logLoss, reliability } = require('../src/metrics');

test('brier: casos conocidos', () => {
  assert.strictEqual(brierScore([]), null);
  assert.strictEqual(brierScore([{ conf: 1, y: 1 }]), 0);
  assert.strictEqual(brierScore([{ conf: 0.5, y: 1 }, { conf: 0.5, y: 0 }]), 0.25);
  // pick perfecto perdido: (1 − 0)² = 1
  assert.strictEqual(brierScore([{ conf: 1, y: 0 }]), 1);
});

test('log loss: clipping evita infinitos', () => {
  const ll = logLoss([{ conf: 1, y: 0 }, { conf: 0, y: 1 }]);
  assert.ok(Number.isFinite(ll), 'no debe ser Infinity');
  // ambos se clippean a 0.999/0.001 → −ln(0.001) cada uno
  assert.ok(Math.abs(ll - (-Math.log(0.001))) < 1e-9);
  // caso balanceado conocido: conf 0.5 → ln 2
  assert.ok(Math.abs(logLoss([{ conf: 0.5, y: 1 }]) - Math.log(2)) < 1e-12);
});

test('reliability table: bins, gap y ECE', () => {
  // 10 picks con conf 0.75, 5 ganados → bin 0.7-0.8: rate 0.5, gap +0.25
  const points = [];
  for (let i = 0; i < 10; i++) points.push({ conf: 0.75, y: i < 5 ? 1 : 0 });
  const { bins, ece } = reliability(points);
  assert.strictEqual(bins.length, 6);
  const b = bins.find(b => b.lo === 0.7);
  assert.strictEqual(b.n, 10);
  assert.ok(Math.abs(b.avgConf - 0.75) < 1e-12);
  assert.ok(Math.abs(b.winRate - 0.5) < 1e-12);
  assert.ok(Math.abs(b.gap - 0.25) < 1e-12);
  assert.ok(Math.abs(ece - 0.25) < 1e-12);
  // los demás bins quedan vacíos
  assert.strictEqual(bins.filter(x => x.n === 0).length, 5);
});

test('reliability: conf en los bordes cae en el bin correcto', () => {
  const { bins } = reliability([
    { conf: 0.5, y: 1 },  // borde inferior de 0.5-0.6
    { conf: 1.0, y: 1 },  // conf = 1 cae en 0.9-1.0
    { conf: 0.49, y: 0 }, // bin 0-0.5
  ]);
  assert.strictEqual(bins.find(b => b.lo === 0.5).n, 1);
  assert.strictEqual(bins.find(b => b.lo === 0.9).n, 1);
  assert.strictEqual(bins.find(b => b.lo === 0).n, 1);
});

test('ECE pondera por tamaño de bin', () => {
  // 8 picks calibrados perfectos (conf 0.55, rate 4/8... no: usar gap 0)
  const points = [];
  for (let i = 0; i < 8; i++) points.push({ conf: 0.55, y: i % 2 ? 1 : 0 }); // rate 0.5, gap 0.05
  for (let i = 0; i < 2; i++) points.push({ conf: 0.95, y: 0 });             // rate 0, gap 0.95
  const { ece } = reliability(points);
  // ECE = 0.8·0.05 + 0.2·0.95 = 0.23
  assert.ok(Math.abs(ece - 0.23) < 1e-12);
});
