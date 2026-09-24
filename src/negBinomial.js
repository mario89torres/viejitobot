// Binomial negativa parametrizada por media (mu) y tamano/dispersion (r):
// var = mu + mu^2/r. r -> infinito converge a Poisson(mu) (el indice de
// dispersion 1 + mu/r -> 1) — por eso sirve tanto para AJUSTAR la NB como
// para comparar contra Poisson sin escribir el caso Poisson aparte (ver fit
// con `rFijo` en scripts/entrenar-nb-corners.js).
//
// POR QUE VEROSIMILITUD CENSURADA. Un partido donde la casa retiro el
// mercado de corners antes del pitido no da un conteo EXACTO: da un piso
// ("el conteo real es >= lo ultimo que se vio", porque los corners no
// bajan). Ajustar como si esos partidos dieran el valor exacto —o
// descartarlos, que sesga hacia los partidos con mercado activo hasta
// tarde, que no son una muestra aleatoria— fabrica una distribucion que no
// es la real. Es el mismo tipo de atajo que ya costo 184 picks inservibles
// en global_draw (ver memoria del proyecto). Por eso cada observacion
// censurada aporta P(X >= conteo_observado) a la verosimilitud, no
// P(X = conteo_observado).
//
// SIN LIBRERIA DE OPTIMIZACION EN EL PROYECTO (package.json no trae ninguna
// de calculo numerico): fit() implementa un ascenso coordenado con pasos
// multiplicativos decrecientes. Para 2 parametros y una verosimilitud
// unimodal esto converge sobrado sin necesitar gradientes ni una
// dependencia nueva.

// Aproximacion de Lanczos para ln(Gamma(x)), g=7 — precision de sobra
// (~1e-13) para el rango de conteos de corners (x < 40, tipicamente < 20).
const LANCZOS_G = 7;
const LANCZOS_COEF = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028,
  771.32342877765313, -176.61502916214059, 12.507343278686905,
  -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
];

function lnGamma(x) {
  if (x < 0.5) {
    // Reflexion: Gamma(x)*Gamma(1-x) = pi/sin(pi*x). No se necesita para
    // conteos (x siempre entero >= 0 en esta app) pero mantiene la funcion
    // correcta para cualquier x real, que es lo esperable de una lnGamma.
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - lnGamma(1 - x);
  }
  x -= 1;
  let a = LANCZOS_COEF[0];
  const t = x + LANCZOS_G + 0.5;
  for (let i = 1; i < LANCZOS_G + 2; i++) a += LANCZOS_COEF[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

function logPmf(x, mu, r) {
  if (!Number.isInteger(x) || x < 0 || mu <= 0 || r <= 0) return -Infinity;
  return lnGamma(x + r) - lnGamma(r) - lnGamma(x + 1)
    + r * Math.log(r / (r + mu))
    + x * Math.log(mu / (r + mu));
}
function pmf(x, mu, r) { return Math.exp(logPmf(x, mu, r)); }

// P(X <= x). Suma directa de la pmf — los conteos de corners son chicos
// (tipicamente < 20), sumar termino a termino es mas simple y mas estable
// numericamente aqui que la beta incompleta regularizada.
function cdf(x, mu, r) {
  if (x < 0) return 0;
  let acum = 0;
  for (let k = 0; k <= Math.floor(x); k++) acum += pmf(k, mu, r);
  return Math.min(1, acum);
}

// P(X >= c) — lo que aporta una observacion CENSURADA a la verosimilitud.
function survival(c, mu, r) {
  if (c <= 0) return 1;
  return Math.max(0, 1 - cdf(c - 1, mu, r));
}

// Lineas de mercado son .5 (nunca hay empate exacto en el total), asi que
// "por debajo de la linea" es X <= floor(linea) sin ambiguedad.
function probUnder(linea, mu, r) { return cdf(Math.floor(linea), mu, r); }
function probOver(linea, mu, r) { return 1 - probUnder(linea, mu, r); }

/**
 * Log-verosimilitud censurada por la derecha.
 * `obs`: [{ count, censored }] — censored=true si count es un PISO, no el
 * valor exacto (el canal murio antes de ver el conteo real de fin de
 * partido, que por monotonia solo puede ser igual o mayor).
 */
function logLikelihood(obs, mu, r) {
  let ll = 0;
  for (const o of obs) {
    ll += o.censored
      ? Math.log(Math.max(survival(o.count, mu, r), 1e-300))
      : logPmf(o.count, mu, r);
    if (!Number.isFinite(ll)) return -Infinity;
  }
  return ll;
}

/**
 * Ajusta (mu, r) por maxima verosimilitud sobre `obs` (censura mixta).
 * Si `opts.rFijo` se pasa, solo se mueve mu — es como se ajusta el caso
 * Poisson comparable (r muy grande) sin duplicar la formula del pmf.
 */
function fit(obs, opts = {}) {
  const media = obs.reduce((a, o) => a + o.count, 0) / obs.length || 1;
  let mu = opts.muInicial || media;
  let r = opts.rFijo || opts.rInicial || 5;
  const rFija = opts.rFijo != null;
  let mejor = logLikelihood(obs, mu, r);

  const pasos = [1, 0.3, 0.1, 0.03, 0.01, 0.003, 0.001];
  for (const paso of pasos) {
    let mejorando = true;
    while (mejorando) {
      mejorando = false;
      const candidatos = rFija
        ? [[paso, 0], [-paso, 0]]
        : [[paso, 0], [-paso, 0], [0, paso], [0, -paso]];
      for (const [dm, dr] of candidatos) {
        const muC = Math.max(1e-3, mu * (1 + dm));
        const rC = rFija ? r : Math.max(1e-3, r * (1 + dr));
        const ll = logLikelihood(obs, muC, rC);
        if (ll > mejor) { mejor = ll; mu = muC; r = rC; mejorando = true; }
      }
    }
  }
  return { mu, r, logLik: mejor, dispersion: 1 + mu / r, n: obs.length };
}

module.exports = { lnGamma, logPmf, pmf, cdf, survival, probUnder, probOver, logLikelihood, fit };
