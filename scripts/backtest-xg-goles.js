/**
 * scripts/backtest-xg-goles.js
 * ─────────────────────────────────────────────────────────────────────────
 * ¿La señal de xG PREDICE los goles totales de un partido? Reconstruye, para
 * cada partido, lo que el piloto prematch_xg_scan habria calculado ANTES de
 * jugarlo (xG y goles a favor/en contra acumulados de la temporada hasta ese
 * momento, mismos dos estimadores: "simple" y "normalizado por liga") y lo
 * contrasta con los goles reales. Datos: scratch/fotmob-xg/ (xG por partido de
 * FotMob, ver scripts/recolectar-xg-fotmob.js) y, para la comparacion con el
 * mercado, los CSV de football-data.co.uk (cierre promedio de Mas/Menos 2.5).
 * Solo lectura.
 *
 * PREGUNTAS, de menos a mas exigente
 *  1. ¿Predice mejor que un promedio de liga?  (sin mercado)
 *  2. ¿Añade informacion sobre los GOLES acumulados? (¿el xG vale la pena frente a
 *     un contador de goles, que es gratis?)
 *  3. ¿Añade informacion sobre el PRECIO del mercado? Esta es la que importa para
 *     apostar: el mercado ya incorpora xG y todo lo demas.
 *
 * PRUEBA PRINCIPAL (fijada antes de mirar): razon de verosimilitud (1 grado de
 * libertad) de añadir log(lambda_xG simple) a un modelo de Poisson de los goles
 * totales que ya usa la media implicita en el mercado de Mas/Menos 2.5, con las
 * dos temporadas juntas. Todo lo demas es exploratorio.
 *
 * SIN FUGAS: las variables de un partido usan SOLO partidos anteriores de su
 * misma liga y temporada, agrupados por dia (los del mismo dia no se ven entre si).
 *
 *   node scripts/backtest-xg-goles.js [--min-prev 6]
 */
const fs = require('fs');
const path = require('path');

const MIN_LIGA = 20; // partidos previos minimos de la liga para tener un promedio de liga

/**
 * Variables previas al partido, sin fugas. `partidos`: [{ id, liga, temp, fecha,
 * homeId, awayId, gl, gv, xgH, xgA }]. Devuelve una fila por partido con ambos
 * equipos con >= minPrev partidos previos y la liga con >= MIN_LIGA. Pura.
 */
function construirFeatures(partidos, minPrev = 6) {
  const grupos = new Map();
  for (const p of partidos) { const k = p.liga + '|' + p.temp; if (!grupos.has(k)) grupos.set(k, []); grupos.get(k).push(p); }
  const filas = [];
  for (const lista of grupos.values()) {
    lista.sort((a, b) => (a.fecha < b.fecha ? -1 : a.fecha > b.fecha ? 1 : 0));
    const eq = new Map();
    const liga = { n: 0, x: 0, g: 0 };           // n = partidos-equipo
    const get = (id) => { if (!eq.has(id)) eq.set(id, { n: 0, xF: 0, xA: 0, gF: 0, gA: 0 }); return eq.get(id); };
    const porDia = new Map();
    for (const p of lista) { const d = String(p.fecha).slice(0, 10); if (!porDia.has(d)) porDia.set(d, []); porDia.get(d).push(p); }
    for (const dia of [...porDia.keys()].sort()) {
      const delDia = porDia.get(dia);
      // 1) features del dia con el estado ANTERIOR al dia
      for (const p of delDia) {
        const h = get(p.homeId), a = get(p.awayId);
        if (h.n < minPrev || a.n < minPrev || liga.n < 2 * MIN_LIGA) continue;
        const lgX = liga.x / liga.n, lgG = liga.g / liga.n;
        const m = (t, k) => t[k] / t.n;
        filas.push({
          id: p.id, liga: p.liga, temp: p.temp, fecha: p.fecha, home: p.home, away: p.away,
          gl: p.gl, gv: p.gv, goles: p.gl + p.gv,
          lamL0: 2 * lgG,
          lamGs: (m(h, 'gF') + m(a, 'gA')) / 2 + (m(a, 'gF') + m(h, 'gA')) / 2,
          lamXs: (m(h, 'xF') + m(a, 'xA')) / 2 + (m(a, 'xF') + m(h, 'xA')) / 2,
          // ataque de un lado contra defensa del otro, por separado (para probabilidades 1X2)
          lamXsL: (m(h, 'xF') + m(a, 'xA')) / 2, lamXsV: (m(a, 'xF') + m(h, 'xA')) / 2,
          lamGn: m(h, 'gF') * m(a, 'gA') / lgG + m(a, 'gF') * m(h, 'gA') / lgG,
          lamXn: m(h, 'xF') * m(a, 'xA') / lgX + m(a, 'xF') * m(h, 'xA') / lgX,
        });
      }
      // 2) recien ahora se incorporan los resultados del dia
      for (const p of delDia) {
        const h = get(p.homeId), a = get(p.awayId);
        h.n++; h.xF += p.xgH; h.xA += p.xgA; h.gF += p.gl; h.gA += p.gv;
        a.n++; a.xF += p.xgA; a.xA += p.xgH; a.gF += p.gv; a.gA += p.gl;
        liga.n += 2; liga.x += p.xgH + p.xgA; liga.g += p.gl + p.gv;
      }
    }
  }
  return filas;
}

