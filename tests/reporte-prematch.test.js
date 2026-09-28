const test = require('node:test');
const assert = require('node:assert');
const R = require('../src/reportePrematch');

const M1 = 'Resultado Final (Tiempo Regular)';
const fila = (id, event, market, selection, odd, extra = {}) => ({
  event_id: id, event, champ: 'Liga de Naciones UEFA', start_date: '2026-09-25T18:00:00Z', market, selection, odd_decimal: odd, suspended: 0, ...extra,
});
const partido = (id = 1, event = 'Italia vs. Bélgica', extra = {}) => R.agruparPartidos([
  fila(id, event, M1, 'Italia', 1.8, extra), fila(id, event, M1, 'Empate', 3.6, extra), fila(id, event, M1, ' Bélgica ', 4.5, extra),
  fila(id, event, 'Doble oportunidad', 'Italia o empate', 1.2, extra), fila(id, event, 'Doble oportunidad', 'Italia o  Bélgica', 1.3, extra),
  fila(id, event, 'Doble oportunidad', 'Empate o Bélgica', 1.9, extra),
  fila(id, event, 'Total 2.5', 'Más de 2.5', 1.9, extra), fila(id, event, 'Total 2.5', 'Menos de 2.5', 1.9, extra),
  fila(id, event, 'Ambos equipos marcan', 'Sí', 1.8, extra), fila(id, event, 'Ambos equipos marcan', 'No', 1.9, extra),
]).get(id);

test('esCategoriaMenor: divisiones inferiores por texto, ademas de sub/reservas/femenil/amateur', () => {
  for (const champ of ['Segunda División Argentina', 'Liga de Ascenso Costa Rica', 'Primera B Chile', 'Tercera División España', 'Liga Regional Amateur']) {
    assert.ok(R.esCategoriaMenor(champ, 'A vs. B'), champ);
  }
  // el caso real que motivo el cambio: selecciones nacionales de nivel FIFA, NO se detectan (limite conocido, documentado en el codigo)
  assert.ok(!R.esCategoriaMenor('Clasificación Mundial CONCACAF', 'Jamaica vs. Honduras'));
  // primera division normal no debe excluirse
  assert.ok(!R.esCategoriaMenor('Liga MX', 'América vs. Chivas'));
  assert.ok(!R.esCategoriaMenor('Premier League', 'Arsenal vs. Chelsea'));
});

test('las probabilidades justas de cada mercado suman 1 (sin margen)', () => {
  const patas = R.patasDePartido(partido());
  const suma = (mkt) => patas.filter(x => x.market === mkt).reduce((s, x) => s + x.p, 0);
  assert.ok(Math.abs(suma(M1) - 1) < 1e-9);
  assert.ok(Math.abs(suma('Total 2.5') - 1) < 1e-9);
  assert.ok(Math.abs(suma('Ambos equipos marcan') - 1) < 1e-9);
});

test('doble oportunidad = suma de las p del 1X2 des-marginado', () => {
  const patas = R.patasDePartido(partido());
  const p = (mkt, sel) => patas.find(x => x.market === mkt && R.norm(x.sel) === R.norm(sel)).p;
  const local = p(M1, 'Italia'), empate = p(M1, 'Empate'), visita = p(M1, 'Bélgica');
  assert.ok(Math.abs(p('Doble oportunidad', 'Italia o empate') - (local + empate)) < 1e-9);
  assert.ok(Math.abs(p('Doble oportunidad', 'Italia o Bélgica') - (local + visita)) < 1e-9);
  assert.ok(Math.abs(p('Doble oportunidad', 'Empate o Bélgica') - (empate + visita)) < 1e-9);
});

test('cuotas suspendidas o invalidas no entran', () => {
  const m = R.agruparPartidos([fila(1, 'A vs. B', M1, 'A', 1.5, { suspended: 1 }), fila(1, 'A vs. B', M1, 'B', 1.0)]);
  assert.strictEqual(m.size, 0);
});

const pata = (id, p, odd, extra = {}) => ({ eventId: id, event: `Eq${id} vs. Otro${id}`, champ: 'Liga de Naciones UEFA',
  start: '2026-09-25T18:00:00Z', market: M1, sel: `Eq${id}`, odd, p, ...extra });
const AHORA = Date.parse('2026-09-25T14:00:00Z');

test('parlay: una pata por partido, minimo 3 y maximo 4', () => {
  const patas = [pata(1, 0.8, 1.3), pata(1, 0.78, 1.28), pata(2, 0.77, 1.3), pata(3, 0.76, 1.3), pata(4, 0.75, 1.3), pata(5, 0.74, 1.3)];
  const r = R.armarParlay(patas, { ahoraMs: AHORA });
  assert.strictEqual(r.patas.length, 4);
  assert.strictEqual(new Set(r.patas.map(x => x.eventId)).size, 4);
  assert.ok(Math.abs(r.pConjunta - r.patas.reduce((a, x) => a * x.p, 1)) < 1e-12);
  assert.ok(Math.abs(r.cuota - r.patas.reduce((a, x) => a * x.odd, 1)) < 1e-12);
  assert.strictEqual(R.armarParlay([pata(1, 0.8, 1.3), pata(2, 0.8, 1.3)], { ahoraMs: AHORA }), null);
});

