const { getUnsettledPicks, getLastScore, getLastSeen, getClosingOdd, settlePick, setSharpClosing,
        getUnsettledRejected, settleRejected } = require('./db');
const { gradePick, parsePick, decidedResult } = require('./markets');

/**
 * Traduce la salida de gradePick al valor que se persiste.
 *
 * gradePick devuelve null con DOS significados muy distintos, y `result ||
 * 'unknown'` los colapsaba en uno:
 *   - ANULADA (push): el mercado se entiende pero la apuesta no computa —
 *     empate en Empate No Acción, marcador justo en la línea de un total,
 *     hándicap que queda en cero. El stake se devuelve.
 *   - NO CALIFICABLE: el mercado ni siquiera se puede interpretar ("Quinto
 *     Gol", "Primer gol 1"…), así que no se sabe qué pasó.
 *
 * Medido el 2026-08-09: de 250 picks en 'unknown', 152 eran PUSH (todos
 * empates en Empate No Acción) y solo 97 eran de mercados no parseables. Los
 * 152 quedaban fuera de las métricas etiquetados como si no se supiera el
 * resultado, cuando sí se sabía: se anularon.
 *
 * 'push' ya estaba soportado en el resto del sistema (dedup en confidence.js,
 * ⚪ NULO en telegram.js); simplemente nunca se escribía.
 */
function resultFor(row, finalScore) {
  if (!finalScore) return 'unknown';
  const graded = gradePick(row, finalScore);
  if (graded) return graded;
  // Sin marcador utilizable o mercado ininterpretable: de verdad no se sabe.
  if (!/^\d+-\d+$/.test(String(finalScore)) || !parsePick(row)) return 'unknown';
  return 'push';
}
const { captureClosingForPick } = require('./sharp');

// Escalera de reintentos (minutos desde que el evento desapareció del vivo)
const RETRY_LADDER_MIN = [2, 5, 15];

// event_id -> { firstMissingAt, attempts }
const missing = new Map();

// Altenar no expone un endpoint público de resultados finales
// (verificado 2026-07-17: GetEventDetails devuelve vacío para terminados;
// GetResults/GetEventResult/GetScoreboard no existen). Punto de integración
// listo para cuando haya una fuente oficial.
async function tryOfficialResult(_eventId) {
  return null; // { score: 'a-b' } cuando exista fuente oficial
}

function settleWith(pick, finalScore, source) {
  const row = { market: pick.market, selection: pick.selection, event: pick.event, sport: pick.sport };
  const result = resultFor(row, finalScore);
  const closing = getClosingOdd(pick.event_id, pick.market, pick.selection);
  settlePick(
    pick.id, result, finalScore, source,
    closing ? closing.odd_decimal : null, closing ? closing.ts : null
  );
  console.log(`[settle:${source}] ${pick.event} | ${pick.selection} -> ${result} (${finalScore || 'sin marcador'})`);
}

// Cierre sharp bajo demanda: UNA consulta por pick cuando su evento desaparece
// del feed de Altenar (fin del partido). Si el evento ya salió también del feed
// sharp, se conserva el último momio visto (como mínimo, el de la entrada).
const sharpClosed = new Set(); // pick ids con intento de cierre ya hecho
async function captureSharpClosing(pick) {
  if (!pick.sharp_event_id || sharpClosed.has(pick.id)) return;
  sharpClosed.add(pick.id);
  try {
    const r = await captureClosingForPick(pick);
    if (r) {
      setSharpClosing(pick.id, r.odd, r.marketJson);
      console.log(`[sharp] cierre: ${pick.event} | ${pick.selection} @ ${r.odd}`);
    } else {
      console.log(`[sharp] cierre no disponible (se conserva el último visto): ${pick.event}`);
    }
  } catch (e) {
    console.error(`[sharp] cierre ${pick.event}: ${e.message}`);
  }
}

// Se invoca tras cada muestreo global con el set completo de eventos en vivo.
// Un evento con picks se liquida solo tras agotar la escalera de reintentos,
// para protegerse de desapariciones temporales del feed (suspensiones).
/**
 * Liquidación anticipada: la selección desapareció del feed pero el partido
 * sigue en vivo.
 *
 * Un mercado se cierra cuando queda decidido — un "Menos de 2.5" desaparece en
 * cuanto cae el tercer gol. Antes eso no se aprovechaba: el pick seguía
 * "pendiente" en el Live Radar hasta que terminaba TODO el partido, aunque su
 * suerte ya estuviera echada.
 *
 * Dos guardas, y las dos importan:
 *  1. `decidedResult` solo devuelve algo cuando el desenlace es IRREVERSIBLE
 *     (totales pasados de línea, ambos-marcan ya cumplido). Para ganador o
 *     empate-no-acción devuelve null, porque un 1-0 al 80' no decide nada.
 *  2. Se exige ausencia en AUSENCIAS_MIN ciclos seguidos. Una selección puede
 *     desaparecer un instante por suspensión o por un hueco del feed, y
 *     liquidar con eso sería liquidar por un parpadeo.
 */
