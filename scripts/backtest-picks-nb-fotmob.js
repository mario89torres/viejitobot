/**
 * scripts/backtest-picks-nb-fotmob.js
 * ─────────────────────────────────────────────────────────────────────────
 * ¿El NB calibrado (src/nbCalibrado.js) elige mejores picks de corners que el
 * NB original? Se REPITE cada ciclo historico del piloto FotMob con las cuotas
 * reales de playdoit de ese instante, se elige la linea sugerida con cada
 * modelo (misma logica que el dashboard: conModelo + elegirSugerida de
 * src/fotmobLive.js) y se liquida con el final real de FotMob.
 *
 * REGLAS PARA NO AUTOENGANARSE
 *  - Un pick por PARTIDO y modelo: el primer ciclo (minuto 10-85) cuyo edge
 *    supera el umbral. Los ciclos del mismo partido estan casi perfectamente
 *    correlacionados; contarlos todos inflaria la muestra.
 *  - Se liquida a la cuota real (con margen de la casa), stake plano 1u.
 *  - Los dos modelos ven exactamente el mismo conteo, cuotas y momento; solo
 *    cambia el modelo (y el reloj: el calibrado usa el minuto de FotMob, como
 *    en produccion).
 *  - VALIDACION CRUZADA: los parametros del calibrado (mu, r, perfil F) se
 *    reajustan por pliegue (K=5, intercalado en el tiempo) SIN los partidos del
 *    pliegue que se evalua. Con los parametros de fotmob_nb.json (entrenados con
 *    todos los partidos) el resultado seria optimista.
 *  - Ademas del ROI (muy ruidoso con pocos partidos) se reporta el Brier de la
 *    probabilidad que cada modelo dio al lado que sugirio, sobre TODOS los
 *    ciclos con peso igual por partido: es la medida con mas potencia.
 *
 *   node scripts/backtest-picks-nb-fotmob.js
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
const media = (a) => a.reduce((s, x) => s + x, 0) / (a.length || 1);

function seedRng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
function bootstrapIC(xs, B = 4000) {
  const rng = seedRng(5), n = xs.length, m = [];
  for (let b = 0; b < B; b++) { let s = 0; for (let i = 0; i < n; i++) s += xs[Math.floor(rng() * n)]; m.push(s / n); }
  m.sort((a, b) => a - b);
  return [m[Math.floor(0.025 * B)], m[Math.floor(0.975 * B)]];
}

function conModo(modo, fn) {
  const antes = process.env.STATS_NB_CALIBRADO;
  if (modo) process.env.STATS_NB_CALIBRADO = 'on'; else delete process.env.STATS_NB_CALIBRADO;
  try { return fn(); } finally { if (antes === undefined) delete process.env.STATS_NB_CALIBRADO; else process.env.STATS_NB_CALIBRADO = antes; }
}

// ciclos historicos: (evento playdoit, evento FotMob, ts) desde los pronosticos guardados
const ciclos = db.prepare(`
  SELECT DISTINCT event_id, fotmob_event_id, ts, minuto FROM fotmob_forecast_snapshots
  WHERE ts >= ? AND fotmob_event_id IS NOT NULL ORDER BY event_id, ts
`).all(DESDE);
const snapFotmob = db.prepare('SELECT * FROM fotmob_corner_snapshots WHERE fotmob_event_id = ? AND ts <= ? ORDER BY ts DESC LIMIT 1');
const ladder = db.prepare(`
  SELECT market, selection, linea, lado, odd_decimal, suspended FROM stat_snapshots
  WHERE event_id = ? AND familia = 'corner' AND ts >= ? AND ts <= ? ORDER BY ts DESC
`);

// Validacion cruzada: pliegue de cada partido y archivo de parametros ajustado SIN el.
const K = 5;
const { todos, conSerie } = T.construir(FINALES);
const pliegue = new Map(todos.map((e, i) => [e.id, i % K]));
const archivos = [];
for (let k = 0; k < K; k++) {
  const fit = T.ajustar(todos.filter(e => pliegue.get(e.id) !== k), conSerie.filter(e => pliegue.get(e.id) !== k));
  const f = path.join(os.tmpdir(), `nb_cv_${process.pid}_${k}.json`);
  fs.writeFileSync(f, JSON.stringify({ mu: fit.mu, r: fit.r, nudos: fit.nudos, F: fit.F }));
  archivos.push(f);
}
process.on('exit', () => archivos.forEach(f => { try { fs.unlinkSync(f); } catch {} }));

const porPartido = new Map(); // event_id -> { final, filas: [ {min, old, cal, conteo} ] }
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
  const oldL = conModo(false, () => conModelo(lin, conteo, minOld));
  process.env.NB_CALIBRADO_FILE = archivos[pliegue.get(c.fotmob_event_id) ?? 0];
  const calL = conModo(true, () => conModelo(lin, conteo, minCal));
  const old = elegirSugerida(oldL), cal = elegirSugerida(calL);
  if (!porPartido.has(c.event_id)) porPartido.set(c.event_id, { final: fin.final, filas: [] });
  porPartido.get(c.event_id).filas.push({ min: minCal, conteo, old, cal, oldL, calL });
}
console.log('ciclos:', ciclos.length, '| descartados:', JSON.stringify(descartados), '| partidos con datos:', porPartido.size);

const gana = (sug, final) => (sug.lado === 'over' ? final > sug.linea : final < sug.linea);

// ── 1. Brier de la probabilidad dada al lado sugerido, todos los ciclos, peso igual por partido ──
function brierPorPartido(modelo) {
  const v = [];
  for (const p of porPartido.values()) {
    const xs = p.filas.filter(f => f.min >= 10 && f[modelo]).map(f => (f[modelo].pModelo - (gana(f[modelo], p.final) ? 1 : 0)) ** 2);
    if (xs.length) v.push(media(xs));
  }
  return v;
}
const bo = brierPorPartido('old'), bc = brierPorPartido('cal');
const dif = bo.map((x, i) => x - bc[i]); // >0 => calibrado mejor
const [lo, hi] = bootstrapIC(dif);
console.log(`\nBRIER de la prob. que cada modelo dio a SU lado sugerido (menor = mejor), ${bo.length} partidos:`);
console.log(`  original ${media(bo).toFixed(4)} | calibrado ${media(bc).toFixed(4)} | ventaja calibrado ${media(dif) >= 0 ? '+' : ''}${media(dif).toFixed(4)}  IC95 [${lo.toFixed(4)}, ${hi.toFixed(4)}]`);
const pmed = (m) => media([...porPartido.values()].flatMap(p => p.filas.filter(f => f.min >= 10 && f[m]).map(f => f[m].pModelo)));
const acc = (m) => media([...porPartido.values()].flatMap(p => p.filas.filter(f => f.min >= 10 && f[m]).map(f => (gana(f[m], p.final) ? 1 : 0))));
console.log(`  prob. media declarada: original ${pmed('old').toFixed(3)} vs acierto real ${acc('old').toFixed(3)} | calibrado ${pmed('cal').toFixed(3)} vs acierto real ${acc('cal').toFixed(3)}`);

// ── 2. Politica: un pick por partido, primer ciclo con edge >= umbral ──
function picks(modelo, umbral) {
  const out = [];
  for (const p of porPartido.values()) {
    const f = p.filas.find(x => x.min >= 10 && x.min <= 85 && x[modelo] && x[modelo].edge >= umbral && x[modelo].odd > 1);
    if (!f) continue;
    const s = f[modelo], w = gana(s, p.final);
    out.push({ lado: s.lado, odd: s.odd, gano: w, profit: w ? s.odd - 1 : -1, edge: s.edge });
  }
  return out;
}
console.log('\nPOLITICA: 1 pick por partido (primer ciclo min 10-85 con edge >= umbral), 1u plano, cuota real:');
console.log('umbral | modelo     |  n  | acierto | ROI      IC95 ROI          | over/under');
for (const u of UMBRALES) {
  for (const [nom, m] of [['original  ', 'old'], ['calibrado ', 'cal']]) {
    const ps = picks(m, u);
    if (!ps.length) { console.log(`${(u * 100).toFixed(0).padStart(4)}pp | ${nom} |   0 |`); continue; }
    const roi = media(ps.map(x => x.profit)), [a, b] = bootstrapIC(ps.map(x => x.profit));
    const nO = ps.filter(x => x.lado === 'over').length;
    console.log(`${(u * 100).toFixed(0).padStart(4)}pp | ${nom} | ${String(ps.length).padStart(3)} | ${(100 * media(ps.map(x => +x.gano))).toFixed(1).padStart(5)}%  | ${(100 * roi).toFixed(1).padStart(6)}%  [${(100 * a).toFixed(0).padStart(4)}%, ${(100 * b).toFixed(0).padStart(4)}%] | ${nO}/${ps.length - nO}`);
  }
}

// ── 3. ¿Aporta el modelo informacion MAS ALLA del precio? Brier de P(under) en TODAS las lineas ──
// pMercado = precio devigado del par; pModelo = NB. Mezcla: w*pModelo + (1-w)*pMercado.
// Solo lineas con par completo y todavia no decididas (conteo <= floor(linea)).
console.log('\nBRIER de P(under) en todas las lineas con par completo (min >= 10), peso igual por partido:');
const PESOS = [0, 0.25, 0.5, 0.75, 1];
function brierMezcla(campo, w) {
  const v = [];
  for (const p of porPartido.values()) {
    const xs = [];
    for (const f of p.filas) {
      if (f.min < 10) continue;
      for (const l of f[campo]) {
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
const ref = brierMezcla('calL', 0);
for (const [campo, nom] of [['oldL', 'NB original'], ['calL', 'NB calibrado']]) {
  console.log(`  ${nom}:`);
  for (const w of PESOS) {
    const b = brierMezcla(campo, w), d = ref.map((x, i) => x - b[i]); // >0 => mejor que mercado solo
    const [a, z] = bootstrapIC(d);
    console.log(`    w=${w.toFixed(2)} (${w === 0 ? 'mercado solo' : w === 1 ? 'modelo solo' : 'mezcla'})  Brier ${media(b).toFixed(4)}   vs mercado solo: ${media(d) >= 0 ? '+' : ''}${media(d).toFixed(4)} IC95 [${a.toFixed(4)}, ${z.toFixed(4)}]`);
  }
}

// ── 4. ¿Hay precios REZAGADOS justo despues de un corner nuevo? ──
// Ciclos donde el conteo de FotMob subio respecto al ciclo anterior del mismo
// partido (un corner cayo en los ultimos ~3 min) vs el resto. Si el modelo le
// gana al mercado sobre todo ahi, la ventaja seria latencia de precio, no
// mejor pronostico.
console.log('\nBRIER de P(under) por tipo de ciclo, NB calibrado vs mercado (>0 = modelo mejor que mercado):');
function brierSub(w, filtro) {
  const v = [];
  for (const p of porPartido.values()) {
    const xs = [];
    p.filas.forEach((f, i) => {
      if (f.min < 10 || !filtro(f, p.filas[i - 1])) return;
      for (const l of f.calL) {
        if (!l.modelo || l.modelo.edgeUnder == null || f.conteo > Math.floor(l.linea)) continue;
        const pMod = l.modelo.pUnder, pMkt = pMod - l.modelo.edgeUnder;
        xs.push((w * pMod + (1 - w) * pMkt - (p.final <= Math.floor(l.linea) ? 1 : 0)) ** 2);
      }
    });
    if (xs.length) v.push({ id: p, b: media(xs) });
  }
  return v.map(x => x.b);
}
for (const [nom, filtro] of [
  ['ciclo con corner NUEVO', (f, prev) => prev && f.conteo > prev.conteo],
  ['ciclo SIN corner nuevo', (f, prev) => prev && f.conteo === prev.conteo],
]) {
  for (const w of [1, 0.5]) {
    const m = brierSub(0, filtro), c = brierSub(w, filtro);
    // partidos pueden diferir entre m y c solo si no hay lineas; misma construccion => mismo largo
    const d = m.map((x, i) => x - c[i]);
    const [a, z] = bootstrapIC(d);
    console.log(`  ${nom.padEnd(24)} w=${w.toFixed(1)}  n=${d.length} partidos  ventaja ${media(d) >= 0 ? '+' : ''}${media(d).toFixed(4)}  IC95 [${a.toFixed(4)}, ${z.toFixed(4)}]`);
  }
}
