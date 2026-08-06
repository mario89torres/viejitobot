// De-vig: convierte los momios decimales de un mercado completo en
// probabilidades sin margen de la casa. Cuatro métodos, misma firma:
//   devig(oddsArray, method) -> probsArray  (suma 1 ± 1e-9)
// Si un método degenera y hay que caer a 'proportional', el array devuelto
// trae las propiedades probs.warning (motivo) y probs.methodUsed.

const METHODS = ['proportional', 'additive', 'power', 'shin'];

// Método por defecto, reversible vía .env (DEVIG_METHOD)
function defaultMethod() {
  const m = (process.env.DEVIG_METHOD || 'shin').toLowerCase();
  return METHODS.includes(m) ? m : 'shin';
}

function implied(odds) {
  if (!Array.isArray(odds) || !odds.length) throw new TypeError('devig: oddsArray vacío');
  return odds.map(o => {
    if (typeof o !== 'number' || !(o > 1) || !Number.isFinite(o)) {
      throw new TypeError(`devig: momio decimal inválido: ${o}`);
    }
    return 1 / o;
  });
}

function withFallback(p, reason) {
  const out = proportional(p);
  out.warning = reason;
  out.methodUsed = 'proportional';
  return out;
}

// (1/o_i) / Σ(1/o_j)
function proportional(p) {
  const sum = p.reduce((s, x) => s + x, 0);
  return p.map(x => x / sum);
}

// Resta el margen a partes iguales: π_i = p_i − (Σp − 1)/n
function additive(p) {
  const adj = (p.reduce((s, x) => s + x, 0) - 1) / p.length;
  const out = p.map(x => x - adj);
  if (out.some(x => x <= 0)) {
    return withFallback(p, 'additive produjo prob <= 0; fallback a proportional');
  }
  return out;
}

// Encuentra k tal que Σ p_i^k = 1 (búsqueda binaria; f es estrictamente
// decreciente en k porque 0 < p_i < 1). Tolerancia 1e-9.
function power(p) {
  const f = k => p.reduce((s, x) => s + Math.pow(x, k), 0);
  let lo = 1e-9, hi = 100;
  let k = 1;
  for (let i = 0; i < 200; i++) {
    k = (lo + hi) / 2;
    const v = f(k);
    if (Math.abs(v - 1) < 1e-9) break;
    if (v > 1) lo = k; else hi = k;
  }
  // renormaliza el residuo numérico para garantizar suma exacta = 1
  return proportional(p.map(x => Math.pow(x, k)));
}

// Shin (1993): z = proporción de dinero informado. Resuelve z tal que
//   π_i = (sqrt(z² + 4(1−z)·(p_i²/Σp)) − z) / (2(1−z))
// sumen 1. g(z) = Σπ_i − 1 es continua y decreciente en [0,1): g(0) = √Σp − 1 > 0
// con sobre-margen, así que la bisección converge al mismo z que el punto fijo.
function shin(p) {
  const P = p.reduce((s, x) => s + x, 0);
  if (P <= 1) {
    // sin margen que quitar: z = 0 y Shin colapsa a la normalización simple
    return withFallback(p, 'mercado sin sobre-margen (Σp <= 1); fallback a proportional');
  }
  if (p.length === 2) {
    // Con 2 resultados Shin equivale al aditivo: solución cerrada.
    const adj = (P - 1) / 2;
    return p.map(x => x - adj); // π_i = (p_i − p_j + 1)/2 > 0 siempre
  }
  const pi = z => p.map(x => (Math.sqrt(z * z + 4 * (1 - z) * (x * x / P)) - z) / (2 * (1 - z)));
  const g = z => pi(z).reduce((s, x) => s + x, 0) - 1;
  let lo = 0, hi = 1 - 1e-9;
  if (g(hi) > 0) return withFallback(p, 'shin no converge en z ∈ [0,1); fallback a proportional');
  while (hi - lo > 1e-12) {
    const mid = (lo + hi) / 2;
    if (Math.abs(g(mid)) < 1e-9) { lo = hi = mid; break; }
    if (g(mid) > 0) lo = mid; else hi = mid;
  }
  return proportional(pi((lo + hi) / 2));
}

function devig(oddsArray, method = defaultMethod()) {
  const p = implied(oddsArray);
  if (p.length === 1) return [1];
  switch (method) {
    case 'proportional': return proportional(p);
    case 'additive': return additive(p);
    case 'power': return power(p);
    case 'shin': return shin(p);
    default: throw new TypeError(`devig: método desconocido '${method}' (usa: ${METHODS.join(', ')})`);
  }
}

module.exports = { devig, METHODS, defaultMethod };
