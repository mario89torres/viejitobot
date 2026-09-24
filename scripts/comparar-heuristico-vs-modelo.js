// Compara el HEURISTICO (picks emitidos) contra el MODELO (sombra, model_picks)
// en la MISMA VENTANA y, sobre todo, A VOLUMEN IGUALADO.
//
// POR QUE A VOLUMEN IGUALADO. La comparacion en crudo esta contaminada: el
// modelo emite ~5x mas picks que el heuristico (207/dia contra 42), y el 94% de
// los suyos son Under. Los dos coinciden en que lo que NO es Under pierde ~2.2%,
// asi que toda la diferencia venia de cuanto Under se atreve a tomar cada uno,
// no de que uno eligiera mejor. Eso no es una comparacion de criterios: es una
// comparacion de apetito.
//
// Igualando el volumen dia a dia se elimina esa variable — y de paso el regimen,
// porque cada dia se compara consigo mismo (ver la nota de comparar siempre en
// la misma ventana).
//
// LA PREGUNTA PREVIA, que decide si lo demas significa algo: ¿conf_learned
// ORDENA? Si el decil superior del modelo no rinde mejor que el inferior, su
// top-N es una muestra aleatoria de sus propios picks y "top-N" no quiere decir
// nada. Ya paso con Kelly (Spearman 0.09) y con la magnitud del edge (-0.19).
//
//   node scripts/comparar-heuristico-vs-modelo.js [--desde 2026-08-29T19:13:45]
require('dotenv').config();
const { db } = require('../src/db');

const argIdx = process.argv.indexOf('--desde');
// Por defecto, el instante en que MODEL_MODE volvio a 'shadow' y el heuristico
// recupero la decision. Antes de eso decidia el modelo y no hay dos ramas.
const DESDE = argIdx > -1 ? process.argv[argIdx + 1] : '2026-08-29T19:13:45';

const ret = (r) => (r.result === 'win' ? r.odd_decimal - 1 : -1);
const liq = (rows) => rows.filter(r => r.result === 'win' || r.result === 'loss');

function stats(rows) {
  const x = liq(rows).map(ret);
  const n = x.length;
  if (n < 2) return { n, roi: null };
  const m = x.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(x.reduce((a, b) => a + (b - m) ** 2, 0) / (n - 1));
  const se = sd / Math.sqrt(n);
  const w = liq(rows).filter(r => r.result === 'win').length;
  return { n, wr: 100 * w / n, roi: 100 * m, se: 100 * se, lo: 100 * (m - 1.96 * se), hi: 100 * (m + 1.96 * se) };
}
const fmt = (e) => e.roi == null
  ? `n=${e.n} (insuficiente)`
  : `${e.roi >= 0 ? '+' : ''}${e.roi.toFixed(2)}%  IC95 [${e.lo.toFixed(1)}, ${e.hi.toFixed(1)}]  WR ${e.wr.toFixed(1)}%  n=${e.n}`;

const heur = db.prepare('SELECT ts, event_id, odd_decimal, result FROM picks WHERE ts >= ?').all(DESDE);
const mod = db.prepare(`SELECT ts, event_id, odd_decimal, result, conf_learned, edge_learned
                        FROM model_picks WHERE ts >= ?`).all(DESDE);

console.log(`ventana desde ${DESDE}`);
console.log(`heuristico ${heur.length} picks | modelo ${mod.length} picks\n`);

// ── 1. ¿Ordena conf_learned? ────────────────────────────────────────────────
console.log('== 1. ¿ORDENA conf_learned? (deciles de la sombra) ==');
const ml = liq(mod).slice().sort((a, b) => b.conf_learned - a.conf_learned);
const D = 5;
const tam = Math.floor(ml.length / D);
for (let i = 0; i < D; i++) {
  const trozo = ml.slice(i * tam, i === D - 1 ? ml.length : (i + 1) * tam);
  const e = stats(trozo);
  const cs = trozo.map(r => r.conf_learned);
  console.log(`  Q${i + 1} conf ${Math.min(...cs).toFixed(4)}-${Math.max(...cs).toFixed(4)}  ${fmt(e)}`);
}
// Spearman entre conf_learned y el retorno.
function spearman(a, b) {
  const rank = (v) => {
    const idx = v.map((x, i) => [x, i]).sort((p, q) => p[0] - q[0]);
    const r = new Array(v.length);
    for (let i = 0; i < idx.length;) {
      let j = i; while (j < idx.length && idx[j][0] === idx[i][0]) j++;
      const med = (i + j - 1) / 2 + 1;
      for (let k = i; k < j; k++) r[idx[k][1]] = med;
      i = j;
    }
    return r;
  };
  const ra = rank(a), rb = rank(b), n = a.length;
  const ma = ra.reduce((x, y) => x + y, 0) / n, mb = rb.reduce((x, y) => x + y, 0) / n;
  let num = 0, da = 0, dbb = 0;
  for (let i = 0; i < n; i++) { num += (ra[i] - ma) * (rb[i] - mb); da += (ra[i] - ma) ** 2; dbb += (rb[i] - mb) ** 2; }
  return num / Math.sqrt(da * dbb);
}
// OJO CON LA CORRELACION CONTRA EL RETORNO: esta contaminada por la cuota. El
// retorno de un acierto ES la cuota, y conf_learned va fuertemente ligada a ella
// (a mas confianza, cuota mas corta). Medido: Spearman(conf, cuota) = -0.66, que
// por si solo produce un Spearman(conf, retorno) negativo aunque la confianza no
// aporte NADA sobre quien gana. La correlacion que responde la pregunta es
// contra el resultado BINARIO.
const gano = ml.map(r => (r.result === 'win' ? 1 : 0));
const rhoRet = spearman(ml.map(r => r.conf_learned), ml.map(ret));
const rhoCuota = spearman(ml.map(r => r.conf_learned), ml.map(r => r.odd_decimal));
const rhoGano = spearman(ml.map(r => r.conf_learned), gano);
const seRho = 1 / Math.sqrt(ml.length - 1);
console.log(`  Spearman(conf, retorno) = ${rhoRet.toFixed(4)}   <- contaminado por la cuota, NO leer`);
console.log(`  Spearman(conf, cuota)   = ${rhoCuota.toFixed(4)}   <- el confusor`);
console.log(`  Spearman(conf, GANO)    = ${rhoGano.toFixed(4)}   <- la pregunta real  (error tipico ${seRho.toFixed(4)})`);
  console.log('  ' + (Math.abs(rhoGano) < 2 * seRho
    ? '-> NO ordena. Elegir por conf equivale a elegir CUOTA CORTA con el mismo acierto, que a igual volumen es el peor subconjunto posible por ROI.'
    : '-> ordena algo sobre el resultado'));

