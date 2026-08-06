// Contabilidad de créditos del matching por liga (rediseño 2026-07-29).
//
// Contrato nuevo:
//   - CHAMP_MAP traduce liga -> sport_key sin gastar nada. Liga no cubierta = 0 créditos.
//   - Liga cubierta: UNA llamada a /sports/{key}/odds (1 crédito) que trae los
//     partidos con momios, incluidos los que ya empezaron.
//   - La cache por liga+mercado se comparte entre picks y con la captura de cierre.
const test = require('node:test');
const assert = require('node:assert');

process.env.ODDS_API_KEY = 'test-key';
process.env.SHARP_CACHE_SECONDS = '600';
process.env.SHARP_MAX_CREDITS_PER_DAY = '999';

const sharp = require('../src/sharp');

const NOW = Date.now();
// evento YA EN CURSO: empezó hace 30 min (lo que /events nunca devolvía)
const EV = {
  id: 'ev42', home_team: 'León', away_team: 'Atlas',
  commence_time: new Date(NOW - 30 * 60000).toISOString(),
  bookmakers: [{ key: 'pinnacle', markets: [{ key: 'h2h', outcomes: [
    { name: 'León', price: 2.05 }, { name: 'Draw', price: 3.6 }, { name: 'Atlas', price: 3.55 }] }] }],
};

let calls;
function mockFetch(events = [EV]) {
  calls = [];
  sharp._internal.clearCaches();
  global.fetch = async (url) => {
    calls.push(url);
    return { ok: true, status: 200, headers: { get: () => '400' }, json: async () => events };
  };
}
const paid = () => calls.filter(u => /\/odds\?/.test(u)).length;

const PICK = {
  event: 'Leon vs. Atlas', sport: 'Fútbol', champ: 'Liga MX',
  market: 'Ganador del partido', selection: 'Leon',
  ts: new Date(NOW).toISOString(), minute: 30,
};

test('liga cubierta y partido EN CURSO: matchea con 1 crédito', async () => {
  mockFetch();
  const r = await sharp.captureForPick(PICK);
  assert.strictEqual(r.status, 'matched');
  assert.strictEqual(r.odd, 2.05);
  assert.strictEqual(paid(), 1);
  assert.ok(/soccer_mexico_ligamx/.test(calls[0]), 'debe consultar la liga mapeada');
});

test('liga NO cubierta: no_coverage sin gastar un solo crédito', async () => {
  mockFetch();
  for (const champ of ['Amistosos de Clubes', 'Copa Federación', 'Kolmonen', 'MLS Next Pro']) {
    const r = await sharp.captureForPick({ ...PICK, champ });
    assert.strictEqual(r.status, 'no_coverage', `${champ} debe ser no_coverage`);
  }
  assert.strictEqual(calls.length, 0, 'ninguna llamada HTTP');
});

test('picks de la misma liga comparten la consulta (cache)', async () => {
  mockFetch();
  await sharp.captureForPick(PICK);
  const r2 = await sharp.captureForPick({ ...PICK, selection: 'Atlas', event: 'Leon vs. Atlas' });
  assert.strictEqual(r2.status, 'matched');
  assert.strictEqual(paid(), 1, 'la segunda reutiliza la cache');
});

test('equipos que no coinciden: unmatched tras 1 consulta', async () => {
  mockFetch();
  const r = await sharp.captureForPick({ ...PICK, event: 'Tigres vs. Monterrey', selection: 'Tigres' });
  assert.strictEqual(r.status, 'unmatched');
  assert.strictEqual(paid(), 1, 'se pagó la liga, pero el evento no estaba');
});

test('el cierre reutiliza la cache de liga', async () => {
  mockFetch();
  await sharp.captureForPick(PICK);           // 1 crédito, llena la cache
  const row = {
    id: 1, sharp_event_id: 'soccer_mexico_ligamx|ev42',
    sharp_closing_market: JSON.stringify({
      bookmaker: 'pinnacle', market: 'h2h', target: 'León', point: null, idx: 0,
      outcomes: [{ name: 'León', price: 2.2 }],
    }),
  };
  const r = await sharp.captureClosingForPick(row);
  assert.ok(r && r.odd === 2.05, 'toma el precio actual de la cache');
  assert.strictEqual(paid(), 1, 'sin crédito adicional');
});

test('mercado no soportado: 0 créditos', async () => {
  mockFetch();
  const r = await sharp.captureForPick({ ...PICK, market: 'Tarjetas totales', selection: 'Mas de 4.5' });
  assert.ok(['unsupported_market', 'unmatched', 'no_coverage'].includes(r.status));
  if (r.status === 'unsupported_market') assert.strictEqual(calls.length, 0);
});

test('el presupuesto diario corta el gasto', async () => {
  const prev = process.env.SHARP_MAX_CREDITS_PER_DAY;
  process.env.SHARP_MAX_CREDITS_PER_DAY = '0';
  try {
    mockFetch();
    const r = await sharp.captureForPick(PICK);
    assert.strictEqual(r.status, 'unmatched', 'sin presupuesto no puede matchear');
    assert.strictEqual(paid(), 0, 'no gasta con el tope en 0');
  } finally { process.env.SHARP_MAX_CREDITS_PER_DAY = prev; }
});
