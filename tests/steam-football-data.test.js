const test = require('node:test');
const assert = require('node:assert/strict');
const { parseCsv, cuotas, ganador, agregarPartido, sumar, metricas, bootstrap, LEN } = require('../scripts/backtest-steam-football-data');

const cerca = (a, b, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol, `${a} deberia estar a ${tol} de ${b}`);

test('parseCsv: cabecera, filas y campos con comillas o comas', () => {
  const filas = parseCsv('﻿Div,HomeTeam,AwayTeam,FTR\r\nE0,"Man, United",Fulham,H\r\nE0,Arsenal,"Chelsea ""FC""",D\r\n\r\n');
  assert.equal(filas.length, 2);
  assert.equal(filas[0].HomeTeam, 'Man, United');
  assert.equal(filas[1].AwayTeam, 'Chelsea "FC"');
  assert.equal(filas[0].Div, 'E0');
  assert.deepEqual(parseCsv(''), []);
});

test('parseCsv: filas cortas rellenan con vacio (no rompen)', () => {
  const [f] = parseCsv('a,b,c\r\n1,2');
  assert.equal(f.c, '');
});

test('cuotas: exige tres cuotas validas > 1', () => {
  assert.deepEqual(cuotas({ A: '2.1', B: '3.4', C: '3.9' }, ['A', 'B', 'C']), [2.1, 3.4, 3.9]);
  assert.equal(cuotas({ A: '2.1', B: '', C: '3.9' }, ['A', 'B', 'C']), null);
  assert.equal(cuotas({ A: '2.1', B: '0.9', C: '3.9' }, ['A', 'B', 'C']), null);
  assert.equal(cuotas({ A: 'x', B: '3', C: '4' }, ['A', 'B', 'C']), null);
});

test('ganador: H, D, A y valores invalidos', () => {
  assert.equal(ganador('H'), 0);
  assert.equal(ganador('D'), 1);
  assert.equal(ganador('A'), 2);
  assert.equal(ganador(''), null);
  assert.equal(ganador('X'), null);
});

test('agregarPartido: clasifica cada lado segun su movimiento y suma n=3 por partido', () => {
  // local baja 2.00 -> 1.80 (-10%: steam), empate igual (plano), visita sube 4.0 -> 4.4 (+10%: deriva)
  const v = agregarPartido([2.0, 3.5, 4.0], [1.8, 3.5, 4.4], 'H', 0.03);
  assert.equal(v.length, LEN);
  const m = metricas(v);
  assert.deepEqual([m.n.steam, m.n.plano, m.n.deriva], [1, 1, 1]);
  // el local (steam) gano: P/L al cierre = 1.8 - 1; al abrir = 2.0 - 1
  cerca(m.roiCierre.steam, 80);
  cerca(m.roiApertura.steam, 100);
  // empate y visita perdieron
  cerca(m.roiCierre.plano, -100);
  cerca(m.roiCierre.deriva, -100);
});

test('agregarPartido: la suma de probabilidades implicitas por partido es 1', () => {
  const v = agregarPartido([2.1, 3.3, 3.9], [2.0, 3.4, 4.1], 'D', 0.03);
  cerca(v[2] + v[7] + v[12], 1);
  cerca(v[1] + v[6] + v[11], 1);   // exactamente un ganador
});

test('agregarPartido: null si falta cuota o el resultado es invalido', () => {
  assert.equal(agregarPartido(null, [2, 3, 4], 'H', 0.03), null);
  assert.equal(agregarPartido([2, 3, 4], null, 'H', 0.03), null);
  assert.equal(agregarPartido([2, 3, 4], [2, 3, 4], '', 0.03), null);
});

test('exceso: sin movimiento y cierre perfectamente calibrado, todas las clases quedan cerca de 0 en promedio', () => {
  // mercado justo sin margen: si la prob implicita es p, y ganan exactamente p de las veces, exceso = 0
  const vec = [];
  for (let i = 0; i < 100; i++) {
    const w = i < 50 ? 'H' : i < 80 ? 'D' : 'A';       // 50/30/20
    vec.push(agregarPartido([2, 3.3333333, 5], [2, 3.3333333, 5], w, 0.03));
  }
  const m = metricas(sumar(vec));
  cerca(m.exceso.plano, 0, 1e-6);
  assert.equal(m.n.steam, 0);
  assert.equal(m.exceso.steam, null);
});

test('Brier apertura-cierre: >0 si el cierre se acerco mas al resultado real', () => {
  // abre 40/30/30, cierra 60/20/20; el local gano => el cierre predijo mejor
  const v = agregarPartido([2.5, 3.3333, 3.3333], [1.6667, 5, 5], 'H', 0.03);
  assert.ok(metricas(v).brier > 0);
  const inv = agregarPartido([2.5, 3.3333, 3.3333], [1.6667, 5, 5], 'A', 0.03);
  assert.ok(metricas(inv).brier < 0);
});

test('bootstrap: determinista, contiene el valor puntual y se estrecha con mas partidos', () => {
  const mk = (n) => Array.from({ length: n }, (_, i) => agregarPartido([2, 3.4, 4], [1.85, 3.4, 4.4], ['H', 'D', 'A', 'H'][i % 4], 0.03));
  const a = bootstrap(mk(60), (m) => m.exceso.steam, 200, 5), b = bootstrap(mk(60), (m) => m.exceso.steam, 200, 5);
  assert.deepEqual(a, b);
  const grande = mk(1200), punto = metricas(sumar(grande)).exceso.steam;
  const ciG = bootstrap(grande, (m) => m.exceso.steam, 200, 5), ciC = bootstrap(mk(60), (m) => m.exceso.steam, 200, 5);
  assert.ok(ciG[0] <= punto && punto <= ciG[1]);
  assert.ok(ciG[1] - ciG[0] < ciC[1] - ciC[0]);
  assert.equal(bootstrap([], (m) => m.dif), null);
});
