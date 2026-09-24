const { test } = require('node:test');
const assert = require('node:assert');
const { modelVersion, score, reloadModel } = require('../src/model');

// El sello identifica QUÉ modelo produjo cada conf_learned. Sin él, agrupar por
// conf_learned cruzando dos modelos mezcla dos escalas distintas sin avisar —
// cada reentrenamiento mueve el significado del número, y el cambio de
// calibración isotónica -> Platt del 2026-08-25 lo movió mucho.

test('el sello lleva timestamp y hash de contenido', () => {
  const v = modelVersion();
  assert.ok(v, 'debe haber sello con model.json presente');
  assert.match(v, /^\d{8}T\d{6}Z-[0-9a-f]{7}$/,
    `formato esperado AAAAMMDDTHHMMSSZ-hash7, recibido: ${v}`);
});

test('es estable entre recargas del mismo fichero', () => {
  const a = modelVersion();
  reloadModel();
  assert.equal(modelVersion(), a, 'recargar el mismo model.json no cambia el sello');
});

test('score() devuelve el sello junto al conf que sella', () => {
  const feats = {
    f_prob_justa: 0.62, f_avance: 0.5, f_situacion: 0.8, f_linea: 0.6, f_apertura: 0.55,
    is_under: 1, is_over: 0, is_btts: 0, is_ganador: 0, is_dnb: 0, linea: 2.5,
  };
  const s = score(feats, 'Fútbol');
  assert.equal(s.modelVersion, modelVersion());
  // Si hay confLearned, tiene que haber sello: son la misma información.
  if (s.confLearned !== null) assert.ok(s.modelVersion, 'confLearned sin sello');
});

test('la columna existe en las tres tablas que guardan conf_learned', () => {
  const { db } = require('../src/db');
  for (const t of ['picks', 'model_picks', 'rejected_picks']) {
    const cols = db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name);
    assert.ok(cols.includes('model_version'), `${t} sin columna model_version`);
    assert.ok(cols.includes('conf_learned'), `${t} sin conf_learned`);
  }
});

test('el sello viaja hasta la fila insertada', () => {
  const { db, logPicks } = require('../src/db');
  const v = modelVersion();
  const [id] = logPicks([{
    ts: new Date().toISOString(), eventId: -99999, event: 'TEST vs. TEST',
    sport: 'Fútbol', market: 'Total 2.5', selection: 'Menos de 2.5',
    oddDecimal: 1.5, conf: 0.7, confLearned: 0.71, modelVersion: v,
  }]);
  try {
    const fila = db.prepare('SELECT model_version, conf_learned FROM picks WHERE id = ?').get(id);
    assert.equal(fila.model_version, v, 'el sello no llegó a la BD');
    assert.equal(fila.conf_learned, 0.71);
  } finally {
    db.prepare('DELETE FROM picks WHERE id = ?').run(id);
  }
});

test('sin sello explícito la fila queda NULL, no rompe el INSERT', () => {
  const { db, logPicks } = require('../src/db');
  const [id] = logPicks([{
    ts: new Date().toISOString(), eventId: -99998, event: 'TEST2 vs. TEST2',
    sport: 'Fútbol', market: 'Total 2.5', selection: 'Menos de 2.5',
    oddDecimal: 1.5, conf: 0.7,
  }]);
  try {
    assert.equal(db.prepare('SELECT model_version FROM picks WHERE id = ?').get(id).model_version, null);
  } finally {
    db.prepare('DELETE FROM picks WHERE id = ?').run(id);
  }
});
