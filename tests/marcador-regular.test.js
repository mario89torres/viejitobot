require('./helpers/db-temporal');
const test = require('node:test');
const assert = require('node:assert');
const { db, getLastScore, getLastRegularScore } = require('../src/db');
const { esFutbolPick, resultFor } = require('../src/results');

const ins = db.prepare(`INSERT INTO snapshots (ts, sport, sport_id, champ, event_id, event, score, live_time, market, selection, odd_decimal, odd_american, suspended)
  VALUES (?, 'Fútbol', 66, 'X', ?, 'China (F) vs. Vietnam (F)', ?, ?, 'Resultado Final (Tiempo Regular)', 'China (F)', 2, 100, 0)`);
const muestra = (ts, ev, score, lt) => ins.run(ts, ev, score, lt);

test('el marcador de la prorroga no cuenta como marcador de tiempo regular', () => {
  muestra('2026-09-25T07:46:00Z', 1, '0-0', "90' — 2ª parte");
  muestra('2026-09-25T07:47:00Z', 1, '0-0', "91' — Esperando prórroga");
  muestra('2026-09-25T08:00:00Z', 1, '0-0', "106' — Descanso prórroga");
  muestra('2026-09-25T08:28:00Z', 1, '1-0', "121' — 2ª Parte Adicional");
  assert.strictEqual(getLastScore(1).score, '1-0');
  assert.strictEqual(getLastRegularScore(1).score, '0-0');
  // el bug real: "Empate o Vietnam" con 1-0 pierde, con 0-0 gana
  const pick = { market: 'Doble oportunidad', selection: 'Empate o Vietnam (F)', event: 'China (F) vs. Vietnam (F)', sport: 'Fútbol' };
  assert.strictEqual(resultFor(pick, '1-0'), 'loss');
  assert.strictEqual(resultFor(pick, '0-0'), 'win');
});

test('un gol en el descuento del tiempo regular SI cuenta y "Esperando prorroga" tambien', () => {
  muestra('2026-09-25T07:00:00Z', 2, '1-1', "89' — 2ª parte");
  muestra('2026-09-25T07:03:00Z', 2, '2-1', "93' — 2ª parte");
  assert.strictEqual(getLastRegularScore(2).score, '2-1');
  muestra('2026-09-25T07:05:00Z', 3, '1-1', "91' — Esperando prórroga");
  assert.strictEqual(getLastRegularScore(3).score, '1-1');
});

test('penales no cuentan y sin muestras da undefined', () => {
  muestra('2026-09-25T07:00:00Z', 4, '2-2', "120' — 2ª parte");
  muestra('2026-09-25T07:10:00Z', 4, '5-4', 'Penales — Penales');
  assert.strictEqual(getLastRegularScore(4).score, '2-2');
  assert.strictEqual(getLastRegularScore(999), undefined);
});

test('solo el futbol usa el marcador regular', () => {
  assert.ok(esFutbolPick('Fútbol') && esFutbolPick('futbol') && !esFutbolPick('Hockey') && !esFutbolPick(null));
});
