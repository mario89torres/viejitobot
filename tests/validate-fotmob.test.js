const test = require('node:test');
const assert = require('node:assert/strict');
const { _internal } = require('../src/validate');
const { elegirPartidoFotmob, marcadorOficial, verificarConFotmob, esFutbol } = _internal;

const ISO = (h) => new Date(Date.UTC(2026, 8, 23, h, 0, 0)).toISOString();
const pick = (over = {}) => ({ id: 1, ts: ISO(15), sport: 'Fútbol', event: 'Berwick Rangers vs. Stranraer FC', ...over });
const fm = (id, home, away, h) => ({ id, home, away, commenceTime: ISO(h) });

test('esFutbol: solo "Fútbol" a secas (no rápido, no e-Fútbol, no americano)', () => {
  assert.ok(esFutbol('Fútbol'));
  assert.ok(esFutbol('futbol'));
  assert.ok(!esFutbol('Fútbol Rápido'));
  assert.ok(!esFutbol('e-Fútbol'));
  assert.ok(!esFutbol('e-Fútbol americano'));
  assert.ok(!esFutbol('Hockey'));
});

test('elegirPartidoFotmob: elige el partido que ya habia empezado, no el de otro dia', () => {
  const cands = [fm(1, 'Berwick Rangers', 'Stranraer', 14), fm(2, 'Berwick Rangers', 'Stranraer', 14 + 24 * 7 - 0)];
  const m = elegirPartidoFotmob(pick(), cands);
  assert.equal(m.ev.id, 1);
  assert.equal(m.swapped, false);
});

test('elegirPartidoFotmob: descarta partidos que empiezan despues del pick o hace mas de 8 h', () => {
  assert.equal(elegirPartidoFotmob(pick(), [fm(1, 'Berwick Rangers', 'Stranraer', 17)]), null); // empieza 2 h despues
  assert.equal(elegirPartidoFotmob(pick(), [fm(1, 'Berwick Rangers', 'Stranraer', 6)]), null);  // 9 h antes
  assert.equal(elegirPartidoFotmob(pick(), [fm(1, 'Berwick Rangers', 'Stranraer', 8)]).ev.id, 1); // 7 h antes: en curso
});

test('elegirPartidoFotmob: detecta local/visita invertidos', () => {
  const m = elegirPartidoFotmob(pick(), [fm(1, 'Stranraer FC', 'Berwick Rangers', 14)]);
  assert.equal(m.swapped, true);
});

test('elegirPartidoFotmob: sin equipos coincidentes o sin datos -> null', () => {
  assert.equal(elegirPartidoFotmob(pick(), [fm(1, 'Celtic', 'Rangers', 14)]), null);
  assert.equal(elegirPartidoFotmob(pick({ event: 'sin separador' }), [fm(1, 'A', 'B', 14)]), null);
  assert.equal(elegirPartidoFotmob(pick({ ts: 'basura' }), [fm(1, 'Berwick Rangers', 'Stranraer', 14)]), null);
  assert.equal(elegirPartidoFotmob(pick(), []), null);
});

test('elegirPartidoFotmob: no confunde equipo femenino con el de mayores', () => {
  const p = pick({ event: 'Liverpool (F) vs. Everton (F)' });
  assert.equal(elegirPartidoFotmob(p, [fm(1, 'Liverpool', 'Everton', 14)]), null);
  assert.equal(elegirPartidoFotmob(p, [fm(2, 'Liverpool (W)', 'Everton (W)', 14)]).ev.id, 2);
});

test('marcadorOficial respeta el orden del evento de playdoit', () => {
  assert.equal(marcadorOficial(3, 2, false), '3-2');
  assert.equal(marcadorOficial(3, 2, true), '2-3');
});

test('verificarConFotmob: verifica terminados, cuenta pendientes y sin match, ignora otros deportes', async () => {
  const calendario = {
    '2026-09-22': [], '2026-09-24': [],
    '2026-09-23': [fm(10, 'Berwick Rangers', 'Stranraer', 14), fm(11, 'Celtic', 'Hearts', 14), fm(12, 'Muaither SC', 'Al-Khor SC', 14)],
  };
  const finales = { 10: { finished: true, home: 3, away: 2 }, 11: { finished: false, home: 1, away: 0 }, 12: { finished: true, home: 2, away: 0 } };
  const deps = {
    scheduledToday: async (d) => calendario[d] || [],
    fetchMarcadorFinal: async (id) => finales[id],
  };
  const picks = [
    pick({ id: 1 }),                                                            // terminado, coincide equipos
    pick({ id: 2, event: 'Celtic vs. Hearts' }),                                // sigue en curso
    pick({ id: 3, event: 'Equipo Fantasma vs. Otro Club' }),                    // sin match
    pick({ id: 4, sport: 'Hockey' }),                                           // otro deporte: ni se intenta
    pick({ id: 5, event: 'Al-Khor SC vs. Muaither SC' }),                       // local/visita invertidos
  ];
  const r = await verificarConFotmob(picks, deps);
  assert.deepEqual(r.verificados.map(v => [v.pick.id, v.oficial]), [[1, '3-2'], [5, '0-2']]);
  assert.equal(r.pendientes, 1);
  assert.equal(r.sinMatch, 1);
});

test('verificarConFotmob: un fallo de red en el detalle deja el pick como pendiente, no rompe', async () => {
  const deps = {
    scheduledToday: async () => [fm(10, 'Berwick Rangers', 'Stranraer', 14)],
    fetchMarcadorFinal: async () => { throw new Error('timeout'); },
  };
  const r = await verificarConFotmob([pick()], deps);
  assert.equal(r.verificados.length, 0);
  assert.equal(r.pendientes, 1);
});

test('verificarConFotmob: un calendario que falla se trata como vacio', async () => {
  const deps = { scheduledToday: async () => { throw new Error('HTTP 500'); }, fetchMarcadorFinal: async () => ({ finished: true, home: 1, away: 0 }) };
  const r = await verificarConFotmob([pick()], deps);
  assert.equal(r.verificados.length, 0);
  assert.equal(r.sinMatch, 1);
});
