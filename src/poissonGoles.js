// Probabilidades de goles totales a partir de un promedio esperado (por ejemplo
// el xG total esperado de src/prematchXg.js). Poisson simple: sin
// sobredispersion, sin ventaja de local, sin estado del juego. Es una
// traduccion aritmetica, NO un modelo calibrado — que el xG de temporada
// prediga bien los goles reales es justo lo que mide el piloto de xG.
//
// LA FORMA DE LA DISTRIBUCION SI ESTA VALIDADA (2026-09-24, 46,187 partidos de 18
// ligas europeas 2019/20-2025/26, scripts/calibrar-dispersion-goles.js): dada la
// media de cada partido (la que reproduce la linea Mas/Menos 2.5 del mercado),
// Poisson gana a la binomial negativa con cualquier r (t entre -11 y -49 a favor
// de Poisson): NO hay sobredispersion. Las colas reales son incluso algo mas
// ligeras: P(>=5 goles) real 13.27% vs Poisson 14.01%; P(>=6) 5.43% vs 6.06%.
// Con esa media Poisson sobrestima "Mas de 4.5" en ~0.7 pp; lineas 1.5-3.5 quedan
// dentro de ~0.5 pp. No hace falta binomial negativa para los goles totales.

// P(X <= k) para X ~ Poisson(lambda), k entero >= 0.
function poissonCdf(k, lambda) {
  if (!(lambda > 0) || k < 0) return k < 0 ? 0 : 1;
  let termino = Math.exp(-lambda);
  let acum = termino;
  for (let i = 1; i <= k; i++) {
    termino *= lambda / i;
    acum += termino;
  }
  return Math.min(1, acum);
}

// Linea de totales tipo 2.5: "Mas de 2.5" gana con 3 goles o mas.
function probMasDe(lambda, linea) {
  return 1 - poissonCdf(Math.floor(linea), lambda);
}

const probMenosDe = (lambda, linea) => poissonCdf(Math.floor(linea), lambda);

// Cuota decimal justa (sin margen) de una probabilidad; null si no es usable.
const cuotaJusta = (p) => (p > 0 && p < 1 ? 1 / p : null);

module.exports = { poissonCdf, probMasDe, probMenosDe, cuotaJusta };
