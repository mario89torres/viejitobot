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

const crypto = require('crypto');
// MODEL_PATH existe para los TESTS, no para produccion.
//
// tests/model.test.js necesita cargar modelos de juguete, y para hacerlo
// ESCRIBIA sobre el model.json real y lo restauraba en un finally. El 2026-09-04
// ese restore fallo por contencion de fichero con el bot vivo y dejo el modelo
// de produccion reducido a 171 bytes de juguete; la unica copia buena quedo en
// la memoria del proceso en marcha, y hubo que reconstruir la calibracion desde
// los conf_learned guardados (scripts/recuperar-calibracion-model.js).
//
// Con MODEL_PATH apuntando a un fichero temporal, el test no toca produccion.
//
// Ojo: definir MODEL_PATH en .env mueve el modelo de produccion. El default es
// la ruta de siempre.
const MODEL_PATH = process.env.MODEL_PATH || path.join(__dirname, '..', 'model.json');

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
// "Resultado Final (Tiempo Regular)" y NO con "1x2", "Ganador", "Ganador (incl.
// prórroga)" ni "Ganador (incl. super over)", que son la misma apuesta con otro
// nombre. Esas caen al bucket de referencia (sin ninguna flag) junto a
// hándicaps y doble oportunidad.
// Lo que NO es: un train/serve skew. Producción y entrenamiento usan ESTA
// función, así que ambos lados fragmentan idéntico.
//
// SE PROBÓ CUBRIRLA Y NO SIRVIÓ (2026-08-22, scripts/experiment-market-coverage.py).
// Parecía la explicación del fallo con datos frescos: el modelo empataba donde
// tenía features (N=111, −0.0001) y perdía fuerte donde no (N=23, −0.0297), y
// esa bolsa había pasado del 6.5% al 15.1%. Se implementaron is_handicap,
// hcp_line, is_ganador_alt e is_doble, se reexportó el dataset y se midió sobre
// picks emitidos (N_oos=549):
//   actual (mercado base)   +0.0023  3/4 folds
//   + handicap              +0.0023  3/4     delta +0.0000
//   + ganador_alt           +0.0026  3/4     delta +0.0003
//   + doble                 +0.0009  2/4     delta −0.0014
//   + TODO                  +0.0013  3/4     delta −0.0010
//   CONTROL: ruido          +0.0018  3/4     delta −0.0004
// Los deltas de las candidatas son del tamaño que mueve el RUIDO, y añadirlas
// todas EMPEORA. Revertidas: no se envía código que no se gana su sitio. El
// script queda para repetirlo con más datos.
//
// Y OJO CON EL DATO DE FONDO: con 3 días más de datos la ventaja del propio
// mercado base bajó de +0.0044 (4/4 folds) a +0.0023 (3/4). Encoge según crece
// el dataset, que es lo que se espera de un resultado con sesgo de selección.
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
let modelVersionId = null;

// SELLO DE VERSIÓN DEL MODELO.
//
// conf_learned se persiste en picks, model_picks y rejected_picks aunque el
// modelo no decida nada (MODEL_MODE=shadow). Cada reentrenamiento cambia la
// escala de esa columna, y hasta 2026-08-25 no quedaba constancia de CUÁL
// modelo la produjo: `score_version` versiona la fórmula heurística, no el
// modelo aprendido. Consecuencia: un análisis que agrupe por conf_learned
// cruzando dos modelos mezcla dos escalas distintas sin avisar. Pasó de forma
// latente al cambiar la calibración de isotónica a Platt, que mueve el
// significado de un mismo número.
//
// Formato: '<trained_at compacto>-<hash7>', p.ej. '20260825T183012Z-a3f9c1b'.
// Lleva las dos mitades a propósito. El timestamp es legible y ordena; el hash
// del CONTENIDO detecta lo que el timestamp no ve — un model.json editado a
// mano conserva su trained_at pero cambia de hash.
function calcularVersion(raw, m) {
  const hash = crypto.createHash('sha1').update(raw).digest('hex').slice(0, 7);
  if (!m || !m.trained_at) return hash;
  const t = String(m.trained_at).replace(/[-:]/g, '').replace(/\.\d+/, '');
  return `${t.replace(/\+0000$/, 'Z').replace(/\s/, 'T')}-${hash}`;
}

function reloadModel() {
  try {
    const raw = fs.readFileSync(MODEL_PATH, 'utf8');
    const m = JSON.parse(raw);
    if (typeof m.intercept !== 'number' || !m.coef || !m.calibration ||
        !Array.isArray(m.calibration.x) || !Array.isArray(m.calibration.y) ||
        m.calibration.x.length !== m.calibration.y.length || m.calibration.x.length < 2) {
      throw new Error('model.json con formato inválido');
    }
    model = m;
    modelVersionId = calcularVersion(raw, m);
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('[model] no se pudo cargar model.json:', e.message);
    model = null;
    modelVersionId = null;
  }
  return model;
}
reloadModel();

// null cuando no hay modelo cargado o está sin adoptar: en ese caso tampoco hay
// conf_learned que sellar, así que la columna queda NULL de forma coherente.
function modelVersion() {
  return (!model || model.adopted === false) ? null : modelVersionId;
}

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

// Devuelve el sigmoide SIN calibrar. Es el que conserva el orden fino: la
// calibración isotónica es una escalera de 28 peldaños y aplasta tramos enteros
// del crudo en un solo valor. Medido el 2026-08-25 sobre 18.967 candidatos, el
// crudo va de 0.13 a 0.82, pero el 94.8% de lo que supera MIN_CONF=0.70 cae en
// los peldaños 0.7025/0.7034 — indistinguibles entre sí. Para ORDENAR hay que
// usar el crudo; para leerlo como probabilidad, el calibrado.
function learnedRaw(features, sport) {
  if (!model || model.adopted === false) return null;
  const featList = Array.isArray(model.features) && model.features.length ? model.features : FEATURES;
  let z = model.intercept;
  for (const f of featList) z += (model.coef[f] || 0) * valorFeature(features, f);
  const sc = model.sport_coef || {};
  const key = sc[sport] !== undefined ? sport : 'otros';
  z += sc[key] || 0;
  return sigmoid(z);
}

function learnedConf(features, sport) {
  const raw = learnedRaw(features, sport);
  if (raw === null) return null;
  const cal = interp(model.calibration, raw);
  return Math.min(1, Math.max(0, cal));
}

// Punto de entrada: devuelve el conf a mostrar según MODEL_MODE y ambos
// scores para persistirlos (shadow). conf_learned queda null si no aplica.
function score(features, sport) {
  const mode = getMode();
  const confHeuristic = heuristicConf(features);
  const confLearned = mode === 'heuristic' ? null : learnedConf(features, sport);
  // El crudo NO se persiste ni se muestra: sirve para desempatar el orden
  // dentro de un peldaño de la calibración (ver learnedRaw).
  const confLearnedRaw = mode === 'heuristic' ? null : learnedRaw(features, sport);
  const conf = mode === 'learned' && confLearned !== null ? confLearned : confHeuristic;
  // El sello se toma AQUÍ, no en la capa de escritura: así identifica al modelo
  // que de verdad produjo este confLearned, aunque model.json se recargue en
  // caliente (bot.js:/train) entre la puntuación y el INSERT.
  return { conf, confHeuristic, confLearned, confLearnedRaw, mode, modelVersion: modelVersion() };
}

module.exports = {
  score, heuristicConf, learnedConf, learnedRaw, getMode, reloadModel, interp, modelVersion,
  marketFeatures, MARKET_FEATURES, FEATURES, HEURISTIC_WEIGHTS,
};
