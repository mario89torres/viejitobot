/**
 * scripts/backtest-xg-filtro-patas.js
 * ─────────────────────────────────────────────────────────────────────────
 * ¿Sirve el xG (previo al partido, sin fugas) como FILTRO DE DESCARTE de las patas
 * "seguras" del reporte pre-partido? Universo: las patas que el reporte consideraria
 * (probabilidad justa del mercado >= 0.70 y cuota >= 1.20) sobre el historico de las
 * 5 grandes ligas (xG de FotMob, scratch/fotmob-xg/) con el CIERRE PROMEDIO de
 * football-data (1X2 y Mas/Menos 2.5). Solo lectura.
 *
 * Patas: ganador local/visita (1X2), doble oportunidad (derivada del 1X2), y
 * Mas/Menos 2.5. La probabilidad del xG sale de dos Poisson independientes
 * (lamXsL, lamXsV = ataque propio vs defensa rival de la temporada hasta ese dia).
 *
 * PRUEBA PRINCIPAL (fijada antes de mirar): en las patas seguras, regresion logistica
 * de que la pata GANE sobre logit(p_mercado) + logit(p_xG); prueba de razon de
 * verosimilitud del coeficiente del xG (1 g.l.), con las patas de un mismo partido
 * tratadas como un bloque (bootstrap por partido para el IC del coeficiente). El resto
 * (descartar cuando el xG discrepa) es exploratorio.
 * LIMITES: cierre promedio, no la cuota de las 08:00; sin datos de doble oportunidad
 * ni de "Ambos marcan" (ROI solo para 1X2 y Mas/Menos).
 *
 *   node scripts/backtest-xg-filtro-patas.js [--p-min 0.70] [--odd-min 1.2]
 */
const fs = require('fs');
const path = require('path');

const pmf = (mu, k) => { let p = Math.exp(-mu); for (let i = 1; i <= k; i++) p *= mu / i; return p; };

/** P(local gana), P(empate), P(visita gana) con dos Poisson independientes. Pura. */
function probs1X2(lamL, lamV, maxG = 12) {
  let pl = 0, pe = 0, pv = 0;
  const a = [], b = [];
  for (let k = 0; k <= maxG; k++) { a.push(pmf(lamL, k)); b.push(pmf(lamV, k)); }
  for (let i = 0; i <= maxG; i++) for (let j = 0; j <= maxG; j++) {
    const p = a[i] * b[j];
    if (i > j) pl += p; else if (i === j) pe += p; else pv += p;
  }
  const s = pl + pe + pv;
  return [pl / s, pe / s, pv / s];
}

/** P(goles totales > 2.5) con Poisson de media lam. Pura. */
const pMasDe25 = (lam) => 1 - pmf(lam, 0) - pmf(lam, 1) - pmf(lam, 2);

/** Cuotas -> probabilidades justas, sin margen (proporcional). Pura. */
const justas = (cuotas) => { const p = cuotas.map(c => 1 / c); const s = p.reduce((a, b) => a + b, 0); return p.map(x => x / s); };

module.exports = { probs1X2, pMasDe25, justas };
if (require.main === module) main();

