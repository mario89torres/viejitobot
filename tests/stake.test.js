const test = require('node:test');
const assert = require('node:assert');
const { computeStake, kellyFraction } = require('../src/confidence');

test('kellyFraction: casos conocidos', () => {
  // edge=0 (conf*odd=1): fracción de Kelly es 0
  assert.strictEqual(kellyFraction(0.5, 2.0), 0);
  // edge negativo: se acota a 0, nunca apuesta en contra de sí mismo
  assert.strictEqual(kellyFraction(0.4, 2.0), 0);
  // f* = (b·p − q)/b con b=0.45, p=0.75, q=0.25 -> (0.3375-0.25)/0.45 = 0.1944
  assert.ok(Math.abs(kellyFraction(0.75, 1.45) - 0.1944) < 1e-3);
  // momio <= 1 (b<=0): siempre 0
  assert.strictEqual(kellyFraction(0.9, 1.0), 0);
});

test('computeStake: flat siempre es 1 unidad', () => {
  assert.strictEqual(computeStake(0.5, 1.5, 'flat'), 1);
  assert.strictEqual(computeStake(0.99, 5.0, 'flat'), 1);
});

test('computeStake: kelly completo es el doble que medio Kelly', () => {
  const half = computeStake(0.75, 1.45, 'half_kelly');
  const full = computeStake(0.75, 1.45, 'kelly');
  assert.ok(Math.abs(full - half * 2) < 0.15, `full=${full} debe ser ~2x half=${half}`);
});

test('computeStake: no satura con edges típicos del histórico (1u=5% bankroll)', () => {
  // casos medidos: mediana del edge histórico da ~1.1u en medio-Kelly, no 5u
  const s = computeStake(0.75, 1.45, 'half_kelly');
  assert.ok(s > 0.5 && s < 5, `stake=${s} debe tener variación real, no saturar en el tope`);
});

test('computeStake: respeta el piso y el techo', () => {
  const prevMin = process.env.STAKE_MIN, prevMax = process.env.STAKE_MAX;
  try {
    process.env.STAKE_MIN = '0.2';
    process.env.STAKE_MAX = '2';
    delete require.cache[require.resolve('../src/confidence')];
    const { computeStake: cs } = require('../src/confidence');
    // edge minúsculo -> se acota al piso
    assert.ok(cs(0.51, 2.0, 'half_kelly') >= 0.2);
    // edge enorme -> se acota al techo
    assert.strictEqual(cs(0.99, 1.1, 'half_kelly'), 2);
  } finally {
    if (prevMin === undefined) delete process.env.STAKE_MIN; else process.env.STAKE_MIN = prevMin;
    if (prevMax === undefined) delete process.env.STAKE_MAX; else process.env.STAKE_MAX = prevMax;
    delete require.cache[require.resolve('../src/confidence')];
  }
});

test('computeStake: sin edge (conf*odd<=1) cae al piso, no a 0', () => {
  const s = computeStake(0.4, 2.0, 'half_kelly');
  assert.strictEqual(s, Number(process.env.STAKE_MIN || 0.1));
});

test('stakeStats: desglose diario cuadra con el total', () => {
  const { db, logPicks } = require('../src/db');
  const { stakeStats } = require('../src/metrics');
  const EIDS = [999999801, 999999802, 999999803];
  const limpiar = () => db.prepare(`DELETE FROM picks WHERE event_id IN (${EIDS.join(',')})`).run();
  limpiar();
  // dos días locales distintos: 18:00Z cae en el día local anterior (UTC-6)
  const base = (d, h) => `2026-06-${d}T${String(h).padStart(2,'0')}:00:00.000Z`;
  const mk = (id, ts, odd) => ({
    ts, eventId: id, event: `E${id} vs. F${id}`, sport: 'Fútbol',
    market: 'Total 2.5', selection: 'Menos de 2.5', oddDecimal: odd, conf: 0.75,
    stake: 2, stakeMode: 'half_kelly',
  });
  logPicks([mk(EIDS[0], base('10', 12), 1.5), mk(EIDS[1], base('10', 20), 1.5), mk(EIDS[2], base('11', 12), 1.5)]);
  db.prepare(`UPDATE picks SET result='win', final_score='1-0' WHERE event_id IN (${EIDS[0]},${EIDS[2]})`).run();
  db.prepare(`UPDATE picks SET result='loss', final_score='3-0' WHERE event_id = ${EIDS[1]}`).run();
  try {
    const s = stakeStats();
    const mios = s.byDay.filter(d => ['2026-06-10','2026-06-11'].includes(d.dia));
    assert.ok(mios.length >= 2, 'debe haber al menos dos días');
    // la suma de los días reproduce el total
    const sumN = s.byDay.reduce((a, d) => a + d.n, 0);
    const sumP = s.byDay.reduce((a, d) => a + d.profit, 0);
    assert.strictEqual(sumN, s.n, 'los picks por día suman el total');
    assert.ok(Math.abs(sumP - s.profit) < 1e-9, 'el P&L por día suma el total');
    // la banca acumulada del último día es el P&L total
    assert.ok(Math.abs(s.byDay[s.byDay.length-1].acumulado - s.profit) < 1e-9,
      'la banca final iguala el P&L total');
    // el acumulado es monótono en su construcción (cada paso suma el día)
    for (let i = 1; i < s.byDay.length; i++) {
      const esperado = s.byDay[i-1].acumulado + s.byDay[i].profit;
      assert.ok(Math.abs(s.byDay[i].acumulado - esperado) < 1e-9, 'la banca acumula correctamente');
    }
  } finally { limpiar(); }
});

