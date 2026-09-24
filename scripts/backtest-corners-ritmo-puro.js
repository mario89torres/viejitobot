/**
 * scripts/backtest-corners-ritmo-puro.js
 * ─────────────────────────────────────────────────────────────────────────
 * ¿"Elegir la linea segun el ritmo que lleva el partido, SIN encogimiento
 * bayesiano hacia el promedio de liga" le gana al mercado? Pregunta del
 * usuario el 2026-09-22 tras ver que el NB calibrado (que SI encoge hacia el
 * prior de liga) esta empatado con el mercado.
 *
 * "Ritmo puro" = misma familia NB-Gamma que el calibrado (mismo perfil de
 * intensidad F(t) medido contra FotMob), pero con r=0: el shape posterior
 * queda en alphaPost=conteo (nada de prior, todo lo observado) en vez de
 * alphaPost=r+conteo. Con conteo=0 no hay ritmo que extrapolar (se descarta,
 * "antes NULL que un numero inventado" — mismo criterio que el resto del
 * piloto).
 *
 * Reusa la MISMA validacion cruzada (K=5 por partido, perfil F(t) reajustado
 * sin los partidos del pliegue evaluado) y las mismas fuentes que
 * backtest-picks-nb-fotmob.js, para que los numeros sean comparables.
 *
 *   node scripts/backtest-corners-ritmo-puro.js
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { db } = require('../src/db');
const { escaleraLineas, elegirSugerida } = require('../src/fotmobLive');
const { devig, defaultMethod } = require('../src/devig');
const { minutoDeStatus } = require('../src/nbCalibrado');
const nbCal = require('../src/nbCalibrado');
const nb = require('../src/negBinomial');
const T = require('./entrenar-nb-fotmob');
const os = require('os');

const DESDE = '2026-09-16T01:40:00Z';
const FINALES = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'scratch', '_fotmob_finales.json'), 'utf8'));
const UMBRALES = [0.03, 0.05, 0.10, 0.15];
const media = (a) => a.reduce((s, x) => s + x, 0) / (a.length || 1);

function seedRng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
function bootstrapIC(xs, B = 4000) {
  const rng = seedRng(5), n = xs.length, m = [];
  if (!n) return [NaN, NaN];
  for (let b = 0; b < B; b++) { let s = 0; for (let i = 0; i < n; i++) s += xs[Math.floor(rng() * n)]; m.push(s / n); }
  m.sort((a, b) => a - b);
  return [m[Math.floor(0.025 * B)], m[Math.floor(0.975 * B)]];
}

// probUnderNB con r=0 (sin encogimiento bayesiano): alphaPost=conteo,
// betaPost=f(minuto) — "lo que falta" ~ NB(conteo*(1-f)/f, conteo). Requiere
// conteo>0: con 0 corners no hay ritmo observable que extrapolar.
function probUnderRitmoPuro(cal, conteo, linea, minuto) {
  if (conteo == null || linea == null || minuto == null || conteo <= 0) return null;
  const colchon = Math.floor(linea) - conteo;
  if (colchon < 0) return 0;
  const f = nbCal.fraccion(cal, minuto);
  const restanFrac = 1 - f;
  if (restanFrac <= 0) return 1;
  const muRestante = conteo * restanFrac / f;
  return nb.cdf(colchon, muRestante, conteo);
}
function conModeloRitmoPuro(lineasPlaydoit, cal, conteoReal, minuto) {
  if (conteoReal == null || minuto == null) return lineasPlaydoit;
  return lineasPlaydoit.map((l) => {
    const pUnderModelo = probUnderRitmoPuro(cal, conteoReal, l.linea, minuto);
    if (pUnderModelo == null) return l;
    const pOverModelo = 1 - pUnderModelo;
    let pOverMercado = null, pUnderMercado = null;
    if (l.over && !l.over.susp && l.under && !l.under.susp) {
      const [po, pu] = devig([l.over.odd, l.under.odd], defaultMethod());
      pOverMercado = po; pUnderMercado = pu;
    }
    return {
      ...l,
      modelo: {
        pOver: +pOverModelo.toFixed(4), pUnder: +pUnderModelo.toFixed(4),
        edgeOver: pOverMercado != null ? +(pOverModelo - pOverMercado).toFixed(4) : null,
        edgeUnder: pUnderMercado != null ? +(pUnderModelo - pUnderMercado).toFixed(4) : null,
      },
    };
  });
}

const ciclos = db.prepare(`
  SELECT DISTINCT event_id, fotmob_event_id, ts, minuto FROM fotmob_forecast_snapshots
  WHERE ts >= ? AND fotmob_event_id IS NOT NULL ORDER BY event_id, ts
`).all(DESDE);
const snapFotmob = db.prepare('SELECT * FROM fotmob_corner_snapshots WHERE fotmob_event_id = ? AND ts <= ? ORDER BY ts DESC LIMIT 1');
const ladder = db.prepare(`
  SELECT market, selection, linea, lado, odd_decimal, suspended FROM stat_snapshots
  WHERE event_id = ? AND familia = 'corner' AND ts >= ? AND ts <= ? ORDER BY ts DESC
`);

const K = 5;
const { todos, conSerie } = T.construir(FINALES);
const pliegue = new Map(todos.map((e, i) => [e.id, i % K]));
const cals = []; // solo perfil F(t) por pliegue, mismo criterio de "sin fuga" que el backtest original
for (let k = 0; k < K; k++) {
  const fit = T.ajustar(todos.filter(e => pliegue.get(e.id) !== k), conSerie.filter(e => pliegue.get(e.id) !== k));
  cals.push({ mu: fit.mu, r: fit.r, nudos: fit.nudos, F: fit.F });
}

const porPartido = new Map();
let descartados = { sinFinal: 0, sinSnap: 0, malMatch: 0, sinEscalera: 0 };
for (const c of ciclos) {
  const fin = FINALES[c.fotmob_event_id];
  if (!fin || !fin.fin) { descartados.sinFinal++; continue; }
  const s = snapFotmob.get(c.fotmob_event_id, c.ts);
  if (!s || Date.parse(c.ts) - Date.parse(s.ts) > 6 * 60000) { descartados.sinSnap++; continue; }
  const conteo = s.corners_home + s.corners_away;
  if (fin.final < conteo) { descartados.malMatch++; continue; }
  const desde = new Date(Date.parse(c.ts) - 20 * 60000).toISOString();
  const lin = escaleraLineas(ladder.all(c.event_id, desde, c.ts));
  if (!lin.length) { descartados.sinEscalera++; continue; }

  const minCal = minutoDeStatus(s.status) ?? c.minuto;
  const cal = cals[pliegue.get(c.fotmob_event_id) ?? 0];
  const ritmoL = conModeloRitmoPuro(lin, cal, conteo, minCal);
  const ritmo = elegirSugerida(ritmoL);
  if (!porPartido.has(c.event_id)) porPartido.set(c.event_id, { final: fin.final, filas: [] });
  porPartido.get(c.event_id).filas.push({ min: minCal, conteo, ritmo, ritmoL });
}
console.log('ciclos:', ciclos.length, '| descartados:', JSON.stringify(descartados), '| partidos con datos:', porPartido.size);

const gana = (sug, final) => (sug.lado === 'over' ? final > sug.linea : final < sug.linea);

// ── 1. Brier de P(under) en todas las lineas con par completo, ritmo puro vs mercado ──
console.log('\nBRIER de P(under), RITMO PURO (sin encogimiento) vs mercado solo (>0 = modelo mejor):');
function brier(w, filtro) {
  const v = [];
  for (const p of porPartido.values()) {
    const xs = [];
    for (const f of p.filas) {
      if (f.min < 10 || (filtro && !filtro(f.min))) continue;
      for (const l of f.ritmoL) {
        if (!l.modelo || l.modelo.edgeUnder == null || f.conteo > Math.floor(l.linea)) continue;
        const pMod = l.modelo.pUnder, pMkt = pMod - l.modelo.edgeUnder;
        const y = p.final <= Math.floor(l.linea) ? 1 : 0;
        xs.push((w * pMod + (1 - w) * pMkt - y) ** 2);
      }
    }
    if (xs.length) v.push(media(xs));
  }
  return v;
}
for (const [nom, filtro] of [['todo el partido (min>=10)', null], ["antes del 70'", (m) => m < 70], ["70' en adelante", (m) => m >= 70]]) {
  const mercado = brier(0, filtro), modelo = brier(1, filtro);
  const d = mercado.map((x, i) => x - modelo[i]);
  const [a, z] = bootstrapIC(d);
  console.log(`  ${nom.padEnd(26)} n=${d.length} partidos  Brier mercado ${media(mercado).toFixed(4)}  ritmo puro ${media(modelo).toFixed(4)}  ventaja ${media(d) >= 0 ? '+' : ''}${media(d).toFixed(4)}  IC95 [${a.toFixed(4)}, ${z.toFixed(4)}]`);
}

// ── 2. Politica de picks: 1 por partido, primer ciclo (min 10-85) con edge >= umbral ──
console.log('\nPOLITICA: 1 pick por partido (primer ciclo min 10-85 con edge >= umbral), 1u plano, cuota real:');
console.log('umbral |  n  | acierto | ROI      IC95 ROI          | over/under');
function picks(umbral, minDesde = 10, minHasta = 85) {
  const out = [];
  for (const p of porPartido.values()) {
    const f = p.filas.find(x => x.min >= minDesde && x.min <= minHasta && x.ritmo && x.ritmo.edge >= umbral && x.ritmo.odd > 1);
    if (!f) continue;
    const s = f.ritmo, w = gana(s, p.final);
    out.push({ lado: s.lado, odd: s.odd, gano: w, profit: w ? s.odd - 1 : -1, edge: s.edge });
  }
  return out;
}
for (const u of UMBRALES) {
  const ps = picks(u);
  if (!ps.length) { console.log(`${(u * 100).toFixed(0).padStart(4)}pp |   0 |`); continue; }
  const roi = media(ps.map(x => x.profit)), [a, b] = bootstrapIC(ps.map(x => x.profit));
  const nO = ps.filter(x => x.lado === 'over').length;
  console.log(`${(u * 100).toFixed(0).padStart(4)}pp | ${String(ps.length).padStart(3)} | ${(100 * media(ps.map(x => +x.gano))).toFixed(1).padStart(5)}%  | ${(100 * roi).toFixed(1).padStart(6)}%  [${(100 * a).toFixed(0).padStart(4)}%, ${(100 * b).toFixed(0).padStart(4)}%] | ${nO}/${ps.length - nO}`);
}
console.log('\nMisma politica, restringida al minuto 70+:');
console.log('umbral |  n  | acierto | ROI      IC95 ROI          | over/under');
for (const u of UMBRALES) {
  const ps = picks(u, 70, 90);
  if (!ps.length) { console.log(`${(u * 100).toFixed(0).padStart(4)}pp |   0 |`); continue; }
  const roi = media(ps.map(x => x.profit)), [a, b] = bootstrapIC(ps.map(x => x.profit));
  const nO = ps.filter(x => x.lado === 'over').length;
  console.log(`${(u * 100).toFixed(0).padStart(4)}pp | ${String(ps.length).padStart(3)} | ${(100 * media(ps.map(x => +x.gano))).toFixed(1).padStart(5)}%  | ${(100 * roi).toFixed(1).padStart(6)}%  [${(100 * a).toFixed(0).padStart(4)}%, ${(100 * b).toFixed(0).padStart(4)}%] | ${nO}/${ps.length - nO}`);
}
