/**
 * scripts/calibrar-dispersion-goles.js
 * ─────────────────────────────────────────────────────────────────────────
 * ¿Poisson basta para traducir un promedio de goles a probabilidades por linea,
 * o hay sobredispersion? Usa los CSV de football-data.co.uk ya descargados en
 * scratch/football-data/ (ver scripts/backtest-steam-football-data.js): goles
 * reales + cuota de cierre PROMEDIO del mercado de Mas/Menos de 2.5.
 *
 * Para cada r de una rejilla (Poisson = r enorme) se busca, partido a partido,
 * la media que reproduce la probabilidad de "Mas de 2.5" del mercado, y se mide
 * la verosimilitud de los goles reales. Diferencia de log-verosimilitud contra
 * Poisson, pareada por partido (error estandar analitico). Solo lectura.
 *
 * LIMITES: ligas europeas top (no las menores donde esta gran parte del
 * volumen de Playdoit); "cierre promedio" es un mercado eficiente, no Playdoit;
 * la media sale del propio mercado, no de xG. Esto calibra la FORMA de la
 * distribucion (dispersion), no el nivel de un partido concreto.
 *
 *   node scripts/calibrar-dispersion-goles.js [--desde 1920]
 */
const fs = require('fs');
const path = require('path');
const { parseCsv } = require('./backtest-steam-football-data');
const { R_POISSON, muParaProbMasDe, pOverDeCuotas, logLikGoles, probMasDeNB } = require('../src/dispersionGoles');
const { cdf } = require('../src/negBinomial');

const LIGAS = ['E0', 'E1', 'E2', 'E3', 'SC0', 'D1', 'D2', 'I1', 'I2', 'SP1', 'SP2', 'F1', 'F2', 'N1', 'B1', 'P1', 'T1', 'G1'];
const TEMPORADAS = ['1920', '2021', '2122', '2223', '2324', '2425', '2526'];
const REJILLA = [R_POISSON, 100, 50, 30, 20, 12, 8, 5];
const LINEA = 2.5;

