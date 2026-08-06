const { db } = require('./db');
const { parsePick, situationFactor } = require('./markets');
const { score: modelScore } = require('./model');

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
function computeStake(conf, oddDecimal, mode = STAKE_MODE, isHighConviction = false) {
  if (mode === 'flat') return 1;
  const f = kellyFraction(conf, oddDecimal);
  let frac = mode === 'kelly' ? f : f / 2; // half_kelly es el default
  if (isHighConviction) frac *= 1.25; // Sharp / High Conviction boost (+25% stake)
  const units = Math.round(frac * STAKE_UNIT_SCALE * 10) / 10;
  let dynamicMax = STAKE_MAX;
  if (oddDecimal >= 1.70) dynamicMax = 2.5;
  else if (oddDecimal >= 1.50) dynamicMax = 3.5;
  return Math.min(dynamicMax, Math.max(STAKE_MIN, units));
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

  const openRow = openStmt.get(row.eventId, row.market, row.selection);
  const openingOdd = openRow ? openRow.odd_decimal : null;
  const fApertura = aperturaFactor(openingOdd, row.oddDecimal);

  // El conf mostrado depende de MODEL_MODE (src/model.js); el heurístico
  // 0.35/0.30/0.20/0.15 sigue vivo como fallback y para el modo shadow.
  // f_apertura solo la consume el modelo aprendido (los pesos fijos no cambian).
  //
  // Para selecciones "Más de X" (Over) cuya línea no ha sido alcanzada aún,
  // la fracción de tiempo transcurrido (progress -> 1) reduce el tiempo disponible
  // para anotar, por lo que fAvance efectivo es (1 - progress).
  let fAvance = progress;
  if (parsed && parsed.type === 'total') {
    const mScore = (row.score || '').match(/^(\d+)-(\d+)$/);
    const totalCurrent = mScore ? Number(mScore[1]) + Number(mScore[2]) : 0;
    if (parsed.over) {
      if (parsed.line !== undefined && totalCurrent < parsed.line) {
        fAvance = 1 - progress;
      }
    } else {
      // Para "Menos de X" (Under), si estamos en el tramo final (progress >= 0.75)
      // y solo queda 1 gol de margen (line - totalCurrent <= 1.0), se aplica un factor
      // de volatilidad tardía para ajustar la brecha de goles de último minuto.
      if (parsed.line !== undefined && totalCurrent < parsed.line && (parsed.line - totalCurrent) <= 1.0 && progress >= 0.75) {
        const lateRiskFactor = 1 - (progress - 0.75) * 0.4;
        fAvance = progress * lateRiskFactor;
      }
    }
  }

  const features = {
    f_prob_justa: base, f_avance: fAvance, f_situacion: scoreFactor,
    f_linea: lineFactor, f_apertura: fApertura,
  };
  const { conf, confHeuristic, confLearned } = modelScore(features, row.sport);
  // edge estimado al momento de emitir: valor esperado por unidad apostada
  const edge = conf * row.oddDecimal - 1;
  const isHighConviction = ((confLearned || conf) >= 0.80) &&
    (row.sharpMatch === 'matched' || row.sharp_match === 'matched' || (edge >= 0.15 && row.oddDecimal >= 1.35));
  const stake = computeStake(conf, row.oddDecimal, STAKE_MODE, isHighConviction);
  return {
    conf, confHeuristic, confLearned, edge, stake, stakeMode: STAKE_MODE, isHighConviction,
    base, progress, scoreFactor, lineFactor, lineDelta, linePoints: points,
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

// DNB (Empate No Acción) exige mayor convención (conf >= 0.75 y edge >= 0.05)
function isWeakDNB(r) {
  const m = (r.market || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  if (m.includes('empate no accion') || m.includes('draw no bet') || m.includes('dnb')) {
    if (r.conf !== undefined && r.conf < 0.75) return true;
    if (r.edge !== undefined && r.edge < 0.05) return true;
  }
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

  // Veto a selecciones directas de "Empate" o "Draw"
  if (sel === 'empate' || sel === 'draw') {
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

function rankPicks(rows, { minOdds = Number(process.env.MIN_ODDS || 1.35), maxOdds = 3, minEdge = 0, minConf = 0, n = 3 } = {}) {
  const seen = new Set();
  const excl = excludedSports();
  return rows
    .filter(r => !r.suspended)
    .filter(r => !isExcluded(r.sport, excl))
    .filter(r => r.oddDecimal >= minOdds && r.oddDecimal <= maxOdds)
    .map(r => ({ ...r, ...scoreRow(r) }))
    .filter(r => !isUncertain(r))
    .filter(r => !isBlockedOver(r))
    .filter(r => !isBlockedMarket(r))
    .filter(r => minConf <= 0 || r.conf >= minConf)
    .filter(r => { const th = edgeThresholdFor(r, minEdge); return th <= 0 || r.edge >= th; })
    .sort((a, b) => b.conf - a.conf)
    .filter(r => {
      if (seen.has(r.eventId)) return false;
      seen.add(r.eventId);
      return true;
    })
    .slice(0, n);
}

// Del universo de jugadas en vivo, devuelve las N con mayor índice de confianza.
// MIN_EDGE (.env, default 0 = desactivado) filtra por edge estimado mínimo;
// MIN_CONF (.env, default 0 = desactivado) exige un piso de confianza — sube
// la tasa de acierto a costa de volumen. Ambos reducen la emisión.
function safestPicks(rows, n = 3) {
  return rankPicks(rows, {
    minOdds: Number(process.env.MIN_ODDS || 1.35),
    minEdge: Number(process.env.MIN_EDGE || 0.03),
    minConf: Number(process.env.MIN_CONF || 0.70),
    n,
  });
}

// Pick dorado: UNA jugada con la mejor combinación seguridad/pago.
// Piso de confianza (GOLDEN_MIN_CONF) y de momio (GOLDEN_MIN_ODDS: la banda
// <1.10 demostró ROI muy negativo con datos reales), y de ahí maximiza el
// edge estimado. Si ningún candidato tiene edge positivo, no hay pick dorado.
function goldenPick(rows, {
  minConf = Number(process.env.GOLDEN_MIN_CONF || 0.70),
  minOdds = Number(process.env.GOLDEN_MIN_ODDS || 1.15),
  maxOdds = 3,
  minEdge = Math.max(Number(process.env.MIN_EDGE || 0), 0),
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
    .filter(r => r.conf >= minConf && r.edge > 0 && r.edge >= minEdge)
    .sort((a, b) => b.edge - a.edge);
  return candidates[0] || null;
}

function parlayCombos(rows, {
  minConf = Number(process.env.PARLAY_MIN_CONF || 0.65),
  minOdds = Number(process.env.PARLAY_MIN_ODDS || 1.08),
  maxOdds = Number(process.env.PARLAY_MAX_ODDS || 1.45),
  minEdge = Math.max(Number(process.env.MIN_EDGE || 0), 0.01),
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
    .filter(r => r.conf >= minConf && r.edge > 0 && r.edge >= minEdge);

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
  scoreRow, safestPicks, rankPicks, goldenPick, parlayCombos, aperturaFactor, lineTrend, SCORE_VERSION,
  isExcluded, excludedSports, baseballProgress, isOverPick, isBlockedOver, isBlockedMarket, isUncertain, isFootballUnder, edgeThresholdFor,
  computeStake, kellyFraction, STAKE_MODE,
};

