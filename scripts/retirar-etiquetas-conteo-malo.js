// Retira las etiquetas por MONOTONIA derivadas con el contador roto (stats-1).
//
// QUE PASO. Hasta el 2026-08-30 conteoInferido tomaba el MAXIMO de los indices
// del mercado del N-esimo. La casa mantiene abiertos varios a la vez, asi que el
// maximo daba un conteo inflado ("10 corners en el minuto 2"). La monotonia se
// apoya en ese numero, asi que etiqueto `over` de mas.
//
// POR QUE SE ANULA LA ETIQUETA Y NO SE BORRA LA FILA. Si se borrara, el evento
// volveria a aparecer en getStatEventosPendientes (que busca eventos SIN fila de
// resultado) y el piloto lo re-liquidaria... reproduciendo las mismas etiquetas
// malas desde las mismas muestras, porque las filas stats-1 no guardaron los
// indices crudos y su `conteo` no se puede reparar. Anular deja el evento como
// liquidado, sin etiqueta, y conserva la evidencia (ultimos precios, muestras).
//
// El metodo queda sellado para que quede rastro de que hubo una etiqueta y se
// retiro, en vez de desaparecer sin dejar constancia.
//
//   node scripts/retirar-etiquetas-conteo-malo.js          # simula
//   node scripts/retirar-etiquetas-conteo-malo.js --write  # aplica
require('dotenv').config();
const { db } = require('../src/db');

const escribir = process.argv.includes('--write');
const donde = "feature_version = 'stats-1' AND metodo = 'monotonia' AND lado_ganador IS NOT NULL";

const antes = db.prepare(`SELECT COUNT(*) n FROM stat_results WHERE ${donde}`).get().n;
const total = db.prepare('SELECT COUNT(*) n, SUM(lado_ganador IS NOT NULL) etiq FROM stat_results').get();

console.log(`etiquetas por monotonia con conteo malo : ${antes}`);
console.log(`etiquetas totales antes                 : ${total.etiq} de ${total.n} lineas`);

if (escribir) {
  const r = db.prepare(`UPDATE stat_results
    SET lado_ganador = NULL, certeza = NULL, metodo = 'retirada_conteo_stats1'
    WHERE ${donde}`).run();
  const desp = db.prepare('SELECT COUNT(*) n, SUM(lado_ganador IS NOT NULL) etiq FROM stat_results').get();
  console.log(`\nfilas anuladas                          : ${r.changes}`);
  console.log(`etiquetas totales despues               : ${desp.etiq} de ${desp.n} lineas`);
  console.log(`por metodo: ${JSON.stringify(db.prepare(
    "SELECT metodo, COUNT(*) n FROM stat_results WHERE lado_ganador IS NOT NULL GROUP BY 1").all())}`);
  console.log('\nAPLICADO.');
} else {
  console.log('\nSIMULACION. Vuelve a correrlo con --write para aplicar.');
}