function main() {
  const dir = path.join(__dirname, '..', 'scratch', 'football-data');
  const idx = process.argv.indexOf('--desde');
  const desde = idx > 0 ? process.argv[idx + 1] : TEMPORADAS[0];
  const partidos = [];
  for (const t of TEMPORADAS.filter(t => t >= desde)) {
    for (const l of LIGAS) {
      const p = path.join(dir, `${t}_${l}.csv`);
      if (!fs.existsSync(p)) continue;
      for (const f of parseCsv(fs.readFileSync(p, 'utf8'))) {
        const gl = Number(f.FTHG), gv = Number(f.FTAG);
        const pOver = pOverDeCuotas(Number(f['AvgC>2.5']), Number(f['AvgC<2.5']));
        if (!Number.isInteger(gl) || !Number.isInteger(gv) || pOver == null || f.FTHG === '' ) continue;
        partidos.push({ liga: l, temp: t, goles: gl + gv, pOver });
      }
    }
  }
  console.log(`partidos con goles y cierre Mas/Menos 2.5 (promedio): ${partidos.length} (${desde}-${TEMPORADAS[TEMPORADAS.length - 1]})\n`);
  if (!partidos.length) return;

  // 1. sanidad: ¿el mercado esta calibrado en la linea 2.5? (por deciles de pOver)
  console.log('── 1. Calibracion del mercado en la linea 2.5 (probabilidad justa vs frecuencia real) ──');
  const orden = [...partidos].sort((a, b) => a.pOver - b.pOver), B = 10;
  for (let b = 0; b < B; b++) {
    const g = orden.slice(Math.floor(b * orden.length / B), Math.floor((b + 1) * orden.length / B));
    const pm = g.reduce((s, x) => s + x.pOver, 0) / g.length, fr = g.filter(x => x.goles > LINEA).length / g.length;
    console.log(`  decil ${String(b + 1).padStart(2)}  n=${g.length}  mercado ${(100 * pm).toFixed(1)}%  real ${(100 * fr).toFixed(1)}%  dif ${(100 * (fr - pm) >= 0 ? '+' : '') + (100 * (fr - pm)).toFixed(1)} pp`);
  }
  const mediaGoles = partidos.reduce((s, x) => s + x.goles, 0) / partidos.length;
  const varGoles = partidos.reduce((s, x) => s + (x.goles - mediaGoles) ** 2, 0) / partidos.length;
  console.log(`  goles por partido: media ${mediaGoles.toFixed(3)}, varianza ${varGoles.toFixed(3)} (varianza/media = ${(varGoles / mediaGoles).toFixed(3)}, mezclando partidos de distinto nivel)\n`);

  // 2. rejilla de r: media que reproduce P(mas de 2.5) y verosimilitud de los goles
  console.log('── 2. Verosimilitud por r (mu ajustada para reproducir la linea 2.5 del mercado) ──');
  const ll = new Map(), mus = new Map();
  for (const r of REJILLA) {
    const a = new Float64Array(partidos.length), m = new Float64Array(partidos.length);
    partidos.forEach((p, i) => {
      const mu = muParaProbMasDe(p.pOver, LINEA, r);
      m[i] = mu == null ? NaN : mu;
      a[i] = mu == null ? NaN : logLikGoles(p.goles, mu, r);
    });
    ll.set(r, a); mus.set(r, m);
  }
  const base = ll.get(R_POISSON);
  const validos = partidos.map((_, i) => REJILLA.every(r => Number.isFinite(ll.get(r)[i])));
  const nVal = validos.filter(Boolean).length;
  console.log(`  partidos utilizables (mu dentro de rango en todas las r): ${nVal}`);
  let mejor = { r: R_POISSON, dLL: 0 };
  for (const r of REJILLA) {
    const a = ll.get(r);
    let s = 0, s2 = 0, n = 0;
    for (let i = 0; i < a.length; i++) if (validos[i]) { const d = a[i] - base[i]; s += d; s2 += d * d; n++; }
    const media = s / n, se = Math.sqrt(Math.max(s2 / n - media * media, 0) / n);
    if (media > mejor.dLL) mejor = { r, dLL: media };
    console.log(`  r=${r === R_POISSON ? 'Poisson' : String(r).padStart(7)}   delta log-verosimilitud vs Poisson: ${(media >= 0 ? '+' : '') + (media * 1000).toFixed(3)} milesimas/partido   (t = ${(media / se).toFixed(1)})`);
  }
  console.log(`  mejor r de la rejilla: ${mejor.r === R_POISSON ? 'Poisson (sin sobredispersion)' : mejor.r}\n`);

  // 3. distribucion predicha vs observada, Poisson y mejor r
  console.log('── 3. P(total >= k): observada vs Poisson vs mejor NB ──');
  const rNB = mejor.r === R_POISSON ? 30 : mejor.r; // si Poisson gana, se muestra r=30 solo como contraste
  const filasK = [1, 2, 3, 4, 5, 6];
  for (const k of filasK) {
    let obs = 0, pP = 0, pN = 0, n = 0;
    partidos.forEach((p, i) => {
      if (!validos[i]) return;
      n++;
      obs += p.goles >= k ? 1 : 0;
      pP += 1 - cdf(k - 1, mus.get(R_POISSON)[i], R_POISSON);
      pN += 1 - cdf(k - 1, mus.get(rNB)[i], rNB);
    });
    console.log(`  >= ${k} goles   real ${(100 * obs / n).toFixed(2)}%   Poisson ${(100 * pP / n).toFixed(2)}%   NB(r=${rNB}) ${(100 * pN / n).toFixed(2)}%`);
  }

  // 4. por liga: mejor r y media de goles (para priors)
  console.log('\n── 4. Por liga: goles medios y mejor r (rejilla) ──');
  const porLiga = new Map();
  partidos.forEach((p, i) => { if (!validos[i]) return; if (!porLiga.has(p.liga)) porLiga.set(p.liga, []); porLiga.get(p.liga).push(i); });
  const salida = {};
  for (const [liga, ids] of [...porLiga.entries()].sort((a, b) => b[1].length - a[1].length)) {
    let best = { r: R_POISSON, d: 0 };
    for (const r of REJILLA) { const a = ll.get(r); const d = ids.reduce((s, i) => s + a[i] - base[i], 0) / ids.length; if (d > best.d) best = { r, d }; }
    const media = ids.reduce((s, i) => s + partidos[i].goles, 0) / ids.length;
    salida[liga] = { n: ids.length, golesMedios: Number(media.toFixed(3)), mejorR: best.r === R_POISSON ? null : best.r };
    console.log(`  ${liga.padEnd(4)} n=${String(ids.length).padStart(5)}  goles/partido ${media.toFixed(2)}  mejor r ${best.r === R_POISSON ? 'Poisson' : best.r}`);
  }
  fs.writeFileSync(path.join(__dirname, '..', 'scratch', '_dispersion_goles.json'), JSON.stringify({ desde, n: nVal, mejorR: mejor.r === R_POISSON ? null : mejor.r, ligas: salida }, null, 1));
}

module.exports = { main };
if (require.main === module) main();
