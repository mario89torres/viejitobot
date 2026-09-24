// BD temporal para los tests que ejercen el pipeline completo (rankPicks,
// safestPicks, goldenPick, modelPicks).
//
// POR QUE HACE FALTA. isRejectedBy5Guards es una de las POST_SCORE_GATES y
// decide CONSULTANDO LA BD: exige 4+ snapshots activos del mercado, feed vivo
// (<15 s), marcador quieto (90 s) y linea estable (60 s). Una fila sintetica no
// tiene nada de eso, asi que la guarda la rechaza y el pipeline devuelve lista
// vacia — la asercion falla lejos de su causa y parece un bug del filtro que se
// estaba probando.
//
// La alternativa era llamar a cada puerta por separado y saltarse rankPicks
// (lo que hace dnb-veto.test.js). Sirve para probar UNA puerta, pero no cubre
// el cableado: "la exclusion llega a /seguras y /golden" es precisamente una
// asercion sobre el cableado, y solo se puede comprobar atravesandolo.
//
// USO. Requerir ESTE MODULO ANTES que src/confidence.js, porque fija DB_PATH y
// src/db.js lee la ruta al cargarse:
//
//   const { sembrarGuardas } = require('./helpers/db-temporal');
//   const { rankPicks } = require('../src/confidence');
//   ...
//   sembrarGuardas(rows);
//   rankPicks(rows, { minConf: 0 });
const fs = require('fs');
const os = require('os');
const path = require('path');

// `node --test` lanza un proceso por archivo, asi que el PID basta para que dos
// archivos no compartan fichero. Se borra al empezar y no al terminar: si un
// test falla, la BD queda para inspeccionarla.
const DB_FILE = path.join(os.tmpdir(), `bot-monitor-test-${process.pid}.db`);
for (const suf of ['', '-wal', '-shm']) {
  try { fs.unlinkSync(DB_FILE + suf); } catch { /* no existia */ }
}
process.env.DB_PATH = DB_FILE;

const { db } = require('../../src/db');

const insertar = db.prepare(`
  INSERT INTO snapshots (ts, sport, event_id, event, score, market, selection, odd_decimal, suspended)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
`);

/**
 * Siembra el historial minimo para que las 5 guardias dejen pasar estas filas.
 *
 * Los snapshots se reparten hacia atras de 10 en 10 segundos y el mas reciente
 * cae en `ahora`: la guardia 2 rechaza si el ultimo tiene mas de 15 s, y sembrar
 * en el instante exacto deja margen para que el test tarde en llegar a la
 * asercion sin volverse intermitente.
 *
 * Marcador y cuota se copian de la fila y NO varian entre snapshots, que es lo
 * que piden las guardias 1 y 3 (marcador quieto, linea estable).
 *
 * Lo que NO hace: no ablanda la guardia 4 (colchon de goles). Un "Menos de 2.5"
 * con el marcador 2-0 seguira vetado por mucho que se siembre, y debe seguirlo:
 * ahi la guarda tiene razon. Si un fixture necesita pasar, dale un marcador con
 * colchon en vez de tocar la guarda.
 *
 * VACIA LA TABLA ANTES de sembrar, y no es un detalle de limpieza: dos casos del
 * mismo archivo suelen reusar el mismo eventId con cuotas distintas. Acumulando,
 * la guardia 3 compara la cuota del caso actual contra el minimo que dejo el
 * anterior y rechaza por "subio mas del 10%" — un fallo que aparece o no segun
 * el orden de ejecucion. Con `acumular: true` se siembran varios lotes a
 * proposito.
 */
function sembrarGuardas(rows, { snapshots = 5, acumular = false } = {}) {
  if (!acumular) limpiarSnapshots();
  const ahora = Date.now();
  const tx = db.transaction((filas) => {
    for (const r of filas) {
      for (let i = snapshots - 1; i >= 0; i--) {
        insertar.run(
          new Date(ahora - i * 10_000).toISOString(),
          r.sport, r.eventId, r.event, r.score, r.market, r.selection, r.oddDecimal,
        );
      }
    }
  });
  tx(rows);
}

/** Vacia la tabla entre casos, para que un fixture no herede el de otro. */
function limpiarSnapshots() {
  db.prepare('DELETE FROM snapshots').run();
}

module.exports = { db, sembrarGuardas, limpiarSnapshots, DB_FILE };
