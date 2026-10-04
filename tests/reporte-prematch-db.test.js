require('./helpers/db-temporal');
const test = require('node:test');
const assert = require('node:assert');
const { db, saveReportPicks, reporteYaEnviado, reportePendientes, liquidarReportePick } = require('../src/db');

const base = { ts: '2026-09-25T14:00:00Z', dia: '2026-09-25', kind: 'parlay', event_id: 1, event: 'A vs. B', champ: 'X',
  start_date: '2026-09-25T18:00:00Z', market: 'Doble oportunidad', selection: 'A o empate', odd_decimal: 1.3, p_justa: 0.75 };

test('guarda patas con y sin xG, y las liquida', () => {
  saveReportPicks([{ ...base, xg_local: 1.6, xg_visita: 1.1, xg_total: 2.7 }, { ...base, event_id: 2 }]);
  assert.ok(reporteYaEnviado('2026-09-25'));
  assert.ok(!reporteYaEnviado('2026-09-24'));
  const filas = db.prepare('SELECT event_id, xg_total FROM prematch_report_picks ORDER BY event_id').all();
  assert.deepStrictEqual(filas, [{ event_id: 1, xg_total: 2.7 }, { event_id: 2, xg_total: null }]);
  const pend = reportePendientes('2026-09-26T00:00:00Z');
  assert.strictEqual(pend.length, 2);
  liquidarReportePick(pend[0].id, 'win', '2-1', 'fotmob');
  assert.strictEqual(reportePendientes('2026-09-26T00:00:00Z').length, 1);
  assert.strictEqual(db.prepare('SELECT result, final_score, score_source FROM prematch_report_picks WHERE id = ?').get(pend[0].id).result, 'win');
});

test('reporteEstado: desde el dia dado, parlay antes que valor y top', () => {
  const { reporteEstado } = require('../src/db');
  saveReportPicks([{ ...base, dia: '2026-09-26', kind: 'top', event_id: 10 }, { ...base, dia: '2026-09-26', kind: 'parlay', event_id: 11 },
    { ...base, dia: '2026-09-26', kind: 'valor', event_id: 12 }, { ...base, dia: '2026-09-20', kind: 'top', event_id: 13 }]);
  const r = reporteEstado('2026-09-26');
  assert.deepStrictEqual(r.map(x => x.kind), ['parlay', 'valor', 'top']);
});
