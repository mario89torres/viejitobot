const test = require('node:test');
const assert = require('node:assert/strict');
const { R_POISSON, probMasDeNB, muParaProbMasDe, pOverDeCuotas, logLikGoles } = require('../src/dispersionGoles');
const { probMasDe } = require('../src/poissonGoles');

const cerca = (a, b, tol = 1e-6) => assert.ok(Math.abs(a - b) <= tol, `${a} deberia estar a ${tol} de ${b}`);

test('probMasDeNB con r enorme coincide con Poisson', () => {
  for (const mu of [1.2, 2.7, 3.04]) for (const linea of [1.5, 2.5, 3.5]) {
    cerca(probMasDeNB(mu, linea, R_POISSON), probMasDe(mu, linea), 1e-5);
  }
});

test('muParaProbMasDe es la inversa de probMasDeNB (ida y vuelta)', () => {
  for (const r of [R_POISSON, 30, 8]) for (const mu of [1.5, 2.6, 3.4]) {
    const p = probMasDeNB(mu, 2.5, r);
    cerca(muParaProbMasDe(p, 2.5, r), mu, 1e-6);
  }
});

test('muParaProbMasDe: null si la probabilidad no es usable o cae fuera de rango', () => {
  assert.equal(muParaProbMasDe(0, 2.5, R_POISSON), null);
  assert.equal(muParaProbMasDe(1, 2.5, R_POISSON), null);
  assert.equal(muParaProbMasDe(NaN, 2.5, R_POISSON), null);
  assert.equal(muParaProbMasDe(0.9995, 2.5, R_POISSON), null);
  assert.equal(muParaProbMasDe(0.002, 2.5, R_POISSON, { lo: 1.5, hi: 9 }), null);
});

test('a igual probabilidad en 2.5, menos r (mas dispersion) da mas cola en 4.5 y mas ceros', () => {
  const p25 = 0.55;
  const muP = muParaProbMasDe(p25, 2.5, R_POISSON), muN = muParaProbMasDe(p25, 2.5, 6);
  assert.ok(probMasDeNB(muN, 4.5, 6) > probMasDe(muP, 4.5));
  // el 0-0 tambien es mas probable con dispersion
  assert.ok(Math.exp(logLikGoles(0, muN, 6)) > Math.exp(logLikGoles(0, muP, R_POISSON)));
});

test('pOverDeCuotas: de-vig proporcional simetrico y validaciones', () => {
  cerca(pOverDeCuotas(1.9, 1.9), 0.5, 1e-12);
  assert.ok(pOverDeCuotas(1.6, 2.4) > 0.5);
  assert.equal(pOverDeCuotas(1.0, 2), null);
  assert.equal(pOverDeCuotas(NaN, 2), null);
  assert.equal(pOverDeCuotas(2, 0.5), null);
});