test('stakeStats: agrupa por día LOCAL, no UTC', () => {
  const { db, logPicks } = require('../src/db');
  const { stakeStats } = require('../src/metrics');
  const EID = 999999810;
  const limpiar = () => db.prepare('DELETE FROM picks WHERE event_id = ?').run(EID);
  limpiar();
  // 2026-06-15T03:00Z son las 21:00 del 14 en CDMX -> debe contar como día 14
  logPicks([{
    ts: '2026-06-15T03:00:00.000Z', eventId: EID, event: 'A vs. B', sport: 'Fútbol',
    market: 'Total 2.5', selection: 'Menos de 2.5', oddDecimal: 1.5, conf: 0.75,
    stake: 1, stakeMode: 'half_kelly',
  }]);
  db.prepare('UPDATE picks SET result=\'win\', final_score=\'1-0\' WHERE event_id = ?').run(EID);
  try {
    const s = stakeStats();
    assert.ok(s.byDay.some(d => d.dia === '2026-06-14'), 'las 21:00 locales pertenecen al día 14');
    assert.ok(!s.byDay.some(d => d.dia === '2026-06-15'), 'no debe caer en el día UTC');
  } finally { limpiar(); }
});

test('stakePicksByDate: devuelve los picks liquidados filtrados por fecha local', () => {
  const { db, logPicks } = require('../src/db');
  const { stakePicksByDate } = require('../src/metrics');
  const EIDS = [999999820, 999999821];
  const limpiar = () => db.prepare(`DELETE FROM picks WHERE event_id IN (${EIDS.join(',')})`).run();
  limpiar();

  logPicks([
    {
      ts: '2026-06-14T15:00:00.000Z', eventId: EIDS[0], event: 'Equipo A vs. B', sport: 'Fútbol',
      market: 'Ganador', selection: 'Equipo A', oddDecimal: 2.0, conf: 0.70,
      stake: 1.5, stakeMode: 'flat',
    },
    {
      ts: '2026-06-14T18:00:00.000Z', eventId: EIDS[1], event: 'Equipo C vs. D', sport: 'Tenis',
      market: 'Ganador', selection: 'Equipo C', oddDecimal: 1.8, conf: 0.80,
      stake: 1.0, stakeMode: 'flat',
    },
  ]);
  db.prepare(`UPDATE picks SET result='win', final_score='2-0' WHERE event_id = ${EIDS[0]}`).run();
  db.prepare(`UPDATE picks SET result='loss', final_score='0-2' WHERE event_id = ${EIDS[1]}`).run();

  try {
    const res = stakePicksByDate('2026-06-14');
    assert.strictEqual(res.date, '2026-06-14');
    assert.strictEqual(res.n, 2);
    assert.strictEqual(res.wins, 1);
    assert.strictEqual(res.staked, 2.5);
    // win: 1.5 * (2.0 - 1) = 1.5. loss: -1.0. Profit total = +0.5
    assert.ok(Math.abs(res.profit - 0.5) < 1e-6);
    assert.strictEqual(res.picks.length, 2);
  } finally { limpiar(); }
});

