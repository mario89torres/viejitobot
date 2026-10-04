const test = require('node:test');
const assert = require('node:assert/strict');
const { parseLiveTime, marcadorFinalCreible } = require('../src/marcadorFeed');

const KO = Date.parse('2026-09-23T18:00:00Z');
const ts = (minTrasKo) => new Date(KO + minTrasKo * 60000).toISOString();

test('parseLiveTime: minuto, parte y prorroga', () => {
  assert.deepEqual(parseLiveTime("91' — 2ª parte"), { minuto: 91, parte: 2, adicional: false });
  assert.deepEqual(parseLiveTime("44' — 1ª parte"), { minuto: 44, parte: 1, adicional: false });
  assert.deepEqual(parseLiveTime("94' — 2ª Parte Adicional"), { minuto: 94, parte: 2, adicional: true });
  assert.deepEqual(parseLiveTime("6' - 1ª parte"), { minuto: 6, parte: 1, adicional: false });
});

test('parseLiveTime: basura o vacio -> null', () => {
  assert.equal(parseLiveTime(null), null);
  assert.equal(parseLiveTime(''), null);
  assert.equal(parseLiveTime('Descanso'), null);
  assert.equal(parseLiveTime('90+3'), null);
});

test('marcadorFinalCreible: acepta 2a parte, minuto >= 85, muestra tardia', () => {
  const m = marcadorFinalCreible({ ts: ts(110), score: '2-1', live_time: "91' — 2ª parte" }, KO);
  assert.deepEqual(m, { gl: 2, gv: 1 });
  assert.deepEqual(marcadorFinalCreible({ ts: ts(100), score: '0-0', live_time: "85' — 2ª parte" }, KO), { gl: 0, gv: 0 });
});

test('marcadorFinalCreible: rechaza si el feed dejo de ver el partido antes del final', () => {
  // casos reales del 2026-09-24: minuto 6, 11, 44, 47, 70 con marcador desactualizado
  for (const lt of ["6' — 1ª parte", "44' — 1ª parte", "47' — 2ª parte", "70' — 2ª parte", "84' — 2ª parte"]) {
    assert.equal(marcadorFinalCreible({ ts: ts(110), score: '1-0', live_time: lt }, KO), null, lt);
  }
});

test('marcadorFinalCreible: rechaza prorroga y muestras demasiado cercanas al kickoff', () => {
  assert.equal(marcadorFinalCreible({ ts: ts(130), score: '1-1', live_time: "94' — 2ª Parte Adicional" }, KO), null);
  assert.equal(marcadorFinalCreible({ ts: ts(60), score: '1-1', live_time: "90' — 2ª parte" }, KO), null);
});

test('marcadorFinalCreible: rechaza marcador ausente o mal formado y datos invalidos', () => {
  assert.equal(marcadorFinalCreible(null, KO), null);
  assert.equal(marcadorFinalCreible({ ts: ts(110), score: null, live_time: "91' — 2ª parte" }, KO), null);
  assert.equal(marcadorFinalCreible({ ts: ts(110), score: '2:1', live_time: "91' — 2ª parte" }, KO), null);
  assert.equal(marcadorFinalCreible({ ts: 'basura', score: '2-1', live_time: "91' — 2ª parte" }, KO), null);
  assert.equal(marcadorFinalCreible({ ts: ts(110), score: '2-1', live_time: "91' — 2ª parte" }, NaN), null);
});
