const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { score, heuristicConf, learnedConf, getMode, reloadModel, interp, HEURISTIC_WEIGHTS } = require('../src/model');

const MODEL_PATH = path.join(__dirname, '..', 'model.json');
const F = { f_prob_justa: 0.8, f_avance: 0.6, f_situacion: 0.7, f_linea: 0.5 };

function withEnv(key, val, fn) {
  const prev = process.env[key];
  if (val === undefined) delete process.env[key]; else process.env[key] = val;
  try { return fn(); } finally {
    if (prev === undefined) delete process.env[key]; else process.env[key] = prev;
  }
}

// Escribe un model.json temporal solo si no existe uno real; lo restaura al final
function withModel(json, fn) {
  const existed = fs.existsSync(MODEL_PATH);
  const backup = existed ? fs.readFileSync(MODEL_PATH) : null;
  fs.writeFileSync(MODEL_PATH, JSON.stringify(json));
  reloadModel();
  try { return fn(); } finally {
    if (existed) fs.writeFileSync(MODEL_PATH, backup); else fs.unlinkSync(MODEL_PATH);
    reloadModel();
  }
}

const FAKE_MODEL = {
  intercept: -1,
  coef: { f_prob_justa: 2, f_avance: 1, f_situacion: 0.5, f_linea: 0.5 },
  sport_coef: { 'Tenis': 0.3, 'otros': -0.1 },
  calibration: { x: [0, 0.5, 1], y: [0, 0.4, 1] }, // deliberadamente no identidad
};

test('heuristicConf reproduce los pesos fijos 0.35/0.30/0.20/0.15', () => {
  const expected = 0.35 * 0.8 + 0.30 * 0.6 + 0.20 * 0.7 + 0.15 * 0.5;
  assert.ok(Math.abs(heuristicConf(F) - expected) < 1e-12);
  assert.ok(Math.abs(Object.values(HEURISTIC_WEIGHTS).reduce((s, x) => s + x, 0) - 1) < 1e-12);
});

test('interp: interpolación lineal con clamp en extremos', () => {
  const t = { x: [0, 0.5, 1], y: [0, 0.4, 1] };
  assert.strictEqual(interp(t, -1), 0);
  assert.strictEqual(interp(t, 2), 1);
  assert.ok(Math.abs(interp(t, 0.25) - 0.2) < 1e-12);
  assert.ok(Math.abs(interp(t, 0.75) - 0.7) < 1e-12);
});

test('learnedConf: sigmoid + coeficientes + dummy de deporte + calibración', () => {
  withModel(FAKE_MODEL, () => {
    // z = −1 + 2·0.8 + 1·0.6 + 0.5·0.7 + 0.5·0.5 + 0.3 (Tenis) = 2.1
    const raw = 1 / (1 + Math.exp(-2.1));
    const expected = interp(FAKE_MODEL.calibration, raw);
    assert.ok(Math.abs(learnedConf(F, 'Tenis') - expected) < 1e-9);
    // deporte desconocido usa 'otros' (−0.1): z = 1.7
    const raw2 = 1 / (1 + Math.exp(-1.7));
    assert.ok(Math.abs(learnedConf(F, 'Curling') - interp(FAKE_MODEL.calibration, raw2)) < 1e-9);
  });
});

test('score respeta MODEL_MODE', () => {
  withModel(FAKE_MODEL, () => {
    const h = heuristicConf(F);
    withEnv('MODEL_MODE', 'heuristic', () => {
      const s = score(F, 'Tenis');
      assert.strictEqual(s.conf, h);
      assert.strictEqual(s.confLearned, null); // no evalúa el modelo
    });
    withEnv('MODEL_MODE', 'shadow', () => {
      const s = score(F, 'Tenis');
      assert.strictEqual(s.conf, h);            // muestra heurístico
      assert.ok(s.confLearned !== null);        // pero guarda el aprendido
      assert.notStrictEqual(s.confLearned, h);
    });
    withEnv('MODEL_MODE', 'learned', () => {
      const s = score(F, 'Tenis');
      assert.strictEqual(s.conf, s.confLearned); // muestra aprendido
      assert.strictEqual(s.confHeuristic, h);    // heurístico sigue disponible
    });
  });
});

test('sin model.json: learned cae al heurístico y shadow guarda null', () => {
  const existed = fs.existsSync(MODEL_PATH);
  const backup = existed ? fs.readFileSync(MODEL_PATH) : null;
  if (existed) fs.unlinkSync(MODEL_PATH);
  reloadModel();
  try {
    withEnv('MODEL_MODE', 'learned', () => {
      const s = score(F, 'Tenis');
      assert.strictEqual(s.conf, heuristicConf(F));
      assert.strictEqual(s.confLearned, null);
    });
  } finally {
    if (existed) fs.writeFileSync(MODEL_PATH, backup);
    reloadModel();
  }
});

test('MODEL_MODE inválido o ausente cae a shadow', () => {
  withEnv('MODEL_MODE', 'yolo', () => assert.strictEqual(getMode(), 'shadow'));
  withEnv('MODEL_MODE', undefined, () => assert.strictEqual(getMode(), 'shadow'));
});
