require('./helpers/db-temporal');
const test = require('node:test');
const assert = require('node:assert');
const { db, getLastRegularScore } = require('../src/db');
const { marcadorEsFinal } = require('../src/results');

test('futbol: solo es final el 85+ de la 2ª parte o "Esperando prórroga"', () => {
  for (const lt of ["90' — 2ª parte", "93' — 2ª parte", "85' — 2ª parte", "91' — Esperando prórroga"]) {
    assert.strictEqual(marcadorEsFinal('Fútbol', lt), true, lt);
  }
  // el caso real: pick #6582 (Japón vs. Venezuela), último snapshot en el descanso
  for (const lt of ["45' — 1ª parte", 'Descanso — Descanso', "84' — 2ª parte", "60' — 2ª parte", "Sólo Resultado", '', null, undefined]) {
    assert.strictEqual(marcadorEsFinal('Fútbol', lt), false, String(lt));
  }
});

test('un 85+ que no es de la 2ª parte no cuenta (p.ej. 1ª parte con minuto raro)', () => {
  assert.strictEqual(marcadorEsFinal('Fútbol', "90' — 1ª parte"), false);
});

test('el umbral es configurable por argumento', () => {
  assert.strictEqual(marcadorEsFinal('Fútbol', "84' — 2ª parte", 80), true);
  assert.strictEqual(marcadorEsFinal('Fútbol', "84' — 2ª parte", 90), false);
});

test('otros deportes no cambian de comportamiento (su live_time no se ha medido)', () => {
  assert.strictEqual(marcadorEsFinal('Hockey', "1º Periodo"), true);
  assert.strictEqual(marcadorEsFinal('Béisbol', null), true);
});

test('getLastRegularScore devuelve el live_time de la muestra elegida', () => {
  const ins = db.prepare(`INSERT INTO snapshots (ts, sport, sport_id, champ, event_id, event, score, live_time, market, selection, odd_decimal, odd_american, suspended)
    VALUES (?, 'Fútbol', 66, 'X', 555, 'A vs. B', ?, ?, 'Total 1.5', 'Menos de 1.5', 1.5, -200, 0)`);
  ins.run('2026-09-28T11:20:00Z', '0-0', "45' — 1ª parte");
  ins.run('2026-09-28T11:28:45Z', '0-0', 'Descanso — Descanso');
  const last = getLastRegularScore(555);
  assert.strictEqual(last.score, '0-0');
  assert.strictEqual(last.live_time, 'Descanso — Descanso');
  assert.strictEqual(marcadorEsFinal('Fútbol', last.live_time), false);
});
