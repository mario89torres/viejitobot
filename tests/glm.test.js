const test = require('node:test');
const assert = require('node:assert/strict');
const { resolver, invertir, poissonReg, logisticReg, pChi2, lrTest, pNormal2 } = require('../src/glm');

const cerca = (a, b, tol) => assert.ok(Math.abs(a - b) <= tol, `${a} deberia estar a ${tol} de ${b}`);

function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
function poisson(lambda, u) { let k = 0, p = Math.exp(-lambda), c = p; const r = u(); while (r > c && k < 100) { k++; p *= lambda / k; c += p; } return k; }

test('resolver e invertir: sistema conocido y matriz singular', () => {
  const x = resolver([[2, 1], [1, 3]], [5, 10]);
  cerca(x[0], 1, 1e-9); cerca(x[1], 3, 1e-9);
  const inv = invertir([[4, 7], [2, 6]]);
  cerca(inv[0][0], 0.6, 1e-9); cerca(inv[0][1], -0.7, 1e-9); cerca(inv[1][0], -0.2, 1e-9); cerca(inv[1][1], 0.4, 1e-9);
  assert.equal(resolver([[1, 2], [2, 4]], [1, 2]), null);
  assert.equal(invertir([[1, 2], [2, 4]]), null);
});

test('poissonReg recupera los parametros verdaderos (0.3 y 0.5) con datos sinteticos', () => {
  const u = rng(42), X = [], y = [];
  for (let i = 0; i < 20000; i++) { const x = u() * 2 - 1; X.push([1, x]); y.push(poisson(Math.exp(0.3 + 0.5 * x), u)); }
  const m = poissonReg(X, y);
  assert.ok(m.converged);
  cerca(m.coef[0], 0.3, 0.03); cerca(m.coef[1], 0.5, 0.05);
  assert.ok(m.se[1] > 0 && m.se[1] < 0.05);
  // el valor verdadero cae dentro de ~3 errores estandar
  assert.ok(Math.abs(m.coef[1] - 0.5) < 3 * m.se[1]);
});

test('poissonReg: sin efecto real, el coeficiente no es significativo y la LR no rechaza', () => {
  const u = rng(7), X = [], y = [];
  for (let i = 0; i < 5000; i++) { X.push([1, u()]); y.push(poisson(2, u)); }
  const completo = poissonReg(X, y), nulo = poissonReg(X.map(f => [f[0]]), y);
  assert.ok(Math.abs(completo.coef[1] / completo.se[1]) < 3);
  assert.ok(lrTest(completo.loglik, nulo.loglik, 1).p > 0.001);
});

test('poissonReg con offset equivale a una exposicion conocida', () => {
  const u = rng(3), X = [], y = [], off = [];
  for (let i = 0; i < 8000; i++) { const e = 0.5 + u() * 2; X.push([1]); off.push(Math.log(e)); y.push(poisson(1.7 * e, u)); }
  const m = poissonReg(X, y, { offset: off });
  cerca(Math.exp(m.coef[0]), 1.7, 0.06);
});

test('logisticReg recupera los parametros verdaderos (-0.4 y 1.2)', () => {
  const u = rng(11), X = [], y = [];
  for (let i = 0; i < 20000; i++) { const x = u() * 4 - 2; X.push([1, x]); y.push(u() < 1 / (1 + Math.exp(-(-0.4 + 1.2 * x))) ? 1 : 0); }
  const m = logisticReg(X, y);
  assert.ok(m.converged);
  cerca(m.coef[0], -0.4, 0.06); cerca(m.coef[1], 1.2, 0.08);
  assert.ok(Math.abs(m.coef[1] - 1.2) < 3.5 * m.se[1]);
});

test('logisticReg: un predictor real mejora la verosimilitud y lo detecta la LR', () => {
  const u = rng(5), X = [], y = [];
  for (let i = 0; i < 6000; i++) { const a = u() * 2 - 1, b = u() * 2 - 1; X.push([1, a, b]); y.push(u() < 1 / (1 + Math.exp(-(0.2 + 1.0 * a))) ? 1 : 0); }
  const completo = logisticReg(X, y), sinA = logisticReg(X.map(f => [f[0], f[2]]), y), sinB = logisticReg(X.map(f => [f[0], f[1]]), y);
  assert.ok(lrTest(completo.loglik, sinA.loglik, 1).p < 1e-6);   // a importa
  assert.ok(lrTest(completo.loglik, sinB.loglik, 1).p > 0.001);  // b es ruido
});

test('pChi2 y pNormal2: valores criticos conocidos', () => {
  cerca(pChi2(3.841, 1), 0.05, 0.002);
  cerca(pChi2(6.635, 1), 0.01, 0.001);
  cerca(pChi2(5.991, 2), 0.05, 0.001);
  assert.equal(pChi2(0, 1), 1);
  assert.throws(() => pChi2(3, 3));
  cerca(pNormal2(1.96), 0.05, 0.002);
  cerca(pNormal2(0), 1, 1e-6);
});
