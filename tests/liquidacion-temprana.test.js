const { test } = require('node:test');
const assert = require('node:assert');
const { decidedResult } = require('../src/markets');

// La liquidación temprana solo puede dispararse cuando el desenlace es
// IRREVERSIBLE. Aflojar esta regla es el error que ya costó caro una vez:
// liquidar el grupo de control contra marcadores de primer tiempo inventó
// +159u de edge inexistente (ver src/results.js:settleRejectedGroup).
//
// La propiedad que lo sostiene es la MONOTONÍA: los goles solo suben. Por eso
// "ya se pasó de la línea" decide para siempre, y "aún no ha llegado" no
// decide nada.

const ev = { event: 'A vs. B', sport: 'Fútbol' };
const dec = (market, selection, score, extra = {}) =>
  decidedResult({ ...ev, ...extra, market, selection }, score);

test('total: se liquida solo cuando la línea YA se superó', () => {
  assert.equal(dec('Total 2.5', 'Menos de 2.5', '2-1'), 'loss'); // 3 goles
  assert.equal(dec('Total 2.5', 'Más de 2.5', '2-1'), 'win');
  assert.equal(dec('Total 3.5', 'Menos de 3.5', '2-2'), 'loss'); // 4 goles
});

test('total: por debajo de la línea NO decide nada, en ningún sentido', () => {
  // Under vivo: aún puede caer el gol que lo mata.
  assert.equal(dec('Total 2.5', 'Menos de 2.5', '2-0'), null);
  // Over pendiente: NO se declara perdido aunque vaya tarde el partido.
  assert.equal(dec('Total 2.5', 'Más de 2.5', '1-1'), null);
  // Justo un gol por debajo: sigue sin decidirse.
  assert.equal(dec('Total 3.5', 'Menos de 3.5', '2-1'), null);
});

test('marcador EXACTO en la línea entera no se liquida antes (sería push)', () => {
  // Total 2 con 2 goles es push, no win/loss: no es asunto de la temprana.
  assert.equal(dec('Total 2', 'Menos de 2', '1-1'), null);
});

test('ambos marcan: irreversible solo cuando ambos ya marcaron', () => {
  assert.equal(dec('Ambos equipos marcan', 'No', '1-1'), 'loss');
  assert.equal(dec('Ambos equipos marcan', 'Sí', '1-1'), 'win');
  assert.equal(dec('Ambos equipos marcan', 'No', '1-0'), null);
  assert.equal(dec('Ambos equipos marcan', 'Sí', '3-0'), null);
});

test('ganador y empate-no-acción NUNCA se liquidan antes', () => {
  // Un 3-0 al 80' no decide: puede acabar 3-3.
  assert.equal(dec('Resultado Final (Tiempo Regular)', 'A', '3-0'), null);
  assert.equal(dec('Empate No Accion', 'A', '2-0'), null);
  assert.equal(dec('Doble oportunidad', 'A o Empate', '2-0'), null);
});

test('tenis queda fuera: los sets no son acumulativos como los goles', () => {
  assert.equal(dec('Total 2.5', 'Menos de 2.5', '2-1', { sport: 'Tenis' }), null);
});

test('sin marcador utilizable no se liquida', () => {
  assert.equal(dec('Total 2.5', 'Menos de 2.5', ''), null);
  assert.equal(dec('Total 2.5', 'Menos de 2.5', null), null);
  assert.equal(dec('Total 2.5', 'Menos de 2.5', 'Descanso'), null);
});

test('monotonía: si decide a favor con N goles, sigue decidiendo con más', () => {
  // Propiedad general — ningún marcador posterior puede invertir el veredicto.
  for (let total = 3; total <= 12; total++) {
    const score = `${total}-0`;
    assert.equal(dec('Total 2.5', 'Menos de 2.5', score), 'loss');
    assert.equal(dec('Total 2.5', 'Más de 2.5', score), 'win');
  }
});
