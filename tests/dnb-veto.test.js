// Veto total del mercado DNB (Empate No Acción) tras BLOCK_DNB.
//
// Se prueba isBlockedMarket directamente y no vía rankPicks: las filas
// sintéticas no tienen histórico de snapshots, así que la guarda 5 ("mínimo 4
// snapshots activos") las rechaza antes de llegar aquí — la misma razón por la
// que fallan varios tests viejos de rankPicks.
const test = require('node:test');
const assert = require('node:assert');
const { isBlockedMarket } = require('../src/confidence');

const conEnv = (vars, fn) => {
  const prev = {};
  for (const [k, v] of Object.entries(vars)) { prev[k] = process.env[k]; process.env[k] = v; }
  try { return fn(); } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
};
// Un DNB que SÍ pasaría el filtro de convicción: conf y edge por encima del piso.
// `event` no es decorativo: isBlockedMarket llama a parsePick() para los
// mercados de totales, y parsePick hace row.event.split(...) sin comprobar. Una
// fila sin `event` no da "false", REVIENTA. En producción siempre viene.
const dnbFuerte = { event: 'Alfa vs. Beta', market: 'Empate No Accion',
                    selection: 'Equipo A', conf: 0.82, edge: 0.09 };

test('BLOCK_DNB=1 veta un DNB que la regla de convicción dejaría pasar', () => {
  assert.strictEqual(conEnv({ BLOCK_DNB: '0' }, () => isBlockedMarket(dnbFuerte)), false);
  assert.strictEqual(conEnv({ BLOCK_DNB: '1' }, () => isBlockedMarket(dnbFuerte)), true);
});

test('veta las tres grafías del mercado', () => {
  for (const market of ['Empate No Accion', 'Empate No Acción', 'Draw No Bet', 'DNB']) {
    assert.strictEqual(
      conEnv({ BLOCK_DNB: '1' }, () => isBlockedMarket({ ...dnbFuerte, market })),
      true, `no vetó "${market}"`);
  }
});

test('con BLOCK_DNB=1 no hace falta que conf ni edge existan', () => {
  // El veto es del MERCADO: no debe depender de campos que podrían faltar.
  assert.strictEqual(
    conEnv({ BLOCK_DNB: '1' }, () => isBlockedMarket({ event: 'Alfa vs. Beta', market: 'Empate No Accion', selection: 'Equipo A' })),
    true);
});

test('NO toca otros mercados', () => {
  const base = { event: 'Alfa vs. Beta', conf: 0.80, edge: 0.08 };
  const otros = [
    { ...base, market: 'Total 2.5', selection: 'Menos de 2.5' },
    { ...base, market: 'Resultado Final (Tiempo Regular)', selection: 'Equipo A' },
    { ...base, market: 'Ambos equipos marcan', selection: 'No' },
  ];
  for (const r of otros) {
    assert.strictEqual(conEnv({ BLOCK_DNB: '1' }, () => isBlockedMarket(r)), false,
      `vetó de más: ${r.market} / ${r.selection}`);
  }
});

test('sin BLOCK_DNB sigue vigente la regla de convicción de siempre', () => {
  delete process.env.BLOCK_DNB;
  assert.strictEqual(isBlockedMarket({ ...dnbFuerte, conf: 0.70 }), true, 'conf baja debe vetar');
  assert.strictEqual(isBlockedMarket({ ...dnbFuerte, edge: 0.02 }), true, 'edge bajo debe vetar');
  assert.strictEqual(isBlockedMarket(dnbFuerte), false, 'conf y edge altos deben pasar');
});
