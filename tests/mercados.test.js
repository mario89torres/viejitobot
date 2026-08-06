const test = require('node:test');
const assert = require('node:assert');
const { parsePick, gradePick } = require('../src/markets');
const { rankPicks, isOverPick } = require('../src/confidence');

const ev = 'Kalsdorf vs. SC Bruck';

test('mercados "N-ésimo gol" se rechazan: no son calificables', () => {
  for (const mk of ['Primer Gol', 'Cuarto Gol', 'Quinto Gol', 'Séptimo Gol', 'Décimo Gol']) {
    assert.strictEqual(parsePick({ market: mk, selection: 'Kalsdorf', event: ev }), null, `${mk} debe dar null`);
    assert.strictEqual(gradePick({ market: mk, selection: 'Kalsdorf', event: ev }, '5-1'), null);
  }
  // el caso que destapó el bug: 3 goles en total, se apostaba al 4º
  assert.strictEqual(gradePick({ market: 'Cuarto Gol', selection: 'Kalsdorf', event: ev }, '3-0'), null,
    'sin 4º gol no puede haber ganador');
});

test('"Total X" no se confunde con los N-ésimo gol', () => {
  const t = parsePick({ market: 'Total 2.5', selection: 'Menos de 2.5', event: ev });
  assert.ok(t && t.type === 'total' && t.over === false);
  assert.strictEqual(gradePick({ market: 'Total 2.5', selection: 'Menos de 2.5', event: ev }, '1-0'), 'win');
  assert.strictEqual(gradePick({ market: 'Total 2.5', selection: 'Más de 2.5', event: ev }, '1-0'), 'loss');
});

test('draw no bet: el empate devuelve, no pierde', () => {
  const row = { market: 'Empate No Accion', selection: 'Kalsdorf', event: ev };
  assert.deepStrictEqual(parsePick(row), { type: 'dnb', side: 'home' });
  assert.strictEqual(gradePick(row, '2-1'), 'win');
  assert.strictEqual(gradePick(row, '0-2'), 'loss');
  assert.strictEqual(gradePick(row, '1-1'), null, 'el empate anula la apuesta');
});

test('BLOCK_OVERS_IN veta los "más de X"', () => {
  const ts = new Date().toISOString();
  const mk = (id, sel, market) => ({
    ts, sport: 'Fútbol', sportId: 66, champ: 'T', eventId: id, event: `E${id}A vs. E${id}B`,
    score: '1-0', liveTime: "80'", minute: 80, setNum: null, market, selection: sel,
    oddDecimal: 1.45, oddAmerican: '-', fairProb: 0.85, suspended: 0,
  });
  const rows = [mk(1, 'Más de 2.5', 'Total 2.5'), mk(2, 'Menos de 2.5', 'Total 2.5'), mk(3, 'E3A', 'Resultado Final')];
  const prev = process.env.BLOCK_OVERS_IN;
  try {
    process.env.BLOCK_OVERS_IN = 'futbol';
    delete require.cache[require.resolve('../src/confidence')];
    const c = require('../src/confidence');
    const got = c.rankPicks(rows, { minConf: 0, minEdge: 0, n: 10 }).map(p => p.selection);
    assert.ok(!got.some(s => /^Más de/.test(s)), `no debe emitir "más de": ${JSON.stringify(got)}`);
    assert.ok(got.includes('Menos de 2.5'), 'los "menos de" siguen pasando');
  } finally {
    if (prev === undefined) delete process.env.BLOCK_OVERS_IN; else process.env.BLOCK_OVERS_IN = prev;
    delete require.cache[require.resolve('../src/confidence')];
  }
});

test('isOverPick distingue dirección', () => {
  assert.strictEqual(isOverPick({ marketType: 'total', selection: 'Más de 3.5' }), true);
  assert.strictEqual(isOverPick({ marketType: 'total', selection: 'Mas de 3.5' }), true);
  assert.strictEqual(isOverPick({ marketType: 'total', selection: 'Menos de 3.5' }), false);
  assert.strictEqual(isOverPick({ marketType: 'winner', selection: 'Equipo A' }), false);
});

test('el veto de overs NO se extrapola a otros deportes', () => {
  const { isBlockedOver } = require('../src/confidence');
  const prev = process.env.BLOCK_OVERS_IN;
  process.env.BLOCK_OVERS_IN = 'futbol';
  try {
    assert.strictEqual(isBlockedOver({ sport: 'Fútbol', selection: 'Más de 2.5', marketType: 'total' }), true);
    // en béisbol el patrón se invierte (unders pierden), así que no se bloquea
    assert.strictEqual(isBlockedOver({ sport: 'Béisbol', selection: 'Más de 8.5', marketType: 'total' }), false);
    assert.strictEqual(isBlockedOver({ sport: 'Tenis', selection: 'Más de 21.5', marketType: 'total' }), false);
  } finally { if (prev === undefined) delete process.env.BLOCK_OVERS_IN; else process.env.BLOCK_OVERS_IN = prev; }
});

