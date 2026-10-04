const test = require('node:test');
const assert = require('node:assert/strict');
const { xgNormalizado } = require('../src/prematchXg');
const { resumirTablaXgLiga } = require('../src/fotmobScraper');

const cerca = (a, b, tol = 0.006) => assert.ok(Math.abs(a - b) <= tol, `${a} deberia estar a ${tol} de ${b}`);
const equipo = (xgFor, xgAgainst, played) => ({ xgFor, xgAgainst, played });

test('xgNormalizado: dos equipos exactamente promedio dan el promedio de la liga por lado', () => {
  const n = xgNormalizado(equipo(14.2, 14.2, 10), equipo(14.2, 14.2, 10), 1.42);
  cerca(n.local, 1.42); cerca(n.visita, 1.42); cerca(n.total, 2.84);
});

test('xgNormalizado: ataque +20% contra defensa +10% peor = 1.32x el promedio', () => {
  // local: ataque 1.704 (1.2 x 1.42); visita concede 1.562 (1.1 x 1.42)
  const n = xgNormalizado(equipo(17.04, 14.2, 10), equipo(14.2, 15.62, 10), 1.42);
  cerca(n.local, 1.42 * 1.2 * 1.1);
});

test('xgNormalizado: normaliza por partidos jugados (distinta cantidad de fechas)', () => {
  const a = xgNormalizado(equipo(14.2, 14.2, 10), equipo(28.4, 28.4, 20), 1.42);
  cerca(a.local, 1.42); cerca(a.visita, 1.42);
});

test('xgNormalizado: una liga de mas goles escala el resultado hacia abajo, no hacia arriba', () => {
  // mismo par de equipos: en una liga con promedio mayor, "ser promedio" vale mas
  const chica = xgNormalizado(equipo(15, 15, 10), equipo(15, 15, 10), 1.2);
  const grande = xgNormalizado(equipo(15, 15, 10), equipo(15, 15, 10), 1.8);
  assert.ok(chica.total > grande.total);
});

test('xgNormalizado: null si falta algun dato o el promedio no es usable', () => {
  assert.equal(xgNormalizado(equipo(10, 10, 10), equipo(10, 10, 10), 0), null);
  assert.equal(xgNormalizado(equipo(10, 10, 10), equipo(10, 10, 10), NaN), null);
  assert.equal(xgNormalizado(equipo(10, 10, 0), equipo(10, 10, 10), 1.4), null);
  assert.equal(xgNormalizado(equipo(10, null, 10), equipo(10, 10, 10), 1.4), null);
  assert.equal(xgNormalizado(null, equipo(10, 10, 10), 1.4), null);
});

test('resumirTablaXgLiga: promedio = xG total / partidos-equipo', () => {
  const json = { LeagueName: 'Championship', TopLists: [{ StatList: [
    { StatValue: 18, MatchesPlayed: 8 }, { StatValue: 16.3, MatchesPlayed: 8 }, { StatValue: 10, MatchesPlayed: 9 },
  ] }] };
  const r = resumirTablaXgLiga(json);
  assert.equal(r.leagueName, 'Championship');
  assert.equal(r.nEquipos, 3);
  assert.equal(r.partidosEquipo, 25);
  assert.equal(r.xgTotal, 44.3);
  cerca(r.xgPorEquipoPartido, 44.3 / 25, 1e-4);
});

test('resumirTablaXgLiga: ignora equipos sin partidos o con datos rotos; null si no queda nada', () => {
  const r = resumirTablaXgLiga({ TopLists: [{ StatList: [
    { StatValue: 12, MatchesPlayed: 6 }, { StatValue: 5, MatchesPlayed: 0 }, { StatValue: 'x', MatchesPlayed: 4 }, { MatchesPlayed: 3 },
  ] }] });
  assert.equal(r.nEquipos, 1);
  assert.equal(r.xgPorEquipoPartido, 2);
  assert.equal(resumirTablaXgLiga({ TopLists: [{ StatList: [] }] }), null);
  assert.equal(resumirTablaXgLiga(null), null);
  assert.equal(resumirTablaXgLiga({}), null);
});
