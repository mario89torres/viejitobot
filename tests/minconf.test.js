const test = require('node:test');
const assert = require('node:assert');
// Antes que src/confidence: fija DB_PATH a una BD temporal. Sin esto, la
// guardia 5 (4+ snapshots activos) rechaza las filas sinteticas en bloque y
// todas las aserciones de abajo reciben [].
const { sembrarGuardas } = require('./helpers/db-temporal');
const { rankPicks, safestPicks } = require('../src/confidence');

const ts = new Date().toISOString();
  // Marcador 1-0 y no 2-0: con 2-0 el evaluador de situacion devuelve 1.0
  // ("situacion perfecta") y la regla R5 del firewall veta la fila — con razon,
  // es un falso positivo sistematico que rinde -12.4%. Con 1-0 la conf sale
  // IDENTICA (0.842 con fairProb 0.90 al minuto 85), asi que los pisos que
  // prueba este archivo siguen midiendo lo mismo sobre una fila emitible.
const mk = (id, odd, fairProb) => ({
  ts, sport: 'Fútbol', sportId: 66, champ: 'T', eventId: id,
  event: `Equipo${id}A vs. Equipo${id}B`, score: '1-0', liveTime: "85'",
  minute: 85, setNum: null, market: 'Ganador del partido', selection: `Equipo${id}A`,
  oddDecimal: odd, oddAmerican: '-', fairProb, suspended: 0,
});

function withEnv(vars, fn) {
  const prev = {};
  for (const [k, v] of Object.entries(vars)) { prev[k] = process.env[k]; process.env[k] = v; }
  try { return fn(); } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

test('rankPicks: minConf filtra por piso de confianza', () => {
  const rows = [
    mk(1, 1.40, 0.90), // conf alta (odd 1.40, no 1.50: con 1.50 el edge sale >20% y lo corta el techo de edge nuevo — no es lo que este test mide)
    mk(2, 1.40, 0.30), // conf baja
  ];
  sembrarGuardas(rows);
  const all = rankPicks(rows, { minConf: 0 });
  assert.strictEqual(all.length, 2);
  const floored = rankPicks(rows, { minConf: 0.75 });
  assert.strictEqual(floored.length, 1);
  assert.strictEqual(floored[0].eventId, 1);
  assert.ok(floored[0].conf >= 0.75);
});

test('safestPicks respeta MIN_CONF del entorno (y 0 lo desactiva)', () => {
  const rows = [mk(1, 1.40, 0.90), mk(2, 1.40, 0.30)];
  sembrarGuardas(rows);
  withEnv({ MIN_CONF: '0.75', MIN_EDGE: '0' }, () => {
    const picks = safestPicks(rows, 3);
    assert.strictEqual(picks.length, 1);
    assert.strictEqual(picks[0].eventId, 1);
  });
  withEnv({ MIN_CONF: '0', MIN_EDGE: '0' }, () => {
    assert.strictEqual(safestPicks(rows, 3).length, 2);
  });
});

test('MIN_CONF y MIN_EDGE se combinan (ambos deben cumplirse)', () => {
  // conf alta pero momio tan bajo que el edge no llega al umbral
  const rows = [mk(1, 1.06, 0.92)];
  sembrarGuardas(rows);
  withEnv({ MIN_CONF: '0.75', MIN_EDGE: '0.02' }, () => {
    const picks = safestPicks(rows, 3);
    for (const p of picks) {
      assert.ok(p.conf >= 0.75);
      assert.ok(p.edge >= 0.02);
    }
  });
});
