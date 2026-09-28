const test = require('node:test');
const assert = require('node:assert');
const {
  esTextoDeConfirmacion, esPeticionDeApuesta, areaExcesiva, latenciaDesdeEmision,
  decimalToAmerican, parsearCuota, regexEtiqueta,
} = require('../src/dryRunHelpers');

test('esTextoDeConfirmacion: bloquea apostar/confirmar y deja pasar cuotas y mercados', () => {
  for (const t of ['Apostar', 'APOSTAR $10', 'Confirmar apuesta', 'Realizar apuesta', 'Realizar la apuesta', 'Place bet', 'Apuesta ahora']) {
    assert.equal(esTextoDeConfirmacion(t), true, t);
  }
  for (const t of ['1,85', '+150', 'Menos de 2.5', 'Ambos equipos marcan', '', null]) {
    assert.equal(esTextoDeConfirmacion(t), false, String(t));
  }
});

test('esPeticionDeApuesta: rutas reales del SDK de Altenar; cualquier método que escribe', () => {
  const P = (p, method = 'POST') => esPeticionDeApuesta({ method, url: `https://x.test/api/${p}` });
  for (const r of ['widget/placeWidget', 'widget/placeToto', 'aamsApi/Bet/PayBetImmediate',
    'WidgetBetOperations/cancelBet', 'WidgetBetOperations/processPendingBet', 'WidgetBetOperations/widgetCashout']) {
    assert.equal(P(r), true, r);
  }
  assert.equal(P('widget/placeWidget', 'PUT'), true, 'PUT también se bloquea');
  assert.equal(P('widget/placeWidget', 'DELETE'), true, 'DELETE también se bloquea');
  for (const r of ['Betslip/reserveBet', 'widget/GetEventDetails']) assert.equal(P(r), false, r);
  assert.equal(P('widget/placeWidget', 'GET'), false, 'GET nunca escribe');
  assert.equal(esPeticionDeApuesta({ url: 'https://x.test/api/widget/placeWidget' }), false, 'sin método = GET');
  assert.equal(esPeticionDeApuesta(), false);
});

test('areaExcesiva: un botón de cuota pasa; un contenedor o un elemento sin caja, no', () => {
  assert.equal(areaExcesiva({ width: 150, height: 50 }), false);
  assert.equal(areaExcesiva({ width: 1000, height: 600 }), true);
  assert.equal(areaExcesiva(null), true);
  assert.equal(areaExcesiva({ width: 0, height: 10 }), true);
});

test('latenciaDesdeEmision: ms desde la emisión; null si la fecha es inválida o futura', () => {
  const emit = '2026-09-26T12:00:00.000Z';
  assert.equal(latenciaDesdeEmision(emit, Date.parse('2026-09-26T12:00:05.500Z')), 5500);
  assert.equal(latenciaDesdeEmision('no es fecha', Date.now()), null);
  assert.equal(latenciaDesdeEmision(emit, Date.parse('2026-09-26T11:59:00.000Z')), null);
});

test('decimalToAmerican', () => {
  assert.equal(decimalToAmerican(2.5), '+150');
  assert.equal(decimalToAmerican(2.0), '+100');
  assert.equal(decimalToAmerican(1.5), '-200');
  assert.equal(decimalToAmerican(1.45), '-222');
  assert.equal(decimalToAmerican(1), null);
  assert.equal(decimalToAmerican(null), null);
});

test('parsearCuota: americana con signo y decimal; lo ambiguo, null', () => {
  assert.ok(Math.abs(parsearCuota('-184') - 1.543478) < 1e-5);
  assert.equal(parsearCuota('+350'), 4.5);
  assert.equal(parsearCuota('+450'), 5.5);
  assert.equal(parsearCuota('1,85'), 1.85);
  assert.equal(parsearCuota('1.45'), 1.45);
  assert.equal(parsearCuota('150'), null, 'sin signo es ambiguo');
  assert.equal(parsearCuota('-50'), null);
  assert.equal(parsearCuota('abc'), null);
  // signo menos unicode y espacios raros que un sitio puede usar
  assert.ok(Math.abs(parsearCuota('−385') - 1.259740) < 1e-5);
  assert.ok(Math.abs(parsearCuota(' − 385 ') - 1.259740) < 1e-5);
  assert.equal(parsearCuota('+240'), 3.4);
});

test('regexEtiqueta: etiqueta exacta de la selección', () => {
  const r = regexEtiqueta('Menos de 3.5');
  assert.equal(r.test('Menos de 3.5'), true);
  assert.equal(r.test('  menos  de 3.5 '), true);
  assert.equal(r.test('Menos de 13.5'), false);
  assert.equal(r.test('Menos de 3x5'), false);
  assert.equal(r.test('Más de 3.5'), false);
  assert.equal(regexEtiqueta('Empate o Dayrout').test('Empate o Dayrout'), true);
});