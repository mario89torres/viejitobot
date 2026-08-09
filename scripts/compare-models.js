/**
 * ¿Qué scorer ha rendido MEJOR de verdad? Comparación cara a cara sobre picks
 * liquidados reales, recomputando los tres desde las features guardadas para
 * que se comparen definiciones idénticas y no restos de configuraciones viejas.
 *
 *   HEURISTICO  pesos fijos de src/model.js (el que corre hoy)
 *   MODELO-A    model_pre_*.json — el del 2026-08-05, isotonic, el que estuvo
 *               en producción del 08-04 al 08-08
 *   CANDIDATO   model_candidate.json — el reentrenado hoy, sigmoid
 *
 * Usa f_avance_model (lo que el modelo consume), NO f_avance (progress crudo).
 * Confundirlos es el train/serve skew que se corrigió el 2026-08-08.
 *
 * Sobre qué se mide, y por qué importa el corte:
 *   - MODELO-A se entrenó el 08-05 con n=798, así que los picks POSTERIORES al
 *     08-05 son verdaderamente fuera de muestra para él. Es la única cifra
 *     limpia, y además es el periodo en que realmente estuvo decidiendo.
 *   - CANDIDATO se entrenó hoy con todo, así que NADA es fuera de muestra para
 *     él aquí: sus números salen inflados por construcción y se marcan como
 *     tales. Su evidencia honesta es su propio walk-forward (2/4 folds).
 *
 * Tres métricas, porque miden cosas distintas:
 *   Brier / log loss -> ¿acierta el NIVEL de probabilidad? (calibración)
 *   AUC              -> ¿ORDENA ganadores sobre perdedores? (discriminación)
 * Un scorer puede tener buen Brier por decir siempre la tasa base y aun así no
 * ordenar nada (AUC 0.5), que es justo el fallo que hay que detectar.
 *
 * Excluye source='global_draw' (features hardcodeadas; ver firewall.js).
 *
 * Uso: node scripts/compare-models.js [--since 2026-08-05]
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const fs = require('fs');
const Database = require('better-sqlite3');
const { HEURISTIC_WEIGHTS, FEATURES, interp } = require('../src/model');

const sinceArg = process.argv.indexOf('--since');
const SINCE = sinceArg > -1 ? process.argv[sinceArg + 1] : '2026-08-05';

const db = new Database(path.join(__dirname, '..', 'snapshots.db'), { readonly: true });
const rows = db.prepare(`
  SELECT ts, sport, result,
         f_prob_justa, f_avance, f_avance_model, f_situacion, f_linea, f_apertura
  FROM picks
  WHERE result IN ('win','loss')
    AND f_prob_justa IS NOT NULL AND f_avance_model IS NOT NULL
    AND f_situacion IS NOT NULL AND f_linea IS NOT NULL AND f_apertura IS NOT NULL
    AND (source IS NULL OR source != 'global_draw')
  ORDER BY ts
`).all();

const sigmoid = z => 1 / (1 + Math.exp(-z));

// Features tal como las consume el modelo: f_avance = f_avance_model.
const featsOf = r => ({
  f_prob_justa: r.f_prob_justa, f_avance: r.f_avance_model,
  f_situacion: r.f_situacion, f_linea: r.f_linea, f_apertura: r.f_apertura,
});

const heuristic = f => FEATURES.reduce((a, k) => a + HEURISTIC_WEIGHTS[k] * f[k], 0);

function loadModel(file) {
  const m = JSON.parse(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'));
  return (f, sport) => {
    let z = m.intercept;
    for (const k of m.features) z += (m.coef[k] || 0) * (f[k] ?? 0.5);
    const sc = m.sport_coef || {};
    z += sc[sc[sport] !== undefined ? sport : 'otros'] || 0;
    return Math.min(1, Math.max(0, interp(m.calibration, sigmoid(z))));
  };
}

const scorers = {
  'HEURISTICO (en produccion)': (f) => heuristic(f),
  'MODELO-A (08-05, isotonic)': loadModel('model_pre_20260809T083247.json'),
  'CANDIDATO (hoy, sigmoid)  ': loadModel('model_candidate.json'),
};

const EPS = 1e-9;
function metrics(preds, ys) {
  const n = preds.length;
  const brier = preds.reduce((a, p, i) => a + (p - ys[i]) ** 2, 0) / n;
  const ll = -preds.reduce((a, p, i) => {
    const q = Math.min(1 - EPS, Math.max(EPS, p));
    return a + (ys[i] * Math.log(q) + (1 - ys[i]) * Math.log(1 - q));
  }, 0) / n;
  // AUC por rangos (Mann-Whitney), con empates promediados.
  const idx = preds.map((p, i) => [p, i]).sort((a, b) => a[0] - b[0]);
  const rank = new Array(n);
  for (let i = 0; i < n;) {
    let j = i; while (j + 1 < n && idx[j + 1][0] === idx[i][0]) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) rank[idx[k][1]] = avg;
    i = j + 1;
  }
  const nPos = ys.reduce((a, y) => a + y, 0), nNeg = n - nPos;
  const sumPos = ys.reduce((a, y, i) => a + (y ? rank[i] : 0), 0);
  const auc = nPos && nNeg ? (sumPos - (nPos * (nPos + 1)) / 2) / (nPos * nNeg) : 0.5;
  const mean = preds.reduce((a, p) => a + p, 0) / n;
  const wr = nPos / n;
  return { n, brier, ll, auc, mean, wr };
}

function report(label, set, note) {
  if (!set.length) return;
  const ys = set.map(r => (r.result === 'win' ? 1 : 0));
  console.log(`\n=== ${label} (N=${set.length}, WR real ${((ys.reduce((a, y) => a + y, 0) / set.length) * 100).toFixed(1)}%) ===`);
  if (note) console.log(`    ${note}`);
  console.log('    scorer                        Brier     logloss    AUC     conf_media   exceso');
  for (const [name, fn] of Object.entries(scorers)) {
    const preds = set.map(r => fn(featsOf(r), r.sport));
    const m = metrics(preds, ys);
    const exceso = (m.mean - m.wr) * 100;
    console.log(`    ${name}  ${m.brier.toFixed(4)}   ${m.ll.toFixed(4)}   ${m.auc.toFixed(3)}    `
      + `${(m.mean * 100).toFixed(1)}%      ${(exceso >= 0 ? '+' : '') + exceso.toFixed(1)}pp`);
  }
}

console.log(`Picks liquidados con features completas: ${rows.length}`);
console.log('Menor Brier/logloss = mejor calibrado. AUC 0.5 = no ordena nada, no mejor que el azar.');

report('FUERA DE MUESTRA para MODELO-A: picks posteriores al ' + SINCE,
  rows.filter(r => r.ts >= SINCE),
  'Unica cifra limpia para MODELO-A, y el periodo en que realmente decidia.\n    OJO: el CANDIDATO se entreno con estos picks -> sus numeros aqui estan inflados.');

report('Todo el historico', rows,
  'Ambos modelos vieron parte de esto en entrenamiento. Solo referencia.');

console.log('\n--- Como leerlo ---');
console.log('Adoptar un modelo exige que GANE al heuristico en Brier Y en log loss');
console.log('fuera de muestra, y en la mayoria de los folds (regla de train_weights.py).');
console.log('Si su AUC ~0.50, no ordena: dimensionar con esa conf reparte sobre ruido.');
