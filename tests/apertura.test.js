const test = require('node:test');
const assert = require('node:assert');
const { aperturaFactor } = require('../src/confidence');
const { learnedConf, reloadModel } = require('../src/model');
const fs = require('fs');
const path = require('path');

test('aperturaFactor: neutro, dirección y suavidad sin saturación', () => {
  // sin movimiento → 0.5; sin datos → 0.5
  assert.strictEqual(aperturaFactor(1.50, 1.50), 0.5);
  assert.strictEqual(aperturaFactor(null, 1.50), 0.5);
  assert.strictEqual(aperturaFactor(1.50, null), 0.5);

  // línea bajó desde la apertura (mercado a favor) → > 0.5
  const down = aperturaFactor(2.00, 1.40); // relDelta = 0.30
  assert.ok(down > 0.5);
  // línea subió (en contra) → < 0.5, simétrico
  const up = aperturaFactor(1.40, 2.00 * 1.40 / 2.00 * (2.00 / 1.40)); // 1.40 -> 2.00
  assert.ok(aperturaFactor(1.40, 2.00) < 0.5);

  // sin saturación dura: drift enorme se acerca a 1 pero no lo toca
  const huge = aperturaFactor(10, 1.05);
  assert.ok(huge > 0.7 && huge < 1);
  // monotónico: más drift → factor mayor
  assert.ok(aperturaFactor(2.0, 1.2) > aperturaFactor(2.0, 1.6));
});

test('learnedConf usa la lista de features del model.json (5 features)', () => {
  const MODEL_PATH = path.join(__dirname, '..', 'model.json');
  const existed = fs.existsSync(MODEL_PATH);
  const backup = existed ? fs.readFileSync(MODEL_PATH) : null;
  fs.writeFileSync(MODEL_PATH, JSON.stringify({
    intercept: 0,
    features: ['f_prob_justa', 'f_avance', 'f_situacion', 'f_linea', 'f_apertura'],
    coef: { f_prob_justa: 1, f_avance: 0, f_situacion: 0, f_linea: 0, f_apertura: 2 },
    sport_coef: {},
    calibration: { x: [0, 1], y: [0, 1] }, // identidad
  }));
  reloadModel();
  try {
    const base = { f_prob_justa: 0.5, f_avance: 0.5, f_situacion: 0.5, f_linea: 0.5 };
    // con f_apertura alta el score sube frente a f_apertura baja
    const hi = learnedConf({ ...base, f_apertura: 0.9 }, 'Fútbol');
    const lo = learnedConf({ ...base, f_apertura: 0.1 }, 'Fútbol');
    assert.ok(hi > lo);
    // si falta f_apertura en la entrada, asume 0.5 (neutro) y no da NaN
    const neutral = learnedConf(base, 'Fútbol');
    assert.ok(Number.isFinite(neutral));
    assert.ok(neutral > lo && neutral < hi);
  } finally {
    if (existed) fs.writeFileSync(MODEL_PATH, backup); else fs.unlinkSync(MODEL_PATH);
    reloadModel();
  }
});
