const test = require('node:test');
const assert = require('node:assert');
const { lineaXg } = require('../src/xgAviso');

const fila = (extra = {}) => ({ xg_esperado_local: 1.64, xg_esperado_visita: 1.26, xg_esperado_total: 2.9, home_played: 10, away_played: 12, ...extra });

test('con dato y muestra suficiente: total, lados y base (el menor de los dos equipos)', () => {
  assert.strictEqual(lineaXg(fila()), '<i>📊 xG prepartido 2.9 (local 1.6 · visita 1.3) · base 10 partidos</i>');
});

test('sin fila, o fila con xG nulo (FotMob no cubre la liga): no hay línea', () => {
  assert.strictEqual(lineaXg(null), '');
  assert.strictEqual(lineaXg(undefined), '');
  assert.strictEqual(lineaXg(fila({ xg_esperado_total: null, xg_esperado_local: null, xg_esperado_visita: null })), '');
  assert.strictEqual(lineaXg(fila({ xg_esperado_total: 0 })), '');
});

test('muestra mínima: Tailandia-Vietnam daba 20.7 con 1 partido por lado y no debe mostrarse', () => {
  assert.strictEqual(lineaXg(fila({ xg_esperado_total: 20.7, home_played: 1, away_played: 1 })), '');
  assert.strictEqual(lineaXg(fila({ home_played: 10, away_played: 4 })), '');
  assert.strictEqual(lineaXg(fila({ home_played: 10, away_played: 5 })).includes('base 5 partidos'), true);
  assert.strictEqual(lineaXg(fila({ home_played: null, away_played: 10 })), '');
});

test('umbral configurable por argumento; si faltan los lados se muestra solo el total', () => {
  assert.notStrictEqual(lineaXg(fila({ home_played: 3, away_played: 3 }), { minPartidos: 3 }), '');
  assert.strictEqual(lineaXg(fila({ xg_esperado_local: null, xg_esperado_visita: null })), '<i>📊 xG prepartido 2.9 · base 10 partidos</i>');
});
