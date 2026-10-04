const { db } = require('./db');
const { parsePick, situationFactor } = require('./markets');
const { score: modelScore, marketFeatures } = require('./model');
// Firewall de jugadas (src/firewall.js). NO se aplica a parlayCombos a
// propósito: sus piernas viven en 1.08-1.45 por diseño y R4 (momio < 1.30) las
// mataría, pero el backtest que originó las reglas se corrió sobre picks
// simples de la tabla `picks`, no sobre piernas de parlay. Filtrar ahí sería
// extrapolar sin medición.
const { isFirewallBlocked, isElite, firewallVerdict } = require('./firewall');

// Versión del cálculo de features. Se persiste en cada pick para no mezclar
// regímenes al entrenar: las features de versiones distintas no son
// comparables entre sí.
//   v1: f_linea saturaba en 1.0 para el 82% de los picks (feature muerta)
//   v2 (2026-07-22): f_linea reescalada con compresión suave, sin saturación
const SCORE_VERSION = 2;

const histStmt = db.prepare(`
  SELECT odd_decimal FROM snapshots
  WHERE ts >= ? AND event_id = ? AND market = ? AND selection = ? AND suspended = 0
  ORDER BY ts ASC
`);

// Ventana de la media móvil que suaviza la serie antes de medir la pendiente
const MA_WINDOW = Math.max(1, Number(process.env.LINE_MA_WINDOW || 3));

// Primera observación en vivo del momio (nuestra "apertura": nunca vemos el
// pre-partido, solo el feed live). Disponible igual en histórico y en vivo,
// así que es una feature sin fuga de datos.
const openStmt = db.prepare(`
  SELECT odd_decimal FROM snapshots
  WHERE event_id = ? AND market = ? AND selection = ? AND suspended = 0
  ORDER BY ts ASC LIMIT 1
`);

// CACHE DE LA CUOTA DE APERTURA. Es la consulta mas cara del sistema.
//
// Medido el 2026-08-28: 7.20 ms por llamada, el 86% del coste de scoreRow
// (8.32 ms). El indice de snapshots es (event_id, ts), asi que ORDER BY ts ASC
// obliga a buscar el evento y escanear hacia delante TODAS sus filas filtrando
// mercado y seleccion en memoria, sobre una tabla de 113 millones de filas.
//
// Por que se puede cachear sin riesgo: la apertura es, por definicion, la
// PRIMERA observacion de esa combinacion. Una vez vista no cambia nunca.
//
// Efecto: el ciclo del sampler puntua el conjunto de candidatos tres veces
// (auditRejections, safestPicks, modelPicks). Con ~2.000 filas por ciclo eso
// eran ~52 s de CPU BLOQUEANTE, y Node es de un solo hilo: durante esos 52 s
// el poll de Telegram no responde. De ahi que los mensajes tardaran.
//
// Solo se cachean los aciertos. Un fallo (todavia no hay snapshot sin
// suspender) SI puede cambiar en el proximo ciclo.
//
// Nota sobre la poda: pruneSnapshots borra filas viejas de eventos sin picks.
// Si borra la fila de apertura, la BD devolveria una posterior. El cache
// conserva la original, que es lo correcto.
const OPEN_CACHE_MAX = Number(process.env.OPEN_CACHE_MAX || 200000);
const openCache = new Map();
function openingOddFor(eventId, market, selection) {
  const k = `${eventId}|${market}|${selection}`;
  const hit = openCache.get(k);
  if (hit !== undefined) return hit;
  const row = openStmt.get(eventId, market, selection);
  if (!row) return null;                    // no se cachea el fallo
  if (openCache.size >= OPEN_CACHE_MAX) openCache.clear();  // tope simple: sin fugas
  openCache.set(k, row.odd_decimal);
  return row.odd_decimal;
}

// Drift relativo apertura→actual mapeado a [0,1] sin saturación dura:
// >0.5 = la línea bajó desde la primera observación (el mercado se movió a
// favor del pick); 0.5 = sin movimiento. relDelta/(1+|relDelta|) es suave y
// acotado, evitando que drifts grandes (~36% de media en vivo) saturen en 1.
function aperturaFactor(openingOdd, currentOdd) {
  if (!(openingOdd > 1) || !(currentOdd > 1)) return 0.5;
  const relDelta = (openingOdd - currentOdd) / openingOdd;
  return 0.5 + 0.5 * (relDelta / (1 + Math.abs(relDelta)));
}

// Media móvil corta (ventana trailing) para filtrar el ruido del muestreo denso
function smooth(prices, w) {
  if (w <= 1) return prices;
  const out = [];
  for (let i = 0; i < prices.length; i++) {
    const start = Math.max(0, i - w + 1);
    let s = 0;
    for (let j = start; j <= i; j++) s += prices[j];
    out.push(s / (i - start + 1));
  }
  return out;
}

// Parámetros por deporte: duración (min), margen "decisivo" y sets totales
const SPORT_PARAMS = {
  66: { duration: 90, margin: 2 },    // Fútbol
  179: { duration: 40, margin: 2 },   // Fútbol Rápido
  67: { duration: 48, margin: 12 },   // Baloncesto
  70: { duration: 60, margin: 2 },    // Hockey
  68: { sets: 3, margin: 1 },         // Tenis
  69: { sets: 5, margin: 2 },         // Voleibol
  77: { sets: 5, margin: 2 },         // Tenis de mesa
  78: { sets: 5, margin: 2 },         // Dardos
  76: { duration: 9, margin: 3 },     // Béisbol (innings)
};
const DEFAULT_PARAMS = { duration: 90, margin: 3, sets: 3 };

// Curva empírica de anotación del béisbol: fracción de las carreras totales
// del partido ya anotadas al terminar cada inning. Medida sobre 134 partidos
// del propio histórico (2026-07-29).
//
// Sustituye a la proyección lineal inning/9, que subestimaba el avance real
// del marcador en los innings centrales (al 5º va el 61% de las carreras, no
// el 55.6% que asume la recta). Ese sesgo inflaba la proyección de carreras
// finales y hacía parecer arriesgados los "menos de" y seguros los "más de".
const BASEBALL_SCORING = [0, .107, .229, .350, .488, .610, .720, .812, .906, .999];

// Avance del partido = fracción de la anotación ya ocurrida. Acepta innings
// fraccionarios (6.5 = mitad baja del 6º) e interpola entre puntos de la curva.
function baseballProgress(inning) {
  if (inning == null) return 0.5;
  if (inning >= 9.5) return 1;              // entradas extra: partido decidiéndose
  const lo = Math.floor(inning), hi = Math.min(lo + 1, 9);
  const a = BASEBALL_SCORING[Math.min(lo, 9)] ?? 1;
  const b = BASEBALL_SCORING[hi] ?? 1;
  return a + (b - a) * (inning - lo);
}

// Avance TAL COMO LO CONSUME EL MODELO (y el heurístico), que no es el mismo
// número que `progress`:
//   - "Más de X" con la línea aún sin alcanzar: el tiempo corre EN CONTRA, así
//     que se invierte a (1 - progress).
//   - "Menos de X" en el tramo final con ≤1 gol de margen: se descuenta la
//     volatilidad de último minuto.
//   - Todo lo demás: progress tal cual.
//
// Es una función pura y exportada a propósito: scripts/backfill-avance-model.js
// la reutiliza para reconstruir la columna histórica. Si la lógica viviera
// duplicada dentro de scoreRow, el backfill y producción podrían divergir en
// silencio — que es exactamente el bug que esto viene a cerrar.
function avanceForModel(progress, parsed, score) {
  if (!parsed || parsed.type !== 'total' || parsed.line === undefined || parsed.line === null) {
    return progress;
  }
  const m = String(score || '').match(/^(\d+)-(\d+)$/);
  const totalCurrent = m ? Number(m[1]) + Number(m[2]) : 0;
  if (totalCurrent >= parsed.line) return progress;

  if (parsed.over) return 1 - progress;
  if ((parsed.line - totalCurrent) <= 1.0 && progress >= 0.75) {
    return progress * (1 - (progress - 0.75) * 0.4);
  }
  return progress;
}

// Tendencia de línea sobre múltiples snapshots: pendiente a favor menos volatilidad.
// Excluye snapshots suspendidos y suaviza con media móvil antes de medir la pendiente.
//
// v2 (2026-07-22): la versión anterior usaba `clamp(0.5 + relDelta*3 - vol*1.5)`,
// que saturaba en 1.0 para el 82% de los picks (drift medio en vivo ~36%, y ×3
// satura pasado el 16.7%). La feature era casi constante y no aportaba
// información. Ahora se usa la misma transformación suave que f_apertura:
// x/(1+|x|), acotada a (0,1) pero sin saturación dura, preservando el orden.
function lineTrend(row) {
  const cutoff = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const raw = histStmt.all(cutoff, row.eventId, row.market, row.selection).map(r => r.odd_decimal);
  if (raw.length < 2) return { lineFactor: 0.5, lineDelta: null, points: raw.length };

  const prices = smooth(raw, MA_WINDOW);
  const relDelta = (prices[0] - prices[prices.length - 1]) / prices[0]; // >0 = línea bajando
  let vol = 0;
  for (let i = 1; i < prices.length; i++) vol += Math.abs(prices[i] - prices[i - 1]) / prices[i - 1];
  vol /= prices.length - 1;

  // señal = pendiente a favor penalizada por volatilidad, comprimida sin saturar
  const signal = relDelta - vol * 0.5;
  const lineFactor = 0.5 + 0.5 * (signal / (1 + Math.abs(signal)));
  return { lineFactor, lineDelta: relDelta, points: prices.length };
}

