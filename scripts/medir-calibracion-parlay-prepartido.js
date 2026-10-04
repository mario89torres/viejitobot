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

// ── Resultado del parlay completo en UNIDADES ─────────────────────────────────
// 1u por día al parlay del reporte (kind='parlay'), a la cuota combinada de las patas MOSTRADAS en el
// reporte (producto de odd_decimal). Una pata perdida pierde el parlay; una pata 'push' sale del
// producto (cuota 1). Días con alguna pata pendiente se excluyen: contarlos como pérdida o como
// ganancia sería inventar el resultado. La cuota es la de las 08:00: quien apuesta después puede
// encontrar otra (ver EXEC_PROBE), así que esto es un techo razonable, no el resultado ejecutable.
const wilson = (k, n, z = 1.96) => {
  if (!n) return [null, null];
  const p = k / n, d = 1 + z * z / n, c = p + z * z / (2 * n), m = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
  return [(c - m) / d, (c + m) / d];
};
console.log('\n── Parlay completo, 1u por día ─────────────────────────────────');
console.log('  dia          patas  estado     cuota  p_conj  ev_previsto  resultado_u');
let nDec = 0, nGan = 0, plTot = 0, evTot = 0;
for (const [dia, patas] of porDia) {
  const pend = patas.filter((f) => f.result == null).length;
  const cuota = patas.reduce((a, f) => a * f.odd_decimal, 1);
  const pConj = patas.reduce((a, f) => a * f.p_justa, 1);
  const ev = pConj * cuota - 1;
  let estado, pl = null;
  if (patas.some((f) => f.result === 'loss')) { estado = 'perdido'; pl = -1; }          // ya decidido aunque queden pendientes
  else if (pend) estado = `pend(${pend})`;
  else { estado = 'ganado'; pl = patas.filter((f) => f.result === 'win').reduce((a, f) => a * f.odd_decimal, 1) - 1; }
  if (pl !== null) { nDec++; plTot += pl; evTot += ev; if (pl > 0) nGan++; }
  console.log(`  ${dia}   ${String(patas.length).padStart(5)}  ${estado.padEnd(9)}  ${cuota.toFixed(2).padStart(5)}  ${(100 * pConj).toFixed(0).padStart(5)}%  ${(100 * ev).toFixed(1).padStart(10)}%  ${pl === null ? '—' : (pl >= 0 ? '+' : '') + pl.toFixed(2)}`);
}
if (nDec) {
  const [lo, hi] = wilson(nGan, nDec);
  console.log(`\n  Días decididos: ${nDec} · ganados: ${nGan} (${(100 * nGan / nDec).toFixed(0)}%, IC95 ${(100 * lo).toFixed(0)}-${(100 * hi).toFixed(0)}%)`);
  console.log(`  P/L real: ${plTot >= 0 ? '+' : ''}${plTot.toFixed(2)}u sobre ${nDec}u apostadas (ROI ${(100 * plTot / nDec).toFixed(1)}%) · EV previsto por el reporte (media): ${(100 * evTot / nDec).toFixed(1)}%`);
  console.log(nDec < 30 ? `  ⚠️  ${nDec} días no alcanzan para concluir (el ROI de un parlay es muy ruidoso); es un conteo, no una tasa.` : '');
}

// Singles: las patas "top" y "parlay" apostadas por separado a 1u, para separar "buen pick" de "mala combinación".
console.log('\n── Las mismas patas apostadas SUELTAS, 1u cada una ─────────────');
for (const kind of ['top', 'parlay']) {
  const rs = db.prepare(`SELECT odd_decimal o, result r FROM prematch_report_picks WHERE kind = ? AND result IN ('win','loss')`).all(kind);
  if (!rs.length) continue;
  const pl = rs.reduce((s, x) => s + (x.r === 'win' ? x.o - 1 : -1), 0);
  const w = rs.filter((x) => x.r === 'win').length, [lo, hi] = wilson(w, rs.length);
  console.log(`  ${kind.padEnd(7)} n=${rs.length}  win ${(100 * w / rs.length).toFixed(1)}% (IC95 ${(100 * lo).toFixed(0)}-${(100 * hi).toFixed(0)}%)  ROI ${(100 * pl / rs.length).toFixed(1)}%  P/L ${pl >= 0 ? '+' : ''}${pl.toFixed(1)}u`);
}
const ult = db.prepare("SELECT MAX(dia) d FROM prematch_report_picks").get().d;
console.log(`\nÚltimo reporte guardado: ${ult}. Los días sin reporte (equipo dormido a las 08:00) no aportan datos.`);

// ── Parlays del botón /parlayprox (kind='parlay_prox') ────────────────────────
// Los registra solo el dueño al presionarlo; pueden ser varios por día (cada uno = un `ts`). Se miden por
// separado de los de las 08:00: se arman con cuotas de minutos antes y partidos por empezar, así que son
// más parecidos a lo que se apuesta de verdad. Muestra = lo que el dueño haya presionado, no un calendario.
const prox = db.prepare("SELECT ts, dia, odd_decimal o, p_justa p, result r FROM prematch_report_picks WHERE kind = 'parlay_prox' ORDER BY ts").all();
const porTs = new Map();
for (const f of prox) { if (!porTs.has(f.ts)) porTs.set(f.ts, []); porTs.get(f.ts).push(f); }
console.log('\n── Parlays del botón /parlayprox ───────────────────────────────');
if (!porTs.size) console.log('  Aún no hay ninguno registrado (se guardan cuando el dueño presiona el botón).');
else {
  let dec = 0, gan = 0, pl = 0;
  for (const [ts, patas] of porTs) {
    const cuota = patas.reduce((a, f) => a * f.o, 1), pConj = patas.reduce((a, f) => a * f.p, 1);
    let estado, res = null;
    if (patas.some((f) => f.r === 'loss')) { estado = 'perdido'; res = -1; }
    else if (patas.some((f) => f.r == null)) estado = 'pendiente';
    else { estado = 'ganado'; res = patas.filter((f) => f.r === 'win').reduce((a, f) => a * f.o, 1) - 1; }
    if (res !== null) { dec++; pl += res; if (res > 0) gan++; }
    console.log(`  ${ts.slice(0, 16)}Z  ${patas.length} patas  cuota ${cuota.toFixed(2)}  p_conj ${(100 * pConj).toFixed(0)}%  ${estado}${res === null ? '' : `  ${res >= 0 ? '+' : ''}${res.toFixed(2)}u`}`);
  }
  console.log(`  Decididos: ${dec} · ganados: ${gan} · P/L ${pl >= 0 ? '+' : ''}${pl.toFixed(2)}u${dec < 30 ? ' (muy pocos para concluir)' : ''}`);
}
