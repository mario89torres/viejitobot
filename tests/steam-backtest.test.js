const test = require('node:test');
const assert = require('node:assert/strict');
const { gano, roi, devigProporcional, bootstrapPorPartido, claseMovimiento, MERCADO_1X2, MERCADO_OU } = require('../scripts/backtest-steam-prematch');

const cerca = (a, b, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol, `${a} deberia estar a ${tol} de ${b}`);

test('gano 1X2: local, empate y visita', () => {
  assert.equal(gano(MERCADO_1X2, 'Barcelona', 'Barcelona', 'Sevilla', 2, 1), true);
  assert.equal(gano(MERCADO_1X2, 'Sevilla', 'Barcelona', 'Sevilla', 2, 1), false);
  assert.equal(gano(MERCADO_1X2, 'Empate', 'Barcelona', 'Sevilla', 1, 1), true);
  assert.equal(gano(MERCADO_1X2, 'Empate', 'Barcelona', 'Sevilla', 2, 1), false);
  assert.equal(gano(MERCADO_1X2, 'Sevilla', 'Barcelona', 'Sevilla', 0, 3), true);
});

test('gano Total 2.5: 3 goles es "Mas de", 2 es "Menos de"', () => {
  assert.equal(gano(MERCADO_OU, 'Más de 2.5', 'A', 'B', 2, 1), true);
  assert.equal(gano(MERCADO_OU, 'Menos de 2.5', 'A', 'B', 2, 1), false);
  assert.equal(gano(MERCADO_OU, 'Menos de 2.5', 'A', 'B', 1, 1), true);
  assert.equal(gano(MERCADO_OU, 'Más de 2.5', 'A', 'B', 0, 0), false);
});

test('gano: null si no se puede resolver (nombre desconocido, mercado ajeno, marcador roto)', () => {
  assert.equal(gano(MERCADO_1X2, 'Otro equipo', 'A', 'B', 1, 0), null);
  assert.equal(gano('Doble oportunidad', 'A o empate', 'A', 'B', 1, 0), null);
  assert.equal(gano(MERCADO_1X2, 'A', 'A', 'B', null, 0), null);
  assert.equal(gano(MERCADO_1X2, 'A', 'A', 'B', 1.5, 0), null);
});

test('roi: stake plano; una cuota 2.0 que gana y otra que pierde dan 0', () => {
  cerca(roi([{ odd: 2, gano: true }, { odd: 2, gano: false }]), 0);
  cerca(roi([{ odd: 1.5, gano: true }]), 50);
  cerca(roi([{ odd: 3, gano: false }]), -100);
  assert.equal(roi([]), null);
});

test('devigProporcional: suma 1 y respeta el orden de las cuotas', () => {
  const p = devigProporcional([2.0, 3.5, 4.0]);
  cerca(p.reduce((a, b) => a + b, 0), 1);
  assert.ok(p[0] > p[1] && p[1] > p[2]);
  cerca(devigProporcional([2, 2])[0], 0.5);
});

test('claseMovimiento: steam si la cuota baja, deriva si sube, plano dentro del umbral', () => {
  assert.equal(claseMovimiento(-0.05, 0.03), 'steam');
  assert.equal(claseMovimiento(-0.03, 0.03), 'steam');
  assert.equal(claseMovimiento(0.05, 0.03), 'deriva');
  assert.equal(claseMovimiento(0.01, 0.03), 'plano');
  assert.equal(claseMovimiento(-0.029, 0.03), 'plano');
});

test('bootstrapPorPartido: determinista y remuestrea PARTIDOS, no filas', () => {
  const grupos = Array.from({ length: 20 }, (_, i) => [{ odd: 2, gano: i % 2 === 0 }, { odd: 2, gano: i % 2 === 1 }]);
  const a = bootstrapPorPartido(grupos, roi, 500, 3), b = bootstrapPorPartido(grupos, roi, 500, 3);
  assert.deepEqual(a, b);
  // cada partido aporta un acierto y un fallo a cuota 2: el ROI es exactamente 0 en toda remuestra
  cerca(a[0], 0); cerca(a[1], 0);
});

test('bootstrapPorPartido: el intervalo se ensancha con menos partidos y contiene el valor puntual', () => {
  const mk = (n) => Array.from({ length: n }, (_, i) => [{ odd: 2.2, gano: i % 3 === 0 }]);
  const chico = bootstrapPorPartido(mk(15), roi, 800, 5), grande = bootstrapPorPartido(mk(150), roi, 800, 5);
  assert.ok(chico[1] - chico[0] > grande[1] - grande[0]);
  const puntual = roi(mk(150).flat());
  assert.ok(grande[0] <= puntual && puntual <= grande[1]);
  assert.equal(bootstrapPorPartido([], roi), null);
});
