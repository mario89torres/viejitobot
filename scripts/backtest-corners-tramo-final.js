/**
 * scripts/backtest-corners-tramo-final.js
 * ─────────────────────────────────────────────────────────────────────────
 * Variante de backtest-picks-nb-fotmob.js: en vez de agregar todos los ciclos
 * (min 10-90), desglosa el Brier de P(under) y el ROI de picks por franja de
 * minuto — en concreto, ¿hay ventaja del modelo (o del mercado) especificamente
 * del minuto 70 en adelante? Pregunta del usuario el 2026-09-22, motivada por
 * la nota de nb-corners-sin-ventaja-vs-mercado: "entre 65-85' caen 1.6x mas
 * corners de lo esperado" — eso ya esta incorporado al perfil F(t) del
 * calibrado, pero no se habia mirado si el mercado se repriega mas lento que
 * el modelo justo en esa franja.
 *
 * Reusa la MISMA validacion cruzada (K=5 por partido) y las mismas fuentes
 * (fotmob_corner_snapshots para el conteo, stat_snapshots para la escalera de
 * cuotas, scratch/_fotmob_finales.json para el resultado real) que el
 * backtest original, para que los numeros sean comparables.
 *
 *   node scripts/backtest-corners-tramo-final.js
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { db } = require('../src/db');
const { escaleraLineas, conModelo, elegirSugerida } = require('../src/fotmobLive');
const { minutoDeStatus } = require('../src/nbCalibrado');
const T = require('./entrenar-nb-fotmob');
const os = require('os');

const DESDE = '2026-09-16T01:40:00Z';
const FINALES = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'scratch', '_fotmob_finales.json'), 'utf8'));
const UMBRALES = [0.03, 0.05, 0.10, 0.15];
const CORTE = 70; // minuto de la franja "final" que pregunta el usuario
const media = (a) => a.reduce((s, x) => s + x, 0) / (a.length || 1);

function seedRng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
function bootstrapIC(xs, B = 4000) {
  const rng = seedRng(5), n = xs.length, m = [];
  if (!n) return [NaN, NaN];
  for (let b = 0; b < B; b++) { let s = 0; for (let i = 0; i < n; i++) s += xs[Math.floor(rng() * n)]; m.push(s / n); }
  m.sort((a, b) => a - b);
  return [m[Math.floor(0.025 * B)], m[Math.floor(0.975 * B)]];
}
function conModo(modo, fn) {
  const antes = process.env.STATS_NB_CALIBRADO;
  if (modo) process.env.STATS_NB_CALIBRADO = 'on'; else delete process.env.STATS_NB_CALIBRADO;
  try { return fn(); } finally { if (antes === undefined) delete process.env.STATS_NB_CALIBRADO; else process.env.STATS_NB_CALIBRADO = antes; }
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
const archivos = [];
for (let k = 0; k < K; k++) {
  const fit = T.ajustar(todos.filter(e => pliegue.get(e.id) !== k), conSerie.filter(e => pliegue.get(e.id) !== k));
  const f = path.join(os.tmpdir(), `nb_tramo_${process.pid}_${k}.json`);
  fs.writeFileSync(f, JSON.stringify({ mu: fit.mu, r: fit.r, nudos: fit.nudos, F: fit.F }));
  archivos.push(f);
}
process.on('exit', () => archivos.forEach(f => { try { fs.unlinkSync(f); } catch {} }));

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

  const minOld = c.minuto;
  const minCal = minutoDeStatus(s.status) ?? c.minuto;
  process.env.NB_CALIBRADO_FILE = archivos[pliegue.get(c.fotmob_event_id) ?? 0];
  const calL = conModo(true, () => conModelo(lin, conteo, minCal));
  const cal = elegirSugerida(calL);
  if (!porPartido.has(c.event_id)) porPartido.set(c.event_id, { final: fin.final, filas: [] });
  porPartido.get(c.event_id).filas.push({ min: minCal, conteo, cal, calL });
}
console.log('ciclos:', ciclos.length, '| descartados:', JSON.stringify(descartados), '| partidos con datos:', porPartido.size);

const gana = (sug, final) => (sug.lado === 'over' ? final > sug.linea : final < sug.linea);

// ── 1. Brier de P(under) en todas las lineas con par completo, por FRANJA de minuto ──
console.log(`\nBRIER de P(under), NB calibrado vs mercado solo, por franja de minuto (corte ${CORTE}'):`);
console.log('(>0 = el modelo calibrado mejora al mercado en esa franja; peso igual por partido)');
function brierTramo(w, filtro) {
  const v = [];
  for (const p of porPartido.values()) {
    const xs = [];
    for (const f of p.filas) {
      if (f.min < 10 || !filtro(f.min)) continue;
      for (const l of f.calL) {
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
for (const [nom, filtro] of [
  [`antes del ${CORTE}'`, (m) => m < CORTE],
  [`${CORTE}' en adelante`, (m) => m >= CORTE],
]) {
  const mercado = brierTramo(0, filtro), modelo = brierTramo(1, filtro);
  const d = mercado.map((x, i) => x - modelo[i]);
  const [a, z] = bootstrapIC(d);
  console.log(`  ${nom.padEnd(18)} n=${d.length} partidos  Brier mercado ${media(mercado).toFixed(4)}  modelo ${media(modelo).toFixed(4)}  ventaja modelo ${media(d) >= 0 ? '+' : ''}${media(d).toFixed(4)}  IC95 [${a.toFixed(4)}, ${z.toFixed(4)}]`);
}

// ── 2. Politica de picks restringida a la franja final: primer ciclo con min >= CORTE y edge >= umbral ──
console.log(`\nPOLITICA: 1 pick por partido, primer ciclo con min >= ${CORTE} y edge >= umbral, 1u plano, cuota real:`);
console.log('umbral |  n  | acierto | ROI      IC95 ROI          | over/under | minuto medio de entrada');
function picksTramo(umbral) {
  const out = [];
  for (const p of porPartido.values()) {
    const f = p.filas.find(x => x.min >= CORTE && x.min <= 90 && x.cal && x.cal.edge >= umbral && x.cal.odd > 1);
    if (!f) continue;
    const s = f.cal, w = gana(s, p.final);
    out.push({ lado: s.lado, odd: s.odd, gano: w, profit: w ? s.odd - 1 : -1, edge: s.edge, min: f.min });
  }
  return out;
}
for (const u of UMBRALES) {
  const ps = picksTramo(u);
  if (!ps.length) { console.log(`${(u * 100).toFixed(0).padStart(4)}pp |   0 |`); continue; }
  const roi = media(ps.map(x => x.profit)), [a, b] = bootstrapIC(ps.map(x => x.profit));
  const nO = ps.filter(x => x.lado === 'over').length;
  console.log(`${(u * 100).toFixed(0).padStart(4)}pp | ${String(ps.length).padStart(3)} | ${(100 * media(ps.map(x => +x.gano))).toFixed(1).padStart(5)}%  | ${(100 * roi).toFixed(1).padStart(6)}%  [${(100 * a).toFixed(0).padStart(4)}%, ${(100 * b).toFixed(0).padStart(4)}%] | ${nO}/${ps.length - nO}       | ${media(ps.map(x => x.min)).toFixed(1)}`);
}

// ── 3. ¿La franja final tiene MENOS lineas con par completo (mercado ya se retira)? ──
// Si el mercado se cierra antes en esa franja, cualquier "edge" ahi puede ser
// solo lineas de peor liquidez, no ventaja real.
console.log('\nCobertura de la escalera por franja (lineas con par completo evaluadas, no partidos):');
for (const [nom, filtro] of [[`antes del ${CORTE}'`, (m) => m < CORTE], [`${CORTE}' en adelante`, (m) => m >= CORTE]]) {
  let nLineas = 0, nCiclos = 0;
  for (const p of porPartido.values()) {
    for (const f of p.filas) {
      if (f.min < 10 || !filtro(f.min)) continue;
      nCiclos++;
      nLineas += f.calL.filter(l => l.modelo && l.modelo.edgeUnder != null && f.conteo <= Math.floor(l.linea)).length;
    }
  }
  console.log(`  ${nom.padEnd(18)} ciclos=${nCiclos}  lineas evaluables=${nLineas}  promedio/ciclo=${nCiclos ? (nLineas / nCiclos).toFixed(1) : '-'}`);
}
