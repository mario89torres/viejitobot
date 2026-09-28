// scripts/medir-calibracion-parlay-prepartido.js
//
// FASE 1 (medición, no ajuste): con datos reales tan escasos (4 días al 2026-09-28), no se puede
// construir un modelo de correlación para armarParlay() sin inventar un número — este script es el
// medidor que se re-corre según se acumulan días, para saber CUÁNDO ya hay suficiente para tocar
// pMin/oddMin/margenMin o el método de devig con datos, no con intuición.
//
// Dos preguntas, ambas de calibración (no de correlación — para eso hace falta que el parlay
// combinado tenga más de un puñado de días):
//   1. Por PATA: de las patas que entraron al parlay (p_justa >= pMin), ¿ganan tanto como su p_justa
//      dice? Esto es una prueba de la calidad del devig prepartido, no del parlay en sí.
//   2. Por PARLAY DEL DÍA: de los días con parlay armado (4 patas), ¿cuántos ganaron LOS 4?
//      Comparado con pConjunta (el producto de las p_justa) Y con el producto de las tasas de
//      victoria REALES por pata (si difieren mucho, ahí es donde se necesitaría un ajuste de
//      correlación — hoy no hay N para saberlo).
//
// Solo lectura. Uso: node scripts/medir-calibracion-parlay-prepartido.js
'use strict';

const Database = require('better-sqlite3');
const path = require('path');

const DB_FILE = process.env.DB_PATH || path.join(__dirname, '..', 'snapshots.db');
const db = new Database(DB_FILE, { readonly: true, timeout: 20000 });

const N_MIN_CONFIABLE = 100; // por debajo de esto, todo es "candidato", no conclusión (convención del proyecto)

const filas = db.prepare(
  `SELECT dia, event_id, market, selection, odd_decimal, p_justa, result, final_score
     FROM prematch_report_picks WHERE kind = 'parlay' ORDER BY dia, id`
).all();

console.log(`prematch_report_picks (kind='parlay'): ${filas.length} patas totales.`);

const liquidadas = filas.filter((f) => f.result === 'win' || f.result === 'loss');
console.log(`Liquidadas: ${liquidadas.length} (${filas.length - liquidadas.length} pendientes/push/sin resultado).`);

if (liquidadas.length < 30) {
  console.log(`\n⚠️  N=${liquidadas.length} es demasiado poco para decir nada con confianza (umbral orientativo: ${N_MIN_CONFIABLE}).`);
  console.log('   Lo que sigue es un candidato para vigilar, no una conclusión — re-correr este script según pasen los días.\n');
}

// 1) Calibración por pata: p_justa media vs. win% real.
const pMedia = liquidadas.reduce((s, f) => s + f.p_justa, 0) / (liquidadas.length || 1);
const winReal = liquidadas.filter((f) => f.result === 'win').length / (liquidadas.length || 1);
console.log('\n── Calibración por pata ──────────────────────────────────────');
console.log(`  p_justa media de las patas usadas : ${(pMedia * 100).toFixed(1)}%`);
console.log(`  % de victorias real               : ${(winReal * 100).toFixed(1)}%  (n=${liquidadas.length})`);
console.log(`  diferencia                        : ${((winReal - pMedia) * 100).toFixed(1)} pp`);

// 2) Por día: ¿ganaron las 4 patas?
const porDia = new Map();
for (const f of filas) {
  if (!porDia.has(f.dia)) porDia.set(f.dia, []);
  porDia.get(f.dia).push(f);
}
console.log('\n── Parlay por día ─────────────────────────────────────────────');
console.log('  dia          patas  liquidadas  todas_ganan  p_conjunta_prevista  producto_winrate_real');
let diasCompletos = 0, diasGanados = 0;
for (const [dia, patas] of porDia) {
  const liq = patas.filter((f) => f.result === 'win' || f.result === 'loss');
  const completo = liq.length === patas.length && patas.length > 0;
  const todasGanan = completo && liq.every((f) => f.result === 'win');
  const pConjunta = patas.reduce((a, f) => a * f.p_justa, 1);
  if (completo) { diasCompletos++; if (todasGanan) diasGanados++; }
  console.log(`  ${dia}   ${String(patas.length).padStart(5)}  ${String(liq.length).padStart(10)}  ${completo ? (todasGanan ? 'SÍ' : 'no') : '—'.padStart(3)}  ${(pConjunta * 100).toFixed(1)}%`.padEnd(90));
}
console.log(`\n  Días con las 4 patas liquidadas: ${diasCompletos}. De esos, ganó el parlay completo: ${diasGanados}.`);
if (diasCompletos > 0) {
  console.log(`  Tasa de acierto del parlay completo: ${(100 * diasGanados / diasCompletos).toFixed(1)}% (n=${diasCompletos} días — no es una tasa, es un conteo).`);
}
console.log('\nRe-correr este script cada tanto: con más días, la sección de calibración por pata (n≥100) será la primera en volverse confiable — la del parlay completo (un dato por día) tardará mucho más.');
