const test = require('node:test');
const assert = require('node:assert');
const { db, logPicks, isDuplicatePick, countPicksSince } = require('../src/db');

const EID = 999999950;
const base = {
  ts: new Date().toISOString(), eventId: EID, event: 'Dedup vs. Test', sport: 'Fútbol',
  market: 'Ganador del partido', selection: 'Dedup', oddDecimal: 1.5, conf: 0.85,
};

test.after(() => db.prepare('DELETE FROM picks WHERE event_id = ?').run(EID));

test('isDuplicatePick: falso antes de registrar, verdadero después', () => {
  db.prepare('DELETE FROM picks WHERE event_id = ?').run(EID);
  assert.strictEqual(isDuplicatePick(EID, base.market, base.selection), false);
  logPicks([base]);
  assert.strictEqual(isDuplicatePick(EID, base.market, base.selection), true);
});

test('bloquea otro mercado del MISMO evento mientras el pick siga vivo', () => {
  // picks del mismo partido están correlacionados: solo uno activo a la vez
  assert.strictEqual(isDuplicatePick(EID, 'Total de goles 2.5', 'Mas de 2.5'), true);
});

test('tras liquidar, otro mercado del evento se permite pero la misma selección no', () => {
  db.prepare(`UPDATE picks SET result = 'win' WHERE event_id = ?`).run(EID);
  // mismo evento, mercado distinto: ya no hay pick vivo -> permitido
  assert.strictEqual(isDuplicatePick(EID, 'Total de goles 2.5', 'Mas de 2.5'), false);
  // misma selección exacta: sigue bloqueada aunque esté liquidada
  assert.strictEqual(isDuplicatePick(EID, base.market, base.selection), true);
});

test('countPicksSince cuenta solo picks source=auto (el tope horario de autoPicks)', () => {
  const hourAgo = new Date(Date.now() - 3600 * 1000).toISOString();
  const before = countPicksSince(hourAgo);
  // Sin source: 'auto' no cuenta — countPicksSince filtra por source='auto'
  // porque solo autoPicks() en bot.js respeta AUTO_PICK_MAX_PER_HOUR; /seguras
  // y /golden son manuales y no deben chocar contra ese tope.
  logPicks([{ ...base, selection: 'Manual', market: 'Otro mercado' }]);
  assert.strictEqual(countPicksSince(hourAgo), before, 'un pick sin source=auto no debe sumar al tope horario');

  logPicks([{ ...base, selection: 'Auto', market: 'Otro mercado', source: 'auto' }]);
  assert.strictEqual(countPicksSince(hourAgo), before + 1);

  // ventana futura: no cuenta nada
  assert.strictEqual(countPicksSince(new Date(Date.now() + 60000).toISOString()), 0);
});
