const test = require('node:test');
const assert = require('node:assert');
const { rankPicks, safestPicks, goldenPick, isExcluded } = require('../src/confidence');

const ts = new Date().toISOString();
const mk = (id, sport) => ({
  ts, sport, sportId: 66, champ: 'T', eventId: id,
  event: `Equipo${id}A vs. Equipo${id}B`, score: '2-0', liveTime: "85'",
  minute: 85, setNum: null, market: 'Ganador del partido', selection: `Equipo${id}A`,
  oddDecimal: 1.45, oddAmerican: '-', fairProb: 0.85, suspended: 0,
});

function withEnv(val, fn) {
  const prev = process.env.EXCLUDE_SPORTS;
  if (val === undefined) delete process.env.EXCLUDE_SPORTS; else process.env.EXCLUDE_SPORTS = val;
  try { return fn(); } finally {
    if (prev === undefined) delete process.env.EXCLUDE_SPORTS; else process.env.EXCLUDE_SPORTS = prev;
  }
}

test('isExcluded ignora acentos y mayúsculas', () => {
  const list = ['beisbol'];
  for (const s of ['Béisbol', 'Beisbol', 'beisbol', 'BÉISBOL']) {
    assert.ok(isExcluded(s, list), `${s} debe excluirse`);
  }
  for (const s of ['Fútbol', 'Tenis', 'Baloncesto']) {
    assert.ok(!isExcluded(s, list), `${s} NO debe excluirse`);
  }
  assert.ok(!isExcluded('Béisbol', []), 'lista vacía no excluye nada');
});

test('rankPicks respeta EXCLUDE_SPORTS en ambas grafías', () => {
  const rows = [mk(1, 'Béisbol'), mk(2, 'Fútbol'), mk(3, 'Beisbol'), mk(4, 'Tenis')];
  withEnv('Béisbol', () => {
    const got = rankPicks(rows, { minConf: 0, minEdge: 0, n: 10 }).map(p => p.sport);
    assert.deepStrictEqual(got.sort(), ['Fútbol', 'Tenis']);
  });
  // sin exclusión pasan los cuatro
  withEnv('', () => {
    assert.strictEqual(rankPicks(rows, { minConf: 0, minEdge: 0, n: 10 }).length, 4);
  });
});

test('la exclusión llega a /seguras, automáticos y /golden', () => {
  const rows = [mk(1, 'Béisbol'), mk(2, 'Fútbol')];
  withEnv('Béisbol', () => {
    assert.deepStrictEqual(safestPicks(rows, 10).map(p => p.sport), ['Fútbol']);
    const g = goldenPick(rows, { minConf: 0, minOdds: 1.05, minEdge: -9 });
    assert.ok(g && g.sport === 'Fútbol', 'golden no debe elegir un deporte excluido');
  });
});

test('varios deportes separados por coma', () => {
  const rows = [mk(1, 'Béisbol'), mk(2, 'Fútbol'), mk(3, 'Tenis')];
  withEnv('beisbol, tenis', () => {
    assert.deepStrictEqual(rankPicks(rows, { minConf: 0, minEdge: 0, n: 10 }).map(p => p.sport), ['Fútbol']);
  });
});