test('veto por falta de certidumbre: mercados no interpretables no se emiten', () => {
  const { rankPicks, goldenPick, isUncertain } = require('../src/confidence');
  const ts = new Date().toISOString();
  const mk = (id, market, sel) => ({
    ts, sport: 'Fútbol', sportId: 66, champ: 'T', eventId: id, event: `E${id}A vs. E${id}B`,
    score: '2-0', liveTime: "80'", minute: 80, setNum: null, market, selection: sel,
    oddDecimal: 1.45, oddAmerican: '-', fairProb: 0.85, suspended: 0,
  });
  assert.strictEqual(isUncertain({ marketType: null }), true);
  assert.strictEqual(isUncertain({}), true, 'sin marketType también es incierto');
  assert.strictEqual(isUncertain({ marketType: 'winner' }), false);

  const rows = [
    mk(1, 'Cuarto Gol', 'E1A'),          // no calificable
    // ojo: 'X' NO sirve aquí como selección genérica — es la notación de empate
    // y parsea como draw. Hace falta algo que no case con local/visitante/empate.
    mk(2, 'Mercado Desconocido', 'Opción rara'),
    mk(3, 'Resultado Final', 'E3A'),     // válido
    mk(4, 'Total 2.5', 'Menos de 2.5'),  // válido
  ];
  const got = rankPicks(rows, { minConf: 0, minEdge: 0, n: 10 }).map(p => p.market);
  assert.deepStrictEqual(got.sort(), ['Resultado Final', 'Total 2.5']);
  const g = goldenPick(rows, { minConf: 0, minOdds: 1.05, minEdge: -9 });
  assert.ok(!g || ['Resultado Final', 'Total 2.5'].includes(g.market));
});

test('experimento MIN_EDGE_UNDER: alcance y umbral', () => {
  const { isFootballUnder, edgeThresholdFor } = require('../src/confidence');
  // solo "menos de" de fútbol 11 entra al experimento
  const casos = [
    [{ sport: 'Fútbol', selection: 'Menos de 2.5', marketType: 'total' }, true],
    [{ sport: 'Fútbol', selection: 'Más de 2.5', marketType: 'total' }, false],
    [{ sport: 'Béisbol', selection: 'Menos de 8.5', marketType: 'total' }, false],
    [{ sport: 'Fútbol Rápido', selection: 'Menos de 3.5', marketType: 'total' }, false],
    [{ sport: 'Fútbol', selection: 'Equipo A', marketType: 'winner' }, false],
  ];
  for (const [r, esperado] of casos) {
    assert.strictEqual(isFootballUnder(r), esperado, `${r.sport}/${r.selection}`);
  }

  const prev = process.env.MIN_EDGE_UNDER;
  try {
    process.env.MIN_EDGE_UNDER = '0';
    // el under de fútbol usa el umbral del experimento; el resto, el normal
    assert.strictEqual(edgeThresholdFor(casos[0][0], 0.02), 0);
    assert.strictEqual(edgeThresholdFor(casos[1][0], 0.02), 0.02);
    assert.strictEqual(edgeThresholdFor(casos[2][0], 0.02), 0.02);
    assert.strictEqual(edgeThresholdFor(casos[3][0], 0.02), 0.02, 'futsal no entra');
    // cerrar el experimento devuelve todo al umbral normal
    delete process.env.MIN_EDGE_UNDER;
    assert.strictEqual(edgeThresholdFor(casos[0][0], 0.02), 0.02);
  } finally {
    if (prev === undefined) delete process.env.MIN_EDGE_UNDER; else process.env.MIN_EDGE_UNDER = prev;
  }
});

test('experimento: rankPicks deja pasar el under de bajo edge y nada más', () => {
  const ts = new Date().toISOString();
  const mk = (id, sport, sportId, market, sel, odd, fair) => ({
    ts, sport, sportId, champ: 'T', eventId: id, event: `E${id}A vs. E${id}B`,
    score: '1-0', liveTime: "80'", minute: 80, setNum: null, market, selection: sel,
    oddDecimal: odd, oddAmerican: '-', fairProb: fair, suspended: 0,
  });
  // fairProb elegido para que el conf quede sobre 0.70 pero con edge < 0.02
  const rows = [
    mk(1, 'Fútbol', 66, 'Total 2.5', 'Menos de 2.5', 1.40, 0.62),
    mk(2, 'Béisbol', 76, 'Totales 8.5', 'Menos de 8.5', 1.40, 0.62),
  ];
  const prev = process.env.MIN_EDGE_UNDER;
  try {
    process.env.MIN_EDGE_UNDER = '0';
    delete require.cache[require.resolve('../src/confidence')];
    const c = require('../src/confidence');
    const got = c.rankPicks(rows, { minConf: 0.70, minEdge: 0.02, n: 10 });
    // ningún pick de béisbol puede colarse por el experimento
    assert.ok(!got.some(p => p.sport === 'Béisbol' && p.edge < 0.02),
      'el experimento no debe afectar a otros deportes');
  } finally {
    if (prev === undefined) delete process.env.MIN_EDGE_UNDER; else process.env.MIN_EDGE_UNDER = prev;
    delete require.cache[require.resolve('../src/confidence')];
  }
});