const AUSENCIAS_MIN = Number(process.env.EARLY_SETTLE_MISSES || 3);
const ausencias = new Map(); // pickId -> ciclos consecutivos sin ver la selección

function settleDecidedEarly(rows, liveEventIds) {
  const vivos = new Set(rows.map(r => `${r.eventId}|${r.market}|${r.selection}`));
  const scorePorEvento = new Map();
  for (const r of rows) if (r.score) scorePorEvento.set(r.eventId, r.score);

  for (const pick of getUnsettledPicks()) {
    // Si el evento ya no está en vivo, de esto se encarga la escalera normal.
    if (!liveEventIds.has(pick.event_id)) { ausencias.delete(pick.id); continue; }

    if (vivos.has(`${pick.event_id}|${pick.market}|${pick.selection}`)) {
      ausencias.delete(pick.id);
      continue;
    }
    const n = (ausencias.get(pick.id) || 0) + 1;
    ausencias.set(pick.id, n);
    if (n < AUSENCIAS_MIN) continue;

    const score = scorePorEvento.get(pick.event_id);
    if (!score) continue;
    const row = { market: pick.market, selection: pick.selection, event: pick.event, sport: pick.sport };
    const result = decidedResult(row, score);
    if (!result) continue; // aún puede cambiar: se espera al final

    const closing = getClosingOdd(pick.event_id, pick.market, pick.selection);
    settlePick(pick.id, result, score, 'early_decided',
      closing ? closing.odd_decimal : null, closing ? closing.ts : null);
    ausencias.delete(pick.id);
    console.log(`[settle:early] ${pick.event} | ${pick.selection} -> ${result} (${score}, mercado cerrado)`);
  }
}

async function processSettlements(rows) {
  // Acepta las filas en vivo (antes solo el Set de eventos) para poder mirar
  // también si la SELECCIÓN concreta sigue en el feed, no solo el partido.
  const liveRows = Array.isArray(rows) ? rows : [];
  const liveEventIds = Array.isArray(rows) ? new Set(rows.map(r => r.eventId)) : rows;

  settleDecidedEarly(liveRows, liveEventIds);

  for (const pick of getUnsettledPicks()) {
    const id = pick.event_id;
    if (liveEventIds.has(id)) {
      missing.delete(id);
      continue;
    }
    let m = missing.get(id);
    if (!m) {
      // ancla la desaparición al último snapshot real del evento (BD), no al
      // reloj del proceso: así la escalera sobrevive reinicios del bot y un
      // evento que lleva 20 min fuera del feed se liquida de inmediato.
      const lastSeen = getLastSeen(id);
      const firstMissingAt = lastSeen ? Date.parse(lastSeen) : Date.now();
      m = { firstMissingAt, attempts: 0 };
      missing.set(id, m);
      await captureSharpClosing(pick); // única consulta sharp de cierre
      continue;
    }
    const elapsedMin = (Date.now() - m.firstMissingAt) / 60000;
    while (m.attempts < RETRY_LADDER_MIN.length && elapsedMin >= RETRY_LADDER_MIN[m.attempts]) {
      m.attempts++;
      const official = await tryOfficialResult(id);
      if (official && official.score) {
        settleWith(pick, official.score, 'official');
        missing.delete(id);
        break;
      }
      if (m.attempts === RETRY_LADDER_MIN.length) {
        const last = getLastScore(id);
        settleWith(pick, last ? last.score : null, 'last_sample');
        missing.delete(id);
      }
    }
  }
  settleRejectedGroup(liveEventIds);
}

/**
 * Liquida el grupo de control (candidatos rechazados). Sin resultado no sirven
 * de nada: el valor entero de guardarlos es poder decir "esto se descartó Y
 * habría ganado/perdido".
 *
 * Más simple que la escalera de los picks emitidos a propósito: no hay dinero
 * en juego, así que no hace falta protegerse de desapariciones temporales del
 * feed ni consultar cierres sharp. Basta con que el evento ya no esté en vivo y
 * exista un marcador; sin marcador se deja pendiente y se reintenta.
 *
 * Se escribe SIEMPRE que haya marcador, incluidos 'push' y 'unknown'. La
 * versión anterior hacía `if (result)`, y como gradePick devuelve null tanto
 * para las anuladas como para los mercados ininterpretables, esas filas se
 * quedaban pendientes PARA SIEMPRE — y una fila pendiente exime a su evento de
 * la poda de snapshots, así que el conjunto exento crecía sin tope. El
 * entrenamiento ya filtra a win/loss, así que guardar la etiqueta real no
 * contamina nada; lo que contaminaba era inventarse un resultado.
 */
function settleRejectedGroup(liveEventIds) {
  for (const r of getUnsettledRejected()) {
    if (liveEventIds.has(r.event_id)) continue;
    const last = getLastScore(r.event_id);
    if (!last || !last.score) continue;
    const row = { market: r.market, selection: r.selection, event: r.event, sport: r.sport };
    settleRejected(r.id, resultFor(row, last.score), last.score);
  }
}

module.exports = { processSettlements };
