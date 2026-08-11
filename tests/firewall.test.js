const test = require('node:test');
const assert = require('node:assert');

// El firewall lee su configuración de process.env en cada llamada, así que los
// defaults se fijan aquí ANTES de requerir el módulo. Sin esto el test heredaría
// el .env de la máquina y pasaría o fallaría según la config local.
process.env.FIREWALL_ENABLED = 'true';
process.env.FIREWALL_BLOCK_OVERS = 'true';
process.env.FIREWALL_MIN_AVANCE = '0.40';
process.env.FIREWALL_MAX_ODDS = '3.0';
process.env.FIREWALL_MAX_SITUACION = '0.99';
process.env.FIREWALL_MAX_UNDER_LINE = '3.5';

const { firewallVerdict, isUnder, underLine } = require('../src/firewall');

// Pick base que NO dispara ninguna regla: sirve de control para que un fallo
// se atribuya a la regla que se está probando y no al estado de partida.
const base = (over = {}) => ({
  market: 'Total 2.5', selection: 'Menos de 2.5', oddDecimal: 1.45,
  progress: 0.80, scoreFactor: 0.60, lineFactor: 0.60, marketType: 'total',
  ...over,
});

test('firewall: el pick de control no dispara ninguna regla', () => {
  const v = firewallVerdict(base());
  assert.strictEqual(v.blocked, false, `no debía bloquear, disparó: ${v.rules.join(',')}`);
});

test('R7: corta los Under de línea alta y respeta los bajos', () => {
  // El edge de Under está en las líneas bajas: <=3.5 rinde +9.8% (IC sobre
  // cero) y >3.5 se queda en +0.7% con el IC cruzando cero. Ver la nota de R7.
  for (const sel of ['Menos de 0.5', 'Menos de 1.5', 'Menos de 2.5', 'Menos de 3.5']) {
    assert.strictEqual(firewallVerdict(base({ selection: sel })).blocked, false, `${sel} no debía bloquearse`);
  }
  for (const sel of ['Menos de 4.5', 'Menos de 5.5', 'Menos de 10.5']) {
    const v = firewallVerdict(base({ selection: sel }));
    assert.ok(v.rules.includes('R7:under_linea_alta'), `${sel} debía disparar R7`);
  }
});

test('R7: el umbral es configurable y 0 la desactiva', () => {
  const prev = process.env.FIREWALL_MAX_UNDER_LINE;
  process.env.FIREWALL_MAX_UNDER_LINE = '5.5';
  assert.strictEqual(firewallVerdict(base({ selection: 'Menos de 4.5' })).blocked, false);
  // 0 = regla apagada, mismo convenio que el resto de máximos del firewall.
  process.env.FIREWALL_MAX_UNDER_LINE = '0';
  assert.strictEqual(firewallVerdict(base({ selection: 'Menos de 10.5' })).blocked, false);
  process.env.FIREWALL_MAX_UNDER_LINE = prev;
});

test('R7 no se confunde con Over: ese caso es de R1', () => {
  // "Más de X" ya lo corta R1; R7 no debe reclamarlo ni dejar de aplicarse R1.
  const v = firewallVerdict(base({ selection: 'Mas de 4.5' }));
  assert.ok(v.rules.includes('R1:over'));
  assert.ok(!v.rules.includes('R7:under_linea_alta'));
});

test('isUnder / underLine reconocen la selección y su línea', () => {
  assert.strictEqual(isUnder({ selection: 'Menos de 3.5', marketType: 'total' }), true);
  assert.strictEqual(isUnder({ selection: 'Más de 3.5', marketType: 'total' }), false);
  // Sin acento y en mayúsculas: el feed no es consistente.
  assert.strictEqual(isUnder({ selection: 'MENOS DE 2.5', marketType: 'total' }), true);
  assert.strictEqual(underLine({ selection: 'Menos de 10.5' }), 10.5);
  assert.strictEqual(underLine({ selection: 'Menos de 0.5' }), 0.5);
  assert.strictEqual(underLine({ selection: 'Empate' }), null);
});

test('FIREWALL_ENABLED=false apaga el firewall entero', () => {
  process.env.FIREWALL_ENABLED = 'false';
  const v = firewallVerdict(base({ selection: 'Mas de 4.5', progress: 0.1 }));
  assert.strictEqual(v.blocked, false);
  assert.deepStrictEqual(v.rules, []);
  process.env.FIREWALL_ENABLED = 'true';
});
