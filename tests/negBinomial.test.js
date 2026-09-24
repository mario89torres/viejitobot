// src/negBinomial.js: pmf/cdf/survival correctos y el optimizador recupera
// los parametros reales sobre datos sinteticos, INCLUYENDO censura. Si esto
// no se sostiene, cualquier numero que salga de scripts/entrenar-nb-corners.js
// es ruido con forma de estadistica.
const test = require('node:test');
const assert = require('node:assert');
const nb = require('../src/negBinomial');

test('pmf suma 1 sobre un rango razonable', () => {
  const suma = Array.from({ length: 60 }, (_, x) => nb.pmf(x, 5, 3)).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(suma - 1) < 1e-6, `suma=${suma}`);
});

test('cdf y survival son complementarios: cdf(c-1) + survival(c) = 1', () => {
  for (const c of [1, 3, 7, 15]) {
    const suma = nb.cdf(c - 1, 4.2, 2.5) + nb.survival(c, 4.2, 2.5);
    assert.ok(Math.abs(suma - 1) < 1e-9, `c=${c} suma=${suma}`);
  }
});

test('survival(0) es 1 (cualquier conteo es >= 0)', () => {
  assert.strictEqual(nb.survival(0, 4, 2), 1);
});

test('r grande converge a Poisson: NB(mu,r->inf) ~= Poisson(mu)', () => {
  const mu = 4;
  const poissonPmf = (x) => Math.exp(-mu) * mu ** x / Array.from({ length: x }, (_, i) => i + 1).reduce((a, b) => a * b, 1);
  for (const x of [0, 2, 4, 8]) {
    const nbVal = nb.pmf(x, mu, 1e6);
    const poiVal = poissonPmf(x);
    assert.ok(Math.abs(nbVal - poiVal) < 1e-4, `x=${x} nb=${nbVal} poisson=${poiVal}`);
  }
});

test('dispersion = 1 + mu/r: r chico da mas varianza que Poisson', () => {
  // var/mu = 1 + mu/r; con r peque (mucha sobredispersion) la cola derecha
  // de la pmf debe pesar mas que en Poisson con la misma media.
  const mu = 5;
  const colaNB = 1 - nb.cdf(9, mu, 1); // r=1 (mucha sobredispersion)
  const colaPoisson = 1 - nb.cdf(9, mu, 1e6);
  assert.ok(colaNB > colaPoisson, `cola NB=${colaNB} deberia ser mayor que Poisson=${colaPoisson}`);
});

test('probUnder + probOver = 1 para una linea de mercado (.5)', () => {
  const pu = nb.probUnder(3.5, 4.5, 2);
  const po = nb.probOver(3.5, 4.5, 2);
  assert.ok(Math.abs(pu + po - 1) < 1e-9);
});

test('logLikelihood: una observacion censurada en 0 aporta log(1) = 0', () => {
  const ll = nb.logLikelihood([{ count: 0, censored: true }], 5, 3);
  assert.ok(Math.abs(ll) < 1e-9, `ll=${ll}`);
});

test('fit recupera mu y r conocidos sobre una muestra sintetica sin censura', () => {
  // Generador NB por mezcla Gamma-Poisson: X | lambda ~ Poisson(lambda),
  // lambda ~ Gamma(r, escala=mu/r). Con semilla fija para reproducibilidad.
  let seed = 42;
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const gammaMuestra = (shape) => {
    // Marsaglia-Tsang, suficiente para shape > 1; para shape<=1 se usa el
    // truco de potencia (Ahrens-Dieter), aceptable para este test.
    if (shape < 1) {
      const u = rand();
      return gammaMuestra(1 + shape) * Math.pow(u, 1 / shape);
    }
    const d = shape - 1 / 3, c = 1 / Math.sqrt(9 * d);
    for (;;) {
      let x, v;
      do {
        // Box-Muller para normal estandar
        const u1 = rand(), u2 = rand();
        x = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
        v = 1 + c * x;
      } while (v <= 0);
      v = v * v * v;
      const u = rand();
      if (u < 1 - 0.0331 * x ** 4) return d * v;
      if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
    }
  };
  const poissonMuestra = (lambda) => {
    const L = Math.exp(-lambda);
    let k = 0, p = 1;
    do { k++; p *= rand(); } while (p > L);
    return k - 1;
  };

  const muReal = 6, rReal = 4;
  const obs = [];
  for (let i = 0; i < 4000; i++) {
    const lambda = gammaMuestra(rReal) * (muReal / rReal);
    obs.push({ count: poissonMuestra(lambda), censored: false });
  }
  const { mu, r } = nb.fit(obs);
  assert.ok(Math.abs(mu - muReal) < 0.3, `mu ajustado=${mu}, real=${muReal}`);
  assert.ok(Math.abs(r - rReal) / rReal < 0.35, `r ajustado=${r}, real=${rReal}`);
});

test('fit con censura no colapsa mu hacia abajo (vs ignorar la censura)', () => {
  // Si la censura se tratara como valor EXACTO en vez de piso, mu saldria
  // sesgado hacia abajo. Se compara el ajuste censurado-correcto contra
  // tratar (a proposito, MAL) las censuradas como exactas.
  const muReal = 6, rReal = 3;
  // seed FUERA de genSample a proposito: si viviera adentro, cada llamada la
  // reiniciaria y las 600 "muestras" serian 600 copias del mismo numero — se
  // encontro exactamente ese bug corriendo este test (mu ajustado se iba a
  // 96 porque la "muestra" no tenia varianza real).
  let seed = 7;
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const genSample = (mu, r) => {
    // Aproximacion simple: usar el propio pmf para samplear por inversion.
    const u = rand();
    let acum = 0;
    for (let x = 0; x < 200; x++) {
      acum += nb.pmf(x, mu, r);
      if (u <= acum) return x;
    }
    return 200;
  };
  const obsReal = Array.from({ length: 600 }, () => genSample(muReal, rReal));
  // Simula censura: cualquier conteo real >= 6 se "observa" truncado en 6
  // (el mercado se retiro antes de llegar ahi).
  const TOPE_CENSURA = 6;
  const obsCensuradoCorrecto = obsReal.map(x => x >= TOPE_CENSURA
    ? { count: TOPE_CENSURA, censored: true }
    : { count: x, censored: false });
  const obsTratadaComoExacta = obsReal.map(x => ({ count: Math.min(x, TOPE_CENSURA), censored: false }));

  const correcto = nb.fit(obsCensuradoCorrecto);
  const sesgado = nb.fit(obsTratadaComoExacta);

  // El ajuste que SI modela la censura debe quedar mas cerca de mu real que
  // el que trata el tope como si fuera el valor de verdad.
  const errorCorrecto = Math.abs(correcto.mu - muReal);
  const errorSesgado = Math.abs(sesgado.mu - muReal);
  assert.ok(errorCorrecto < errorSesgado,
    `censura modelada deberia acercarse mas: correcto mu=${correcto.mu} (err ${errorCorrecto}) vs sesgado mu=${sesgado.mu} (err ${errorSesgado})`);
});
