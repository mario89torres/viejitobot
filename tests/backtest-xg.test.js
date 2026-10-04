const test = require('node:test');
const assert = require('node:assert/strict');
const { construirFeatures, MIN_LIGA } = require('../scripts/backtest-xg-goles');
const { parseXg } = require('../scripts/recolectar-xg-fotmob');

const cerca = (a, b, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol, `${a} deberia estar a ${tol} de ${b}`);

// Liga sintetica de 4 equipos que juegan una jornada por dia: cada equipo anota y concede goles/xG fijos,
// asi los promedios acumulados son predecibles.
function ligaSintetica(jornadas, sobrescribir = {}) {
  const out = [];
  let id = 1;
  for (let j = 0; j < jornadas; j++) {
    const fecha = `2025-09-${String(1 + j).padStart(2, '0')}T15:00:00Z`;
    const pares = j % 2 === 0 ? [[1, 2], [3, 4]] : [[2, 3], [4, 1]];
    for (const [h, a] of pares) {
      out.push({ id: String(id++), liga: 47, temp: '2025/2026', fecha, home: 'E' + h, away: 'E' + a, homeId: h, awayId: a, gl: 2, gv: 1, xgH: 1.8, xgA: 0.9, ...(sobrescribir[j] || {}) });
    }
  }
  return out;
}

test('parseXg: numeros, cadenas y datos faltantes', () => {
  assert.deepEqual(parseXg({ 'Expected goals (xG)': { home: '1.25', away: '0.4' } }), { home: 1.25, away: 0.4 });
  assert.deepEqual(parseXg({ 'Expected goals (xG)': { home: 2, away: 0 } }), { home: 2, away: 0 });
  assert.equal(parseXg({}), null);
  assert.equal(parseXg(null), null);
  assert.equal(parseXg({ 'Expected goals (xG)': { home: 'x', away: '1' } }), null);
});

test('sin fugas: los primeros partidos no tienen variables (faltan partidos previos)', () => {
  const filas = construirFeatures(ligaSintetica(28), 6);
  const fechas = filas.map(f => f.fecha).sort();
  // cada equipo juega 1 por jornada: con minPrev=6 la primera fila sale en la jornada 7 (dia 7)
  assert.ok(fechas[0] >= '2025-09-07T', fechas[0]);
});

test('sin fugas: cambiar el resultado de un partido FUTURO no altera las variables de uno anterior', () => {
  const base = ligaSintetica(28), alterada = ligaSintetica(28, { 22: { gl: 9, gv: 9, xgH: 8, xgA: 8 } });
  const a = construirFeatures(base, 6), b = construirFeatures(alterada, 6);
  const mapa = new Map(b.map(f => [f.id, f]));
  let comparados = 0;
  for (const f of a) {
    const g = mapa.get(f.id);
    if (!g) continue;
    if (f.fecha <= '2025-09-23T15:00:00Z') { cerca(f.lamXs, g.lamXs); cerca(f.lamGs, g.lamGs); cerca(f.lamXn, g.lamXn); cerca(f.lamL0, g.lamL0); comparados++; }
  }
  assert.ok(comparados > 10);
  // y SI cambia despues de la jornada alterada
  const despues = a.find(f => f.fecha > '2025-09-24T' && mapa.get(f.id));
  assert.ok(Math.abs(despues.lamXs - mapa.get(despues.id).lamXs) > 1e-6);
});

test('sin fugas: partidos del MISMO dia no se ven entre si', () => {
  const base = ligaSintetica(12);
  const alterada = ligaSintetica(12, { 10: { gl: 9, gv: 9, xgH: 8, xgA: 8 } });
  const a = construirFeatures(base, 6), b = construirFeatures(alterada, 6);
  const mapa = new Map(b.map(f => [f.id, f]));
  // las filas de la jornada 10 (dia 11) usan solo jornadas anteriores: iguales aunque su propio resultado cambie
  const dia11 = a.filter(f => f.fecha.startsWith('2025-09-11'));
  assert.ok(dia11.length > 0);
  for (const f of dia11) cerca(f.lamXs, mapa.get(f.id).lamXs);
});

test('valores: con goles y xG constantes, los estimadores dan lo esperado', () => {
  const filas = construirFeatures(ligaSintetica(28), 6);
  const f = filas[filas.length - 1];
  // total de xG por partido = 1.8 + 0.9 = 2.7 y de goles = 2 + 1 = 3, sea quien sea local
  assert.ok(f.lamXs > 2.5 && f.lamXs < 2.9, String(f.lamXs));
  assert.ok(f.lamGs > 2.8 && f.lamGs < 3.2, String(f.lamGs));
  cerca(f.lamL0, 3, 0.06);
  assert.equal(f.goles, 3);
});

test('descarta partidos cuando la liga aun no tiene promedio (MIN_LIGA)', () => {
  const chica = construirFeatures(ligaSintetica(8), 2);   // 8 jornadas x 4 partidos-equipo = 32 < 2*MIN_LIGA
  assert.ok(MIN_LIGA * 2 > 32);
  assert.equal(chica.length, 0);
});

test('ligas y temporadas se calculan por separado', () => {
  const a = ligaSintetica(28);
  const otra = ligaSintetica(28).map(p => ({ ...p, liga: 87, id: 'x' + p.id, gl: 0, gv: 0, xgH: 0.1, xgA: 0.1 }));
  const mezcla = construirFeatures([...a, ...otra], 6);
  const soloA = construirFeatures(a, 6);
  const m = new Map(mezcla.map(f => [f.id, f]));
  for (const f of soloA) cerca(f.lamXs, m.get(f.id).lamXs);
});