/**
 * 🎯 SEÑAL DE EMPATE ESTRUCTURAL (Line Flatline & Mean Reversion Signal)
 * Detecta cuando un mercado entra en una meseta horizontal ultrastable (baja varianza)
 * tras un periodo de volatilidad o avance del partido (>50% de duración).
 * Indica equilibrio táctico entre equipos (alta probabilidad de Empate / Under).
 */
// Los umbrales son parámetros para poder barrerlos desde el backtest
// (scripts/backtest_draw_thresholds.js) sin duplicar la lógica. Los valores por
// defecto son los de producción: llamarla sin opts no cambia nada.
const DRAW_SIGNAL_DEFAULTS = {
  maxVariance: 0.035,   // techo de desviación típica para considerar la línea plana
  minSamples: 5,        // muestras mínimas para siquiera evaluar
  minSamplesNoTie: 8,   // muestras exigidas cuando el marcador NO está empatado
};

/** true si el marcador cambió dentro de las últimas `within` muestras.
 *  `scores` viene de los snapshots MÁS NUEVO PRIMERO. */
function recentScoreChange(scores, within = 10) {
  const list = (scores || []).filter(Boolean).slice(0, within);
  return list.length > 1 && list.some(s => s !== list[0]);
}

/** true si la selección es literalmente el empate (no "doble oportunidad"). */
function isDrawSelection(selection) {
  return /^(empate|draw|x)$/i.test(String(selection || '').trim());
}

/**
 * Señal de "empate estructural": la línea del EMPATE lleva plana con el
 * marcador igualado, o sea que el mercado ya no espera que nadie desempate.
 *
 * Tenía tres agujeros, medidos el 2026-08-09 sobre 145 disparos reales:
 *
 *   1. Se aplicaba a CUALQUIER pick, no solo a los de empate: el 100% de los
 *      disparos fueron en mercados que no eran el de empate. La señal no
 *      detectaba empates, detectaba "línea plana" y le ponía la etiqueta
 *      equivocada. Ahora exige que la selección SEA el empate.
 *   2. `isFlatline && (isTiedScore || muestras >= minSamplesNoTie)` dejaba
 *      pasar marcadores NO empatados con solo tener suficientes muestras — el
 *      76% de los disparos. Un "empate estructural" con 2-0 es un contrasentido:
 *      ahora el marcador empatado es obligatorio.
 *   3. No miraba si acababa de haber gol. Si el marcador cambió hace un momento,
 *      la ventana de cuotas todavía mezcla precios de antes y después del gol, y
 *      esa varianza baja no significa "estabilizado" sino "aún sin repreciar".
 *
 * `scores` es opcional para no romper llamadas antiguas; sin él no se puede
 * comprobar el gol reciente y se avisa en el retorno.
 */
function computeStructuralDrawSignal(oddsList, scoreStr = '', opts = {}) {
  const { maxVariance, minSamples, minSamplesNoTie } = { ...DRAW_SIGNAL_DEFAULTS, ...opts };
  const { selection, scores, goalWindow = 10 } = opts;

  // Solo el mercado de empate. Sin esto la señal miente sobre lo que detecta.
  if (opts.requireDrawSelection !== false && !isDrawSelection(selection)) {
    return { isStructuralDraw: false, variance: null, reason: 'no_es_empate' };
  }
  // Gol reciente: la línea aún no ha repreciado, su planitud no significa nada.
  if (scores && recentScoreChange(scores, goalWindow)) {
    return { isStructuralDraw: false, variance: null, reason: 'gol_reciente' };
  }
  if (!oddsList || oddsList.length < minSamples) return { isStructuralDraw: false, variance: null };
  const lastOdds = oddsList.slice(0, 20);
  const mean = lastOdds.reduce((a, b) => a + b, 0) / lastOdds.length;
  const variance = Math.sqrt(lastOdds.reduce((sq, n) => sq + Math.pow(n - mean, 2), 0) / lastOdds.length);

  // Varianza ultrabaja = línea plana y estabilizada
  const isFlatline = variance <= maxVariance;
  let isTiedScore = false;
  if (scoreStr) {
    const parts = String(scoreStr).split('-').map(Number);
    if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
      isTiedScore = parts[0] === parts[1];
    }
  }

  // El marcador empatado es OBLIGATORIO. Antes bastaba con acumular
  // minSamplesNoTie muestras, y por ahí se colaba el 76% de los falsos
  // positivos: un 2-0 con la línea plana no es un empate estructural, es un
  // mercado muerto. minSamplesNoTie se conserva solo por compatibilidad de la
  // firma; ya no relaja nada.
  return {
    isStructuralDraw: isFlatline && isTiedScore && lastOdds.length >= minSamples,
    variance: Number(variance.toFixed(4)),
    mean: Number(mean.toFixed(3)),
    sampleCount: lastOdds.length,
    reason: !isFlatline ? 'linea_no_plana' : !isTiedScore ? 'marcador_no_empatado' : null,
  };
}

/**
 * Lectura del spike de cuota respecto a la entrada.
 *
 * IMPORTANTE — esto estaba al revés. La alerta se llamaba SNIPER_VALUE y se
 * presentaba como oportunidad ("el mercado sobre-reaccionó, hay valor"). Los
 * datos dicen lo contrario: medido el 2026-08-09 sobre 700 picks liquidados, el
 * WR real cae de forma monótona conforme sube la cuota desde la entrada:
 *
 *   spike <1.05   N=502  WR 81.7%     <- la cuota se mantuvo o bajó
 *   spike 1.05-1.15  N= 32  WR 31.3%
 *   spike 1.15-1.35  N= 34  WR 41.2%
 *   spike 1.35-1.60  N= 23  WR 17.4%
 *   spike >=1.60  N=107  WR  2.8%     <- aquí disparaba "SNIPER VALUE"
 *
 * O sea que el mercado no se equivoca al subir la cuota: repreciar contra
 * nuestra posición es exactamente lo que corresponde cuando va perdiendo. Los
 * 94 disparos históricos de SNIPER_VALUE acertaron el 3.2%. La señal es buena,
 * lo que estaba mal era el signo: no marca valor, marca deterioro.
 *
 * Se mantiene como AVISO, que es información útil de verdad ("esto pinta mal"),
 * y ya no como sugerencia de entrada.
 */
const SPIKE_DEFAULTS = { aviso: 1.15, grave: 1.35 };

function readSpike(entryOdd, currentOdd, opts = {}) {
  const { aviso, grave } = { ...SPIKE_DEFAULTS, ...opts };
  if (!entryOdd || !currentOdd || entryOdd <= 0) return { level: null, ratio: null };
  const ratio = currentOdd / entryOdd;
  if (ratio >= grave) return { level: 'grave', ratio: Number(ratio.toFixed(2)) };
  if (ratio >= aviso) return { level: 'aviso', ratio: Number(ratio.toFixed(2)) };
  return { level: null, ratio: Number(ratio.toFixed(2)) };
}

// Dimensionamiento de la apuesta en unidades (1 unidad = 5% del bankroll).
//
// Por defecto medio-Kelly: en el backtest de estrategias de staking (picks
// históricos liquidados), Kelly completo con `conf` casi duplicó el ROI del
// staking plano (+4.5% vs +2.5%) arriesgando un tercio del capital y con un
// drawdown máximo también de un tercio. Medio Kelly es la versión conservadora
// recomendada: menos sensible a que `conf` esté mal calibrado.
//
// Escala del "1 unidad": medida sobre 680 picks liquidados con edge>0, la
// fracción de Kelly completo tiene mediana 11% del bankroll y p90 en 24% — muy
// agresivo para tratarlo como "1% = 1 unidad" (con esa regla, casi todo
// saturaba el tope). Con 1 unidad = 5% del bankroll, medio-Kelly da mediana
// ~1.1u y solo el 0.1% de los picks históricos habría tocado el tope de 5u:
// deja variación real entre picks de bajo y alto edge en vez de aplanarla.
//
// STAKE_MODE=flat vuelve al criterio más simple: 1 unidad fija por pick.
const STAKE_MODE = (process.env.STAKE_MODE || 'half_kelly').toLowerCase();
const STAKE_MIN = Number(process.env.STAKE_MIN || 0.1);
const STAKE_MAX = Number(process.env.STAKE_MAX || 5);
const STAKE_UNIT_SCALE = Number(process.env.STAKE_UNIT_SCALE || 20); // 1/0.05: 1u = 5% bankroll

// f* = (b·p − q) / b, con b = momio neto, p = conf, q = 1−p. Negativo si no
// hay edge (no debería pasar en picks ya filtrados por MIN_EDGE, pero se acota
// a 0 por seguridad: nunca se apuesta en contra de la propia estimación).
function kellyFraction(conf, oddDecimal) {
  const b = oddDecimal - 1;
  if (b <= 0) return 0;
  return Math.max(0, (b * conf - (1 - conf)) / b);
}

