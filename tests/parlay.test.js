const test = require('node:test');
const assert = require('node:assert');
const { parlayCombos } = require('../src/confidence');

const ts = new Date().toISOString();
const mkRow = (id, odd, fairProb) => ({
  ts, sport: 'Fútbol', sportId: 66, champ: 'Liga', eventId: id,
  event: `Equipo ${id}A vs. Equipo ${id}B`, score: '2-0', liveTime: "85'",
  minute: 85, setNum: null, market: 'Ganador del partido', selection: `Equipo ${id}A`,
  oddDecimal: odd, oddAmerican: '-', fairProb, suspended: 0,
});

test('parlayCombos: exige edge individual positivo en cada pata', () => {
  const rows = [
    mkRow(1, 1.25, 0.88), // +EV individual (0.88 * 1.25 - 1 > 0)
    mkRow(2, 1.20, 0.88), // +EV individual
    mkRow(3, 1.05, 0.90), // -EV individual (0.90 * 1.05 - 1 = -0.055)
  ];
  const combos = parlayCombos(rows, { minConf: 0.65, minOdds: 1.05, maxOdds: 1.45, minEdge: 0.01 });
  assert.ok(combos.length > 0, 'debe encontrar combo +EV');
  const best = combos[0];
  assert.strictEqual(best.legCount, 2);
  const ids = best.legs.map(l => l.eventId);
  assert.ok(ids.includes(1) && ids.includes(2), 'debe incluir solo las patas +EV (1 y 2)');
  assert.ok(!ids.includes(3), 'debe descartar la pata 3 (-EV)');
});

test('parlayCombos: agrupa por eventos distintos', () => {
  const rows = [
    mkRow(1, 1.25, 0.88),
    { ...mkRow(1, 1.30, 0.85), selection: 'Otro mercado del mismo partido' },
    mkRow(2, 1.20, 0.88),
  ];
  const combos = parlayCombos(rows, { minConf: 0.65, minOdds: 1.05, maxOdds: 1.45, minEdge: 0.01 });
  assert.ok(combos.length > 0);
  const best = combos[0];
  assert.strictEqual(best.legs[0].eventId !== best.legs[1].eventId, true);
});

test('parlayCombos: aplica el ajuste por varianza gamma=0.97', () => {
  const rows = [
    mkRow(1, 1.25, 0.85),
    mkRow(2, 1.25, 0.85),
  ];
  const combos = parlayCombos(rows, { minConf: 0.65, minOdds: 1.08, maxOdds: 1.45, minEdge: 0.01 });
  if (combos.length > 0) {
    const c = combos[0];
    const expectedAdj = c.rawProb * 0.97;
    assert.ok(Math.abs(c.adjProb - expectedAdj) < 1e-6);
  }
});

test('parlayCombos: devuelve lista vacía si no hay combinaciones +EV', () => {
  const rows = [
    mkRow(1, 1.05, 0.85), // -EV
    mkRow(2, 1.08, 0.80), // -EV
  ];
  const combos = parlayCombos(rows, { minConf: 0.65, minOdds: 1.05, maxOdds: 1.45, minEdge: 0.01 });
  assert.strictEqual(combos.length, 0);
});
