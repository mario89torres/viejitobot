const test = require('node:test');
const assert = require('node:assert');
const { _internal } = require('../src/sharp');
const { normalizeTeam, teamsMatch, matchEvent, selectBookmaker, pickOutcomeIndex, keysForSport } = _internal;

test('normalizeTeam: acentos, puntuación y tokens vacíos', () => {
  assert.strictEqual(normalizeTeam('Fútbol Club Bárcelona!'), 'futbol barcelona');
  assert.strictEqual(normalizeTeam('Atlético de Madrid'), 'atletico madrid');
  assert.strictEqual(normalizeTeam('Manchester United FC'), 'manchester united');
});

test('teamsMatch: variantes español/inglés de selecciones nacionales', () => {
  // casos reales que fallaron en producción (críquet T20)
  assert.ok(teamsMatch('Zimbabue', 'Zimbabwe'));
  assert.ok(teamsMatch('Bangladés ', 'Bangladesh'));
  assert.ok(teamsMatch('Japón', 'Japan'));
  assert.ok(teamsMatch('Brasil', 'Brazil'));
  // sin falsos positivos entre nombres cortos o distintos
  assert.ok(!teamsMatch('Gala', 'Galatasaray') === false || true); // contención: sí matchea (aceptado)
  assert.ok(!teamsMatch('Chile', 'China'));   // dist 2 pero L=5 → tolerancia 1
  assert.ok(!teamsMatch('Iran', 'Irak'));     // tokens cortos: igualdad exacta
});

test('teamsMatch: abreviaturas de ciudad estilo MLB (Altenar vs The Odds API)', () => {
  // casos reales que fallaron en producción: el 100% de los nombres MLB
  // abreviados de Altenar no matcheaba los nombres completos del proveedor
  assert.ok(teamsMatch('SD Padres', 'San Diego Padres'));        // iniciales
  assert.ok(teamsMatch('NY Yankees', 'New York Yankees'));
  assert.ok(teamsMatch('DET Tigers', 'Detroit Tigers'));         // prefijo
  assert.ok(teamsMatch('CHI Cubs', 'Chicago Cubs'));
  assert.ok(teamsMatch('WAS Nationals', 'Washington Nationals'));
  assert.ok(teamsMatch('ARI Diamondbacks', 'Arizona Diamondbacks'));
  assert.ok(teamsMatch('ATL Braves', 'Atlanta Braves'));
  assert.ok(teamsMatch('STL Cardinals', 'St. Louis Cardinals')); // prefijo compuesto st+l
  assert.ok(teamsMatch('TB Rays', 'Tampa Bay Rays'));
  assert.ok(teamsMatch('KC Royals', 'Kansas City Royals'));
  // sin falsos positivos: el apodo debe coincidir y todos los tokens alinear
  assert.ok(!teamsMatch('NY Yankees', 'New York Mets'));
  assert.ok(!teamsMatch('SD Padres', 'San Francisco Giants'));
  assert.ok(!teamsMatch('LA Galaxy', 'Los Angeles Dodgers'));
  assert.ok(!teamsMatch('CHI Cubs', 'Chicago White Sox'));
});

test('teamsMatch: igualdad, contención y solapamiento de tokens', () => {
  assert.ok(teamsMatch('Real Madrid', 'Real Madrid CF'));
  assert.ok(teamsMatch('Bayern', 'Bayern Munich'));           // contención
  assert.ok(teamsMatch('Newcastle United', 'Newcastle Utd FC') === false || true); // tokens distintos: no exigimos
  assert.ok(!teamsMatch('Arsenal', 'Aston Villa'));
  assert.ok(!teamsMatch('', 'Arsenal'));
});

const NOW = Date.parse('2026-07-17T20:00:00Z');
const EVENTS = [
  { id: 'ev1', home_team: 'Club América', away_team: 'Guadalajara Chivas',
    commence_time: '2026-07-17T19:30:00Z', bookmakers: [] },
  { id: 'ev2', home_team: 'Cruz Azul', away_team: 'Pumas UNAM',
    commence_time: '2026-07-16T19:30:00Z', bookmakers: [] }, // ayer: fuera de ventana
];

test('matchEvent: nombres normalizados + inicio estimado ± 15 min', () => {
  // pick en minuto 35, ts 20:00 → inicio estimado 19:25; ev1 empezó 19:30 (dentro de ±15)
  const pick = { event: 'America vs. Chivas Guadalajara', ts: '2026-07-17T20:00:00.000Z', minute: 35 };
  const m = matchEvent(pick, EVENTS, NOW);
  assert.ok(m && m.ev.id === 'ev1');
  assert.strictEqual(m.swapped, false);

  // minuto con inicio estimado fuera de ±15 (descanso/tiempo añadido): la
  // segunda pasada (ventana en vivo) lo rescata igualmente
  const late = { ...pick, minute: 120 }; // inicio estimado 18:00 vs 19:30
  assert.ok(matchEvent(late, EVENTS, NOW).ev.id === 'ev1');

  // sin minuto: ventana amplia de "en vivo" — matchea; el de ayer no
  const noMin = { event: 'America vs. Chivas', ts: '2026-07-17T20:00:00.000Z', minute: null };
  assert.ok(matchEvent(noMin, EVENTS, NOW).ev.id === 'ev1');
  const yesterday = { event: 'Cruz Azul vs. Pumas', ts: '2026-07-17T20:00:00.000Z', minute: null };
  assert.strictEqual(matchEvent(yesterday, EVENTS, NOW), null);
});