// Unidades a apostar. 1 unidad = 5% del bankroll (STAKE_UNIT_SCALE = 20), así
// que stake en unidades = fracción de Kelly × 20 (× 0.5 si es medio Kelly).
// Acotado a [STAKE_MIN, STAKE_MAX] para que un edge extremo no dispare el
// tamaño de la apuesta más allá de lo prudente.
// --- STAKE_MODE=tiered ------------------------------------------------------
// Escalona el stake por la ÚNICA señal que demuestra ordenar el resultado:
// mercado + línea, reforzada por la deriva desde apertura. NO usa `conf`, que
// tiene Spearman 0.092 con el acierto — dimensionar con ella reparte sobre
// ruido (por eso se abandonó Kelly el 2026-08-09).
//
// Medido sobre 21 días (N=1004 tras firewall, sin source='global_draw'), con
// TODOS los esquemas normalizados a la misma exposición total para que la
// comparación no premie el simple apalancamiento:
//
//                              TEST(OOS)          TOTAL      maxDD   P/L:maxDD
//   plano 1u                    -6.3u            +50.7u      15.2u      3.33
//   escalonado por linea        -3.0u            +70.8u      10.3u      6.89
//   linea + apertura (este)     +1.1u            +76.1u       9.5u      7.98
//   CONTROL escalonado por conf -11.6u           +36.9u      21.3u      1.73
//
// El CONTROL existe a propósito: si escalonar por conf mejorara igual que lo
// demás, el test no estaría midiendo señal. Empeora, como debía.
//
// Las bandas de f_apertura salieron de un escaneo de avance, hora del día,
// edge, deporte y deriva; solo la deriva sobrevivió, con +33.7/+33.0/+30.0% de
// ROI fuera de muestra en tres cortes distintos. Son ~2 picks/día (N=45 en
// 21d): por eso pondera el stake y NO filtra.
//
// LOS VALORES MANTIENEN LA EXPOSICIÓN ACTUAL, no la suben. Con la mezcla
// observada el stake medio queda en ~1u, igual que el plano que sustituye:
// esto REDISTRIBUYE riesgo, no añade. Subir el tamaño total es una decisión
// aparte — se hace con STAKE_TIER_BASE, a la vista.
const STAKE_TIER_BASE = Number(process.env.STAKE_TIER_BASE || 0.6);
const STAKE_TIER_MID = Number(process.env.STAKE_TIER_MID || 1.2);
const STAKE_TIER_HIGH = Number(process.env.STAKE_TIER_HIGH || 1.8);
const STAKE_TIER_APERTURA = Number(process.env.STAKE_TIER_APERTURA || 0.70);

const deacc = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Peso de escalón de un pick. `ctx` es opcional: sin él, cae al escalón base. */
function tierStake(ctx = {}) {
  const sel = deacc(ctx.selection);
  const esUnder = /^menos de/.test(sel)
    && (ctx.marketType === undefined || ctx.marketType === null || ctx.marketType === 'total');
  const m = String(ctx.selection || '').match(/([\d.]+)/);
  const linea = m ? Number(m[1]) : null;

  let stake = STAKE_TIER_BASE;
  if (esUnder && linea != null && linea <= 2.5) stake = STAKE_TIER_HIGH;
  else if (esUnder && linea != null && linea <= 3.5) stake = STAKE_TIER_MID;
  // Deriva a favor desde la apertura: sube un escalón, sin acumular sin tope.
  else if (ctx.fApertura != null && ctx.fApertura >= STAKE_TIER_APERTURA) stake = STAKE_TIER_MID;

  return stake;
}

function computeStake(conf, oddDecimal, mode = STAKE_MODE, isHighConviction = false, ctx = {}) {
  if (mode === 'flat') return 1;
  if (mode === 'tiered') {
    // Se respetan igualmente STAKE_MIN/STAKE_MAX y el tope por momio: el
    // escalón decide el tamaño relativo, no anula los controles de riesgo.
    const oddsCapT = oddDecimal >= 1.70 ? 2.5 : oddDecimal >= 1.50 ? 3.5 : Infinity;
    const capT = Math.min(STAKE_MAX, oddsCapT);
    return Math.min(capT, Math.max(STAKE_MIN, tierStake(ctx)));
  }
  const f = kellyFraction(conf, oddDecimal);
  let frac = mode === 'kelly' ? f : f / 2; // half_kelly es el default
  if (isHighConviction) frac *= 1.25; // Sharp / High Conviction boost (+25% stake)
  const units = Math.round(frac * STAKE_UNIT_SCALE * 10) / 10;
  // Tope por momio: a más momio, más varianza, así que el techo baja. Es un
  // control de riesgo, y por eso se COMBINA con STAKE_MAX en vez de sustituirlo.
  //
  // Antes esto ASIGNABA (`dynamicMax = 2.5`), lo que invertía su propósito: con
  // STAKE_MAX=2 en .env, un pick a momio 1.60 acababa con techo 3.5 — un 75% POR
  // ENCIMA del máximo que el operador había configurado. Medido el 2026-08-09:
  // 757 de 1406 picks con stake registrado superaron el STAKE_MAX=2 declarado, y
  // seguía pasando ese mismo día ya con el modelo revertido (9 de 53 picks
  // llegaron a 3.5u). El tope del operador nunca debe poder subirse solo.
  const oddsCap = oddDecimal >= 1.70 ? 2.5 : oddDecimal >= 1.50 ? 3.5 : Infinity;
  const cap = Math.min(STAKE_MAX, oddsCap);
  return Math.min(cap, Math.max(STAKE_MIN, units));
}

// Índice de confianza [0..1] combinando:
//  - probabilidad justa: devig() sobre el mercado completo, método DEVIG_METHOD (peso 45%)
//  - avance del juego: a menos tiempo restante, más certeza (20%)
//  - estado del juego según el tipo de mercado (ventaja, totales, etc.) (20%)
//  - tendencia de línea multi-snapshot (15%)
function scoreRow(row) {
  const base = row.fairProb || 1 / row.oddDecimal;
  const params = { ...DEFAULT_PARAMS, ...(SPORT_PARAMS[row.sportId] || {}) };

  let progress = 0.5;
  if (row.sportId === 76 && row.minute !== null) progress = baseballProgress(row.minute);
  else if (row.minute !== null && params.duration) progress = Math.min(row.minute / params.duration, 1);
  else if (row.setNum !== null) progress = Math.min(row.setNum / (params.sets || 3), 1);

  const parsed = parsePick(row);
  const scoreFactor = situationFactor(row, parsed, progress, params);

  // ventaja visible solo para picks de equipo/jugador
  let lead = null;
  const m = (row.score || '').match(/^(\d+)-(\d+)$/);
  if (m && parsed && (parsed.type === 'winner' || parsed.type === 'handicap')) {
    const a = Number(m[1]), b = Number(m[2]);
    lead = parsed.side === 'home' ? a - b : b - a;
  }

  const { lineFactor, lineDelta, points } = lineTrend(row);

  const openingOdd = openingOddFor(row.eventId, row.market, row.selection);
  const fApertura = aperturaFactor(openingOdd, row.oddDecimal);

  // El conf mostrado depende de MODEL_MODE (src/model.js); el heurístico
  // 0.35/0.30/0.20/0.15 sigue vivo como fallback y para el modo shadow.
  // f_apertura solo la consume el modelo aprendido (los pesos fijos no cambian).
  //
  const fAvance = avanceForModel(progress, parsed, row.score);

  // marketFeatures() se deriva en model.js y el exportador del dataset escribe
  // esas MISMAS claves al CSV: una sola fuente para entrenar y para servir, así
  // no puede haber divergencia. El heurístico las ignora (solo suma FEATURES),
  // así que añadirlas aquí no cambia conf mientras el modelo no se adopte.
  const features = {
    f_prob_justa: base, f_avance: fAvance, f_situacion: scoreFactor,
    f_linea: lineFactor, f_apertura: fApertura,
    ...marketFeatures(row),
  };
  const { conf, confHeuristic, confLearned, confLearnedRaw, modelVersion, mode: modelMode } = modelScore(features, row.sport);
  // edge estimado al momento de emitir: valor esperado por unidad apostada
  const edge = conf * row.oddDecimal - 1;
  const isHighConviction = ((confLearned || conf) >= 0.80) &&
    (row.sharpMatch === 'matched' || row.sharp_match === 'matched' || (edge >= 0.15 && row.oddDecimal >= 1.35));
  // El contexto lo necesita STAKE_MODE=tiered para saber en qué escalón cae:
  // mercado/línea y deriva desde apertura. Los demás modos lo ignoran.
  const stake = computeStake(conf, row.oddDecimal, STAKE_MODE, isHighConviction, {
    selection: row.selection, marketType: parsed && parsed.type === 'total' ? 'total' : null,
    fApertura,
  });
  return {
    conf, confHeuristic, confLearned, confLearnedRaw, modelVersion, modelMode, edge, stake, stakeMode: STAKE_MODE, isHighConviction,
    // `progress` es el avance CRUDO (lo usan el firewall y los mensajes);
    // `fAvance` es el que realmente entra al modelo. Se devuelven los dos para
    // poder persistir el servido sin romper a quien depende del crudo.
    base, progress, fAvance, scoreFactor, lineFactor, lineDelta, linePoints: points,
    openingOdd, fApertura, scoreVersion: SCORE_VERSION,
    lead, marketType: parsed ? parsed.type : null,
  };
}

// Deportes excluidos de la emisión de picks (EXCLUDE_SPORTS en .env).
// Compara sin acentos ni mayúsculas, así "beisbol" y "Béisbol" coinciden.
const normSport = s => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

function excludedSports() {
  return (process.env.EXCLUDE_SPORTS || '').split(',').map(normSport).filter(Boolean);
}

