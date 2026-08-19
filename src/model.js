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

// --- Features de MERCADO (2026-08-19) --------------------------------------
//
// Se derivan AQUÍ, en Node, y el exportador del dataset las escribe ya
// calculadas al CSV. Python nunca las recalcula. Es deliberado: si cada lado
// las derivara por su cuenta, cualquier divergencia entre las dos
// implementaciones sería un train/serve skew silencioso — exactamente el bug
// de f_avance que costó reconstruir 2228 filas (ver avanceForModel en
// confidence.js). Con una sola fuente, ese fallo no puede existir.
//
// POR QUÉ EXISTEN. El modelo entrenaba con f_prob_justa/f_avance/f_situacion/
// f_linea/f_apertura y era CIEGO a qué mercado era el pick — pese a que el
// mercado es lo único que hemos demostrado que discrimina de verdad:
//   Under línea <= 3.5  ROI  +9.8%  IC [+3.1%, +16.4%]
//   Under línea  > 3.5  ROI  +0.7%  IC cruza cero
//   Over                ROI -22.2%  IC [-39.9%, -4.6%]
// Ese edge estaba implementado a mano en el firewall (R1, R7) y en el
// dimensionamiento (STAKE_MODE=tiered), pero el modelo no podía aprenderlo.
//
// Medido el 2026-08-19 sobre picks EMITIDOS (la métrica que decide):
//   base (5 features)      d_Brier -0.0011   2/4 folds
//   + mercado + línea      d_Brier +0.0044   4/4 folds   <- pasa la regla
//   CONTROL: + ruido       d_Brier -0.0006   1/4 folds   <- no mejora, como debe
// El control con ruido aleatorio NO mejora, así que la ganancia es información
// real y no simple capacidad extra del modelo.
//
// LIMITACIÓN CONOCIDA (medida, no sospechada): is_ganador sólo casa con
// "Resultado Final (Tiempo Regular)" — el 2551 de filas dominante — y NO con
// "1x2", "Ganador", "Ganador (incl. prórroga)" ni "Ganador (incl. super over)",
// que son la misma apuesta con otro nombre. Esas caen al bucket de referencia
// (sin ninguna flag) junto a hándicaps y doble oportunidad. Son 51 de 2310
// picks emitidos = 2.2%, así que el +0.0044 medido YA incluye este defecto: la
// ganancia es real a pesar de él, no gracias a él. Ampliar el regex es un
// experimento aparte y hay que correrlo con el mismo rigor (control de ruido,
// picks-only, 4/4 folds), no como un retoque — cada variante que se prueba
// sobre el mismo dataset gasta grados de libertad.
// Lo que NO es: un train/serve skew. Producción y entrenamiento usan ESTA
// función, así que ambos lados fragmentan idéntico.
const deaccModel = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/**
 * Features de mercado a partir del pick crudo. Devuelve SIEMPRE todas las
 * claves (0 cuando no aplica): un `undefined` acabaría en el `?? 0.5` de
 * learnedConf(), que para un indicador binario sería un valor imposible y
 * reintroduciría el skew que este diseño evita.
 */
function marketFeatures(row = {}) {
  const sel = deaccModel(row.selection);
  const mkt = deaccModel(row.market);
  const esTotal = /^total/.test(mkt);

  const isUnder = esTotal && /^menos de/.test(sel) ? 1 : 0;
  const isOver = esTotal && /^mas de/.test(sel) ? 1 : 0;
  const m = String(row.selection || '').match(/(\d+(?:\.\d+)?)/);
  // Acotada a 6.5: por encima el edge ya se desvaneció y una línea de 10.5
  // dominaría la escala sin aportar.
  const linea = esTotal && m ? Math.min(Number(m[1]), 6.5) : 0;

  return {
    is_under: isUnder,
    is_over: isOver,
    is_btts: /ambos equipos marcan/.test(mkt) ? 1 : 0,
    is_ganador: /resultado final/.test(mkt) ? 1 : 0,
    is_dnb: /empate no accion/.test(mkt) ? 1 : 0,
    linea,
  };
}

const MARKET_FEATURES = ['is_under', 'is_over', 'is_btts', 'is_ganador', 'is_dnb', 'linea'];

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
// nuevas como f_apertura que el heurístico no usa).
//
// EL FALLBACK ES LA PARTE PELIGROSA. Antes, una feature ausente se sustituía en
// silencio por 0.5. Para las f_* continuas eso es un "valor neutro" defendible,
// pero para un indicador binario (is_under, is_over…) 0.5 es un valor
// IMPOSIBLE: el modelo entrenó viendo 0 o 1 y en producción recibiría medio
// punto, o sea el mismo train/serve skew que costó reconstruir 2228 filas con
// f_avance. Ahora un binario ausente vale 0 y se avisa una sola vez, en vez de
// degradar callando.
const AVISADAS = new Set();
function valorFeature(features, f) {
  const v = features[f];
  if (v !== undefined && v !== null) return v;
  if (!AVISADAS.has(f)) {
    AVISADAS.add(f);
    console.error(`[model] falta la feature '${f}' al inferir; se usa ${MARKET_FEATURES.includes(f) ? 0 : 0.5}. `
      + 'Si es de mercado, quien llama debe pasar marketFeatures(row).');
  }
  // Un binario/lineal de mercado ausente es 0 ("no es ese mercado"), nunca 0.5.
  return MARKET_FEATURES.includes(f) ? 0 : 0.5;
}

function learnedConf(features, sport) {
  if (!model || model.adopted === false) return null;
  const featList = Array.isArray(model.features) && model.features.length ? model.features : FEATURES;
  let z = model.intercept;
  for (const f of featList) z += (model.coef[f] || 0) * valorFeature(features, f);
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

module.exports = {
  score, heuristicConf, learnedConf, getMode, reloadModel, interp,
  marketFeatures, MARKET_FEATURES, FEATURES, HEURISTIC_WEIGHTS,
};
