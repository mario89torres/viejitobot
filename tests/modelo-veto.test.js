// La puerta 'modelo_veto' deja que el modelo aprendido QUITE picks que el
// heurístico habría emitido, sin dejarle decidir `conf`.
//
// Se prueba la PUERTA aislada, no vía rankPicks, y no por comodidad: las filas
// sintéticas no tienen histórico de snapshots, así que la guarda 5 ("mínimo 4
// snapshots activos") las rechaza antes de llegar aquí. Es la misma razón por
// la que fallan varios tests viejos de rankPicks.
const test = require('node:test');
const assert = require('node:assert');
const { POST_SCORE_GATES } = require('../src/confidence');

const puerta = POST_SCORE_GATES.find(([n]) => n === 'modelo_veto');
const pasa = (row, env = {}) => {
  const prev = {};
  for (const [k, v] of Object.entries(env)) { prev[k] = process.env[k]; process.env[k] = v; }
  try { return puerta[1](row, { minConf: 0.70, minEdge: 0.03 }); } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
};

test('la puerta modelo_veto existe y va la ÚLTIMA', () => {
  assert.ok(puerta, 'no está registrada en POST_SCORE_GATES');
  // El orden importa: yendo la última, etiqueta exactamente los picks que el
  // bot HABRÍA emitido, que es lo que hace medible la decisión.
  assert.strictEqual(POST_SCORE_GATES[POST_SCORE_GATES.length - 1][0], 'modelo_veto');
});

test('desactivada, deja pasar aunque conf_learned sea ínfima', () => {
  assert.strictEqual(pasa({ conf: 0.80, confLearned: 0.01 }, { MODEL_VETO: '0' }), true);
});

test('activada, veta por debajo del umbral y deja pasar por encima', () => {
  const env = { MODEL_VETO: '1', MODEL_VETO_MIN_CONF: '0.70' };
  assert.strictEqual(pasa({ conf: 0.80, confLearned: 0.69 }, env), false);
  assert.strictEqual(pasa({ conf: 0.80, confLearned: 0.70 }, env), true, 'el umbral es inclusivo');
  assert.strictEqual(pasa({ conf: 0.80, confLearned: 0.95 }, env), true);
});

test('FALLA ABIERTO sin conf_learned: un modelo ausente no puede dejar al bot sin emitir', () => {
  const env = { MODEL_VETO: '1', MODEL_VETO_MIN_CONF: '0.70' };
  assert.strictEqual(pasa({ conf: 0.80, confLearned: null }, env), true);
  assert.strictEqual(pasa({ conf: 0.80, confLearned: undefined }, env), true);
  assert.strictEqual(pasa({ conf: 0.80 }, env), true);
});

test('conf_learned = 0 se veta, no se confunde con ausente', () => {
  // El bug clásico de `!r.confLearned`: un 0 legítimo pasaría por "no hay dato".
  assert.strictEqual(pasa({ conf: 0.80, confLearned: 0 },
    { MODEL_VETO: '1', MODEL_VETO_MIN_CONF: '0.70' }), false);
});

test('sin MODEL_VETO_MIN_CONF cae a MIN_CONF', () => {
  const env = { MODEL_VETO: '1', MIN_CONF: '0.80' };
  delete process.env.MODEL_VETO_MIN_CONF;
  assert.strictEqual(pasa({ conf: 0.90, confLearned: 0.75 }, env), false);
  assert.strictEqual(pasa({ conf: 0.90, confLearned: 0.85 }, env), true);
});
