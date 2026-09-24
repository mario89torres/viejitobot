// NB calibrado contra FotMob (src/nbCalibrado.js + matchStats.posteriorNB):
// opt-in por STATS_NB_CALIBRADO. Sin el, el modelo original queda intacto
// (ver tests/prob-under-nb.test.js); con el, el tiempo consumido es F(t) en
// vez de t/90 y ya no hay "sin tiempo" en el minuto 90.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const archivo = path.join(os.tmpdir(), `fotmob_nb_test_${process.pid}.json`);
// Perfil lineal hasta 100' con mu/r de juguete: facil de razonar a mano.
fs.writeFileSync(archivo, JSON.stringify({ mu: 10, r: 20, nudos: [0, 50, 100], F: [0, 0.5, 1] }));
process.env.NB_CALIBRADO_FILE = archivo;

const { probUnderNB, posteriorNB, nbParamsVigentes, featureVersionScorer, STATS_NB_MU } = require('../src/matchStats');
const cal = require('../src/nbCalibrado');

test.after(() => { try { fs.unlinkSync(archivo); } catch {} });

function conModo(modo, fn) {
  const antes = process.env.STATS_NB_CALIBRADO;
  if (modo == null) delete process.env.STATS_NB_CALIBRADO; else process.env.STATS_NB_CALIBRADO = modo;
  try { return fn(); } finally { if (antes === undefined) delete process.env.STATS_NB_CALIBRADO; else process.env.STATS_NB_CALIBRADO = antes; }
}

test('por defecto (off) ignora el archivo: mismo modelo y sello de siempre', () => {
  conModo(null, () => {
    assert.strictEqual(nbParamsVigentes().calibrado, false);
    assert.strictEqual(nbParamsVigentes().mu, STATS_NB_MU);
    assert.strictEqual(featureVersionScorer(), 'stats-4');
    assert.strictEqual(probUnderNB(7, 9.5, 90), 1); // sin tiempo, como antes
  });
});

test('on: usa mu/r del archivo y sella stats-5', () => {
  conModo('on', () => {
    assert.deepStrictEqual(nbParamsVigentes(), { mu: 10, r: 20, calibrado: true });
    assert.strictEqual(featureVersionScorer(), 'stats-5');
  });
});

test('on: en el minuto 0 lo que falta tiene la media del prior (mu)', () => {
  conModo('on', () => {
    const p = posteriorNB(0, 0);
    assert.ok(Math.abs(p.muRestante - 10) < 1e-9, `muRestante=${p.muRestante}`);
  });
});

test('on: con F lineal coincide con la formula original (t/D con D=100)', () => {
  conModo('on', () => {
    const c = 4, t = 40;
    const a = 20 + c, b = 20 / 10 + t / 100, esperado = a * (1 - t / 100) / b;
    assert.ok(Math.abs(posteriorNB(c, t).muRestante - esperado) < 1e-9);
  });
});

test('on: en el minuto 90 todavia queda tiempo (a diferencia del modelo original)', () => {
  conModo('on', () => {
    assert.ok(posteriorNB(7, 90).muRestante > 0);
    assert.ok(probUnderNB(7, 9.5, 90) < 1);
  });
});

test('on: pasado el ultimo nudo no queda tiempo y el under con colchon gana', () => {
  conModo('on', () => {
    assert.strictEqual(posteriorNB(7, 100).muRestante, 0);
    assert.strictEqual(probUnderNB(7, 9.5, 105), 1);
    assert.strictEqual(probUnderNB(10, 9.5, 105), 0);
  });
});

test('on: sigue siendo monotono en tiempo y en conteo, y dentro de [0,1]', () => {
  conModo('on', () => {
    assert.ok(probUnderNB(5, 9.5, 70) >= probUnderNB(5, 9.5, 40));
    assert.ok(probUnderNB(8, 9.5, 60) < probUnderNB(5, 9.5, 60));
    for (const c of [0, 3, 7, 12]) for (const m of [1, 30, 60, 89, 95]) {
      const p = probUnderNB(c, 9.5, m);
      assert.ok(p >= 0 && p <= 1, `p=${p} c=${c} m=${m}`);
    }
  });
});

test('mu/r explicitos siempre ganan al calibrado (barridos y pruebas)', () => {
  conModo('on', () => {
    const p = posteriorNB(0, 0, 12, 7);
    assert.ok(Math.abs(p.muRestante - 12) < 1e-9);
  });
});

test('archivo invalido se ignora en vez de romper', () => {
  const malo = path.join(os.tmpdir(), `fotmob_nb_malo_${process.pid}.json`);
  fs.writeFileSync(malo, JSON.stringify({ mu: 10, r: 20, nudos: [0, 50], F: [0, 0.9, 1] }));
  const previo = process.env.NB_CALIBRADO_FILE;
  process.env.NB_CALIBRADO_FILE = malo;
  try {
    conModo('on', () => assert.strictEqual(nbParamsVigentes().calibrado, false));
  } finally { process.env.NB_CALIBRADO_FILE = previo; fs.unlinkSync(malo); }
});

test('minutoDeStatus: minuto, descuento, descanso y no-minutos', () => {
  assert.strictEqual(cal.minutoDeStatus("46‎’‎"), 46);
  assert.strictEqual(cal.minutoDeStatus("45+2’"), 47);
  assert.strictEqual(cal.minutoDeStatus('HT'), 45);
  assert.strictEqual(cal.minutoDeStatus('FT') , null);
  assert.strictEqual(cal.minutoDeStatus(null), null);
});