// Calibracion: lo prometido contra lo ocurrido. Si conf fuera informativa, el WR
// real subiria con el conf medio del tramo.
console.log(`\n  CALIBRACION (conf medio prometido vs WR real)`);
const ordC = ml.slice().sort((a, b) => a.conf_learned - b.conf_learned);
for (let i = 0; i < D; i++) {
  const t2 = Math.floor(ordC.length / D);
  const s2 = ordC.slice(i * t2, i === D - 1 ? ordC.length : (i + 1) * t2);
  const pred = s2.reduce((x, r) => x + r.conf_learned, 0) / s2.length;
  const real = s2.filter(r => r.result === 'win').length / s2.length;
  const se2 = Math.sqrt(real * (1 - real) / s2.length);
  const cuo = s2.reduce((x, r) => x + r.odd_decimal, 0) / s2.length;
  console.log(`    Q${i + 1} promete ${(100 * pred).toFixed(1)}%  ocurre ${(100 * real).toFixed(1)}% ±${(196 * se2).toFixed(1)}  cuota media ${cuo.toFixed(2)}  n=${s2.length}`);
}

// ── 2. Volumen igualado dia a dia ───────────────────────────────────────────
console.log('\n== 2. A VOLUMEN IGUALADO (top-N del modelo = N picks del heuristico ese dia) ==');
const porDia = {};
for (const r of heur) { const d = r.ts.slice(0, 10); (porDia[d] = porDia[d] || { h: [], m: [] }).h.push(r); }
for (const r of mod) { const d = r.ts.slice(0, 10); (porDia[d] = porDia[d] || { h: [], m: [] }).m.push(r); }

const topIgualado = [];
for (const d of Object.keys(porDia).sort()) {
  const { h, m } = porDia[d];
  const nH = liq(h).length;
  const top = m.slice().sort((a, b) => b.conf_learned - a.conf_learned);
  const elegidos = liq(top).slice(0, nH);
  topIgualado.push(...elegidos);
  console.log(`  ${d}  heuristico ${fmt(stats(h))}`);
  console.log(`              modelo top-${nH}  ${fmt(stats(elegidos))}`);
}
console.log('\n  ACUMULADO');
const eH = stats(heur), eM = stats(topIgualado);
console.log(`    HEURISTICO        ${fmt(eH)}`);
console.log(`    MODELO top-igual  ${fmt(eM)}`);
if (eH.roi != null && eM.roi != null) {
  const dif = eM.roi - eH.roi, se = Math.sqrt(eH.se ** 2 + eM.se ** 2);
  const lo = dif - 1.96 * se, hi = dif + 1.96 * se;
  console.log(`    DIFERENCIA        ${dif >= 0 ? '+' : ''}${dif.toFixed(2)}pp  IC95 [${lo.toFixed(1)}, ${hi.toFixed(1)}]  ${lo * hi > 0 ? '<- EXCLUYE el cero' : '<- abarca el cero: indistinguible'}`);
}

// ── 3. Barrido: ¿mejora al ser mas selectivo? ───────────────────────────────
console.log('\n== 3. BARRIDO de selectividad (top-K por dia del modelo) ==');
for (const K of [5, 10, 20, 42, 80, 200]) {
  const sel = [];
  for (const d of Object.keys(porDia).sort()) {
    const top = porDia[d].m.slice().sort((a, b) => b.conf_learned - a.conf_learned);
    sel.push(...liq(top).slice(0, K));
  }
  console.log(`  top-${String(K).padStart(3)}/dia  ${fmt(stats(sel))}`);
}
console.log(`  TODOS       ${fmt(stats(mod))}`);
