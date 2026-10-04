// Calibracion de la DISPERSION de los goles totales de un partido. Puro, sin red
// ni BD (lo usa scripts/calibrar-dispersion-goles.js y se prueba en
// tests/dispersion-goles.test.js).
//
// PREGUNTA. src/poissonGoles.js traduce un promedio esperado de goles (por
// ejemplo el xG total) a probabilidades por linea con Poisson simple: varianza
// = media. Si los goles reales tienen MAS varianza que la media (sobredispersion),
// Poisson subestima las colas ("Menos de 1.5", "Mas de 4.5"). La binomial negativa
// (var = mu + mu^2/r) lo corrige con un unico parametro r; r -> infinito es Poisson.
//
// COMO SE IDENTIFICA r. Dado un mercado, la cuota de "Mas/Menos de 2.5" fija UN
// cuantil de la distribucion. Para cada valor de r se busca la media mu que
// reproduce esa probabilidad, y se evalua la verosimilitud de los goles reales
// bajo NB(mu, r). Asi r se elige por lo que el modelo predice en el RESTO de la
// distribucion (0, 1, 2, 4, 5+ goles), no por el punto ya usado para fijar mu.

const { logPmf, cdf } = require('./negBinomial');

const R_POISSON = 1e7; // r enorme: indistinguible de Poisson en conteos de goles

/** P(total > linea) bajo NB(mu, r). Lineas .5: "mas de 2.5" = 3 o mas goles. */
const probMasDeNB = (mu, linea, r) => 1 - cdf(Math.floor(linea), mu, r);

/**
 * Media mu tal que P(total > linea) = pOver bajo NB(., r), por biseccion (la
 * probabilidad crece con mu). null si pOver no es usable o cae fuera del rango
 * de medias plausibles en futbol.
 */
function muParaProbMasDe(pOver, linea, r, { lo = 0.2, hi = 9 } = {}) {
  if (!(pOver > 0.001 && pOver < 0.999)) return null;
  if (probMasDeNB(lo, linea, r) > pOver || probMasDeNB(hi, linea, r) < pOver) return null;
  for (let i = 0; i < 50; i++) {
    const mid = (lo + hi) / 2;
    if (probMasDeNB(mid, linea, r) < pOver) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Probabilidad justa de "Mas de" a partir de las dos cuotas de la linea (de-vig proporcional). */
function pOverDeCuotas(cuotaMas, cuotaMenos) {
  if (!(cuotaMas > 1) || !(cuotaMenos > 1)) return null;
  const a = 1 / cuotaMas, b = 1 / cuotaMenos;
  return a / (a + b);
}

/** Log-verosimilitud de un total de goles entero bajo NB(mu, r). */
const logLikGoles = (goles, mu, r) => logPmf(goles, mu, r);

module.exports = { R_POISSON, probMasDeNB, muParaProbMasDe, pOverDeCuotas, logLikGoles };
