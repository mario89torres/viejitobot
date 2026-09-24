// probUnderNB / posteriorNB (src/matchStats.js): el scorer en sombra desde
// stats-4. Mismos limites de borde que ya se exigian a probUnderPoisson
// (ver tests/stats-etiquetas.test.js), mas la propiedad nueva que Poisson de
// lambda fija no tiene: la actualizacion bayesiana por partido.
const test = require('node:test');
const assert = require('node:assert');
const { probUnderNB, posteriorNB } = require('../src/matchStats');

test('ya se paso la linea: under pierde seguro (0), pase lo que pase con el tiempo', () => {
  assert.strictEqual(probUnderNB(10, 9.5, 70), 0);
});

test('no queda tiempo (minuto 90): el conteo actual ya es el final', () => {
  assert.strictEqual(probUnderNB(7, 9.5, 90), 1); // 7 <= floor(9.5), under gano
  assert.strictEqual(probUnderNB(10, 9.5, 90), 0); // 10 > floor(9.5), ya perdio antes
});

test('pasado el minuto 90 tampoco queda tiempo', () => {
  assert.strictEqual(probUnderNB(7, 9.5, 95), 1);
});

test('null en cualquier ingrediente faltante — nunca rellena con 0.5', () => {
  assert.strictEqual(probUnderNB(null, 9.5, 60), null);
  assert.strictEqual(probUnderNB(7, null, 60), null);
  assert.strictEqual(probUnderNB(7, 9.5, null), null);
});

test('monotono en el tiempo: mas cerca del final, mas seguro el under (con el mismo conteo)', () => {
  const a = probUnderNB(5, 9.5, 40);
  const b = probUnderNB(5, 9.5, 70);
  assert.ok(b >= a, `b=${b} deberia ser >= a=${a}`);
});

test('monotono en el conteo: mas corners ya caidos => menos probable el under', () => {
  const conPocos = probUnderNB(5, 9.5, 60);
  const conMuchos = probUnderNB(8, 9.5, 60);
  assert.ok(conMuchos < conPocos, `conMuchos=${conMuchos} deberia ser menor que conPocos=${conPocos}`);
});

test('actualizacion bayesiana: un partido con MUCHOS corners tempranos sube la expectativa del resto', () => {
  // Dos partidos al mismo minuto (30), uno con 2 corners y otro con 8. Para
  // el segundo, el posterior de rho (corners/min) sube — con Poisson de
  // lambda fija ambos partidos tendrian la MISMA tasa esperada para lo que
  // resta; aqui no.
  const bajo = posteriorNB(2, 30);
  const alto = posteriorNB(8, 30);
  assert.ok(alto.muRestante > bajo.muRestante,
    `partido con mas corners tempranos deberia esperar mas para el resto: alto=${alto.muRestante} bajo=${bajo.muRestante}`);
});

test('posteriorNB: sin tiempo restante, la media de lo que falta es 0', () => {
  const post = posteriorNB(7, 90);
  assert.strictEqual(post.muRestante, 0);
  assert.strictEqual(post.restan, 0);
});

test('probUnderNB nunca sale fuera de [0,1]', () => {
  for (const conteo of [0, 3, 7, 12]) {
    for (const minuto of [1, 30, 60, 89]) {
      const p = probUnderNB(conteo, 9.5, minuto);
      assert.ok(p >= 0 && p <= 1, `conteo=${conteo} minuto=${minuto} p=${p}`);
    }
  }
});
