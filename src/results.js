const { getUnsettledPicks, getLastScore, getLastSeen, getClosingOdd, settlePick, setSharpClosing } = require('./db');
const { gradePick } = require('./markets');
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
  const row = { market: pick.market, selection: pick.selection, event: pick.event };
  const result = finalScore ? gradePick(row, finalScore) : null;
  const closing = getClosingOdd(pick.event_id, pick.market, pick.selection);
  settlePick(
    pick.id, result || 'unknown', finalScore, source,
    closing ? closing.odd_decimal : null, closing ? closing.ts : null
  );
  console.log(`[settle:${source}] ${pick.event} | ${pick.selection} -> ${result || 'unknown'} (${finalScore || 'sin marcador'})`);
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
async function processSettlements(liveEventIds) {
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
}

module.exports = { processSettlements };
