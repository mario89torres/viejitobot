// Veto total del mercado "Doble oportunidad" en fútbol.
//
// Medido 2026-09-29, histórico completo (n=138): ROI -4.9% (-6.8u), negativo en las
// dos mitades del historial y en TODOS los buckets de edge (incluido 14%+: -7.7%,
// el peor de todos) -- no es un problema de umbral, es el mercado. Solo aparece en
// fútbol (169/169 filas), así que el veto no distingue por deporte.
//
// Se prueba isBlockedMarket directamente, no vía rankPicks: ver tests/dnb-veto.test.js
// para el porqué (guarda 5 rechaza filas sintéticas sin histórico de snapshots).
const test = require('node:test');
const assert = require('node:assert');
const { isBlockedMarket } = require('../src/confidence');

const base = { event: 'Alfa vs. Beta', sport: 'Fútbol', conf: 0.82, edge: 0.09 };

test('veta "Doble oportunidad" sin importar la selección ni cuán fuerte sea conf/edge', () => {
  for (const selection of ['Equipo A o Empate', 'Empate o Equipo B', 'Equipo A o Equipo B']) {
    assert.strictEqual(
      isBlockedMarket({ ...base, market: 'Doble oportunidad', selection }),
      true, `no vetó "${selection}"`);
  }
});

test('el veto no depende de que conf/edge existan', () => {
  assert.strictEqual(
    isBlockedMarket({ event: 'Alfa vs. Beta', market: 'Doble oportunidad', selection: 'Equipo A o Empate' }),
    true);
});

test('NO toca otros mercados (Total, 1X2, Ambos equipos marcan)', () => {
  const otros = [
    { ...base, market: 'Total 2.5', selection: 'Menos de 2.5' },
    { ...base, market: 'Resultado Final (Tiempo Regular)', selection: 'Equipo A' },
    { ...base, market: 'Ambos equipos marcan', selection: 'No' },
  ];
  for (const r of otros) {
    assert.strictEqual(isBlockedMarket(r), false, `vetó de más: ${r.market} / ${r.selection}`);
  }
});
