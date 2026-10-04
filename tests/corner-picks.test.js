require('./helpers/db-temporal');
const test = require('node:test');
const assert = require('node:assert');
const { configCorner, candidatosCorners, resultadoCorner, mensajeCorners } = require('../src/cornerPicks');
const dbm = require('../src/db');

const CFG = configCorner({});
const sug = (extra = {}) => ({ linea: 9.5, lado: 'over', odd: 2.0, pModelo: 0.70, pMercado: 0.50, edge: 0.20, ...extra });
const df = (extra = {}, sugerida = sug(), poisson = {}) => ({
  playdoit: { eventId: '17620795.0', event: 'Alfa vs. Beta ', champ: 'Liga X' },
  fotmob: { fotmobEventId: 555, cornersHome: 3, cornersAway: 2 },
  poisson: { calibrado: true, minuto: 45, esperados: 10.2, sugerida, ...poisson },
  ...extra,
});

test('umbrales por defecto provisionales y configurables por entorno', () => {
  assert.deepStrictEqual(CFG, { minEdge: 0.15, minMinuto: 15, maxMinuto: 80, oddMin: 1.30, oddMax: 3.50, maxPorHora: 6 });
  assert.strictEqual(configCorner({ CORNER_MIN_EDGE: '0.25' }).minEdge, 0.25);
  assert.strictEqual(configCorner({ CORNER_MIN_EDGE: '' }).minEdge, 0.15);
});

test('un candidato válido sale con el id normalizado y el modelo calibrado', () => {
  const [c] = candidatosCorners([df()]);
  assert.strictEqual(c.eventId, 17620795);
  assert.strictEqual(c.event, 'Alfa vs. Beta');
  assert.strictEqual(c.conteoReal, 5);
  assert.strictEqual(c.nbVersion, 'nb-cal-1');
});

test('nunca emite con el modelo original (no calibrado) ni sin conteo real', () => {
  assert.strictEqual(candidatosCorners([df({}, sug(), { calibrado: false })]).length, 0);
  assert.strictEqual(candidatosCorners([df({ fotmob: { fotmobEventId: 1, cornersHome: null, cornersAway: 2 } })]).length, 0);
  assert.strictEqual(candidatosCorners([df({}, null)]).length, 0);
});

test('guardas: edge, cuota, ventana de minutos y línea ya decidida', () => {
  assert.strictEqual(candidatosCorners([df({}, sug({ edge: 0.149 }))]).length, 0);
  assert.strictEqual(candidatosCorners([df({}, sug({ odd: 1.2 }))]).length, 0);
  assert.strictEqual(candidatosCorners([df({}, sug({ odd: 4 }))]).length, 0);
  assert.strictEqual(candidatosCorners([df({}, sug(), { minuto: 10 })]).length, 0);
  assert.strictEqual(candidatosCorners([df({}, sug(), { minuto: 85 })]).length, 0);
  assert.strictEqual(candidatosCorners([df({}, sug(), { minuto: null })]).length, 0);
  // ya van 10 corners con la línea en 9.5: decidida, no se emite
  assert.strictEqual(candidatosCorners([df({ fotmob: { fotmobEventId: 1, cornersHome: 6, cornersAway: 4 } })]).length, 0);
});

test('ordena por edge descendente', () => {
  const a = df(); const b = df({ playdoit: { eventId: 2, event: 'Gamma vs. Delta' } }, sug({ edge: 0.40 }));
  assert.deepStrictEqual(candidatosCorners([a, b]).map((x) => x.eventId), [2, 17620795]);
});

test('resultadoCorner: líneas .5, push en entero y null sin dato', () => {
  assert.strictEqual(resultadoCorner('over', 9.5, 10), 'win');
  assert.strictEqual(resultadoCorner('over', 9.5, 9), 'loss');
  assert.strictEqual(resultadoCorner('under', 9.5, 9), 'win');
  assert.strictEqual(resultadoCorner('under', 9.5, 10), 'loss');
  assert.strictEqual(resultadoCorner('over', 9, 9), 'push');
  assert.strictEqual(resultadoCorner('over', 9.5, null), null);
  assert.strictEqual(resultadoCorner('raro', 9.5, 10), null);
});

test('el mensaje deja claro que es un experimento sin ventaja demostrada', () => {
  const [c] = candidatosCorners([df()]);
  const m = mensajeCorners([c], [7]);
  assert.match(m, /CORNERS — experimento/);
  assert.match(m, /sin stake/);
  assert.match(m, /no ha mostrado ventaja/);
  assert.match(m, /#C7/);
  assert.match(m, /Más de 9\.5 @ 2\.00/);
  assert.match(m, /diferencia <b>\+20 pp<\/b>/);
});

test('BD: un solo pick por partido y liquidación contra el conteo final de stat_results', () => {
  const [c] = candidatosCorners([df()]);
  const id = dbm.logCornerPick(c);
  assert.ok(id > 0);
  assert.strictEqual(dbm.logCornerPick(c), null, 'el mismo partido no se registra dos veces');
  assert.strictEqual(dbm.getUnsettledCornerPicks().length, 1);
  assert.strictEqual(dbm.getCornerFinalCount(17620795, 9.5), undefined, 'sin etiqueta del piloto: sigue pendiente');
  dbm.db.prepare(`INSERT INTO stat_results (event_id, event, familia, linea, fotmob_conteo_final) VALUES (17620795, 'Alfa vs. Beta', 'corner', 9.5, 12)`).run();
  const fin = dbm.getCornerFinalCount(17620795, 9.5);
  assert.strictEqual(fin, 12);
  dbm.settleCornerPick(id, resultadoCorner('over', 9.5, fin), fin);
  const fila = dbm.db.prepare('SELECT result, final_count FROM corner_picks WHERE id = ?').get(id);
  assert.deepStrictEqual({ ...fila }, { result: 'win', final_count: 12 });
  assert.strictEqual(dbm.getUnsettledCornerPicks().length, 0);
});
