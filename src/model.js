// Inferencia del modelo aprendido (entrenado por scripts/train_weights.py).
// model.json = coeficientes de la logística + tabla de calibración interpolable,
// así Node no necesita sklearn. Si no hay model.json, el score heurístico
// (pesos fijos 0.45/0.20/0.20/0.15) sigue siendo el fallback.
//
// MODEL_MODE (.env):
//   'heuristic' — solo score heurístico (no evalúa el modelo)
//   'shadow'    — calcula ambos, el bot muestra el heurístico (default)
//   'learned'   — muestra el aprendido; si no hay modelo, cae al heurístico

const fs = require('fs');
const path = require('path');

const MODEL_PATH = path.join(__dirname, '..', 'model.json');

// Las features que EXISTEN. No confundir con las que el heurístico pondera:
// f_situacion se sigue calculando y persistiendo (el firewall la usa en R5 y hay
// que poder re-auditarla), simplemente ya no entra en la mezcla. Ver abajo.
const FEATURES = ['f_prob_justa', 'f_avance', 'f_situacion', 'f_linea'];

// Pesos del heurístico. f_situacion SALIÓ de la mezcla el 2026-08-09 (peso 0).
//
// Por qué: medido sobre picks liquidados (N=1151, sin source='global_draw'), su
// correlación con acertar es NEGATIVA —  −0.119 — y la heurística le daba el
// 20% del peso. Estaba restando señal a propósito sin querer, y por eso la
// mezcla completa (corr +0.080) rendía PEOR que su mejor componente sola
// (f_prob_justa, +0.131). Es el mismo defecto que R5 del firewall ya parchea en
// el extremo (>=0.99: "el evaluador de totales devuelve 1.0 cuando la línea aún
// no se cruzó y el scoring lo lee como 'va a pasar'"), pero el parche solo
// tapaba la cola — el peso contaminaba a todos los demás picks.
//
// Efecto medido con corte temporal, aplicando MIN_CONF=0.70 y MIN_EDGE=0.03:
//   TRAIN 07-17→08-05   con f_situacion N=714 WR 74.5% ROI  +8.4%
//                       sin f_situacion N=346 WR 76.6% ROI +10.0%
//   TEST  08-05→08-09   con f_situacion N=174 WR 58.6% ROI  -9.3%
//                       sin f_situacion N= 41 WR 75.6% ROI +11.2%
// Consistente en ambos periodos y MAYOR fuera de muestra. El coste es volumen:
// recorta la emisión ~56%, pero lo que recorta perdía dinero en conjunto.
//
// CAVEAT honesto: sólo se puede medir sobre picks que el sistema YA emitió con
// los pesos viejos, así que el efecto en volumen está sesgado — no se ven los
// picks que estos pesos aceptarían y los viejos descartaron. Eso es justo lo
// que el registro de rechazados viene a resolver.
//
// Reversible sin tocar código: HEURISTIC_W_PROB / _AVANCE / _SITUACION / _LINEA.
const w = (env, d) => {
  const v = process.env[env];
  return v === undefined || v === '' ? d : Number(v);
};
const HEURISTIC_WEIGHTS = {
  f_prob_justa: w('HEURISTIC_W_PROB', 0.4375),
  f_avance: w('HEURISTIC_W_AVANCE', 0.375),
  f_situacion: w('HEURISTIC_W_SITUACION', 0),
  f_linea: w('HEURISTIC_W_LINEA', 0.1875),
};

let model = null;
function reloadModel() {
  try {
    const m = JSON.parse(fs.readFileSync(MODEL_PATH, 'utf8'));
    if (typeof m.intercept !== 'number' || !m.coef || !m.calibration ||
        !Array.isArray(m.calibration.x) || !Array.isArray(m.calibration.y) ||
        m.calibration.x.length !== m.calibration.y.length || m.calibration.x.length < 2) {
      throw new Error('model.json con formato inválido');
    }
    model = m;
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('[model] no se pudo cargar model.json:', e.message);
    model = null;
  }
  return model;
}
reloadModel();

function getMode() {
  const m = (process.env.MODEL_MODE || 'shadow').toLowerCase();
  return ['learned', 'heuristic', 'shadow'].includes(m) ? m : 'shadow';
}

const sigmoid = z => 1 / (1 + Math.exp(-z));

// Interpolación lineal sobre la tabla (x ascendente); clamp en los extremos
function interp(table, v) {
  const { x, y } = table;
  if (v <= x[0]) return y[0];
  if (v >= x[x.length - 1]) return y[y.length - 1];
  let lo = 0, hi = x.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (x[mid] <= v) lo = mid; else hi = mid;
  }
  const t = (v - x[lo]) / (x[hi] - x[lo]);
  return y[lo] + t * (y[hi] - y[lo]);
}

function heuristicConf(features) {
  let conf = 0;
  for (const f of FEATURES) conf += HEURISTIC_WEIGHTS[f] * features[f];
  return conf;
}

// sigmoid(β0 + Σ βi·fi + β_deporte) pasado por la tabla de calibración.
// La lista de features viene del propio model.json (puede incluir features
// nuevas como f_apertura que el heurístico no usa); si al momento de inferir
// falta alguna, se asume el valor neutro 0.5.
function learnedConf(features, sport) {
  if (!model || model.adopted === false) return null;
  const featList = Array.isArray(model.features) && model.features.length ? model.features : FEATURES;
  let z = model.intercept;
  for (const f of featList) z += (model.coef[f] || 0) * (features[f] ?? 0.5);
  const sc = model.sport_coef || {};
  const key = sc[sport] !== undefined ? sport : 'otros';
  z += sc[key] || 0;
  const raw = sigmoid(z);
  const cal = interp(model.calibration, raw);
  return Math.min(1, Math.max(0, cal));
}

// Punto de entrada: devuelve el conf a mostrar según MODEL_MODE y ambos
// scores para persistirlos (shadow). conf_learned queda null si no aplica.
function score(features, sport) {
  const mode = getMode();
  const confHeuristic = heuristicConf(features);
  const confLearned = mode === 'heuristic' ? null : learnedConf(features, sport);
  const conf = mode === 'learned' && confLearned !== null ? confLearned : confHeuristic;
  return { conf, confHeuristic, confLearned, mode };
}

module.exports = { score, heuristicConf, learnedConf, getMode, reloadModel, interp, FEATURES, HEURISTIC_WEIGHTS };
