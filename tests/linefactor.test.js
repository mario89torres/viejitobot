const test = require('node:test');
const assert = require('node:assert');
const { db } = require('../src/db');
const { lineTrend, SCORE_VERSION } = require('../src/confidence');

// Inserta una serie de precios sintética para un evento y mide el factor
const EID = 999999960;
const MK = 'Ganador del partido', SEL = 'Test';

function seed(prices) {
  db.prepare('DELETE FROM snapshots WHERE event_id = ?').run(EID);
  const ins = db.prepare(`INSERT INTO snapshots (ts, sport, sport_id, champ, event_id, event, score, live_time, market, selection, odd_decimal, odd_american, suspended)
    VALUES (?, 'Test', 66, '', ?, 'A vs B', '', '', ?, ?, ?, '', 0)`);
  const t0 = Date.now() - 30 * 60000;
  prices.forEach((p, i) => ins.run(new Date(t0 + i * 60000).toISOString(), EID, MK, SEL, p));
}
const factor = () => lineTrend({ eventId: EID, market: MK, selection: SEL }).lineFactor;

test.after(() => db.prepare('DELETE FROM snapshots WHERE event_id = ?').run(EID));

test('SCORE_VERSION es 2 (f_linea reescalada)', () => {
  assert.strictEqual(SCORE_VERSION, 2);
});

test('no satura: drifts grandes siguen diferenciándose (el bug de v1)', () => {
  seed([2.00, 1.80, 1.60, 1.40]);   // drift 30% — en v1 esto daba 1.0
  const drift30 = factor();
  seed([2.00, 1.50, 1.00 + 0.20, 0.90 + 0.15]); // drift mayor
  const driftBig = factor();
  assert.ok(drift30 < 1, `drift 30% no debe saturar (dio ${drift30})`);
  assert.ok(driftBig < 1, 'ni siquiera un drift enorme satura');
  assert.ok(driftBig > drift30, 'más drift => factor mayor (orden preservado)');
});

test('dirección correcta y neutralidad', () => {
  seed([1.50, 1.50, 1.50, 1.50]);          // sin movimiento
  const flat = factor();
  assert.ok(Math.abs(flat - 0.5) < 0.02, `sin movimiento ~0.5 (dio ${flat})`);

  seed([1.40, 1.60, 1.80, 2.00]);          // línea subiendo (en contra)
  assert.ok(factor() < 0.5, 'línea en contra => < 0.5');

  seed([2.00, 1.80, 1.60, 1.40]);          // línea bajando (a favor)
  assert.ok(factor() > 0.5, 'línea a favor => > 0.5');
});

test('la volatilidad penaliza aun con más drift', () => {
  // Par elegido para aislar la volatilidad: la serie caótica termina con MAYOR
  // drift medido que la oscilante, y aun así debe puntuar MENOS.
  seed([2.0, 1.7, 2.0, 1.7, 1.8, 1.5]);
  const oscilante = lineTrend({ eventId: EID, market: MK, selection: SEL });
  seed([2.0, 1.3, 2.2, 1.4, 2.0, 1.5]);
  const caotica = lineTrend({ eventId: EID, market: MK, selection: SEL });

  assert.ok(caotica.lineDelta > oscilante.lineDelta, 'la caótica tiene más drift bruto');
  assert.ok(caotica.lineFactor < oscilante.lineFactor,
    `pese a más drift debe puntuar menos por volatilidad (${caotica.lineFactor} vs ${oscilante.lineFactor})`);
});

test('sin historial suficiente devuelve 0.5', () => {
  db.prepare('DELETE FROM snapshots WHERE event_id = ?').run(EID);
  const r = lineTrend({ eventId: EID, market: MK, selection: SEL });
  assert.strictEqual(r.lineFactor, 0.5);
  assert.strictEqual(r.lineDelta, null);
});
