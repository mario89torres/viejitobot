const test = require('node:test');
const assert = require('node:assert');
const { devig, METHODS, defaultMethod } = require('../src/devig');

const sum = a => a.reduce((s, x) => s + x, 0);

// Mercado de referencia del enunciado: favorito / medio / longshot
const MARKET3 = [1.50, 2.60, 6.00];
const MARKET2 = [1.50, 2.50];
const EVEN2 = [1.90, 1.90];
const MARKET4 = [1.80, 3.50, 4.20, 9.00];

test('todos los métodos suman 1 (tolerancia 1e-6)', () => {
  for (const method of METHODS) {
    for (const odds of [MARKET3, MARKET2, EVEN2, MARKET4]) {
      const probs = devig(odds, method);
      assert.ok(Math.abs(sum(probs) - 1) < 1e-6, `${method} sobre [${odds}] suma ${sum(probs)}`);
      assert.ok(probs.every(p => p > 0 && p < 1), `${method} sobre [${odds}] tiene probs fuera de (0,1)`);
    }
  }
});

test('proportional: valores conocidos', () => {
  // p = [2/3, 2/5], Σ = 16/15 → [0.625, 0.375]
  const probs = devig(MARKET2, 'proportional');
  assert.ok(Math.abs(probs[0] - 0.625) < 1e-9);
  assert.ok(Math.abs(probs[1] - 0.375) < 1e-9);
});

test('additive: valores conocidos', () => {
  // margen = 16/15 − 1 = 1/15; π_i = p_i − 1/30 → [0.63333…, 0.36666…]
  const probs = devig(MARKET2, 'additive');
  assert.ok(Math.abs(probs[0] - (2 / 3 - 1 / 30)) < 1e-9);
  assert.ok(Math.abs(probs[1] - (2 / 5 - 1 / 30)) < 1e-9);
});

test('additive: fallback a proportional cuando produce prob <= 0', () => {
  // p = [0.98039, 0.33333, 0.001]; margen/3 = 0.10491 > 0.001 → longshot negativo
  const odds = [1.02, 3, 1000];
  const probs = devig(odds, 'additive');
  assert.ok(probs.warning, 'debe marcar warning');
  assert.strictEqual(probs.methodUsed, 'proportional');
  const prop = devig(odds, 'proportional');
  for (let i = 0; i < odds.length; i++) assert.ok(Math.abs(probs[i] - prop[i]) < 1e-12);
});

test('power: mercado simétrico da 50/50 y k resuelve Σp^k = 1', () => {
  const probs = devig(EVEN2, 'power');
  assert.ok(Math.abs(probs[0] - 0.5) < 1e-9);
  assert.ok(Math.abs(probs[1] - 0.5) < 1e-9);
});

test('shin: con 2 resultados equivale al aditivo (solución cerrada)', () => {
  const shin = devig(MARKET2, 'shin');
  const add = devig(MARKET2, 'additive');
  for (let i = 0; i < 2; i++) assert.ok(Math.abs(shin[i] - add[i]) < 1e-12);
  const even = devig(EVEN2, 'shin');
  assert.ok(Math.abs(even[0] - 0.5) < 1e-12);
});

test('shin: n=3 satisface la ecuación de punto fijo con z > 0', () => {
  const probs = devig(MARKET3, 'shin');
  assert.ok(Math.abs(sum(probs) - 1) < 1e-9);
  // recupera z desde el favorito e invierte la fórmula para verificar coherencia:
  // π_i·(2(1−z)) + z = sqrt(z² + 4(1−z)p_i²/P) para todos los i con el mismo z
  const p = MARKET3.map(o => 1 / o);
  const P = sum(p);
  // busca z por bisección independiente y compara las probs resultantes
  const pi = z => p.map(x => (Math.sqrt(z * z + 4 * (1 - z) * (x * x / P)) - z) / (2 * (1 - z)));
  let lo = 0, hi = 0.999;
  while (hi - lo > 1e-13) {
    const mid = (lo + hi) / 2;
    if (sum(pi(mid)) - 1 > 0) lo = mid; else hi = mid;
  }
  const z = (lo + hi) / 2;
  assert.ok(z > 0, 'z debe ser positivo con sobre-margen');
  const expected = pi(z);
  for (let i = 0; i < 3; i++) assert.ok(Math.abs(probs[i] - expected[i]) < 1e-6);
});

test('sesgo favorito-longshot: shin castiga al longshot más que proportional', () => {
  const prop = devig(MARKET3, 'proportional');
  const shin = devig(MARKET3, 'shin');
  // el longshot (6.00) debe recibir prob relativa menor con shin
  assert.ok(shin[2] < prop[2], `longshot: shin ${shin[2]} debe ser < proportional ${prop[2]}`);
  // y el favorito (1.50) prob mayor
  assert.ok(shin[0] > prop[0], `favorito: shin ${shin[0]} debe ser > proportional ${prop[0]}`);
});

test('método desconocido lanza error; default es shin', () => {
  assert.throws(() => devig(MARKET2, 'kelly'), TypeError);
  const prev = process.env.DEVIG_METHOD;
  delete process.env.DEVIG_METHOD;
  assert.strictEqual(defaultMethod(), 'shin');
  process.env.DEVIG_METHOD = 'proportional';
  assert.strictEqual(defaultMethod(), 'proportional');
  process.env.DEVIG_METHOD = 'no-existe';
  assert.strictEqual(defaultMethod(), 'shin');
  if (prev === undefined) delete process.env.DEVIG_METHOD; else process.env.DEVIG_METHOD = prev;
});

test('momios inválidos lanzan error', () => {
  assert.throws(() => devig([], 'shin'), TypeError);
  assert.throws(() => devig([1.5, 1.0], 'shin'), TypeError);
  assert.throws(() => devig([1.5, 0.8], 'shin'), TypeError);
});
