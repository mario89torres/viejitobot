const test = require('node:test');
const assert = require('node:assert');
// Antes que src/confidence: ver tests/helpers/db-temporal.js.
const { sembrarGuardas } = require('./helpers/db-temporal');
const { rankPicks, safestPicks, goldenPick, isExcluded } = require('../src/confidence');

const ts = new Date().toISOString();
  // Marcador 1-0 y no 2-0: con 2-0 el evaluador de situacion devuelve 1.0
  // ("situacion perfecta") y la regla R5 del firewall veta la fila — con razon,
  // es un falso positivo sistematico que rinde -12.4%. Con 1-0 la conf sale
  // IDENTICA (0.842 con fairProb 0.90 al minuto 85), asi que los pisos que
  // prueba este archivo siguen midiendo lo mismo sobre una fila emitible.
const mk = (id, sport) => ({
  ts, sport, sportId: 66, champ: 'T', eventId: id,
  event: `Equipo${id}A vs. Equipo${id}B`, score: '1-0', liveTime: "85'",
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
  sembrarGuardas(rows);
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
  sembrarGuardas(rows);
  withEnv('Béisbol', () => {
    assert.deepStrictEqual(safestPicks(rows, 10).map(p => p.sport), ['Fútbol']);
    const g = goldenPick(rows, { minConf: 0, minOdds: 1.05, minEdge: -9 });
    assert.ok(g && g.sport === 'Fútbol', 'golden no debe elegir un deporte excluido');
  });
});

test('varios deportes separados por coma', () => {
  const rows = [mk(1, 'Béisbol'), mk(2, 'Fútbol'), mk(3, 'Tenis')];
  sembrarGuardas(rows);
  withEnv('beisbol, tenis', () => {
    assert.deepStrictEqual(rankPicks(rows, { minConf: 0, minEdge: 0, n: 10 }).map(p => p.sport), ['Fútbol']);
  });
});
