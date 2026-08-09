/**
 * Marca con score_version = 0 las filas de `source='global_draw'` cuyas features
 * fueron FABRICADAS por globalDrawScanner.ts antes del arreglo de 2026-08-09.
 *
 * EL BUG: el scanner insertaba una única combinación constante en cada pick —
 * f_prob_justa=0.72, f_avance=0.85, f_situacion=0.75, f_linea=0.82, conf=0.76 —
 * en vez de llamar a scoreRow(). Las 224 filas que llegó a emitir comparten esa
 * huella exacta y tienen etiqueta `y` real, así que cualquier modelo entrenado
 * sobre ellas aprende una constante contra un resultado: ruido con forma de
 * señal. Ya produjo un falso positivo caro (la regla R6 del firewall, ver la
 * nota en src/firewall.js).
 *
 * POR QUÉ score_version = 0 y no otra cosa:
 *   - Es explícito y auditable. Un NULL en alguna feature también las sacaría
 *     del dataset, pero de forma tácita: dentro de un mes nadie sabría por qué,
 *     y un backfill futuro las repoblaría en silencio. Eso NO es hipotético —
 *     es literalmente lo que pasó con f_avance_model: el backfill copió el 0.85
 *     fabricado en las 224 filas sin distinguirlas.
 *   - No borra nada. El histórico de lo que el bot mandó a Telegram y cómo
 *     salió sigue intacto, y revertir es un UPDATE.
 *   - 0 nunca colisiona con una versión real de scoring (SCORE_VERSION va desde
 *     1 y sube), así que `score_version > 0` es un filtro seguro para siempre.
 *
 * OJO — esto NO es un filtro por `source`: los picks del scanner POSTERIORES al
 * arreglo llevan features reales y score_version normal, y SÍ deben entrenar.
 * Lo que se excluye es la huella fabricada, no el origen. Por eso el criterio
 * es la combinación exacta de constantes, no `source='global_draw'` a secas.
 *
 * Uso:
 *   node scripts/mark-fabricated-global-draws.js            # dry-run, no escribe
 *   node scripts/mark-fabricated-global-draws.js --apply    # escribe
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { db } = require('../src/db');

const APPLY = process.argv.includes('--apply');

// La huella exacta del scanner roto. Se exige TODA la combinación, no una
// feature suelta: un pick real podría tener f_linea=0.82 por casualidad.
const WHERE = `
  source = 'global_draw'
  AND f_prob_justa = 0.72 AND f_avance = 0.85
  AND f_situacion = 0.75 AND f_linea  = 0.82
  AND conf = 0.76
`;

const rows = db.prepare(`
  SELECT id, ts, event, market, selection, odd_decimal, result, score_version
  FROM picks WHERE ${WHERE} ORDER BY ts
`).all();

console.log(`Filas con la huella fabricada: ${rows.length}`);
if (!rows.length) { console.log('Nada que hacer.'); process.exit(0); }

const byResult = rows.reduce((a, r) => { a[r.result || 'pendiente'] = (a[r.result || 'pendiente'] || 0) + 1; return a; }, {});
console.log('  por resultado :', byResult);
console.log(`  rango de ts   : ${rows[0].ts} → ${rows[rows.length - 1].ts}`);
console.log(`  ya marcadas   : ${rows.filter(r => r.score_version === 0).length}`);

// Guardia: si alguna fila NO tiene las 5 constantes no debería haber entrado en
// el SELECT. Si el conteo por source no cuadra, algo cambió y mejor parar.
const totalGlobal = db.prepare(`SELECT COUNT(*) n FROM picks WHERE source = 'global_draw'`).get().n;
if (rows.length > totalGlobal) {
  console.error('❌ Inconsistencia: más filas con huella que picks global_draw. No se escribe nada.');
  process.exit(1);
}
if (rows.length < totalGlobal) {
  console.log(`  (${totalGlobal - rows.length} pick(s) global_draw NO tienen la huella — features reales, se dejan intactos)`);
}

// Cuántas de estas entrarían hoy al dataset. Hoy son 0 porque f_apertura quedó
// NULL y export-dataset.js exige que no lo sea — pero es una exclusión POR
// ACCIDENTE, no por decisión. Marcarlas la hace deliberada y a prueba de un
// futuro backfill de f_apertura.
const inDataset = db.prepare(`
  SELECT COUNT(*) n FROM picks
  WHERE ${WHERE} AND result IN ('win','loss')
    AND f_prob_justa IS NOT NULL AND f_avance_model IS NOT NULL
    AND f_situacion IS NOT NULL AND f_linea IS NOT NULL AND f_apertura IS NOT NULL
`).get().n;
console.log(`  entran al dataset AHORA MISMO: ${inDataset}`);

if (!APPLY) {
  console.log('\n(dry-run) Nada escrito. Repite con --apply para persistir.');
  process.exit(0);
}

const info = db.prepare(`UPDATE picks SET score_version = 0 WHERE ${WHERE}`).run();
console.log(`\n✅ ${info.changes} filas marcadas con score_version = 0.`);
console.log('   Revertir: UPDATE picks SET score_version = 1 WHERE score_version = 0;');