test('parlay: descarta categorias menores, cuotas cortas, p baja y partidos por empezar', () => {
  const malas = [
    pata(1, 0.9, 1.3, { champ: 'Paulista Sub-20' }), pata(2, 0.9, 1.05), pata(3, 0.5, 2.0),
    pata(4, 0.9, 1.3, { start: '2026-09-25T14:20:00Z' }), pata(5, 0.9, 1.3, { event: 'Ajax (W) vs. PSV (W)' }),
  ];
  assert.strictEqual(R.armarParlay([...malas, pata(6, 0.8, 1.3), pata(7, 0.8, 1.3)], { ahoraMs: AHORA }), null);
  assert.strictEqual(R.armarParlay([...malas, pata(6, 0.8, 1.3), pata(7, 0.8, 1.3), pata(8, 0.8, 1.3)], { ahoraMs: AHORA }).patas.length, 3);
});

test('parlay: entre las seguras prefiere las de menos margen (mayor p*cuota)', () => {
  const patas = [pata(1, 0.8, 1.2), pata(2, 0.75, 1.3), pata(3, 0.75, 1.25), pata(4, 0.75, 1.32)];
  const r = R.armarParlay(patas, { ahoraMs: AHORA, max: 3 });
  assert.deepStrictEqual(r.patas.map(x => x.eventId), [4, 2, 1]);
});

test('resolverPata: 1X2, DNB con push, doble oportunidad, totales y ambos marcan', () => {
  const ev = 'Italia vs. Bélgica';
  const r = (market, selection, gl, gv) => R.resolverPata({ market, selection, event: ev }, gl, gv);
  assert.strictEqual(r(M1, 'Italia', 2, 1), 'win');
  assert.strictEqual(r(M1, ' Bélgica ', 2, 1), 'loss');
  assert.strictEqual(r(M1, 'Empate', 1, 1), 'win');
  assert.strictEqual(r('Empate No Accion', 'Italia', 1, 1), 'push');
  assert.strictEqual(r('Empate No Accion', 'Italia', 0, 1), 'loss');
  assert.strictEqual(r('Doble oportunidad', 'Italia o empate', 1, 1), 'win');
  assert.strictEqual(r('Doble oportunidad', 'Italia o empate', 0, 1), 'loss');
  assert.strictEqual(r('Doble oportunidad', 'Italia o  Bélgica', 1, 1), 'loss');
  assert.strictEqual(r('Doble oportunidad', 'Empate o Bélgica', 0, 2), 'win');
  assert.strictEqual(r('Total 2.5', 'Más de 2.5', 2, 1), 'win');
  assert.strictEqual(r('Total 2.5', 'Menos de 2.5', 2, 1), 'loss');
  assert.strictEqual(r('Total 3.5', 'Menos de 3.5', 2, 1), 'win');
  assert.strictEqual(r('Ambos equipos marcan', 'Sí', 1, 1), 'win');
  assert.strictEqual(r('Ambos equipos marcan', 'No', 2, 0), 'win');
  assert.strictEqual(r('Mercado raro', 'x', 1, 1), null);
  assert.strictEqual(R.resolverPata({ market: M1, selection: 'Italia', event: ev }, null, 1), null);
});

test('valorSharp: ultima lectura por seleccion, solo edge positivo, ordenado', () => {
  const f = (id, sel, edge, ts) => ({ event_id: id, market: 'h2h', selection: sel, edge_pct: edge, ts });
  const r = R.valorSharp([f(1, 'A', 5, '2026-09-25T01:00:00Z'), f(1, 'A', -2, '2026-09-25T02:00:00Z'),
    f(2, 'B', 3, '2026-09-25T01:00:00Z'), f(3, 'C', 7, '2026-09-25T01:00:00Z'), f(4, 'D', 0.4, '2026-09-25T01:00:00Z')]);
  assert.deepStrictEqual(r.map(x => x.selection), ['C', 'B']);
});

test('csv: BOM, separador ; y una fila por pata', () => {
  const csv = R.csvTodas(new Map([[1, partido()]]));
  assert.ok(csv.startsWith('﻿hora_cdmx;'));
  assert.strictEqual(csv.trim().split('\r\n').length, 1 + 10);
});

test('imagen y leyenda: sin lectura sharp lo dicen, sin parlay tambien', () => {
  const d = R.armarDatosImagen({ fecha: 'x', hora: '08:00', valor: [], parlay: null, totalPartidos: 5, top: [] });
  assert.ok(d.sections.length === 3 && d.sections[0].rows[0][1].includes('Sin valor'));
  assert.ok(R.leyenda({ valor: [], parlay: null }).includes('no se inventa valor'));
  const parlay = R.armarParlay([pata(1, 0.8, 1.3), pata(2, 0.8, 1.3), pata(3, 0.8, 1.3)], { ahoraMs: AHORA });
  assert.ok(R.leyenda({ valor: [], parlay }).includes('Valor esperado'));
});