// true si el pick es un "más de X" (total con over). Se apoya en marketType,
// que ya calculó scoreRow, para no volver a parsear.
function isOverPick(r) {
  if (r.marketType !== 'total') return false;
  return /^m[aá]s de/i.test((r.selection || '').normalize('NFD').replace(/[̀-ͯ]/g, ''));
}

// "menos de X" de FÚTBOL: el único mercado con ventaja verificada
// (n=235, ROI +15.9%, t=4.03, pasa todas las pruebas de robustez).
function isFootballUnder(r) {
  if (r.marketType !== 'total') return false;
  const sel = (r.selection || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
  if (!/^menos de/i.test(sel)) return false;
  // Coincidencia EXACTA con "futbol": "Fútbol Rápido" es futsal, otro deporte
  // (9 picks históricos, ROI -71.8%) y no forma parte de la señal verificada.
  const sp = (r.sport || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
  return sp === 'futbol';
}

// Umbral de edge aplicable a un pick concreto.
//
// EXPERIMENTO (MIN_EDGE_UNDER): permite un umbral distinto SOLO para los
// "menos de X" de fútbol. Motivo: el 84% de los picks de ese mercado sale con
// edge entre 2% y 5%, apilado justo contra el umbral de MIN_EDGE=0.02 — la
// distribución está truncada y no sabemos qué hay debajo, porque esos picks
// nunca se emitieron. Bajando el umbral solo ahí, la zona ciega se vuelve
// medible sin tocar el resto del sistema.
//
// Los picks del experimento se identifican después sin columna extra: un
// "menos de" de fútbol con edge < MIN_EDGE solo puede existir por esta vía.
// Vaciar MIN_EDGE_UNDER en .env cierra el experimento.
function edgeThresholdFor(r, defaultMin) {
  const raw = process.env.MIN_EDGE_UNDER;
  if (raw !== undefined && raw !== '' && isFootballUnder(r)) return Number(raw);
  return defaultMin;
}

// "menos de X" de fútbol con X <= 3.5: el segmento donde MIN_CONF recorta volumen
// rentable (ver minConfFor).
function isLowLineFootballUnder(r) {
  if (!isFootballUnder(r)) return false;
  const m = /(\d+(?:\.\d+)?)/.exec(r.selection || '');
  return !!m && Number(m[1]) <= 3.5;
}

// Piso de confianza aplicable a un pick concreto.
//
// EXPERIMENTO (MIN_CONF_UNDER_LOW): piso distinto SOLO para los "menos de X<=3.5"
// de fútbol. Vacío (por defecto) = sin efecto: todos usan MIN_CONF.
//
// Medido el 2026-09-25 sobre rejected_picks (rechazados SOLO por min_conf, "menos
// de" con linea <=3.5, desde 2026-08-10, bootstrap por EVENTO):
//   rechazados  N=11,285 ev  ROI +9.6%  IC95% [+8.0, +11.3]
//   emitidos    N= 1,034 ev  ROI +3.8%  IC95% [-0.4, +7.6]   (misma ventana)
//   TRAIN <09-01 +8.3% [6.1, 10.7] · TEST >=09-01 +11.1% [8.9, 13.4]
// `conf` no ordena dentro del segmento (ROI por tramo: 0.4-0.5 +10.1%, 0.5-0.6
// +6.0%, 0.6-0.7 +5.0%), asi que el piso no filtra malos picks: recorta volumen.
//
// OJO: los rechazados se midieron con precio de PRIMER AVISTAMIENTO, no
// ejecutable, y con MIN_EDGE/MAX_EDGE previos a 2026-09-23. Sin tope, el
// segmento pasaria de ~5 a ~190 picks/dia: por eso el piloto exige
// UNDER_LOW_DAILY_CAP (bot.js) — este piso NUNCA debe activarse sin el.
// Los picks del piloto se reconocen sin columna extra: un "menos de" de futbol
// con conf < MIN_CONF solo puede existir por esta via.
function minConfFor(r, defaultMin) {
  const raw = process.env.MIN_CONF_UNDER_LOW;
  if (raw !== undefined && raw !== '' && isLowLineFootballUnder(r)) return Number(raw);
  return defaultMin;
}

// Veto por falta de certidumbre: si el sistema no sabe interpretar el mercado,
// no puede evaluarlo ni calificarlo.
//
// Un mercado no reconocido recibe factor de situación 0.5 (neutro) — es decir,
// se puntúa a ciegas, ignorando el estado real del partido — y al liquidarlo
// gradePick devuelve null, así que tampoco sabremos si acertó. Apostar donde no
// hay ni evaluación ni verificación posible es ruido puro: contamina el dataset
// sin aportar información. Ejemplo real detectado: un pick pendiente de "Cuarto
// Gol", el mercado que produjo las 52 victorias fabricadas.
function isUncertain(r) {
  if (r.marketType === null || r.marketType === undefined) return true;
  const s = (r.sport || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  if (s.includes('tenis') || s.includes('tennis')) {
    const m = (r.market || '').toLowerCase();
    // En tenis, los totales de juegos/puntos y hándicaps de juegos/puntos no tienen resolución
    // de puntuación en el feed live (solo hay conteo de sets), por lo que se marcan inciertos.
    if (r.marketType === 'total' || (r.marketType === 'handicap' && !m.includes('set'))) {
      return true;
    }
  }
  return false;
}

// true si es un "más de" en un deporte donde está vetado
function isBlockedOver(r) {
  if (!isOverPick(r)) return false;
  const s = (r.sport || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  return blockOversIn().some(d => s.includes(d));
}

function esDNB(r) {
  const m = (r.market || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  return m.includes('empate no accion') || m.includes('draw no bet') || m.includes('dnb');
}

// DNB (Empate No Acción). Por defecto solo se exige mayor convicción
// (conf >= 0.75 y edge >= 0.05); con BLOCK_DNB=1 se veta el mercado ENTERO.
//
// POR QUÉ SE PUEDE VETAR ENTERO (medido el 2026-08-22, N=488 liquidados):
//
// 1. El 62.0% terminan en EMPATE, o sea push: el stake vuelve y el pick no
//    produce nada. De 1006.8u desplegadas en DNB, 558.6u devuelven cero. En la
//    ventana reciente ese push sube al 80%.
// 2. Ese 62% NO es una señal, es el PRECIO. La cuota mediana del empate en ese
//    instante es 1.63, cuyo equilibrio está en 61.3%. Acertamos 61.3+0.7. El
//    margen de la casa se come la diferencia.
// 3. Cambiar el target a Empate directo tampoco sirve: contra los picks
//    emitidos de la misma ventana da −3.0pp, IC95% [−12.1, +7.5], P(mejor)=27.5%.
//
// LO QUE ESTO NO ES: una mejora de rentabilidad. DNB es PLANO, ≈0 u/pick en
// todas las ventanas (−0.0235 histórico, −0.0027 desde 08-12, −0.0283 desde
// 08-19), y sobre el histórico completo su diferencia con el resto NI SIQUIERA
// es significativa (IC [−0.213, +0.083], P=13%). Vetarlo no gana dinero
// esperado.
//
// Y OJO con el argumento que parece obvio y es FALSO: no libera ranura de
// emisión. AUTO_PICK_MAX_PER_HOUR=100 y el máximo real en una hora fue 36, con
// mediana 3; el tope no se tocó ni una vez en 136 horas. Quitar DNB no hace que
// se emita otra cosa en su lugar, simplemente se emite menos.
//
// Lo que SÍ gana: ~20% menos capital desplegado para el mismo P/L, y ~18% menos
// apuestas colocadas — que importa por el riesgo de limitación de cuenta.
// Es una decisión de eficiencia y exposición, no de rentabilidad.
//
// Volver atrás: BLOCK_DNB=0.
function isWeakDNB(r) {
  if (!esDNB(r)) return false;
  if (process.env.BLOCK_DNB === '1') return true;
  if (r.conf !== undefined && r.conf < 0.75) return true;
  if (r.edge !== undefined && r.edge < 0.05) return true;
  return false;
}

// "Menos de X" tardío (progress >= 0.80) con margen apretado exige edge >= 0.04
function isWeakLateUnder(r) {
  const sel = (r.selection || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  if (r.marketType === 'total' || /menos de/i.test(sel)) {
    if (r.progress !== undefined && r.progress >= 0.80) {
      if (r.edge !== undefined && r.edge < 0.04) return true;
    }
  }
  return false;
}

function isBlockedMarket(r) {
  if (!r || !r.selection) return false;
  const m = (r.market || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const sel = (r.selection || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

  // Veto a "Ambos equipos marcan: Sí" / "Ambos marcan: Sí"
  if (m.includes('ambos') && (sel === 'si' || sel === 'sí' || sel.includes('si'))) {
    return true;
  }

  // Veto a "Doble oportunidad" ENTERO en fútbol (medido 2026-09-29, histórico
  // completo, n=138): ROI -4.9% (-6.8u), negativo en las DOS mitades del
  // historial (-7.3% / -2.6%: mejora pero sigue en rojo) y negativo en TODOS
  // los buckets de edge, incluido el de mayor edge (14%+: -7.7%, el peor de
  // todos). Que ni el bucket de más edge se salve descarta que sea un problema
  // de umbral — es la selección del mercado en sí. Contraste: "Ambos equipos
  // marcan" (arriba) se midió en la misma sesión con la misma ventana de 6
  // días y parecía perder (-11.3%, n=39); el histórico completo lo desmiente
  // (+6.0% ROI, n=1026, estable en ambas mitades) — Doble oportunidad NO tiene
  // esa reversión, por eso se veta y BTTS no.
  if (m.includes('doble oportunidad')) return true;

  // Veto a selecciones directas de "Empate" o "Draw" (EXCEPTO si es una Señal de Empate Estructural Flatline)
  if ((sel === 'empate' || sel === 'draw') && !r.isStructuralDraw && r.alert !== 'STRUCTURAL_DRAW') {
    return true;
  }

  // Regla de emisión para líneas altas:
  //   Over (Más de X):  vetado si línea >= 4.5  → mercados volátiles/impredecibles
  //   Under (Menos de X): SIN VETO — análisis histórico 2026-08-06 confirma ROI positivo
  //     en TODOS los rangos: 5.5 (+35.4% ROI, 85.7% WR), 6.5 (+6.3%), 7.5 (+24.7%),
  //     9.5 (+40%), 10.5 (+47.5%). El veto anterior era un error estadístico.
  if (r.marketType === 'total' || /m[aá]s de|menos de/i.test(sel)) {
    const parsed = parsePick(r);
    if (parsed && parsed.type === 'total') {
      if (parsed.over && parsed.line !== undefined && parsed.line !== null && parsed.line >= 4.5) {
        // Over sigue vetado desde 4.5 en adelante
        return true;
      }
      // Under: sin veto — ROI positivo confirmado empíricamente en todas las líneas
    }
  }

  // DNB débil (conf < 75% o edge < +5%)
  if (isWeakDNB(r)) return true;

  // Under tardío débil (progress >= 80% y edge < +4%)
  if (isWeakLateUnder(r)) return true;

  return false;
}

function isExcluded(sport, list) {
  if (!list.length) return false;
  const s = normSport(sport);
  return list.some(x => s === x || s.includes(x));
}

// Rankea jugadas por índice de confianza dentro de una banda de momios,
// máximo una por evento. minEdge <= 0 desactiva el filtro de edge;
// minConf <= 0 desactiva el piso de confianza. Respeta EXCLUDE_SPORTS.
// Veto a los "más de X" SOLO en los deportes donde hay evidencia (BLOCK_OVERS_IN).
//
// En fútbol (n=500) el patrón es contundente y significativo: TODAS las líneas
// "menos de" rinden entre +16.6% y +38.4%, TODAS las "más de" pierden (-0.4% a
// -75.8%), en conjunto -24.5%. Causa mecánica: la proyección goles/avance
// sobrestima el total final.
//
// Pero en BÉISBOL el patrón se INVIERTE: los "menos de" pierden (-8.7%, n=71) y
// los "más de" quedan neutros (-0.5%, n=8). Aplicar el veto global habría
// bloqueado justamente el lado menos malo. Por eso la lista es por deporte:
// un hallazgo de un deporte no se extrapola a los demás sin medirlo.
const blockOversIn = () => (process.env.BLOCK_OVERS_IN ?? 'futbol')
  .split(',').map(s => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim()).filter(Boolean);

/**
 * 🛡️ PROTOCOLO DE VALIDACIÓN DE 5 GUARDIAS (Anti-Ghost & Latency Protocol)
 * ─────────────────────────────────────────────────────────────────────────────
 * 1. Guardia 1: Score Shock Guard (Calma de Marcador 90s sin goles/puntos recientes)
 * 2. Guardia 2: Heartbeat Latency Anomaly (Silencio de Feed >15s pre-suspensión)
 * 3. Guardia 3: Line Stability Window (Sin suspensión ni drift >10% en 60s)
 * 4. Guardia 4: Safe Margin Buffer (Colchón de seguridad línea vs marcador)
 * 5. Guardia 5: Snapshot Maturity Check (Mínimo 4-5 snapshots activos observados)
 * ─────────────────────────────────────────────────────────────────────────────
 */
// Analisis retrospectivo del 2026-09-12 sobre el grupo de control: de las 5
// guardias, solo la 5 mostro evidencia clara de proteger contra picks
// perdedores (n=47, -12.6% ROI en lo que bloqueaba); 1 y 3 salieron
// neutrales o con muestra insuficiente (n=30 y n=12), y 2 y 4 sin evidencia
// a favor. Se apagaron 1-4 ese mismo dia dejando solo la 5 activa.
//
// La 5 se apago horas despues, el mismo dia, junto con quitar la escritura
// duplicada de getFreshRows() (bot.js): /parlay, /golden, /seguras, /top y
// /deportes volvian a guardar su propia foto de las cuotas en vivo ademas de
// la que ya guarda el sampler de fondo cada minuto, y esa escritura extra
// (sincrona, cara con la BD bajo contencion) era buena parte de la lentitud
// que se reportaba en esos comandos. Quitar la escritura duplicada deja a
// esos comandos dependiendo del historial que el sampler de fondo ya viene
// llenando solo, sin el suyo propio — la Guardia 5 exigia 4+ snapshots
// ACTIVOS muy recientes para el mercado exacto, algo que antes se garantizaba
// en parte con esa escritura extra. Decision explicita del usuario: aceptar
// perder esa proteccion (la unica con evidencia real) a cambio de comandos
// mas rapidos, en vez de mantener la escritura solo para sostenerla.
//
// GUARDIA 4 REACTIVADA el mismo dia, horas despues. El n=0 del analisis
// retrospectivo NO significaba "nunca hace falta" — significaba que la
// guardia ya estaba activa en el pasado y filtraba estos casos ANTES de que
// pudieran generar datos que medir; ausencia de evidencia, no evidencia de
// ausencia. Se confirmo en vivo: con las 5 apagadas, salio un auto-pick real
// (#7781, Santos vs. Cruzeiro, Under 2.5 con marcador 2-0 al 81') que
// GUARDIA_4 existe exactamente para bloquear — un gol mas y el pick pierde
// sin importar cuanto edge tuviera. Las guardias 1, 2, 3 y 5 siguen apagadas.
const GUARDIA_1_ACTIVA = false;
const GUARDIA_2_ACTIVA = false;
const GUARDIA_3_ACTIVA = false;
const GUARDIA_4_ACTIVA = true;
const GUARDIA_5_ACTIVA = false;

function isRejectedBy5Guards(r) {
  if (!r) return false;
  // Si el pick ya está resuelto o guardado (win/loss/push), no evaluar ventana live histórica
  if (r.result && ['win', 'loss', 'push'].includes(r.result)) return false;

  const eventId = r.eventId || r.event_id;
  const market = r.market;
  const selection = r.selection;
  if (!eventId || !market || !selection) return false;

  try {
    // ── GUARDIA 5: Mínimo 4 Snapshots Activos Muestreados ──
    const allSnaps = db.prepare(`
      SELECT id, ts, score, odd_decimal, suspended
      FROM snapshots
      WHERE event_id = ? AND market = ? AND selection = ?
      ORDER BY ts DESC
      LIMIT 20
    `).all(eventId, market, selection);

    const activeSnaps = allSnaps.filter(s => s.suspended === 0);
    if (GUARDIA_5_ACTIVA && activeSnaps.length < 4) {
      return true; // RECHAZADO: Mercado inmaduro (<4 snapshots activos)
    }

    // ── GUARDIA 2: Silencio de Feed (Latencia > 15s) — DESACTIVADA ──
    // Apagada el 2026-09-12 tras el analisis retrospectivo sobre el grupo de
    // control: de 1300 candidatos liquidados que esta guardia habria
    // bloqueado (brecha >15s, ya usando r.ts del batch en vez de Date.now()
    // — ver GUARDIA_2_ACTIVA mas abajo para el porque de ese cambio previo),
    // el resultado real fue 72.0% WR y +7.1% ROI — MEJOR que el 70.6% WR /
    // +2.7% ROI de los picks que si se emiten. La guardia estaba filtrando
    // candidatos de igual o mejor calidad que los que ya se apuestan, no
    // protegiendo de nada. El codigo se deja intacto (no se borra) por si el
    // patron cambia y hace falta revisarla con una muestra fresca —
    // reactivar es solo volver GUARDIA_2_ACTIVA a true.
    if (GUARDIA_2_ACTIVA) {
      // "Ahora" es el ts del propio BATCH (r.ts, sellado una sola vez por
      // normalize() al momento de recibir el feed — antes de cualquier
      // escritura a la BD), no Date.now(). Con Date.now() esta guardia no
      // medía silencio del FEED sino latencia de NUESTRO pipeline: saveSnapshot
      // puede tardar decenas de segundos a veces (contención de la BD,
      // documentada aparte), y para cuando el scoring corre sobre ese mismo
      // ciclo, Date.now() ya está bien por delante del ts real del snapshot —
      // aunque el dato en si siga fresco. Encontrado el 2026-09-12: un pick con
      // 74% de confianza y +10.7% de edge (Storhamar vs. Frolunda) rechazado
      // por "silencio de feed" con una brecha real de 115s, toda ella tiempo de
      // escritura, no de mercado.
      const ahora = r.ts ? new Date(r.ts).getTime() : Date.now();
      const lastSnapTs = new Date(activeSnaps[0].ts).getTime();
      const elapsedSec = (ahora - lastSnapTs) / 1000;
      if (elapsedSec > 15) {
        return true; // RECHAZADO: Silencio sospechoso de feed (>15s sin update)
      }
    }

    // "Ahora" para las ventanas de tiempo de las guardias 1 y 3: el ts del
    // propio batch (r.ts), no Date.now() — mismo motivo que la Guardia 2 (ver
    // arriba): evaluar contra el reloj real mide cuanto tardo NUESTRO
    // pipeline en llegar a puntuar esta fila, no que tan reciente es el dato.
    const ahoraGuardas = r.ts ? new Date(r.ts).getTime() : Date.now();

    // ── GUARDIA 1: Calma de Marcador (Score Shock Guard 90s) — DESACTIVADA ──
    // Analisis del 2026-09-12: n=30, WR 70.4%, ROI +2.5% — practicamente
    // identico al 70.6%/+2.7% de los picks que si se emiten. No demuestra
    // proteger de nada por encima del ruido normal.
    if (GUARDIA_1_ACTIVA) {
      const scoreSince = new Date(ahoraGuardas - 90 * 1000).toISOString();
      const scoreSnaps = db.prepare(`
        SELECT score, ts
        FROM snapshots
        WHERE event_id = ? AND ts >= ? AND ts <= ?
        ORDER BY ts ASC
      `).all(eventId, scoreSince, r.ts || new Date(ahoraGuardas).toISOString());

      if (scoreSnaps.length > 1) {
        const firstScore = scoreSnaps[0].score;
        const lastScore = scoreSnaps.at(-1).score;
        if (firstScore && lastScore && firstScore !== lastScore) {
          return true; // RECHAZADO: Hubo cambio de marcador en los últimos 90s
        }
      }
    }

    // ── GUARDIA 3: Estabilidad de Línea (Ventana 60s) — DESACTIVADA ──
    // Analisis del 2026-09-12: n=12, WR 50%, ROI -26.1% — la señal mas
    // fuerte de las 4, pero la muestra es demasiado chica (12 casos) para
    // confiar. Se apaga hasta acumular mas datos y poder revisarla en serio.
    if (GUARDIA_3_ACTIVA) {
      const windowSince = new Date(ahoraGuardas - 60 * 1000).toISOString();
      const windowSnaps = db.prepare(`
        SELECT odd_decimal, suspended, ts
        FROM snapshots
        WHERE event_id = ? AND market = ? AND selection = ? AND ts >= ? AND ts <= ?
        ORDER BY ts ASC
      `).all(eventId, market, selection, windowSince, r.ts || new Date(ahoraGuardas).toISOString());

      if (windowSnaps.some(s => s.suspended === 1)) {
        return true; // RECHAZADO: Hubo suspensión en la ventana de 60s
      }

      const currentOdd = r.oddDecimal || r.odd_decimal;
      const windowOdds = windowSnaps.filter(s => s.odd_decimal > 0).map(s => s.odd_decimal);
      if (currentOdd && windowOdds.length > 0) {
        const minOdd = Math.min(...windowOdds);
        if (minOdd > 0 && (currentOdd - minOdd) / minOdd > 0.10) {
          return true; // RECHAZADO: Cuota subió >10% en el último minuto
        }
      }
    }

    // ── GUARDIA 4: Colchón de Margen Seguro (Safe Margin Buffer) — REACTIVADA ──
    // Se apago junto con las demas el 2026-09-12 por n=0 en el analisis
    // retrospectivo (nunca fue la causa registrada de un rechazo), pero eso
    // media ausencia de datos, no ausencia de utilidad: con las 5 apagadas
    // salio un auto-pick real (#7781, Under 2.5 con 2-0 al minuto 81 — un gol
    // mas y pierde sin importar el edge) que es exactamente el patron que
    // esta guardia existe para bloquear. Reactivada el mismo dia, horas
    // despues, tras verlo en vivo.
    if (GUARDIA_4_ACTIVA) {
      const parsed = parsePick(r);
      if (parsed && parsed.type === 'total' && !parsed.over && parsed.line !== undefined) {
        const currentScore = r.score || (activeSnaps.length > 0 ? activeSnaps[0].score : null);
        if (currentScore) {
          const parts = currentScore.split('-').map(Number);
          if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
            const totalGoals = parts[0] + parts[1];
            if (totalGoals >= parsed.line - 0.5) {
              return true; // RECHAZADO: Colchón de goles agotado (ej: 2 goles en Under 2.5)
            }
          }
        }
      }
    }

  } catch (e) {
    // No vetar si falla la consulta por bloqueo puntual
  }

  return false;
}

// Alias para mantener compatibilidad
function isSuspensionOrInstabilityInWindow(r, windowSeconds = 60) {
  return isRejectedBy5Guards(r);
}

// Las puertas que se aplican DESPUÉS de puntuar, en orden. Se declaran una sola
// vez porque las consumen dos caminos — rankPicks (producción) y auditRejections
// (el grupo de control). Si divergieran, el control quedaría mal etiquetado y
// entrenaríamos contra una frontera que el bot no usa, que es peor que no tener
// control ninguno.
const POST_SCORE_GATES = [
  ['incierto', (r) => !isUncertain(r)],
  ['over_bloqueado', (r) => !isBlockedOver(r)],
  ['mercado_bloqueado', (r) => !isBlockedMarket(r)],
  ['guardas5', (r) => !isRejectedBy5Guards(r)],
  ['firewall', (r) => !isFirewallBlocked(r)],
  ['min_conf', (r, o) => { const th = minConfFor(r, o.minConf); return th <= 0 || r.conf >= th; }],
  ['min_edge', (r, o) => { const th = edgeThresholdFor(r, o.minEdge); return th <= 0 || r.edge >= th; }],
  // TECHO DE EDGE (2026-09-12). Analisis retrospectivo sobre 4156 picks
  // liquidados: el edge NO ordena de forma monotona — la banda 2-6% rinde
  // mejor que cualquier otra (+5.9% ROI en dias ocupados), y la cola >20%
  // pierde dinero en TODOS los regimenes de volumen (dias ocupados -0.7%
  // ROI n=292; dias flojos -30.6% ROI n=5). Un edge enorme casi siempre
  // significa que el modelo discrepa mucho del mercado, y en promedio el
  // mercado tiene razon. Backtest de dos alternativas: techo fijo en 20% vs
  // techo escalado por volumen del dia — el fijo gano en ganancia total
  // (176.0u vs 156.6u) por no sacrificar los picks buenos de edge 10-20% en
  // dias flojos, que el escalado bloqueaba igual que en dias ocupados.
  // Decision explicita del usuario: techo fijo, no escalado.
  ['max_edge', (r, o) => { const cap = o.maxEdge ?? Number(process.env.MAX_EDGE ?? 0.20); return cap <= 0 || r.edge < cap; }],
  // VETO DEL MODELO (2026-08-19). El modelo aprendido NO sustituye al
  // heurístico: sólo puede QUITAR picks que el heurístico habría emitido, nunca
  // añadir.
  //
  // Por qué así y no MODEL_MODE=learned. La ventaja medida (+0.0044 de Brier,
  // bootstrap P=95.4%) se midió sobre `origin='picks'` — o sea CONDICIONADA a
  // la selección del heurístico. Si el modelo pasara a decidir `conf`,
  // cambiaría la población emitida (`conf` alimenta MIN_CONF y
  // edge = conf × momio − 1) y empezaría a puntuar jugadas de una zona donde no
  // hay ninguna validación. El veto se queda DENTRO de la población medida, que
  // es la única sobre la que sabemos algo.
  //
  // Va la ÚLTIMA de las puertas a propósito: así etiqueta exactamente los picks
  // que el bot HABRÍA emitido, y auditRejections los guarda con razón
  // 'modelo_veto'. Eso hace la decisión MEDIBLE — en unas semanas se compara el
  // rendimiento de lo vetado contra lo emitido y se sabe si acertó, en vez de
  // discutirlo.
  //
  // Falla ABIERTO: sin conf_learned (MODEL_MODE=heuristic, model.json ausente o
  // adopted:false) la puerta deja pasar. Un modelo que desaparece no puede
  // dejar al bot sin emitir.
  ['modelo_veto', (r) => !modelVetoActivo() || r.confLearned == null || r.confLearned >= modelVetoMinConf()],
];

// Se leen en cada llamada, no al cargar el módulo: los tests cambian el entorno
// en caliente con withEnv, y una constante congelada al arranque los haría
// mentir.
const modelVetoActivo = () => process.env.MODEL_VETO === '1';
const modelVetoMinConf = () =>
  Number(process.env.MODEL_VETO_MIN_CONF || process.env.MIN_CONF || 0.70);

// Filtros previos al scoring. Separados a propósito: rechazan por razones
// estructurales (suspendido, deporte excluido, momio fuera de rango) y no
// producen un control interesante — nunca habrían sido apuestas plausibles.
// Tope de cuota para EMITIR. Era 3 hardcodeado en cada funcion; ahora es
// configurable porque es una palanca medida, no una constante.
//
// 2026-08-27, sobre 2.973 picks liquidados: el tramo 2.20+ tiene un margen
// sobre el equilibrio de +0.4pp (el resto del sistema esta entre +2.3 y +4.1)
// y un ROI de -21.5%. Cortarlo sube WR y ROI a la vez:
//   WR  70.53% -> 71.57%   ROI 3.69% -> 4.45%
//   IC95% de la diferencia de ROI [0.06, 1.48], P(mejor)=98.4%
// Replicado fuera de muestra: el tramo rinde -30.1% en la primera mitad de la
// serie y -25.2% en la segunda, con 26% de acierto en ambas.
//
// OJO: auditRejections NO usa este tope, usa 3 fijo. Es deliberado — el grupo
// de control tiene que seguir observando la banda excluida, o esta decision
// deja de ser medible y reversible.
const PICK_MAX_ODDS = Number(process.env.PICK_MAX_ODDS || 3);

function preScoreFilter(rows, excl, minOdds, maxOdds) {
  return rows
    .filter(r => !r.suspended)
    .filter(r => !isExcluded(r.sport, excl))
    .filter(r => r.oddDecimal >= minOdds && r.oddDecimal <= maxOdds);
}

/**
 * Puntua UNA VEZ el conjunto de candidatos, para que los consumidores del ciclo
 * lo compartan en vez de repetir el trabajo.
 *
 * El ciclo del sampler llama a auditRejections, safestPicks y modelPicks, y
 * cada uno puntuaba TODAS las filas por su cuenta: tres pasadas identicas.
 * Medido el 2026-08-28 con ~2.000 filas por ciclo, eran ~43 s de CPU
 * BLOQUEANTE por ciclo, y Node es de un solo hilo: mientras dura, el poll de
 * Telegram no responde.
 *
 * El rango de cuota es el MAS ANCHO de todos los consumidores a proposito
 * (auditRejections usa 3.0 y el resto PICK_MAX_ODDS=2.2). Lo compartido tiene
 * que ser un SUPERCONJUNTO: cada consumidor vuelve a filtrar por el suyo.
 * Lo mismo con el filtro de e-sports, que solo aplica autoPicks.
 */
function scoreCandidates(rows, { minOdds = Number(process.env.MIN_ODDS || 1.35),
                                 maxOdds = Math.max(PICK_MAX_ODDS, 3) } = {}) {
  const excl = excludedSports();
  return preScoreFilter(rows, excl, minOdds, maxOdds).map(r => ({ ...r, ...scoreRow(r) }));
}

// Reaprovecha `scored` si viene; si no, puntua. Cada consumidor acota por SU
// rango de cuota, que puede ser mas estrecho que el del conjunto compartido.
function tomar(rows, scored, minOdds, maxOdds) {
  const base = scored || scoreCandidates(rows, { minOdds, maxOdds });
  return base.filter(r => r.oddDecimal >= minOdds && r.oddDecimal <= maxOdds);
}

function rankPicks(rows, { minOdds = Number(process.env.MIN_ODDS || 1.35), maxOdds = PICK_MAX_ODDS, minEdge = 0, minConf = 0, n = 3, scored = null } = {}) {
  const seen = new Set();
  const opts = { minConf, minEdge };
  let out = tomar(rows, scored, minOdds, maxOdds);
  for (const [, ok] of POST_SCORE_GATES) out = out.filter(r => ok(r, opts));
  return out
    .sort((a, b) => b.conf - a.conf)
    .filter(r => {
      if (seen.has(r.eventId)) return false;
      seen.add(r.eventId);
      return true;
    })
    .slice(0, n);
}

/**
 * Los picks que emitiria el MODELO aprendido si el decidiera (MODEL_MODE=learned),
 * SIN emitirlos de verdad. Sirve para poder comparar los dos decisores sobre la
 * misma realidad en vez de discutirlo.
 *
 * Decide con conf_learned y con el edge RECALCULADO a partir de ella
 * (edge = conf_learned x momio - 1), porque asi es exactamente como se
 * comportaria learned: `conf` alimenta las dos puertas de emision.
 *
 * Pero pasa por LAS MISMAS puertas y el mismo firewall que la emision real. Si
 * le quitaramos las guardas, lo que midiriamos seria "modelo sin firewall"
 * contra "heuristico con firewall", que no es la pregunta.
 *
 * Devuelve tambien `tambienHeuristico`: si el heuristico habria emitido esa
 * misma jugada. Es la separacion que importa — donde ambos coinciden no hay
 * nada que aprender, y donde SOLO lo ve el modelo esta la poblacion sin validar.
 */
function modelPicks(rows, { minOdds = Number(process.env.MIN_ODDS || 1.35), maxOdds = PICK_MAX_ODDS,
                            minEdge = 0, minConf = 0, n = 3, scored = null,
                            // Techo de edge PROPIO del modelo, distinto del MAX_EDGE del
                            // heuristico. Backtest del 2026-09-16 sobre 4057 picks learned
                            // liquidados: el bucket >=20% de edge_learned rinde +28.2% (n=8,
                            // muestra chica) y 15-20% +9.4% — nada parecido al colapso que sí
                            // se ve en el heuristico (>=20% ahi: WR 36%, ROI -16.6%). Aplicarle
                            // el mismo MAX_EDGE=0.08 le cortaria justo las colas que en este
                            // modelo SI rinden. Pedido explicito del usuario: separar los topes.
                            maxEdge = Number(process.env.MAX_EDGE_LEARNED ?? process.env.MAX_EDGE ?? 0.20) } = {}) {
  const optsHeuristico = { minConf, minEdge }; // sin override: representa lo que el heuristico REAL emitiria
  const optsModelo = { minConf, minEdge, maxEdge };
  const seen = new Set();
  const puntuadas = tomar(rows, scored, minOdds, maxOdds)
    .filter(r => r.confLearned !== null && r.confLearned !== undefined);

  // Que habria emitido el heuristico, para marcar las coincidencias.
  const delHeuristico = new Set(
    puntuadas.filter(r => POST_SCORE_GATES.every(([, ok]) => ok(r, optsHeuristico)))
             .map(r => `${r.eventId}|${r.market}|${r.selection}`));

  return puntuadas
    // La fila que ven las puertas lleva la conf y el edge DEL MODELO.
    .map(r => ({ ...r, conf: r.confLearned, edge: r.confLearned * r.oddDecimal - 1 }))
    .filter(r => POST_SCORE_GATES.every(([, ok]) => ok(r, optsModelo)))
    // Se ORDENA por el crudo, no por conf. La calibración isotónica aplasta el
    // 94.8% de lo que pasa la puerta en dos peldaños identicos (0.7025/0.7034),
    // asi que ordenar por conf era ordenar por nada: los 3 que salian eran los
    // 3 primeros que devolvia el filtro. El crudo conserva el orden fino.
    // La PUERTA sigue usando el calibrado, que es lo unico interpretable como
    // probabilidad; el crudo solo desempata dentro del peldaño.
    .sort((a, b) => (b.confLearnedRaw ?? b.conf) - (a.confLearnedRaw ?? a.conf))
    .filter(r => {
      if (seen.has(r.eventId)) return false;
      seen.add(r.eventId);
      return true;
    })
    .slice(0, n)
    .map(r => ({ ...r, tambienHeuristico: delHeuristico.has(`${r.eventId}|${r.market}|${r.selection}`) ? 1 : 0 }));
}

/**
 * MODEL_RESCUE — el experimento inverso al veto.
 *
 * El veto deja que el modelo QUITE picks que el heuristico emitiria. Esto deja
 * que RESCATE picks que el heuristico tira, y solo por una razon concreta:
 * fallar `min_conf` y nada mas.
 *
 * Por que esta poblacion y no otra. Medido el 2026-08-26 con walk-forward
 * (entrenar antes del 20-ago, puntuar despues; bootstrap por EVENTO porque el
 * control tiene 2.06 filas por partido):
 *
 *   rechazados por min_conf, top 30% del modelo:  n=1679 (1391 ev)  ROI  +7.18%  IC95% [+2.81, +11.51]
 *   rechazados por min_conf, resto 70%:           n=3918 (2244 ev)  ROI -13.15%  IC95% [-16.53,  -9.69]
 *   picks emitidos, misma ventana (referencia):   n= 314 ( 312 ev)  ROI  +6.96%  IC95% [-0.48, +14.37]
 *
 * O sea: el heuristico esta tirando una bolsa que el modelo sabe partir, y su
 * mejor tercio rinde como lo que si emitimos, con mucho mas volumen.
 *
 * PERO ese numero es OBSERVACIONAL: nadie aposto esos picks, no pasaron por el
 * escalonado ni por el tope horario, y su precio es el del muestreo. Esta
 * funcion existe para convertirlo en un experimento de verdad, con dinero, y
 * por eso los picks salen MARCADOS (source='rescue') y con stake minimo.
 *
 * Exige fallar EXACTAMENTE una puerta, igual que auditRejections: un candidato
 * que ademas choca con el firewall o con min_edge no pertenece a la poblacion
 * medida y rescatarlo seria extrapolar.
 *
 * OJO AL UMBRAL. `minLearned` es un cuantil (el p70) de la distribucion de
 * conf_learned del modelo EN PRODUCCION — 0.5332 para el modelo del 2026-08-25.
 * Cada reentrenamiento mueve esa escala y el umbral deja de ser el p70. Hay que
 * recalcularlo al adoptar un modelo nuevo; si no, el "top 30%" pasa a ser otra
 * cosa sin avisar.
 */
function rescuePicks(rows, { minOdds = Number(process.env.MIN_ODDS || 1.35), maxOdds = PICK_MAX_ODDS,
                             minEdge = 0, minConf = 0, minLearned = 0, n = 2, scored = null } = {}) {
  if (minLearned <= 0) return [];
  const opts = { minConf, minEdge };
  const out = [];
  for (const r of tomar(rows, scored, minOdds, maxOdds)) {
    if (r.confLearned == null || r.confLearned < minLearned) continue;
    const failed = POST_SCORE_GATES.filter(([, ok]) => !ok(r, opts));
    if (failed.length !== 1 || failed[0][0] !== 'min_conf') continue;
    out.push(r);
  }
  // MUESTREO ALEATORIO, no "los mejores". Es contraintuitivo y es deliberado.
  //
  // El +7.18% medido describe el TOP 30% ENTERO, y las filas que lo midieron
  // salieron del muestreo aleatorio de auditRejections. Quedarse con los 2 de
  // mayor score por ciclo no reproduce esa poblacion: es una nata mucho mas
  // fina, del orden del decil superior. Y el decil superior rinde PEOR — el ROI
  // no es monotono en el score (medido 2026-08-26, n=5597 fuera de muestra):
  //
  //   decil 9 (el mas alto)  WR 68.2%  ROI  +3.84%
  //   decil 8                WR 62.7%  ROI  +6.41%
  //   decil 7                WR 58.9%  ROI +11.30%
  //
  // El modelo ordena la PROBABILIDAD; el dinero esta donde esa probabilidad no
  // esta del todo en el precio. Descremar el top convertiria el experimento en
  // una apuesta por el tramo peor pagado, y ademas mediria algo distinto de lo
  // que se quiso validar.
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  const seen = new Set();
  return out
    .filter(r => {
      if (seen.has(r.eventId)) return false;
      seen.add(r.eventId);
      return true;
    })
    .slice(0, n);
}

/**
 * Grupo de control para entrenar: candidatos que se puntuaron pero NO se
 * emitieron, etiquetados con la puerta que los frenó.
 *
 * Solo devuelve los que fallan UNA sola puerta ("por poco"). Es deliberado por
 * dos razones: (1) son los informativos — un candidato que falla seis puertas no
 * enseña dónde está la frontera, solo que está lejos; (2) el universo son ~74k
 * combinaciones únicas cada 10 min y guardarlas todas sepultaría una BD que ya
 * crece de más.
 *
 * No toca el camino de producción: se llama aparte, sobre las mismas filas.
 */
// maxOdds = 3 FIJO, no PICK_MAX_ODDS: ver el comentario de PICK_MAX_ODDS.
function auditRejections(rows, { minOdds = Number(process.env.MIN_ODDS || 1.35), maxOdds = 3, minEdge = 0, minConf = 0, limit = 10, scored = null } = {}) {
  const opts = { minConf, minEdge };
  const out = [];
  for (const r of tomar(rows, scored, minOdds, maxOdds)) {
    const failed = POST_SCORE_GATES.filter(([, ok]) => !ok(r, opts));
    if (failed.length !== 1) continue; // ni emitido (0) ni lejano (>1)
    out.push({ row: r, rule: failed[0][0] });
  }
  // Muestreo aleatorio: quedarse con los primeros sesgaría hacia los deportes
  // que el feed devuelve antes.
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out.slice(0, limit);
}

// Del universo de jugadas en vivo, devuelve las N con mayor índice de confianza.
// MIN_EDGE (.env, default 0 = desactivado) filtra por edge estimado mínimo;
// MIN_CONF (.env, default 0 = desactivado) exige un piso de confianza — sube
// la tasa de acierto a costa de volumen. Ambos reducen la emisión.
function safestPicks(rows, n = 3, scored = null) {
  return rankPicks(rows, {
    minOdds: Number(process.env.MIN_ODDS || 1.35),
    minEdge: Number(process.env.MIN_EDGE || 0.03),
    minConf: Number(process.env.MIN_CONF || 0.70),
    n,
    scored,
  });
}

// Pick dorado: UNA jugada con la mejor combinación seguridad/pago.
// Piso de confianza (GOLDEN_MIN_CONF) y de momio (GOLDEN_MIN_ODDS: la banda
// <1.10 demostró ROI muy negativo con datos reales), y de ahí maximiza el
// edge estimado. Si ningún candidato tiene edge positivo, no hay pick dorado.
function goldenPick(rows, {
  minConf = Number(process.env.GOLDEN_MIN_CONF || 0.70),
  minOdds = Number(process.env.GOLDEN_MIN_ODDS || 1.15),
  maxOdds = PICK_MAX_ODDS,
  minEdge = Math.max(Number(process.env.MIN_EDGE || 0), 0),
  // Mismo techo de edge que autoPicks (ver POST_SCORE_GATES 'max_edge'), y con
  // mas razon aqui: goldenPick ordena por MAYOR edge y se queda con el
  // primero, asi que sin este techo el "pick dorado" seria justo el sesgo que
  // el analisis retrospectivo del 2026-09-12 encontro — la cola de edge >20%
  // pierde dinero en todos los regimenes de volumen. Extendido a /golden y
  // /parlay a pedido explicito del usuario, mismo dia.
  maxEdge = Number(process.env.MAX_EDGE ?? 0.20),
} = {}) {
  const excl = excludedSports();
  const candidates = rows
    .filter(r => !r.suspended)
    .filter(r => !isExcluded(r.sport, excl))
    .filter(r => r.oddDecimal >= minOdds && r.oddDecimal <= maxOdds)
    .map(r => ({ ...r, ...scoreRow(r) }))
    .filter(r => !isUncertain(r))
    .filter(r => !isBlockedOver(r))
    .filter(r => !isBlockedMarket(r))
    .filter(r => !isRejectedBy5Guards(r))
    .filter(r => !isFirewallBlocked(r))
    .filter(r => r.conf >= minConf && r.edge > 0 && r.edge >= minEdge && (maxEdge <= 0 || r.edge < maxEdge))
    .sort((a, b) => b.edge - a.edge);
  return candidates[0] || null;
}

function parlayCombos(rows, {
  minConf = Number(process.env.PARLAY_MIN_CONF || 0.65),
  minOdds = Number(process.env.PARLAY_MIN_ODDS || 1.08),
  maxOdds = Number(process.env.PARLAY_MAX_ODDS || 1.45),
  minEdge = Math.max(Number(process.env.MIN_EDGE || 0), 0.01),
  // Mismo techo de edge que autoPicks y goldenPick (ver comentario junto a
  // goldenPick) — una pata de parlay con edge >20% tiene el mismo problema
  // que un pick suelto: casi siempre es el modelo discrepando con el mercado,
  // no valor real.
  maxEdge = Number(process.env.MAX_EDGE ?? 0.20),
} = {}) {
  const excl = excludedSports();
  const candidates = rows
    .filter(r => !r.suspended)
    .filter(r => !isExcluded(r.sport, excl))
    .filter(r => r.oddDecimal >= minOdds && r.oddDecimal <= maxOdds)
    .map(r => ({ ...r, ...scoreRow(r) }))
    .filter(r => !isUncertain(r))
    .filter(r => !isBlockedOver(r))
    .filter(r => !isBlockedMarket(r))
    .filter(r => r.conf >= minConf && r.edge > 0 && r.edge >= minEdge && (maxEdge <= 0 || r.edge < maxEdge));

  const byEvent = new Map();
  for (const c of candidates) {
    if (!byEvent.has(c.eventId) || c.conf > byEvent.get(c.eventId).conf) {
      byEvent.set(c.eventId, c);
    }
  }
  const pool = Array.from(byEvent.values()).sort((a, b) => b.conf - a.conf);
  if (pool.length < 2) return [];

  const combos = [];
  for (let i = 0; i < pool.length; i++) {
    for (let j = i + 1; j < pool.length; j++) {
      const legs = [pool[i], pool[j]];
      const totalOdd = legs.reduce((s, p) => s * p.oddDecimal, 1);
      const rawProb = legs.reduce((s, p) => s * p.conf, 1);
      const adjProb = rawProb * 0.97;
      const edge = adjProb * totalOdd - 1;
      if (edge > 0) {
        combos.push({ legs, totalOdd, rawProb, adjProb, edge, legCount: 2 });
      }
    }
  }

  if (pool.length >= 3) {
    for (let i = 0; i < pool.length; i++) {
      for (let j = i + 1; j < pool.length; j++) {
        for (let k = j + 1; k < pool.length; k++) {
          const legs = [pool[i], pool[j], pool[k]];
          const totalOdd = legs.reduce((s, p) => s * p.oddDecimal, 1);
          const rawProb = legs.reduce((s, p) => s * p.conf, 1);
          const adjProb = rawProb * Math.pow(0.97, 2);
          const edge = adjProb * totalOdd - 1;
          if (edge > 0) {
            combos.push({ legs, totalOdd, rawProb, adjProb, edge, legCount: 3 });
          }
        }
      }
    }
  }

  return combos.sort((a, b) => b.edge - a.edge);
}

module.exports = {
  scoreRow, safestPicks, rankPicks, auditRejections, goldenPick, parlayCombos, aperturaFactor, lineTrend, avanceForModel, SCORE_VERSION,
  isExcluded, excludedSports, baseballProgress, isOverPick, isBlockedOver, isBlockedMarket, isUncertain, isFootballUnder, isLowLineFootballUnder, edgeThresholdFor, minConfFor,
  isSuspensionOrInstabilityInWindow, isRejectedBy5Guards, computeStructuralDrawSignal, DRAW_SIGNAL_DEFAULTS,
  recentScoreChange, isDrawSelection, readSpike, SPIKE_DEFAULTS,
  computeStake, kellyFraction, tierStake, STAKE_MODE,
  STAKE_TIER_BASE, STAKE_TIER_MID, STAKE_TIER_HIGH,
  POST_SCORE_GATES, modelPicks, rescuePicks, scoreCandidates,
};

