/**
 * scripts/entrenar-nb-corners.js
 * ─────────────────────────────────────────────────────────────────────────
 * Ajusta la binomial negativa del TOTAL de corners por partido via MLE con
 * verosimilitud censurada (ver src/negBinomial.js), y la compara contra
 * Poisson sobre la MISMA verosimilitud (likelihood ratio test) — no contra
 * el indice de dispersion nada mas, que ya se sabia sesgado por la censura
 * silenciosa que se arreglo en src/matchStats.js el 2026-09-10.
 *
 * DATOS: un registro por evento liquidado de familia='corner', tomando
 * conteo_final (que bajo serie_fiable=1 coincide con conteo_max — los
 * corners no bajan) y censurado. Solo entra serie_fiable=1: una serie que
 * bajo es lectura corrupta, no dato.
 *
 *   node scripts/entrenar-nb-corners.js
 */
require('dotenv').config();
const { db } = require('../src/db');
const nb = require('../src/negBinomial');

const rows = db.prepare(`
  SELECT event_id, MAX(conteo_final) conteo_final, MAX(serie_fiable) serie_fiable,
         MAX(conteo_censurado) censurado
  FROM stat_results WHERE familia = 'corner' GROUP BY event_id
`).all();

const obs = rows
  .filter(r => r.serie_fiable === 1 && r.conteo_final != null)
  .map(r => ({ count: r.conteo_final, censored: r.censurado === 1 }));

const nCensuradas = obs.filter(o => o.censored).length;
console.log(`eventos con serie fiable y conteo: ${obs.length} (${nCensuradas} censurados por la derecha, ${(100 * nCensuradas / obs.length).toFixed(1)}%)`);

if (obs.length < 30) {
  console.log('\nMuy pocos datos para un ajuste con algo de solidez (< 30). Se ajusta igual, pero tomen los numeros con pinzas.');
}

// ── Ajuste libre (NB real) ──
const ajusteNB = nb.fit(obs);

// ── Ajuste Poisson comparable: NB con r fijo enorme (== Poisson), mismo
//    dato y misma verosimilitud censurada, para que el likelihood ratio
//    test compare manzanas con manzanas. ──
const ajustePoisson = nb.fit(obs, { rFijo: 1e7, muInicial: ajusteNB.mu });

const LR = 2 * (ajusteNB.logLik - ajustePoisson.logLik);
// Poisson es NB con 1 restriccion menos (r libre vs r fijo): 1 grado de
// libertad. Critico chi2(1): 3.84 (95%), 6.64 (99%), 10.83 (99.9%).
const critico99 = 6.635;

console.log('\n── Binomial Negativa (MLE, verosimilitud censurada) ──');
console.log(`mu (media)     : ${ajusteNB.mu.toFixed(3)}`);
console.log(`r (tamano)     : ${ajusteNB.r.toFixed(3)}`);
console.log(`dispersion     : ${ajusteNB.dispersion.toFixed(3)} (Poisson = 1.0)`);
console.log(`log-verosim.   : ${ajusteNB.logLik.toFixed(2)}`);

console.log('\n── Poisson comparable (mismo dato, misma censura) ──');
console.log(`mu (media)     : ${ajustePoisson.mu.toFixed(3)}`);
console.log(`log-verosim.   : ${ajustePoisson.logLik.toFixed(2)}`);

console.log('\n── Likelihood ratio test (NB vs Poisson) ──');
console.log(`LR = ${LR.toFixed(2)}  (critico chi2(1) al 99% = ${critico99})`);
console.log(LR > critico99
  ? '=> Se rechaza Poisson: la NB ajusta significativamente mejor.'
  : '=> NO hay evidencia suficiente para preferir NB sobre Poisson con estos datos.');

// ── Tabla de referencia: como cambia P(under) segun el modelo, para dar
//    una idea de cuanto importa esto en la practica sobre lineas tipicas. ──
console.log('\n── P(Under) por linea, NB vs Poisson (mismo mu) ──');
console.log('linea\tP(under) NB\tP(under) Poisson\tdiferencia');
for (const linea of [3.5, 5.5, 7.5, 9.5, 11.5]) {
  const pNB = nb.probUnder(linea, ajusteNB.mu, ajusteNB.r);
  const pPoi = nb.probUnder(linea, ajustePoisson.mu, ajustePoisson.r);
  console.log(`${linea}\t${pNB.toFixed(4)}\t\t${pPoi.toFixed(4)}\t\t${(pNB - pPoi >= 0 ? '+' : '')}${(pNB - pPoi).toFixed(4)}`);
}