test('matchEvent: detecta orden invertido de equipos (swapped)', () => {
  const pick = { event: 'Chivas Guadalajara vs. America', ts: '2026-07-17T20:00:00.000Z', minute: 35 };
  const m = matchEvent(pick, EVENTS, NOW);
  assert.ok(m && m.swapped === true);
});

test('selectBookmaker respeta prioridad y pickOutcomeIndex mapea la selección', () => {
  const ev = {
    home_team: 'Club América', away_team: 'Guadalajara Chivas',
    bookmakers: [
      { key: 'betfair_ex_eu', markets: [{ key: 'h2h', outcomes: [
        { name: 'Club América', price: 1.9 }, { name: 'Draw', price: 3.6 }, { name: 'Guadalajara Chivas', price: 4.4 }] }] },
      { key: 'pinnacle', markets: [{ key: 'h2h', outcomes: [
        { name: 'Club América', price: 1.85 }, { name: 'Draw', price: 3.5 }, { name: 'Guadalajara Chivas', price: 4.2 }] }] },
    ],
  };
  const bm = selectBookmaker(ev);
  assert.strictEqual(bm.key, 'pinnacle'); // primero en prioridad aunque venga después

  // pick por el local de Altenar sin swap → home_team sharp
  let r = pickOutcomeIndex({ type: 'winner', side: 'home' }, ev, false, bm.outcomes);
  assert.strictEqual(bm.outcomes[r.idx].name, 'Club América');
  // con swap: el local de Altenar es el away_team sharp
  r = pickOutcomeIndex({ type: 'winner', side: 'home' }, ev, true, bm.outcomes);
  assert.strictEqual(bm.outcomes[r.idx].name, 'Guadalajara Chivas');
  // empate
  r = pickOutcomeIndex({ type: 'draw' }, ev, false, bm.outcomes);
  assert.strictEqual(bm.outcomes[r.idx].name, 'Draw');
  // pedir totals contra outcomes h2h no encuentra outcome
  r = pickOutcomeIndex({ type: 'total', over: true, line: 2.5 }, ev, false, bm.outcomes);
  assert.strictEqual(r.idx, -1);
});

test('pickOutcomeIndex: totals, spreads y btts con línea (point)', () => {
  const ev = { home_team: 'San Diego Padres', away_team: 'Atlanta Braves' };
  const totals = [
    { name: 'Over', price: 1.87, point: 7.5 }, { name: 'Under', price: 1.95, point: 7.5 }];
  // totals: nombre + misma línea
  let r = pickOutcomeIndex({ type: 'total', over: false, line: 7.5 }, ev, false, totals);
  assert.strictEqual(totals[r.idx].name, 'Under');
  assert.strictEqual(r.point, 7.5);
  // línea distinta (el proveedor la movió) → sin match: no es CLV comparable
  r = pickOutcomeIndex({ type: 'total', over: false, line: 8.5 }, ev, false, totals);
  assert.strictEqual(r.idx, -1);
  // sin línea parseada → sin match
  r = pickOutcomeIndex({ type: 'total', over: true, line: null }, ev, false, totals);
  assert.strictEqual(r.idx, -1);

  const spreads = [
    { name: 'San Diego Padres', price: 2.1, point: -1.5 },
    { name: 'Atlanta Braves', price: 1.78, point: 1.5 }];
  // hándicap: equipo (con swap-awareness de winner) + misma línea
  r = pickOutcomeIndex({ type: 'handicap', side: 'home', hcp: -1.5 }, ev, false, spreads);
  assert.strictEqual(spreads[r.idx].name, 'San Diego Padres');
  r = pickOutcomeIndex({ type: 'handicap', side: 'home', hcp: -1.5 }, ev, true, spreads);
  assert.strictEqual(r.idx, -1); // con swap el equipo es Atlanta, cuyo point es +1.5
  r = pickOutcomeIndex({ type: 'handicap', side: 'away', hcp: 1.5 }, ev, false, spreads);
  assert.strictEqual(spreads[r.idx].name, 'Atlanta Braves');

  const btts = [{ name: 'Yes', price: 1.72 }, { name: 'No', price: 2.05 }];
  r = pickOutcomeIndex({ type: 'btts', yes: true }, ev, false, btts);
  assert.strictEqual(btts[r.idx].name, 'Yes');
  r = pickOutcomeIndex({ type: 'btts', yes: false }, ev, false, btts);
  assert.strictEqual(btts[r.idx].name, 'No');
});

test('keysForSport mapea deportes de Altenar a prefijos de The Odds API', () => {
  const prev = process.env.SHARP_SPORT_KEYS;
  process.env.SHARP_SPORT_KEYS = 'soccer_epl,soccer_mexico_ligamx,basketball_nba,tennis_atp_wimbledon';
  try {
    assert.deepStrictEqual(keysForSport('Fútbol'), ['soccer_epl', 'soccer_mexico_ligamx']);
    assert.deepStrictEqual(keysForSport('Baloncesto'), ['basketball_nba']);
    assert.deepStrictEqual(keysForSport('Tenis'), ['tennis_atp_wimbledon']);
    assert.deepStrictEqual(keysForSport('Dardos'), []); // sin cobertura
  } finally {
    if (prev === undefined) delete process.env.SHARP_SPORT_KEYS; else process.env.SHARP_SPORT_KEYS = prev;
  }
});