test('parlay de proximos: solo patas que empiezan dentro de la ventana y no en los proximos minutos', () => {
  const en = (min, id, extra = {}) => pata(id, 0.8, 1.3, { start: new Date(AHORA + min * 60000).toISOString(), ...extra });
  const patas = [en(5, 1), en(30, 2), en(90, 3), en(150, 4), en(400, 5), en(500, 6)];
  const r = R.armarParlayProximos(patas, { ahoraMs: AHORA, horas: 3 });
  assert.deepStrictEqual(r.patas.map(x => x.eventId).sort(), [2, 3, 4]); // 1 empieza en 5 min (< 10), 5 y 6 fuera de 3 h
  assert.strictEqual(R.armarParlayProximos(patas, { ahoraMs: AHORA, horas: 1 }), null); // solo 1 pata en la hora
});

test('texto del parlay de proximos: con y sin parlay, escapa HTML y avisa la frescura', () => {
  const patas = [pata(1, 0.8, 1.3, { event: 'A & B vs. <C>' }), pata(2, 0.8, 1.3), pata(3, 0.8, 1.3)];
  const t = R.textoParlayProximos(R.armarParlay(patas, { ahoraMs: AHORA }), { horas: 3, partidos: 3, frescuraMin: 12 });
  assert.ok(t.includes('A &amp; B vs. &lt;C&gt;') && t.includes('hace 12 min') && t.includes('Valor esperado'));
  assert.ok(R.textoParlayProximos(null, { horas: 3, partidos: 0, frescuraMin: null }).includes('No hay 3 patas'));
});

test('resumenEstado: parlay LOSS si una pata perdio, pendiente si falta, WIN si todas ganaron (push sale)', () => {
  const f = (kind, result, odd = 1.3, dia = '2026-09-25') => ({ kind, result, odd_decimal: odd, dia });
  let r = R.resumenEstado([f('parlay', 'win'), f('parlay', 'loss'), f('top', null)]);
  assert.strictEqual(r.parlays[0].estado, 'loss');
  assert.deepStrictEqual([r.total, r.liquidadas, r.pendientes, r.wins, r.decididas], [3, 2, 1, 1, 2]);
  assert.strictEqual(R.resumenEstado([f('parlay', 'win'), f('parlay', null)]).parlays[0].estado, 'pendiente');
  r = R.resumenEstado([f('parlay', 'win', 1.2), f('parlay', 'push', 1.5), f('parlay', 'win', 1.3)]);
  assert.strictEqual(r.parlays[0].estado, 'win');
  assert.ok(Math.abs(r.parlays[0].cuota - 1.56) < 1e-9); // el push no multiplica
  assert.strictEqual(R.resumenEstado([f('parlay', 'push')]).parlays[0].estado, 'push');
});

test('armarEstadoImagen: pill por resultado, pendiente sin pill, vacio con mensaje y texto envuelto', () => {
  const fila = (result, extra = {}) => ({ dia: '2026-09-25', kind: 'top', event: 'A vs. B', selection: 'A o empate', odd_decimal: 1.2, result, final_score: result ? '2-1' : null, ...extra });
  const d = R.armarEstadoImagen({ fecha: 'x', hora: '08:00', filas: [fila('win'), fila('loss'), fila('push'), fila(null)] });
  const res = d.sections[0].rows.map(r => r[6]);
  assert.deepStrictEqual(res.map(c => c.t), ['WIN', 'LOSS', 'PUSH', 'Pend.']);
  assert.ok(res[0].pill && !res[3].pill);
  assert.ok(d.sections[0].wrap);
  const cols = d.sections[0].columns;
  assert.ok(Math.abs(cols.reduce((a, c) => a + c.w, 0) - 1) < 1e-9);
  for (const r of d.sections[0].rows) assert.strictEqual(r.length, cols.length);
  assert.ok(R.armarEstadoImagen({ fecha: 'x', hora: 'y', filas: [] }).sections[0].rows[0][2].includes('Aún no hay'));
});

test('horaEncuentro: hora CDMX del partido; con fecha si cae en otro dia que el reporte; guion sin dato', () => {
  // 2026-09-26T02:30Z = 20:30 del 25-sep en CDMX (UTC-6, sin horario de verano)
  assert.strictEqual(R.horaEncuentro({ dia: '2026-09-25', start_date: '2026-09-26T02:30:00Z' }), '20:30');
  assert.strictEqual(R.horaEncuentro({ dia: '2026-09-25', start_date: '2026-09-26T07:00:00Z' }), '26/09 01:00');
  assert.strictEqual(R.horaEncuentro({ dia: '2026-09-25', start_date: null }), '—');
  const d = R.armarEstadoImagen({ fecha: 'x', hora: '08:00', filas: [{ dia: '2026-09-25', kind: 'top', event: 'A vs. B', selection: 'A', odd_decimal: 1.2, result: null, start_date: '2026-09-26T02:30:00Z' }] });
  assert.strictEqual(d.sections[0].columns[1].name, 'Hora');
  assert.strictEqual(d.sections[0].rows[0][1], '20:30');
});
