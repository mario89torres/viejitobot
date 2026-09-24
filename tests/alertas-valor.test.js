// Alertas de valor: filtro, formato y dedupe (src/valueAlerts.js).
//
// El dedupe se prueba contra una BD TEMPORAL, no contra snapshots.db. Es la
// leccion del 2026-09-04, cuando tests/model.test.js escribio sobre el
// model.json de produccion y hubo que reconstruirlo desde la BD.
const path = require('path');
const os = require('os');
const fs = require('fs');

const DB_FILE = path.join(os.tmpdir(), `bot-monitor-alertas-test-${process.pid}.db`);
for (const suf of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_FILE + suf); } catch {} }
process.env.DB_PATH = DB_FILE;

const test = require('node:test');
const assert = require('node:assert');
const { config, esCandidato, motivoDescarte, formatearAlerta, esUnder } = require('../src/valueAlerts');
const { db, getPicksSinAlertar, marcarAlertado, yaAlertado } = require('../src/db');

const CFG = config({});   // los defaults: edge [3%, 8%), solo Under, Fútbol

const pick = (o = {}) => ({
  id: 1, ts: new Date().toISOString(), event_id: 555, event: 'Toluca vs. León',
  sport: 'Fútbol', market: 'Total 2.5', selection: 'Menos de 2.5',
  odd_decimal: 1.85, conf: 0.72, edge: 0.05, ...o,
});

// ─────────────────────────────── FILTRO ───────────────────────────────

test('el edge es una BANDA: la cola alta se descarta', () => {
  // Contraintuitivo pero medido: edge >=20% rinde -3.89% con WR 53.5% (n=318).
  // Un edge enorme es el modelo discrepando mucho del mercado, y de media el
  // mercado tiene razon.
  assert.ok(esCandidato(pick({ edge: 0.05 }), CFG));
  assert.match(motivoDescarte(pick({ edge: 0.02 }), CFG), /< 3%/);
  assert.match(motivoDescarte(pick({ edge: 0.08 }), CFG), /la cola alta pierde/);
  assert.match(motivoDescarte(pick({ edge: 0.35 }), CFG), /la cola alta pierde/);
});

test('los limites de la banda son inclusivo abajo y exclusivo arriba', () => {
  assert.ok(esCandidato(pick({ edge: 0.03 }), CFG), '3% entra');
  assert.ok(!esCandidato(pick({ edge: 0.0799999 }), CFG) === false, '7.99% entra');
  assert.ok(!esCandidato(pick({ edge: 0.08 }), CFG), '8% ya no');
});

test('solo Under, y el acento no decide', () => {
  assert.ok(esUnder({ selection: 'Menos de 2.5' }));
  assert.ok(esUnder({ selection: 'menos de 3.5' }));
  assert.ok(!esUnder({ selection: 'Más de 2.5' }));
  assert.ok(!esUnder({ selection: 'Mas de 2.5' }));
  assert.ok(!esUnder({ selection: 'Equipo A' }));
  assert.match(motivoDescarte(pick({ selection: 'Más de 2.5' }), CFG), /no es Under/);
});

test('filtra por deporte', () => {
  assert.ok(esCandidato(pick({ sport: 'Fútbol' }), CFG));
  assert.match(motivoDescarte(pick({ sport: 'Tenis' }), CFG), /deporte fuera/);
});

test('un pick sin edge no se alerta', () => {
  assert.match(motivoDescarte(pick({ edge: null }), CFG), /sin edge/);
});

test('la configuracion se puede abrir por entorno', () => {
  const abierta = config({ ALERTA_EDGE_MIN: '0', ALERTA_EDGE_MAX: '1', ALERTA_SOLO_UNDER: '0', ALERTA_DEPORTES: 'Tenis,Hockey' });
  assert.ok(esCandidato(pick({ sport: 'Hockey', selection: 'Más de 2.5', edge: 0.5 }), abierta));
  assert.ok(!esCandidato(pick({ sport: 'Fútbol' }), abierta), 'Fútbol ya no está en la lista');
});

// ─────────────────────────────── FORMATO ──────────────────────────────

test('el mensaje trae las seis cosas que pide leerse de un vistazo', () => {
  const m = formatearAlerta(pick(), { link: 'https://ejemplo/x' });
  assert.match(m, /Toluca vs\. León/, 'partido');
  assert.match(m, /Total 2\.5/, 'mercado');
  assert.match(m, /Menos de 2\.5/, 'selección');
  assert.match(m, /Casa <b>1\.85<\/b>/, 'precio de la casa');
  assert.match(m, /Justo <b>1\.39<\/b>/, 'valor justo = 1/conf');
  assert.match(m, /Edge <b>\+5\.0%<\/b>/, 'edge en %');
  assert.match(m, /https:\/\/ejemplo\/x/, 'deep link');
});