function main() {
  const { construirFeatures } = require('./backtest-xg-goles');
  const { parseCsv } = require('./backtest-steam-football-data');
  const { teamsMatch } = require('../src/teamMatch');
  const { logisticReg, lrTest } = require('../src/glm');
  const { bootstrapPorPartido } = require('./backtest-steam-prematch');
  const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? Number(process.argv[i + 1]) : d; };
  const P_MIN = arg('--p-min', 0.70), ODD_MIN = arg('--odd-min', 1.2);

  const dir = path.join(__dirname, '..', 'scratch', 'fotmob-xg');
  const crudos = [];
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.json'))) for (const r of JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))) crudos.push(r);
  const validos = crudos.filter(r => r.xgH != null && r.xgA != null && Number.isInteger(r.gl) && Number.isInteger(r.gv));
  const feats = construirFeatures(validos, 6);

  const csvDir = path.join(__dirname, '..', 'scratch', 'football-data');
  const csvPorLiga = { 47: 'E0', 87: 'SP1', 54: 'D1', 55: 'I1', 53: 'F1' };
  const tempCsv = { '2024/2025': '2425', '2025/2026': '2526' };
  const fechaCsv = (s) => { const [d, m, a] = s.split('/'); return Date.parse(`${a.length === 2 ? '20' + a : a}-${m}-${d}T12:00:00Z`); };
  const filasCsv = {};
  for (const [lid, code] of Object.entries(csvPorLiga)) for (const t of Object.values(tempCsv)) {
    const p = path.join(csvDir, `${t}_${code}.csv`);
    if (fs.existsSync(p)) filasCsv[`${lid}|${t}`] = parseCsv(fs.readFileSync(p, 'utf8'));
  }

  const patas = [];
  let partidos = 0;
  for (const f of feats) {
    const rows = filasCsv[`${f.liga}|${tempCsv[f.temp]}`]; if (!rows) continue;
    const d0 = Date.parse(String(f.fecha).slice(0, 10) + 'T12:00:00Z');
    const cand = rows.filter(r => r.Date && Math.abs(fechaCsv(r.Date) - d0) <= 36 * 3600e3 && (teamsMatch(f.home, r.HomeTeam) || teamsMatch(f.away, r.AwayTeam)));
    const ambos = cand.filter(r => teamsMatch(f.home, r.HomeTeam) && teamsMatch(f.away, r.AwayTeam));
    const r = ambos.length === 1 ? ambos[0] : (cand.length === 1 ? cand[0] : null);
    if (!r) continue;
    const c1 = [Number(r.AvgCH), Number(r.AvgCD), Number(r.AvgCA)], cOU = [Number(r['AvgC>2.5']), Number(r['AvgC<2.5'])];
    const ok1 = c1.every(x => x > 1), okOU = cOU.every(x => x > 1);
    if (!ok1 && !okOU) continue;
    partidos++;
    const g = { l: f.gl, v: f.gv }, id = f.id;
    const push = (fam, nombre, pMkt, pXg, gana, cuota) => patas.push({ id, fam, nombre, pMkt, pXg: Math.min(Math.max(pXg, 0.01), 0.99), gana: gana ? 1 : 0, cuota, fecha: f.fecha });
    if (ok1) {
      const pm = justas(c1), px = probs1X2(f.lamXsL, f.lamXsV);
      const res = [g.l > g.v, g.l === g.v, g.l < g.v];
      ['local', 'empate', 'visita'].forEach((n, i) => { if (i !== 1) push('ganador', n, pm[i], px[i], res[i], c1[i]); });
      // doble oportunidad: p derivada del 1X2; sin cuota real (null)
      push('doble oportunidad', '1X', pm[0] + pm[1], px[0] + px[1], res[0] || res[1], null);
      push('doble oportunidad', 'X2', pm[1] + pm[2], px[1] + px[2], res[1] || res[2], null);
      push('doble oportunidad', '12', pm[0] + pm[2], px[0] + px[2], res[0] || res[2], null);
    }
    if (okOU) {
      const pm = justas(cOU), px = pMasDe25(f.lamXsL + f.lamXsV), over = f.goles > 2.5;
      push('mas/menos 2.5', 'mas', pm[0], px, over, cOU[0]);
      push('mas/menos 2.5', 'menos', pm[1], 1 - px, !over, cOU[1]);
    }
  }
  console.log(`partidos emparejados: ${partidos} | patas: ${patas.length}`);
  const seguras = patas.filter(p => p.pMkt >= P_MIN && (p.cuota == null || p.cuota >= ODD_MIN));
  console.log(`patas "seguras" (p mercado >= ${P_MIN}, cuota >= ${ODD_MIN}): ${seguras.length} en ${new Set(seguras.map(p => p.id)).size} partidos\n`);
  if (seguras.length < 100) { console.log('muestra insuficiente'); return; }

  const media = (a) => a.reduce((s, v) => s + v, 0) / a.length;
  const logit = (p) => Math.log(p / (1 - p));
  const wr = (a) => (a.length ? media(a.map(p => p.gana)) : NaN);
  const roi = (a) => { const c = a.filter(p => p.cuota != null); return c.length ? 100 * media(c.map(p => (p.gana ? p.cuota - 1 : -1))) : null; };
  const pcs = (x) => (x == null || Number.isNaN(x) ? 'n/d' : (100 * x).toFixed(1) + '%');
  const porPartido = (a) => { const m = new Map(); for (const p of a) { if (!m.has(p.id)) m.set(p.id, []); m.get(p.id).push(p); } return [...m.values()]; };

  // Prueba principal
  const X0 = seguras.map(p => [1, logit(p.pMkt)]), X1 = seguras.map(p => [1, logit(p.pMkt), logit(p.pXg)]), y = seguras.map(p => p.gana);
  const m0 = logisticReg(X0, y), m1 = logisticReg(X1, y), lr = lrTest(m1.loglik, m0.loglik, 1);
  const coef = (rows) => { const r = logisticReg(rows.map(p => [1, logit(p.pMkt), logit(p.pXg)]), rows.map(p => p.gana)); return r.coef[2]; };
  const ci = bootstrapPorPartido(porPartido(seguras), (m) => coef(m.flat ? m.flat() : m), 200, 3);
  console.log('── PRUEBA PRINCIPAL: en las patas seguras, ¿el xG añade algo sobre el precio? ──');
  console.log(`  coef logit(p_mercado) ${m1.coef[1].toFixed(2)} ± ${m1.se[1].toFixed(2)} | coef logit(p_xG) ${m1.coef[2].toFixed(3)} ± ${m1.se[2].toFixed(3)}`);
  console.log(`  LR chi2 ${lr.estadistico.toFixed(2)}  p = ${lr.p.toExponential(2)}  | IC95 del coef xG (bootstrap por partido): ${ci ? `[${ci[0].toFixed(2)}, ${ci[1].toFixed(2)}]` : 'n/d'}`);

  // Exploratorio: descartar cuando el xG discrepa
  console.log('\n── Exploratorio: descartar patas seguras donde el xG contradice al mercado (p_xG < p_mercado - d) ──');
  console.log(`  base: n=${seguras.length}  WR ${pcs(wr(seguras))}  ROI ${roi(seguras) == null ? 'n/d' : roi(seguras).toFixed(1) + '%'}`);
  for (const d of [0.05, 0.10, 0.15]) {
    const quitadas = seguras.filter(p => p.pXg < p.pMkt - d), quedan = seguras.filter(p => !(p.pXg < p.pMkt - d));
    const dif = 100 * (wr(quedan) - wr(seguras));
    const cid = bootstrapPorPartido(porPartido(seguras), (m) => { const r = m.filter(p => !(p.pXg < p.pMkt - d)); return m.length && r.length ? 100 * (wr(r) - wr(m)) : null; }, 400, 5);
    console.log(`  d=${(d * 100).toFixed(0)} pp: quita ${String(quitadas.length).padStart(5)} (WR ${pcs(wr(quitadas))}) | quedan ${String(quedan.length).padStart(5)} WR ${pcs(wr(quedan))} | dWR ${dif >= 0 ? '+' : ''}${dif.toFixed(2)} pp IC95 [${cid ? cid[0].toFixed(2) + ', ' + cid[1].toFixed(2) : 'n/d'}] | ROI quedan ${roi(quedan) == null ? 'n/d' : roi(quedan).toFixed(1) + '%'} vs quitadas ${roi(quitadas) == null ? 'n/d' : roi(quitadas).toFixed(1) + '%'}`);
  }

  console.log('\n── Por tipo de pata (mismo criterio d = 10 pp) ──');
  for (const fam of ['ganador', 'doble oportunidad', 'mas/menos 2.5']) {
    const a = seguras.filter(p => p.fam === fam), q = a.filter(p => p.pXg < p.pMkt - 0.10);
    console.log(`  ${fam.padEnd(18)} n=${String(a.length).padStart(5)} WR ${pcs(wr(a))} | discrepa n=${String(q.length).padStart(4)} WR ${pcs(wr(q))} | resto WR ${pcs(wr(a.filter(p => !(p.pXg < p.pMkt - 0.10))))}`);
  }
  const o = [...seguras].sort((a, b) => (a.fecha < b.fecha ? -1 : 1)), h = o.length >> 1;
  for (const [n, a] of [['1a mitad', o.slice(0, h)], ['2a mitad', o.slice(h)]]) {
    const q = a.filter(p => p.pXg < p.pMkt - 0.10);
    console.log(`  ${n}: discrepa n=${q.length} WR ${pcs(wr(q))} vs resto ${pcs(wr(a.filter(p => !(p.pXg < p.pMkt - 0.10))))}`);
  }
}
