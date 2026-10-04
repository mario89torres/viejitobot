const test = require('node:test');
const assert = require('node:assert/strict');
const { poissonCdf, probMasDe, probMenosDe, cuotaJusta } = require('../src/poissonGoles');

const cerca = (a, b, tol = 5e-4) => assert.ok(Math.abs(a - b) <= tol, `${a} deberia estar a ${tol} de ${b}`);

test('xG 3.04: probabilidades por linea (valores calculados a mano)', () => {
  cerca(probMasDe(3.04, 1.5), 0.8067);
  cerca(probMasDe(3.04, 2.5), 0.5857);
  cerca(probMasDe(3.04, 3.5), 0.3617);
  cerca(probMasDe(3.04, 4.5), 0.1915);
});

test('Mas de + Menos de suman 1 en cualquier linea', () => {
  for (const lambda of [0.5, 1.2, 2.7, 3.04, 5]) {
    for (const linea of [0.5, 1.5, 2.5, 3.5]) {
      cerca(probMasDe(lambda, linea) + probMenosDe(lambda, linea), 1, 1e-12);
    }
  }
});

test('poissonCdf: casos limite', () => {
  assert.equal(poissonCdf(-1, 2), 0);
  assert.equal(poissonCdf(3, 0), 1);
  cerca(poissonCdf(0, 1), Math.exp(-1), 1e-12);
  cerca(poissonCdf(200, 3), 1, 1e-12);
});

test('mas promedio esperado => mas probabilidad de "Mas de"', () => {
  assert.ok(probMasDe(3.5, 2.5) > probMasDe(3.0, 2.5));
  assert.ok(probMasDe(3.0, 2.5) > probMasDe(2.0, 2.5));
});

test('cuotaJusta: inversa de la probabilidad y null si no es usable', () => {
  cerca(cuotaJusta(0.5857), 1.7075, 1e-3);
  assert.equal(cuotaJusta(0), null);
  assert.equal(cuotaJusta(1), null);
  assert.equal(cuotaJusta(NaN), null);
});
