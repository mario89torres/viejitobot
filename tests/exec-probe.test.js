// buscarEstado (src/execProbe.js): clasifica un pick como ok / susp / gone a
// partir del overview normalizado. Es lo que decide si un pick "seguia
// apostable" en el sondeo de ejecutabilidad, asi que un error aqui falsea toda
// la medicion.
const test = require('node:test');
const assert = require('node:assert');
const { buscarEstado } = require('../src/execProbe');

const item = { eventId: 10, market: 'Total 2.5', selection: 'Menos de 2.5', oddDecimal: 1.5 };
const fila = (o = {}) => ({ eventId: 10, market: 'Total 2.5', selection: 'Menos de 2.5', oddDecimal: 1.45, suspended: 0, score: '1-0', ...o });

test('seleccion activa -> ok con la cuota vista', () => {
  const r = buscarEstado([fila()], item);
  assert.deepStrictEqual(r, { status: 'ok', oddSeen: 1.45, scoreSeen: '1-0' });
});

test('seleccion suspendida -> susp', () => {
  assert.strictEqual(buscarEstado([fila({ suspended: 1 })], item).status, 'susp');
});

test('evento ausente del overview -> gone', () => {
  const r = buscarEstado([fila({ eventId: 99 })], item);
  assert.strictEqual(r.status, 'gone');
  assert.strictEqual(r.oddSeen, null);
});

test('evento presente pero la linea ya no existe -> gone, conserva el marcador', () => {
  const r = buscarEstado([fila({ selection: 'Menos de 3.5' })], item);
  assert.strictEqual(r.status, 'gone');
  assert.strictEqual(r.scoreSeen, '1-0');
});

test('no confunde selecciones del mismo evento con otro mercado', () => {
  const r = buscarEstado([fila({ market: 'Total 3.5' })], item);
  assert.strictEqual(r.status, 'gone');
});
