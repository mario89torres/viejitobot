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

const FEATURES = ['f_prob_justa', 'f_avance', 'f_situacion', 'f_linea'];
const HEURISTIC_WEIGHTS = { f_prob_justa: 0.35, f_avance: 0.30, f_situacion: 0.20, f_linea: 0.15 };

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
  if (!model) return null;
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
