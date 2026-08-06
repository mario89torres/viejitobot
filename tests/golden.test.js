const test = require('node:test');
const assert = require('node:assert');
const { goldenPick } = require('../src/confidence');

// filas sintéticas con fairProb alto para controlar la confianza resultante
const ts = new Date().toISOString();
const mk = (id, odd, fairProb) => ({
  ts, sport: 'Fútbol', sportId: 66, champ: 'T', eventId: id,
  event: `Equipo${id}A vs. Equipo${id}B`, score: '2-0', liveTime: "85'",
  minute: 85, setNum: null, market: 'Ganador del partido', selection: `Equipo${id}A`,
  oddDecimal: odd, oddAmerican: '-', fairProb, suspended: 0,
});

test('goldenPick maximiza edge entre candidatos con confianza suficiente', () => {
  const rows = [
    mk(1, 1.20, 0.95), // conf alta, edge moderado
    mk(2, 1.45, 0.90), // conf alta, momio mayor → edge máximo esperado
    mk(3, 2.80, 0.40), // edge alto solo si la conf lo permitiera (no llega al piso)
  ];
  const p = goldenPick(rows, { minConf: 0.70, minOdds: 1.15, minEdge: 0 });
  assert.ok(p, 'debe encontrar pick');
  assert.strictEqual(p.eventId, 2);
  assert.ok(p.edge > 0);
});

test('goldenPick veta la banda de momios tóxica y respeta el piso de confianza', () => {
  // momio 1.05: aunque la conf sea altísima, queda fuera por minOdds
  const low = [mk(1, 1.05, 0.99)];
  assert.strictEqual(goldenPick(low, { minConf: 0.70, minOdds: 1.15, minEdge: 0 }), null);
  // conf insuficiente: fuera aunque el edge diera positivo
  const weak = [mk(2, 2.00, 0.35)];
  assert.strictEqual(goldenPick(weak, { minConf: 0.70, minOdds: 1.15, minEdge: 0 }), null);
});

test('goldenPick exige edge positivo (y respeta MIN_EDGE)', () => {
  // conf ~0.7-0.8 con momio 1.16 → edge negativo o marginal → null con minEdge alto
  const rows = [mk(1, 1.16, 0.80)];
  const relaxed = goldenPick(rows, { minConf: 0.70, minOdds: 1.15, minEdge: 0 });
  const strict = goldenPick(rows, { minConf: 0.70, minOdds: 1.15, minEdge: 0.15 });
  if (relaxed) assert.ok(relaxed.edge > 0, 'si emite, el edge debe ser positivo');
  assert.strictEqual(strict, null, 'con minEdge 0.15 este candidato no pasa');
});

test('goldenPick ignora suspendidos y devuelve null sin candidatos', () => {
  const rows = [{ ...mk(1, 1.30, 0.95), suspended: 1 }];
  assert.strictEqual(goldenPick(rows, { minConf: 0.70, minOdds: 1.15, minEdge: 0 }), null);
  assert.strictEqual(goldenPick([], {}), null);
});