test('el deep link usa el formato de Playdoit con evento y deporte', () => {
  const m = formatearAlerta(pick({ event_id: 17520368, sport_id: 66 }));
  assert.match(m, /playdoit\.mx\/#page=event&amp;eventId=17520368&amp;sportId=66/);
});

test('escapa el HTML: un nombre con < no rompe el mensaje', () => {
  const m = formatearAlerta(pick({ event: 'A <b>x</b> vs. B' }), { link: 'x' });
  assert.match(m, /A &lt;b&gt;x&lt;\/b&gt; vs\. B/);
  assert.ok(!/A <b>x<\/b> vs/.test(m), 'no debe quedar HTML crudo del dato');
});

test('sin marcador ni minuto no deja una linea huerfana', () => {
  const m = formatearAlerta(pick({ score: null, minute: null }), { link: 'x' });
  assert.ok(!m.includes('⏱'), 'la línea de estado se omite entera');
});

// ─────────────────────────────── DEDUPE ───────────────────────────────

test('dos ciclos seguidos con el mismo pick generan UNA alerta', () => {
  db.prepare('DELETE FROM value_alerts').run();
  db.prepare('DELETE FROM picks').run();
  const ahora = new Date().toISOString();
  db.prepare(`INSERT INTO picks (id, ts, event_id, event, sport, market, selection, odd_decimal, conf, edge)
    VALUES (77, ?, 555, 'Toluca vs. León', 'Fútbol', 'Total 2.5', 'Menos de 2.5', 1.85, 0.72, 0.05)`).run(ahora);
  const desde = new Date(Date.now() - 20 * 60000).toISOString();

  const ciclo1 = getPicksSinAlertar(desde);
  assert.strictEqual(ciclo1.length, 1, 'el primer ciclo lo ve');
  marcarAlertado(ciclo1[0], false);

  const ciclo2 = getPicksSinAlertar(desde);
  assert.strictEqual(ciclo2.length, 0, 'el segundo ciclo ya no');
  assert.ok(yaAlertado(77));
});

test('marcar dos veces no duplica ni revienta', () => {
  db.prepare('DELETE FROM value_alerts').run();
  const p = { id: 88, odd_decimal: 2, conf: 0.6, edge: 0.05 };
  assert.strictEqual(marcarAlertado(p, false), 1, 'la primera inserta');
  assert.strictEqual(marcarAlertado(p, false), 0, 'la segunda es INSERT OR IGNORE');
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM value_alerts').get().n, 1);
});

test('guarda el precio del aviso, para poder medir el CLV despues', () => {
  db.prepare('DELETE FROM value_alerts').run();
  marcarAlertado({ id: 99, odd_decimal: 1.85, conf: 0.72, edge: 0.05 }, false);
  const r = db.prepare('SELECT * FROM value_alerts WHERE pick_id = 99').get();
  assert.strictEqual(r.odd_alertada, 1.85);
  assert.strictEqual(r.edge_alertado, 0.05);
  assert.strictEqual(r.dry_run, 0);
});

test('el techo de edad impide que el primer arranque mande el historico', () => {
  // Sin el, el primer ciclo veria miles de picks viejos sin fila en
  // value_alerts y los enviaria todos de golpe.
  db.prepare('DELETE FROM value_alerts').run();
  db.prepare('DELETE FROM picks').run();
  const viejo = new Date(Date.now() - 5 * 3600 * 1000).toISOString();
  db.prepare(`INSERT INTO picks (id, ts, event_id, event, sport, market, selection, odd_decimal, conf, edge)
    VALUES (1, ?, 1, 'Viejo vs. Antiguo', 'Fútbol', 'Total 2.5', 'Menos de 2.5', 1.85, 0.72, 0.05)`).run(viejo);
  const desde = new Date(Date.now() - 20 * 60000).toISOString();
  assert.strictEqual(getPicksSinAlertar(desde).length, 0, 'un pick de hace 5 h queda fuera');
});

test('un pick ya liquidado no se alerta', () => {
  db.prepare('DELETE FROM value_alerts').run();
  db.prepare('DELETE FROM picks').run();
  const ahora = new Date().toISOString();
  db.prepare(`INSERT INTO picks (id, ts, event_id, event, sport, market, selection, odd_decimal, conf, edge, result)
    VALUES (5, ?, 1, 'Ya vs. Terminado', 'Fútbol', 'Total 2.5', 'Menos de 2.5', 1.85, 0.72, 0.05, 'win')`).run(ahora);
  const desde = new Date(Date.now() - 20 * 60000).toISOString();
  assert.strictEqual(getPicksSinAlertar(desde).length, 0, 'avisar de algo ya decidido es ruido');
});
