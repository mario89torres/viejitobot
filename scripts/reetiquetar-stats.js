// Re-etiqueta los partidos ya liquidados del piloto (stat_results) aplicando la
// regla actual de src/matchStats.js.
//
// POR QUE SE PUEDE HACER. Las etiquetas se derivan de stat_snapshots, que guarda
// la EVIDENCIA cruda y no solo la conclusion. Cambiar la regla no obliga a
// volver a muestrear ni un solo partido — que es exactamente para lo que se
// diseño asi. Es la primera vez que esa prevision se cobra sola.
//
// QUE PASO. La regla original exigia que el contador de corners siguiera vivo en
// la ULTIMA observacion del partido. Medido el 2026-08-30: la casa retira el
// mercado del N-esimo una media de 2.6 minutos ANTES del final, asi que todo
// partido seguido hasta el pitido salia censurado y la regla no se disparo nunca
// (0 etiquetas por conteo de 286 lineas). La regla nueva usa la MONOTONIA: los
// corners solo suben, asi que un conteo que ya supero la linea deja el over
// ganado para siempre, muera despues el contador o no.
//
//   node scripts/reetiquetar-stats.js          # simula, no escribe
//   node scripts/reetiquetar-stats.js --write  # aplica
require('dotenv').config();
const { getStatEventosEtiquetados, getStatMuestras, borrarStatResults, saveStatResults, db } = require('../src/db');
const { derivarEtiquetas } = require('../src/matchStats');

// derivarEtiquetas() no sabe nada de SofaScore — ese enriquecido lo hace
// aparte enriquecerConSofa() (bot.js), a mano, SOLO en el instante real de
// liquidar (necesita Chromium, no se puede reproducir aqui). Sin este
// rescate, borrar + reinsertar tiraria a la basura cualquier
// sofa_conteo_final/sofa_lado_ganador ya capturado para ese evento.
const sofaGuardadoStmt = db.prepare(`
  SELECT sofa_event_id, sofa_conteo_final, sofa_lado_ganador
  FROM stat_results WHERE event_id = ? AND sofa_event_id IS NOT NULL LIMIT 1
`);

const escribir = process.argv.includes('--write');

const eventos = getStatEventosEtiquetados();
console.log(`${eventos.length} partidos ya etiquetados\n`);

let antes = 0, despues = 0, lineas = 0, sinMuestras = 0;
const porMetodo = {};
const porCerteza = {};
const cambios = [];

for (const id of eventos) {
  const muestras = getStatMuestras(id);
  if (!muestras.length) { sinMuestras++; continue; }
  const nuevas = derivarEtiquetas(muestras);
  const sofaGuardado = sofaGuardadoStmt.get(id);
  for (const f of nuevas) {
    f.sofaEventId = sofaGuardado ? sofaGuardado.sofa_event_id : null;
    f.sofaConteoFinal = sofaGuardado ? sofaGuardado.sofa_conteo_final : null;
    f.sofaLadoGanador = sofaGuardado ? sofaGuardado.sofa_lado_ganador : null;
  }
  lineas += nuevas.length;
  for (const f of nuevas) {
    if (f.ladoGanador) {
      despues++;
      porMetodo[f.metodo] = (porMetodo[f.metodo] || 0) + 1;
      porCerteza[f.certeza] = (porCerteza[f.certeza] || 0) + 1;
      if (cambios.length < 10) cambios.push(f);
    }
  }
  if (escribir) {
    borrarStatResults(id);
    saveStatResults(nuevas);
  }
}

// Recuento previo, leido de la propia tabla antes de tocarla (si no se escribio)
antes = db.prepare('SELECT COUNT(*) n FROM stat_results WHERE lado_ganador IS NOT NULL').get().n;

console.log(`lineas re-derivadas : ${lineas}`);
console.log(`con etiqueta ANTES  : ${escribir ? '(ya reescrito)' : antes}`);
console.log(`con etiqueta DESPUES: ${despues}  (${lineas ? (100 * despues / lineas).toFixed(1) : 0}%)`);
console.log(`por metodo          : ${JSON.stringify(porMetodo)}`);
console.log(`por certeza         : ${JSON.stringify(porCerteza)}`);
if (sinMuestras) console.log(`sin muestras (evidencia podada): ${sinMuestras}`);

if (cambios.length) {
  console.log('\nmuestra de etiquetas nuevas:');
  for (const f of cambios) {
    console.log(`  ${f.familia.padEnd(8)} L${String(f.linea).padStart(5)} -> ${f.ladoGanador.padEnd(5)} ` +
      `(${f.metodo}/${f.certeza}) Nmax ${String(f.conteoMax ?? '—').padStart(3)} | ${f.event}`);
  }
}

console.log(escribir ? '\nESCRITO.' : '\nSIMULACION. Vuelve a correrlo con --write para aplicar.');
