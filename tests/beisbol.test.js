const test = require('node:test');
const assert = require('node:assert');
const { baseballProgress } = require('../src/confidence');
const { normalize } = require('../src/normalize');

test('baseballProgress sigue la curva empírica, no la recta', () => {
  // al 5º inning va el 61% de la anotación real, no el 55.6% de inning/9
  assert.ok(Math.abs(baseballProgress(5) - 0.610) < 1e-9);
  assert.ok(baseballProgress(5) > 5 / 9, 'la curva adelanta a la recta en el centro');
  assert.ok(baseballProgress(6) > 6 / 9);
  // monótona
  for (let i = 1; i < 9; i++) assert.ok(baseballProgress(i + 1) > baseballProgress(i));
});

test('media entrada: el inning fraccionario interpola', () => {
  const seis = baseballProgress(6), sieteMedio = baseballProgress(6.5), siete = baseballProgress(7);
  assert.ok(sieteMedio > seis && sieteMedio < siete, 'el 6.5 cae entre el 6 y el 7');
  assert.ok(Math.abs(sieteMedio - (seis + siete) / 2) < 1e-9, 'interpolación lineal entre puntos');
});

test('el 9º ya NO satura en 1.0 (el bug que hacía ver seguros los "menos de")', () => {
  assert.ok(baseballProgress(9) < 1, `el 9º debe dejar margen, dio ${baseballProgress(9)}`);
  assert.strictEqual(baseballProgress(9.5), 1, 'solo las entradas extra saturan');
  assert.strictEqual(baseballProgress(12), 1);
});

test('sin inning conocido devuelve el neutro', () => {
  assert.strictEqual(baseballProgress(null), 0.5);
});

test('normalize detecta la mitad baja del inning', () => {
  const mk = (liveTime) => ({
    sport: { name: 'Béisbol', id: 76 },
    data: {
      champs: [], markets: [{ id: 1, name: 'Ganador', oddIds: [1, 2] }],
      odds: [{ id: 1, price: 1.5, name: 'A', oddStatus: 0 }, { id: 2, price: 2.6, name: 'B', oddStatus: 0 }],
      events: [{ id: 1, name: 'A vs. B', marketIds: [1], score: [1, 0], liveTime }],
    },
  });
  assert.strictEqual(normalize([mk('3rd inning top')])[0].minute, 3);
  assert.strictEqual(normalize([mk('3rd inning bottom')])[0].minute, 3.5, 'la mitad baja suma 0.5');
  assert.strictEqual(normalize([mk('3º inning')])[0].minute, 3, 'formato español sin mitad: entero');
});
