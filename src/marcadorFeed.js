// Marcador final "creible" de un partido a partir de NUESTRO feed en vivo
// (tabla snapshots), para los partidos que FotMob no cubre. Solo lectura.
//
// POR QUE NO ES UN MARCADOR OFICIAL. El bot ve el marcador hasta el ultimo ciclo
// antes de que el evento salga del feed de Altenar. Medido el 2026-09-24 contra
// FotMob sobre 97 partidos: coincide en 81%. Los desacuerdos son de dos tipos:
//  (a) el feed dejo de ver el partido ANTES del final (ultima muestra en el
//      minuto 6, 11, 44, 47...): se descartan exigiendo minuto >= 85 en la 2a parte;
//  (b) gol en el descuento, despues de la ultima muestra (91'-94'): no se puede
//      detectar desde el feed. Cambia el resultado 1X2 en ~5% de los casos.
// Por eso el llamador debe marcar estos marcadores como fuente 'feed' y NO
// mezclarlos sin decirlo con los de una fuente oficial.

const MIN_MINUTO_FINAL = 85;
const MIN_TRAS_KICKOFF = 80; // la ultima muestra tuvo que ser al menos 80 min despues del inicio

/**
 * Parsea el live_time de Altenar: "91' — 2ª parte", "44' — 1ª parte",
 * "94' — 2ª Parte Adicional". Devuelve { minuto, parte, adicional } o null.
 */
function parseLiveTime(liveTime) {
  const m = String(liveTime || '').match(/^\s*(\d{1,3})'\s*[—-]\s*(\d)ª\s*parte(\s+adicional)?/i);
  if (!m) return null;
  return { minuto: Number(m[1]), parte: Number(m[2]), adicional: !!m[3] };
}

/**
 * ¿Sirve esta ultima muestra como marcador final? Exige: 2a parte de tiempo
 * regular (no prorroga), minuto >= 85, marcador "a-b" y que la muestra sea al
 * menos 80 min posterior al kickoff. Pura.
 * ultima: { ts, score, live_time }; kickoffMs: inicio del partido.
 */
function marcadorFinalCreible(ultima, kickoffMs) {
  if (!ultima || !ultima.score) return null;
  const m = String(ultima.score).match(/^(\d+)-(\d+)$/);
  if (!m) return null;
  const t = parseLiveTime(ultima.live_time);
  if (!t || t.adicional || t.parte !== 2 || t.minuto < MIN_MINUTO_FINAL) return null;
  const tsMs = Date.parse(ultima.ts);
  if (!Number.isFinite(tsMs) || !Number.isFinite(kickoffMs)) return null;
  if ((tsMs - kickoffMs) / 60000 < MIN_TRAS_KICKOFF) return null;
  return { gl: Number(m[1]), gv: Number(m[2]) };
}

// Ultima muestra con marcador de un evento (usa idx_snapshots_event: rapido).
function ultimaMuestraConMarcador(db, eventId) {
  return db.prepare('SELECT ts, score, live_time FROM snapshots WHERE event_id = ? AND score IS NOT NULL ORDER BY ts DESC LIMIT 1').get(eventId) || null;
}

module.exports = { parseLiveTime, marcadorFinalCreible, ultimaMuestraConMarcador, MIN_MINUTO_FINAL, MIN_TRAS_KICKOFF };
