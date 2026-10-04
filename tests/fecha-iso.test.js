const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

// start_date de prematch_snapshots se guarda en ISO con "T" y "Z" ("2026-09-24T01:30:00Z").
// datetime('now') de SQLite devuelve "2026-09-24 05:18:11" (con ESPACIO). Como "T" > " ",
// un partido de HOY siempre parece futuro al compararlos como texto. Hallado el
// 2026-09-24: el panel listaba como proximos partidos ya jugados y los contadores de
// monitoreo iban un dia atrasados. La comparacion correcta usa el mismo formato ISO.
const AHORA_ISO = "strftime('%Y-%m-%dT%H:%M:%SZ','now')";
const db = new Database(':memory:');

test('la trampa: datetime("now") trata como futuro un partido de hace horas del mismo dia', () => {
  const haceHoras = db.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-4 hours') AS s").get().s;
  const mismoDia = db.prepare("SELECT date('now') = date('now','-4 hours') AS mismo").get().mismo;
  if (!mismoDia) return; // cerca de la medianoche UTC el partido cae en el dia anterior y no hay trampa que mostrar
  const roto = db.prepare("SELECT ? < datetime('now') AS r").get(haceHoras).r;
  assert.equal(roto, 0, 'si esto pasa a 1, SQLite cambio su formato y la advertencia ya no aplica');
});

test('la comparacion en formato ISO clasifica bien pasado y futuro, incluso el mismo dia', () => {
  const pasado = db.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-4 hours') AS s").get().s;
  const futuro = db.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '+4 hours') AS s").get().s;
  assert.equal(db.prepare(`SELECT ? < ${AHORA_ISO} AS r`).get(pasado).r, 1);
  assert.equal(db.prepare(`SELECT ? > ${AHORA_ISO} AS r`).get(futuro).r, 1);
  assert.equal(db.prepare(`SELECT ? < ${AHORA_ISO} AS r`).get(futuro).r, 0);
});

test('el codigo de produccion ya no compara start_date con datetime("now")', () => {
  const fs = require('node:fs'), path = require('node:path');
  const raiz = path.join(__dirname, '..');
  for (const f of ['bot.js', 'src/server/dashboardApi.ts', 'scripts/backtest-steam-prematch.js']) {
    const txt = fs.readFileSync(path.join(raiz, f), 'utf8');
    assert.ok(!/start_date\s*[<>]\s*datetime\('now'\)/.test(txt), `${f} compara start_date (ISO) con datetime('now')`);
  }
});
