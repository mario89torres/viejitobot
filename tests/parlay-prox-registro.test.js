require('./helpers/db-temporal');
const test = require('node:test');
const assert = require('node:assert');
const dbm = require('../src/db');

const fila = (id, extra = {}) => ({ ts: '2026-10-05T14:00:00.000Z', dia: '2026-10-05', kind: 'parlay_prox', event_id: id, event: `E${id}`,
  champ: 'X', start_date: '2026-10-05T18:00:00Z', market: 'Doble oportunidad', selection: `S${id}`, odd_decimal: 1.25, p_justa: 0.75, ...extra });
const parlay = (ids, ts) => ids.map((i) => fila(i, { ts }));

test('registra un parlay y NO lo vuelve a registrar aunque las patas lleguen en otro orden u otra hora', () => {
  assert.strictEqual(dbm.guardarParlayProx(parlay([1, 2, 3, 4], 't1'), '2026-10-05'), true);
  assert.strictEqual(dbm.guardarParlayProx(parlay([4, 3, 2, 1], 't2'), '2026-10-05'), false, 'mismo parlay, otro orden');
  assert.strictEqual(dbm.db.prepare("SELECT COUNT(*) n FROM prematch_report_picks WHERE kind='parlay_prox'").get().n, 4);
});

test('un parlay distinto el mismo día sí se registra; el mismo parlay otro día también', () => {
  assert.strictEqual(dbm.guardarParlayProx(parlay([1, 2, 3, 9], 't3'), '2026-10-05'), true);
  assert.strictEqual(dbm.guardarParlayProx(parlay([1, 2, 3, 4].map((i) => i), 't4').map((f) => ({ ...f, dia: '2026-10-06' })), '2026-10-06'), true);
});

test('sin patas no guarda nada', () => {
  assert.strictEqual(dbm.guardarParlayProx([], '2026-10-05'), false);
  assert.strictEqual(dbm.guardarParlayProx(null, '2026-10-05'), false);
});

test('parlay_prox NO cuenta como "reporte ya enviado": no bloquea el reporte de las 08:00', () => {
  assert.strictEqual(dbm.reporteYaEnviado('2026-10-05'), false, 'solo hay parlay_prox ese día');
  dbm.saveReportPicks([fila(50, { kind: 'parlay' })]);
  assert.strictEqual(dbm.reporteYaEnviado('2026-10-05'), true, 'un parlay del reporte sí lo marca');
});

test('parlay_prox NO entra en el estado de picks de las 08:00', () => {
  const kinds = new Set(dbm.reporteEstado('2026-10-05').map((f) => f.kind));
  assert.ok(kinds.has('parlay'));
  assert.ok(!kinds.has('parlay_prox'));
});

test('las patas registradas quedan pendientes para la liquidación existente', () => {
  const pend = dbm.reportePendientes('2027-01-01T00:00:00Z');
  assert.ok(pend.some((f) => f.kind === 'parlay_prox'), 'reportePendientes las incluye: la liquidación cada 30 min las resuelve');
});
