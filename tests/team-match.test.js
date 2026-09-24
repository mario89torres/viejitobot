const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeTeam, teamsMatch } = require('../src/teamMatch');

// Casos reales del diagnostico del 2026-09-23 (playdoit vs. calendario FotMob).
test('selecciones: pais en espanol == pais en ingles', () => {
  const pares = [
    ['Países Bajos', 'Netherlands'], ['Alemania', 'Germany'], ['Italia', 'Italy'], ['Bélgica', 'Belgium'],
    ['República Checa', 'Czechia'], ['Chequia', 'Czechia'], ['Costa de Marfil', 'Ivory Coast'],
    ['Bosnia y Herzegovina', 'Bosnia and Herzegovina'], ['Estados Unidos', 'USA'], ['Corea del Sur', 'South Korea'],
    ['Macedonia del Norte', 'North Macedonia'], ['Islas Feroe', 'Faroe Islands'], ['Timor Oriental', 'Timor-Leste'],
    ['RD Congo', 'DR Congo'], ['Santa Lucía', 'Saint Lucia'], ['Turquía', 'Turkey'], ['Turquía', 'Türkiye'],
  ];
  for (const [es, en] of pares) assert.ok(teamsMatch(es, en), `${es} deberia casar con ${en}`);
});

test('selecciones juveniles: "Alemania Sub-21" == "Germany U21"', () => {
  assert.ok(teamsMatch('Alemania Sub-21', 'Germany U21'));
  assert.ok(teamsMatch('Azerbaiyán Sub-21', 'Azerbaijan U21'));
  assert.ok(teamsMatch('Países Bajos Sub-21', 'Netherlands U21'));
});

test('femenino: "(F)" == "(W)" y nombre corto == nombre largo', () => {
  assert.ok(teamsMatch('Leicester (F)', 'Leicester City (W)'));
  assert.ok(teamsMatch('Tottenham (F)', 'Tottenham Hotspur (W)'));
  assert.ok(teamsMatch('Manchester United (F)', 'Manchester United (W)'));
  assert.ok(teamsMatch('Nottingham Forest (F)', 'Nottingham Forest WFC (W)'));
  assert.ok(teamsMatch('Arsenal (F)', 'Arsenal Women'));
});

test('diacriticos y letras que NFD no descompone', () => {
  assert.ok(teamsMatch('Nykoebing FC', 'Nykøbing FC'));
  assert.ok(teamsMatch('Naestved BK', 'Næstved'));
  assert.ok(teamsMatch('Ringsted IF', 'Ringsted'));
  assert.ok(teamsMatch('IFK Goteborg (F)', 'IFK Göteborg (W)'));
  assert.ok(teamsMatch('Vaxjo DFF (F)', 'Växjö DFF (W)'));
  assert.ok(teamsMatch('FC Helsingoer', 'FC Helsingør'));
});

// Las salvaguardas: lo que NO debe casar.
test('"Irlanda" no casa con "Irlanda del Norte" (ni en ingles)', () => {
  assert.ok(!teamsMatch('Irlanda', 'Northern Ireland'));
  assert.ok(!teamsMatch('Irlanda del Norte', 'Ireland'));
  assert.ok(!teamsMatch('Ireland', 'Northern Ireland'));
  assert.ok(teamsMatch('Irlanda del Norte', 'Northern Ireland'));
  assert.ok(teamsMatch('Irlanda', 'Ireland'));
});

test('un equipo femenino no casa con su equipo de mayores', () => {
  assert.ok(!teamsMatch('Liverpool (F)', 'Liverpool'));
  assert.ok(!teamsMatch('Liverpool', 'Liverpool (W)'));
  assert.ok(!teamsMatch('Arsenal Women', 'Arsenal'));
});

test('un equipo juvenil no casa con su equipo de mayores ni con otra edad', () => {
  assert.ok(!teamsMatch('Club Brugge Sub-19', 'Club Brugge'));
  assert.ok(!teamsMatch('España Sub-21', 'Spain'));
  assert.ok(!teamsMatch('España Sub-21', 'Spain U19'));
});

test('calificador geografico: "Korea" no casa con "South Korea" ni "North Korea"', () => {
  assert.ok(!teamsMatch('South Korea', 'North Korea'));
  assert.ok(!teamsMatch('Corea del Sur', 'Corea del Norte'));
  assert.ok(teamsMatch('West Ham', 'West Ham United'));
  assert.ok(teamsMatch('West Brom', 'West Bromwich Albion'));
});

// Falso positivo real hallado al validar contra datos: los tokens de categoria
// compartidos (u20 + w) inflaban el Jaccard a 0.5 entre selecciones sin relacion.
test('categoria compartida no cuenta como similitud de nombre', () => {
  assert.ok(!teamsMatch('Paraguay Sub-20 (F)', 'Italy U20 (W)'));
  assert.ok(!teamsMatch('Venezuela Sub-20 (F)', 'Colombia U20 (W)'));
  assert.ok(!teamsMatch('Chile Sub-20 (F)', 'North Korea U20 (W)'));
  assert.ok(teamsMatch('Italy U20 Women', 'Italy Sub-20 (F)'));
  assert.ok(teamsMatch('Paraguay Sub-20 (F)', 'Paraguay U20 (W)'));
});

// Regresion: lo que ya casaba (y debe seguir casando).
test('regresion: emparejamientos que ya funcionaban', () => {
  assert.ok(teamsMatch('Seattle Sounders', 'Seattle Sounders FC'));
  assert.ok(teamsMatch('Club Brugge Sub-19', 'Club Brugge U19'));
  assert.ok(teamsMatch('Zimbabue', 'Zimbabwe'));
  assert.ok(teamsMatch('Real Salt Lake', 'Real Salt Lake'));
  assert.ok(!teamsMatch('Manchester City', 'Manchester United'));
  assert.ok(!teamsMatch('Real Madrid', 'Atlético Madrid'));
});

test('normalizeTeam: el sufijo de categoria queda como token', () => {
  assert.equal(normalizeTeam('Alemania Sub-21'), 'germany u21');
  assert.equal(normalizeTeam('Leicester (F)'), 'leicester w');
  assert.equal(normalizeTeam('Leicester City (W)'), 'leicester city w');
  assert.equal(normalizeTeam('Nykøbing FC'), 'nykobing');
});
