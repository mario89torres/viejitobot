// Regresiones Poisson y logistica por Newton-Raphson / IRLS, con errores
// estandar y prueba de razon de verosimilitud. Puro, sin dependencias: el
// proyecto no trae libreria de calculo numerico (ver src/negBinomial.js) y aqui
// los modelos son de 2 a 4 parametros, asi que un solver denso basta.
//
// USO: scripts/backtest-xg-goles.js (¿el xG añade informacion mas alla de los
// goles y mas alla del precio del mercado?). Cada X es un arreglo de filas con
// la columna de intercepto INCLUIDA por quien llama (X[i][0] = 1).
const { lnGamma } = require('./negBinomial');

/** Resuelve A x = b (A cuadrada, eliminacion gaussiana con pivoteo parcial). null si es singular. */
function resolver(A, b) {
  const n = A.length;
  const M = A.map((f, i) => [...f, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = c + 1; r < n; r++) {
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k];
    x[r] = s / M[r][r];
  }
  return x;
}

/** Inversa de A (n pequeño) resolviendo A x = e_j. null si es singular. */
function invertir(A) {
  const n = A.length, cols = [];
  for (let j = 0; j < n; j++) {
    const e = new Array(n).fill(0); e[j] = 1;
    const x = resolver(A, e);
    if (!x) return null;
    cols.push(x);
  }
  return A.map((_, i) => cols.map(c => c[i]));
}

// H = X' W X y g = X' r, con pesos w y residuos r por fila
function normales(X, w, r) {
  const k = X[0].length, H = Array.from({ length: k }, () => new Array(k).fill(0)), g = new Array(k).fill(0);
  for (let i = 0; i < X.length; i++) {
    const xi = X[i];
    for (let a = 0; a < k; a++) {
      g[a] += xi[a] * r[i];
      for (let b = a; b < k; b++) H[a][b] += w[i] * xi[a] * xi[b];
    }
  }
  for (let a = 0; a < k; a++) for (let b = 0; b < a; b++) H[a][b] = H[b][a];
  return { H, g };
}

function resultado(X, coef, H, loglik, converged, iter) {
  const inv = invertir(H);
  return {
    coef, loglik, converged, iter, n: X.length,
    se: inv ? coef.map((_, i) => Math.sqrt(Math.max(inv[i][i], 0))) : coef.map(() => NaN),
  };
}

/** Regresion de Poisson (enlace log). y: conteos >= 0. `offset` opcional (log de exposicion). */
function poissonReg(X, y, { maxIter = 50, tol = 1e-9, offset = null } = {}) {
  const k = X[0].length;
  let b = new Array(k).fill(0);
  const ymedia = y.reduce((s, v) => s + v, 0) / y.length;
  b[0] = Math.log(Math.max(ymedia, 1e-6));   // arranque razonable: intercepto = log de la media
  let ll = -Infinity, H = null, conv = false, it = 0;
  const eta = (xi, i) => xi.reduce((s, v, j) => s + v * b[j], 0) + (offset ? offset[i] : 0);
  for (it = 1; it <= maxIter; it++) {
    const mu = X.map((xi, i) => Math.exp(Math.min(eta(xi, i), 30)));
    const r = y.map((v, i) => v - mu[i]);
    const nm = normales(X, mu, r);
    H = nm.H;
    const paso = resolver(H, nm.g);
    if (!paso) break;
    b = b.map((v, j) => v + paso[j]);
    const nuevo = y.reduce((s, v, i) => { const m = Math.exp(Math.min(eta(X[i], i), 30)); return s + v * Math.log(m) - m - lnGamma(v + 1); }, 0);
    if (Math.abs(nuevo - ll) < tol * (1 + Math.abs(nuevo))) { ll = nuevo; conv = true; break; }
    ll = nuevo;
  }
  const mu = X.map((xi, i) => Math.exp(Math.min(eta(xi, i), 30)));
  H = normales(X, mu, y.map((v, i) => v - mu[i])).H;
  return resultado(X, b, H, ll, conv, it);
}

/** Regresion logistica por IRLS. y: 0/1. */
function logisticReg(X, y, { maxIter = 50, tol = 1e-9 } = {}) {
  const k = X[0].length;
  let b = new Array(k).fill(0);
  const pm = Math.min(Math.max(y.reduce((s, v) => s + v, 0) / y.length, 1e-6), 1 - 1e-6);
  b[0] = Math.log(pm / (1 - pm));
  const prob = (xi) => 1 / (1 + Math.exp(-xi.reduce((s, v, j) => s + v * b[j], 0)));
  let ll = -Infinity, H = null, conv = false, it = 0;
  const logLik = () => y.reduce((s, v, i) => { const p = Math.min(Math.max(prob(X[i]), 1e-12), 1 - 1e-12); return s + (v ? Math.log(p) : Math.log(1 - p)); }, 0);
  for (it = 1; it <= maxIter; it++) {
    const p = X.map(prob);
    const w = p.map(v => Math.max(v * (1 - v), 1e-10));
    const nm = normales(X, w, y.map((v, i) => v - p[i]));
    H = nm.H;
    const paso = resolver(H, nm.g);
    if (!paso) break;
    b = b.map((v, j) => v + paso[j]);
    const nuevo = logLik();
    if (Math.abs(nuevo - ll) < tol * (1 + Math.abs(nuevo))) { ll = nuevo; conv = true; break; }
    ll = nuevo;
  }
  const p = X.map(prob);
  H = normales(X, p.map(v => Math.max(v * (1 - v), 1e-10)), y.map((v, i) => v - p[i])).H;
  return resultado(X, b, H, ll, conv, it);
}

// erfc de Abramowitz-Stegun 7.1.26 (error < 1.5e-7): suficiente para p-valores.
function erfc(x) {
  const z = Math.abs(x), t = 1 / (1 + 0.3275911 * z);
  const y = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429)))) * Math.exp(-z * z);
  return x >= 0 ? y : 2 - y;
}

/** p-valor de una chi-cuadrado con 1 o 2 grados de libertad (los unicos que se usan aqui). */
function pChi2(x, df) {
  if (x <= 0) return 1;
  if (df === 1) return erfc(Math.sqrt(x / 2));
  if (df === 2) return Math.exp(-x / 2);
  throw new Error('pChi2 solo soporta df 1 o 2');
}

/** Razon de verosimilitud: modelo completo vs restringido (anidado). */
function lrTest(llCompleto, llRestringido, df) {
  const estadistico = 2 * (llCompleto - llRestringido);
  return { estadistico, df, p: pChi2(estadistico, df) };
}

/** Normal estandar: p-valor de dos colas para un estadistico z (usa erfc). */
const pNormal2 = (z) => erfc(Math.abs(z) / Math.SQRT2);

module.exports = { resolver, invertir, poissonReg, logisticReg, pChi2, lrTest, pNormal2 };
