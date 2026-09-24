const { test } = require('node:test');
const assert = require('node:assert');
const { rescuePicks, POST_SCORE_GATES } = require('../src/confidence');

// MODEL_RESCUE deja pasar SOLO la población medida: candidatos que fallan
// exactamente la puerta min_conf y que el modelo coloca en su top 30%.
// Ensanchar eso es extrapolar a una zona sin validar — la trampa contra la que
// existe el comentario de rescuePicks.

const base = (extra = {}) => ({
  eventId: 1, event: 'A vs. B', sport: 'Fútbol', champ: 'Liga',
  market: 'Total 2.5', selection: 'Menos de 2.5',
  oddDecimal: 1.5, suspended: 0, score: '0-0', minute: 40,
  ...extra,
});

test('sin umbral no rescata nada (apagado por defecto)', () => {
  assert.deepEqual(rescuePicks([base()], { minLearned: 0 }), []);
});

test('la puerta min_conf sigue existiendo en el conjunto de puertas', () => {
  // Si alguien la renombra, rescuePicks dejaría de encontrarla y pasaría de
  // rescatar la población medida a no rescatar nada (o peor, otra cosa).
  assert.ok(POST_SCORE_GATES.some(([n]) => n === 'min_conf'),
    'rescuePicks depende del nombre exacto de la puerta min_conf');
});

test('nunca devuelve más de n ni repite evento', () => {
  const rows = [
    base({ eventId: 7, market: 'Total 2.5', selection: 'Menos de 2.5' }),
    base({ eventId: 7, market: 'Total 3.5', selection: 'Menos de 3.5' }),
    base({ eventId: 8 }),
  ];
  const out = rescuePicks(rows, { minLearned: 0.0001, minConf: 0.70, n: 5 });
  const eventos = out.map(p => p.eventId);
  assert.equal(new Set(eventos).size, eventos.length, 'no debe repetir evento');
  assert.ok(out.length <= 5);
});

test('respeta el tope n', () => {
  const rows = Array.from({ length: 20 }, (_, i) => base({ eventId: 100 + i }));
  assert.ok(rescuePicks(rows, { minLearned: 0.0001, minConf: 0.70, n: 2 }).length <= 2);
});

test('un candidato que YA pasa min_conf no es rescatable', () => {
  // minConf=0 hace que la puerta min_conf pase siempre: entonces el candidato
  // falla 0 puertas y no pertenece a la población de rescate.
  const out = rescuePicks([base()], { minLearned: 0.0001, minConf: 0 });
  assert.deepEqual(out, [], 'sin puerta fallada no hay rescate');
});

test('los rescates quedan fuera del rendimiento principal', () => {
  const { db } = require('../src/db');
  const { stakeStats, rescueStats } = require('../src/metrics');
  const antes = stakeStats();
  const ts = new Date().toISOString();
  const info = db.prepare(`INSERT INTO picks (ts,event_id,event,sport,market,selection,
      odd_decimal,conf,result,stake,stake_mode,source)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(ts, -777, 'R vs. R', 'Fútbol', 'Total 2.5', 'Menos de 2.5',
         2.0, 0.6, 'win', 0.25, 'rescue', 'rescue');
  try {
    const despues = stakeStats();
    assert.equal(despues.n, antes.n, 'un rescate NO debe entrar en stakeStats');
    assert.equal(despues.profit.toFixed(4), antes.profit.toFixed(4),
      'un rescate NO debe mover el P/L principal');
    const r = rescueStats();
    assert.ok(r.n >= 1, 'rescueStats sí debe verlo');
  } finally {
    db.prepare('DELETE FROM picks WHERE id = ?').run(info.lastInsertRowid);
  }
});
