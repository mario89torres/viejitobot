/**
 * EXPERIMENTO: ¿por qué no entrena, y qué SÍ aprovecharía estos datos?
 *
 * Diagnóstico que motiva esto (medido el 2026-08-09, N=1816 liquidados sin
 * source='global_draw'):
 *
 *   Brier de un predictor CONSTANTE (siempre la tasa base 69.9%) = 0.2104
 *   heurístico 0.2075 · candidato 0.2073
 *   -> TODO el aprendizaje disponible vale 0.003 de Brier. Por eso ningún
 *      modelo "gana": no hay casi nada que ganar con estas features.
 *
 *   Y peor, la mezcla destruye señal. Correlación con acierto (solo picks
 *   scoreados por la heurística, N=1151):
 *      f_prob_justa   +0.131      f_situacion   -0.119   <- ¡NEGATIVA!
 *      f_avance_model +0.108      f_linea       +0.026
 *      conf_heuristic +0.080      <- la mezcla rinde PEOR que su mejor parte
 *   La heurística pondera f_situacion al 20% cuando empíricamente resta. Es el
 *   mismo defecto que R5 del firewall ya parchea en el extremo (>=0.99), pero
 *   el peso sigue contaminando a todos los demás picks.
 *
 * Este script NO propone algoritmos más grandes: con 0.003 de Brier disponible
 * y N~1600, un gradient boosting sobreajustaría en vez de aprender. Prueba lo
 * contrario — scorers MÁS SIMPLES — con corte temporal.
 *
 * También descarta CLV como objetivo, y con datos: el "cierre" se toma 31 min
 * antes de liquidar, y en directo eso es con el partido casi resuelto (momio de
 * cierre medio: ganadores 1.294, perdedores 7.996). Entrenar contra CLV daría
 * un modelo brillante en test e inútil en producción. Es fuga de etiqueta.
 *
 * Uso: node scripts/experiment-scorers.js [--split 0.6]
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const Database = require('better-sqlite3');

const splitArg = process.argv.indexOf('--split');
const SPLIT = splitArg > -1 ? Number(process.argv[splitArg + 1]) : 0.6;

const db = new Database(path.join(__dirname, '..', 'snapshots.db'), { readonly: true });
const rows = db.prepare(`
  SELECT ts, result, f_prob_justa, f_avance_model, f_situacion, f_linea, f_apertura
  FROM picks
  WHERE result IN ('win','loss')
    AND f_prob_justa IS NOT NULL AND f_avance_model IS NOT NULL
    AND f_situacion IS NOT NULL AND f_linea IS NOT NULL AND f_apertura IS NOT NULL
    AND (source IS NULL OR source != 'global_draw')
  ORDER BY ts
`).all();

const cut = Math.floor(rows.length * SPLIT);
const TRAIN = rows.slice(0, cut), TEST = rows.slice(cut);
const y = r => (r.result === 'win' ? 1 : 0);

// Los candidatos. Deliberadamente simples: el diagnóstico dice que el problema
// es exceso de mezcla, no falta de capacidad del modelo.
const scorers = {
  'CONSTANTE (tasa base de TRAIN)': () => TRAIN.reduce((a, r) => a + y(r), 0) / TRAIN.length,
  'heuristico ACTUAL (35/30/20/15)': r =>
    0.35 * r.f_prob_justa + 0.30 * r.f_avance_model + 0.20 * r.f_situacion + 0.15 * r.f_linea,
  'sin f_situacion (44/37/19)     ': r =>
    0.4375 * r.f_prob_justa + 0.375 * r.f_avance_model + 0.1875 * r.f_linea,
  'f_prob_justa SOLA              ': r => r.f_prob_justa,
  'f_prob_justa + f_avance (54/46)': r => 0.54 * r.f_prob_justa + 0.46 * r.f_avance_model,
};

// Calibración isotónica ajustada SOLO en TRAIN y aplicada a TEST: sin esto se
// compararía el orden pero no el nivel, y el nivel es lo que consume Kelly.
function fitIsotonic(xs, ys) {
  const pts = xs.map((x, i) => ({ x, y: ys[i], w: 1 })).sort((a, b) => a.x - b.x);
  const st = [];
  for (const p of pts) {
    st.push({ ...p });
    while (st.length > 1 && st[st.length - 2].y >= st[st.length - 1].y) {
      const b = st.pop(), a = st.pop();
      st.push({ x: b.x, y: (a.y * a.w + b.y * b.w) / (a.w + b.w), w: a.w + b.w });
    }
  }
  return st;
}
function applyIso(st, x) {
  if (x <= st[0].x) return st[0].y;
  if (x >= st[st.length - 1].x) return st[st.length - 1].y;
  let lo = 0, hi = st.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (st[m].x <= x) lo = m; else hi = m; }
  const t = (x - st[lo].x) / ((st[hi].x - st[lo].x) || 1);
  return st[lo].y + t * (st[hi].y - st[lo].y);
}

const EPS = 1e-9;
function evaluate(preds, ys) {
  const n = preds.length;
  const brier = preds.reduce((a, p, i) => a + (p - ys[i]) ** 2, 0) / n;
  const ll = -preds.reduce((a, p, i) => {
    const q = Math.min(1 - EPS, Math.max(EPS, p));
    return a + (ys[i] * Math.log(q) + (1 - ys[i]) * Math.log(1 - q));
  }, 0) / n;
  const idx = preds.map((p, i) => [p, i]).sort((a, b) => a[0] - b[0]);
  const rank = new Array(n);
  for (let i = 0; i < n;) {
    let j = i; while (j + 1 < n && idx[j + 1][0] === idx[i][0]) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) rank[idx[k][1]] = avg;
    i = j + 1;
  }
  const nPos = ys.reduce((a, v) => a + v, 0), nNeg = n - nPos;
  const sumPos = ys.reduce((a, v, i) => a + (v ? rank[i] : 0), 0);
  return { brier, ll, auc: nPos && nNeg ? (sumPos - (nPos * (nPos + 1)) / 2) / (nPos * nNeg) : 0.5 };
}

console.log(`N=${rows.length}  TRAIN=${TRAIN.length} (${TRAIN[0].ts.slice(0, 10)}->${TRAIN[cut - 1].ts.slice(0, 10)})  `
  + `TEST=${TEST.length} (${TEST[0].ts.slice(0, 10)}->${TEST[TEST.length - 1].ts.slice(0, 10)})`);
console.log(`Tasa base en TEST: ${((TEST.reduce((a, r) => a + y(r), 0) / TEST.length) * 100).toFixed(1)}%`);
console.log('\nTodos calibrados isotónicamente sobre TRAIN y evaluados en TEST (fuera de muestra).');
console.log('\n  scorer                             Brier      logloss     AUC');

const ysTest = TEST.map(y);
const out = [];
for (const [name, fn] of Object.entries(scorers)) {
  const iso = fitIsotonic(TRAIN.map(fn), TRAIN.map(y));
  const preds = TEST.map(r => applyIso(iso, fn(r)));
  const m = evaluate(preds, ysTest);
  out.push({ name, ...m });
  console.log(`  ${name}  ${m.brier.toFixed(4)}    ${m.ll.toFixed(4)}    ${m.auc.toFixed(3)}`);
}

const base = out[0], cur = out[1];
console.log(`\n  Referencia: el CONSTANTE saca Brier ${base.brier.toFixed(4)}. Todo lo que quede por encima`);
console.log('  de esa cifra es PEOR que no modelar nada.');
const best = out.slice(1).reduce((a, b) => (b.brier < a.brier ? b : a));
console.log(`\n  Mejor scorer: ${best.name.trim()}`);
console.log(`  vs heuristico actual -> Brier ${(cur.brier - best.brier >= 0 ? '-' : '+')}${Math.abs(cur.brier - best.brier).toFixed(4)}, `
  + `AUC ${(best.auc - cur.auc >= 0 ? '+' : '')}${(best.auc - cur.auc).toFixed(3)}`);
console.log('\n  (AUC 0.5 = no ordena. Si NINGUN scorer supera claramente al constante,');
console.log('   el problema son los datos, no el algoritmo: hay que capturar features nuevas.)');

// ── La prueba que explica por qué NADA entrena ──────────────────────────────
// Un modelo solo puede aprender un mapa que se quede quieto. Si la relación
// entre el precio y el resultado se mueve entre TRAIN y TEST, cualquier ajuste
// —heurístico, logístico o gradient boosting— aprende un régimen que ya no
// existe cuando se pone a decidir.
console.log('\n=== ¿ES ESTACIONARIO EL MAPA precio -> resultado? ===');
const lift = set => {
  const p = set.reduce((a, r) => a + r.f_prob_justa, 0) / set.length;
  const w = set.reduce((a, r) => a + y(r), 0) / set.length;
  return { p: p * 100, w: w * 100, d: (w - p) * 100 };
};
for (const [label, set] of [['TRAIN', TRAIN], ['TEST ', TEST]]) {
  const l = lift(set);
  console.log(`  ${label}  f_prob_justa media ${l.p.toFixed(1)}%   WR real ${l.w.toFixed(1)}%   `
    + `lift ${(l.d >= 0 ? '+' : '') + l.d.toFixed(1)}pp`);
}
const dTr = lift(TRAIN).d, dTe = lift(TEST).d;
console.log(`\n  El lift sobre el precio pasó de ${dTr.toFixed(1)}pp a ${dTe.toFixed(1)}pp `
  + `(${((1 - dTe / dTr) * 100).toFixed(0)}% de caída).`);
console.log('  Ese lift ES el edge explotable. Si no se queda quieto, no hay modelo que lo');
console.log('  capture: no es un problema de capacidad, es de NO ESTACIONARIEDAD. La palanca');
console.log('  entonces no es un algoritmo más grande, sino (a) reajustar sobre ventana móvil');
console.log('  corta, (b) capturar los picks RECHAZADOS para que el clasificador vea la');
console.log('  frontera, y (c) features ortogonales al mismo flujo de momios.');