module.exports = { construirFeatures, MIN_LIGA };
if (require.main === module) main();

function main() {
  const { poissonReg, logisticReg, lrTest, pNormal2 } = require('../src/glm');
  const { lnGamma } = require('../src/negBinomial');
  const { probMasDe } = require('../src/poissonGoles');
  const { muParaProbMasDe, pOverDeCuotas, R_POISSON } = require('../src/dispersionGoles');
  const { parseCsv } = require('./backtest-steam-football-data');
  const { teamsMatch } = require('../src/teamMatch');

  const idx = process.argv.indexOf('--min-prev');
  const MIN_PREV = idx > 0 ? Number(process.argv[idx + 1]) : 6;
  const dir = path.join(__dirname, '..', 'scratch', 'fotmob-xg');
  const crudos = [];
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.json'))) for (const r of JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))) crudos.push(r);
  const validos = crudos.filter(r => r.xgH != null && r.xgA != null && Number.isInteger(r.gl) && Number.isInteger(r.gv));
  console.log(`partidos recolectados: ${crudos.length} | con xG y goles: ${validos.length}`);
  const feats = construirFeatures(validos, MIN_PREV);
  console.log(`con >= ${MIN_PREV} partidos previos de ambos equipos: ${feats.length} (${[...new Set(feats.map(f => f.liga + '/' + f.temp))].length} liga-temporadas)\n`);

  const pLL = (y, mu) => y * Math.log(mu) - mu - lnGamma(y + 1);
  const media = (a) => a.reduce((s, v) => s + v, 0) / a.length;
  const seMedia = (a) => { const m = media(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1) / a.length); };
  const signo = (x, d = 3) => (x >= 0 ? '+' : '') + x.toFixed(d);

  // ── 1. nivel y precision, sin ajustar nada (tal como lo calcula el piloto)
  console.log('── 1. Los estimadores tal cual (sin ajustar): sesgo y verosimilitud Poisson por partido ──');
  const modelos = ['lamL0', 'lamGs', 'lamXs', 'lamGn', 'lamXn'];
  const nombres = { lamL0: 'promedio de liga', lamGs: 'goles, simple', lamXs: 'xG, simple (piloto)', lamGn: 'goles, por liga', lamXn: 'xG, por liga (piloto)' };
  const llPor = {};
  for (const m of modelos) {
    llPor[m] = feats.map(f => pLL(f.goles, f[m]));
    const sesgo = media(feats.map(f => f[m] - f.goles)), rmse = Math.sqrt(media(feats.map(f => (f[m] - f.goles) ** 2)));
    console.log(`  ${nombres[m].padEnd(24)} sesgo ${signo(sesgo)} goles  RMSE ${rmse.toFixed(3)}  LL/partido ${media(llPor[m]).toFixed(4)}`);
  }
  const par = (a, b, txt) => { const d = feats.map((_, i) => llPor[a][i] - llPor[b][i]); console.log(`  ${txt.padEnd(44)} ${signo(media(d), 4)} LL/partido  (t = ${(media(d) / seMedia(d)).toFixed(1)})`); };
  console.log('  Diferencias pareadas por partido (>0: gana el primero):');
  par('lamXs', 'lamL0', 'xG simple vs promedio de liga');
  par('lamXs', 'lamGs', 'xG simple vs goles simple');
  par('lamXn', 'lamGn', 'xG por liga vs goles por liga');
  par('lamXn', 'lamXs', 'xG por liga vs xG simple');

  // ── 2. ¿el xG añade informacion sobre los goles acumulados? (Poisson, log lambda)
  console.log('\n── 2. ¿El xG añade informacion mas alla de los goles acumulados? (regresion de Poisson, ajustada) ──');
  const y = feats.map(f => f.goles);
  const X = (cols) => feats.map(f => [1, ...cols.map(c => Math.log(f[c]))]);
  for (const [g, x, etq] of [['lamGs', 'lamXs', 'simple'], ['lamGn', 'lamXn', 'por liga']]) {
    const solo0 = poissonReg(X(['lamL0']), y), soloG = poissonReg(X([g]), y), soloX = poissonReg(X([x]), y), ambos = poissonReg(X([g, x]), y);
    const aporteX = lrTest(ambos.loglik, soloG.loglik, 1), aporteG = lrTest(ambos.loglik, soloX.loglik, 1);
    console.log(`  Variante ${etq}: coef log(goles) ${ambos.coef[1].toFixed(2)} ± ${ambos.se[1].toFixed(2)} | coef log(xG) ${ambos.coef[2].toFixed(2)} ± ${ambos.se[2].toFixed(2)}`);
    console.log(`     LL: liga ${solo0.loglik.toFixed(1)} | solo goles ${soloG.loglik.toFixed(1)} | solo xG ${soloX.loglik.toFixed(1)} | ambos ${ambos.loglik.toFixed(1)}`);
    console.log(`     xG aporta sobre goles: chi2 ${aporteX.estadistico.toFixed(2)}, p = ${aporteX.p.toExponential(2)} | goles aporta sobre xG: chi2 ${aporteG.estadistico.toFixed(2)}, p = ${aporteG.p.toExponential(2)}`);
  }

  // fuera de muestra: ajustar en una temporada, evaluar en la otra
  console.log('\n   Fuera de muestra (ajusta en una temporada, evalua en la otra; LL por partido):');
  const temps = [...new Set(feats.map(f => f.temp))].sort();
  if (temps.length === 2) {
    const evalua = (train, test, cols) => {
      const tr = feats.filter(f => f.temp === train), te = feats.filter(f => f.temp === test);
      const m = poissonReg(tr.map(f => [1, ...cols.map(c => Math.log(f[c]))]), tr.map(f => f.goles));
      return media(te.map(f => { const mu = Math.exp(m.coef.reduce((s, b, j) => s + b * (j === 0 ? 1 : Math.log(f[cols[j - 1]])), 0)); return pLL(f.goles, mu); }));
    };
    for (const [etq, cols] of [['liga', ['lamL0']], ['goles simple', ['lamGs']], ['xG simple', ['lamXs']], ['goles+xG simple', ['lamGs', 'lamXs']], ['xG por liga', ['lamXn']]]) {
      console.log(`     ${etq.padEnd(18)} ${temps[0]}->${temps[1]}: ${evalua(temps[0], temps[1], cols).toFixed(4)}   ${temps[1]}->${temps[0]}: ${evalua(temps[1], temps[0], cols).toFixed(4)}`);
    }
  }

  // ── 3. contra el mercado: cierre promedio de Mas/Menos 2.5 (football-data)
  console.log('\n── 3. ¿Añade informacion mas alla del PRECIO del mercado? (Mas/Menos 2.5, cierre promedio) ──');
  const csvDir = path.join(__dirname, '..', 'scratch', 'football-data');
  const csvPorLiga = { 47: 'E0', 87: 'SP1', 54: 'D1', 55: 'I1', 53: 'F1' };
  const tempCsv = { '2024/2025': '2425', '2025/2026': '2526' };
  const fechaCsv = (s) => { const [d, m, a] = s.split('/'); return Date.parse(`${a.length === 2 ? '20' + a : a}-${m}-${d}T12:00:00Z`); };
  const filasCsv = {};
  for (const [lid, code] of Object.entries(csvPorLiga)) for (const t of Object.values(tempCsv)) {
    const p = path.join(csvDir, `${t}_${code}.csv`);
    if (fs.existsSync(p)) filasCsv[`${lid}|${t}`] = parseCsv(fs.readFileSync(p, 'utf8'));
  }
  const unidos = [];
  for (const f of feats) {
    const rows = filasCsv[`${f.liga}|${tempCsv[f.temp]}`]; if (!rows) continue;
    const d0 = Date.parse(String(f.fecha).slice(0, 10) + 'T12:00:00Z');
    const cand = rows.filter(r => r.Date && Math.abs(fechaCsv(r.Date) - d0) <= 36 * 3600e3 && (teamsMatch(f.home, r.HomeTeam) || teamsMatch(f.away, r.AwayTeam)));
    const ambos = cand.filter(r => teamsMatch(f.home, r.HomeTeam) && teamsMatch(f.away, r.AwayTeam));
    const r = ambos.length === 1 ? ambos[0] : (cand.length === 1 ? cand[0] : null);
    if (!r) continue;
    const pm = pOverDeCuotas(Number(r['AvgC>2.5']), Number(r['AvgC<2.5']));
    if (pm == null) continue;
    const mu = muParaProbMasDe(pm, 2.5, R_POISSON);
    if (mu == null) continue;
    unidos.push({ ...f, pm, muMkt: mu, overCuota: Number(r['AvgC>2.5']), underCuota: Number(r['AvgC<2.5']), over: f.goles > 2.5 ? 1 : 0 });
  }
  console.log(`  partidos con cierre del mercado emparejado: ${unidos.length} de ${feats.length} (${(100 * unidos.length / feats.length).toFixed(0)}%)`);
  if (unidos.length < 200) { console.log('  muestra insuficiente para esta seccion'); return; }

  const logit = (p) => Math.log(p / (1 - p));
  const yU = unidos.map(u => u.goles);
  const XU = (cols) => unidos.map(u => [1, ...cols.map(c => Math.log(u[c]))]);
  const mercado = poissonReg(XU(['muMkt']), yU);
  const conX = poissonReg(XU(['muMkt', 'lamXs']), yU), conG = poissonReg(XU(['muMkt', 'lamGs']), yU), conXn = poissonReg(XU(['muMkt', 'lamXn']), yU);
  const conXG = poissonReg(XU(['muMkt', 'lamXs', 'lamGs']), yU);
  const lrX = lrTest(conX.loglik, mercado.loglik, 1);
  console.log('\n  (a) Goles totales ~ Poisson(mercado + señal), log-lambda:');
  console.log(`     solo mercado:            LL ${mercado.loglik.toFixed(1)}  coef log(mu_mercado) ${mercado.coef[1].toFixed(2)} ± ${mercado.se[1].toFixed(2)}`);
  console.log(`     mercado + xG simple:     LL ${conX.loglik.toFixed(1)}  coef xG ${conX.coef[2].toFixed(3)} ± ${conX.se[2].toFixed(3)}   LR chi2 ${lrX.estadistico.toFixed(2)}  p = ${lrX.p.toExponential(2)}   <- PRUEBA PRINCIPAL`);
  const lrXn = lrTest(conXn.loglik, mercado.loglik, 1), lrG = lrTest(conG.loglik, mercado.loglik, 1);
  console.log(`     mercado + xG por liga:   coef ${conXn.coef[2].toFixed(3)} ± ${conXn.se[2].toFixed(3)}   LR chi2 ${lrXn.estadistico.toFixed(2)}  p = ${lrXn.p.toExponential(2)}`);
  console.log(`     mercado + goles simple:  coef ${conG.coef[2].toFixed(3)} ± ${conG.se[2].toFixed(3)}   LR chi2 ${lrG.estadistico.toFixed(2)}  p = ${lrG.p.toExponential(2)}`);
  console.log(`     mercado + xG + goles:    coef xG ${conXG.coef[2].toFixed(3)} ± ${conXG.se[2].toFixed(3)} | coef goles ${conXG.coef[3].toFixed(3)} ± ${conXG.se[3].toFixed(3)}`);

  // (b) logistica sobre el resultado Mas/Menos 2.5
  const pX = (u) => Math.min(Math.max(probMasDe(u.lamXs, 2.5), 0.01), 0.99);
  const XL = (cols) => unidos.map(u => [1, logit(u.pm), ...cols.map(c => logit(c(u)))]);
  const yL = unidos.map(u => u.over);
  const mL = logisticReg(XL([]), yL), mLX = logisticReg(XL([pX]), yL);
  const lrL = lrTest(mLX.loglik, mL.loglik, 1);
  console.log('\n  (b) Resultado "Mas de 2.5" ~ logistica(logit mercado + logit P_xG):');
  console.log(`     coef mercado ${mLX.coef[1].toFixed(2)} ± ${mLX.se[1].toFixed(2)} | coef xG ${mLX.coef[2].toFixed(3)} ± ${mLX.se[2].toFixed(3)} (z = ${(mLX.coef[2] / mLX.se[2]).toFixed(2)}, p = ${pNormal2(mLX.coef[2] / mLX.se[2]).toExponential(2)})  LR chi2 ${lrL.estadistico.toFixed(2)}  p = ${lrL.p.toExponential(2)}`);

  // (c) exploratorio: apostar cuando el xG discrepa del mercado (a cuota de cierre promedio)
  console.log('\n  (c) Exploratorio: apostar Mas/Menos 2.5 al cierre promedio cuando P_xG discrepa del mercado:');
  for (const umbral of [0.05, 0.08, 0.12]) {
    const bets = [];
    for (const u of unidos) {
      const d = probMasDe(u.lamXs, 2.5) - u.pm;
      if (d >= umbral) bets.push(u.over ? u.overCuota - 1 : -1);
      else if (d <= -umbral) bets.push(u.over ? -1 : u.underCuota - 1);
    }
    if (bets.length) console.log(`     |dif| >= ${(umbral * 100).toFixed(0)} pp: n=${String(bets.length).padStart(4)}  ROI ${signo(100 * media(bets), 1)}% ± ${(100 * seMedia(bets)).toFixed(1)} (1 error estandar)`);
  }
  fs.writeFileSync(path.join(__dirname, '..', 'scratch', '_backtest_xg_goles.json'), JSON.stringify({ n: feats.length, nMercado: unidos.length, lrPrincipal: lrX, coefXg: conX.coef[2], seXg: conX.se[2] }, null, 1));
}
