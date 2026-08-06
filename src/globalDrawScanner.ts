import * as path from 'path';

const dbPath = path.join(__dirname, '..', 'src', 'db');
const confPath = path.join(__dirname, '..', 'src', 'confidence');
const tgPath = path.join(__dirname, '..', 'src', 'telegram');

const { db } = require(dbPath);
const { computeStructuralDrawSignal, computeStake } = require(confPath);
const { sendStructuralDrawAlert } = require(tgPath);

/**
 * 🎯 GLOBAL STRUCTURAL DRAW SCANNER (Minuto 75+)
 * Muestra y audita TODO el universo de partidos de fútbol en vivo del mundo
 * que se encuentren en el minuto 75 o posterior.
 *
 * Registra automáticamente cada señal como un Pick oficial en la base de datos `picks`
 * y emite la alerta al Canal de Telegram VIP.
 */
function parseMinute(liveTimeStr: any): number | null {
  if (!liveTimeStr) return null;
  const match = String(liveTimeStr).match(/(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}

export function scanGlobalDraws75() {
  const since = new Date(Date.now() - 25 * 60 * 1000).toISOString();

  const recentEvents = db.prepare(`
    SELECT DISTINCT event_id, event, sport_id, sport, score, live_time
    FROM snapshots
    WHERE (sport_id = 66 OR LOWER(sport) LIKE '%futbol%')
      AND ts >= ?
    ORDER BY ts DESC
  `).all(since) as any[];

  const candidates: any[] = [];

  for (const ev of recentEvents) {
    const min = parseMinute(ev.live_time);
    if (min !== null && min < 75) continue;

    const snaps = db.prepare(`
      SELECT odd_decimal, suspended, score, ts, market, selection
      FROM snapshots
      WHERE event_id = ? AND ts >= ?
      ORDER BY ts DESC
      LIMIT 30
    `).all(ev.event_id, since) as any[];

    const activeOdds = snaps.filter((s: any) => !s.suspended && s.odd_decimal > 0).map((s: any) => s.odd_decimal);
    if (activeOdds.length < 8) continue;

    const drawSig = computeStructuralDrawSignal(activeOdds, ev.score);

    if (drawSig.isStructuralDraw) {
      candidates.push({
        event_id: ev.event_id,
        event: ev.event,
        sport: ev.sport || 'Fútbol',
        sport_id: ev.sport_id || 66,
        score: ev.score || (snaps.length ? snaps[0].score : '0-0'),
        live_time: ev.live_time || (min ? `${min}'` : "75'+"),
        elapsed_min: min || 75,
        variance: drawSig.variance,
        mean_odd: drawSig.mean,
        sample_count: drawSig.sampleCount,
        market: snaps[0]?.market || 'Resultado Final (Tiempo Regular)',
        selection: snaps[0]?.selection || 'Empate',
        entry_odd: drawSig.mean,
        current_odd: activeOdds[0],
      });
    }
  }

  return candidates;
}

const alertedGlobalEvents = new Set<string>();

export async function checkAndBroadcastGlobalDraws(token: string, chatId: string) {
  if (!token || !chatId) return;

  try {
    const candidates = scanGlobalDraws75();
    for (const c of candidates) {
      const key = `${c.event_id}:global_draw_75`;
      if (alertedGlobalEvents.has(key)) continue;

      alertedGlobalEvents.add(key);

      // 📝 REGISTRAR COMO PICK OFICIAL EN LA BASE DE DATOS
      const existing = db.prepare(`
        SELECT id FROM picks WHERE event_id = ? AND market = ? AND selection = ?
      `).get(c.event_id, c.market, c.selection);

      let pickId = existing?.id;

      if (!pickId) {
        const nowTs = new Date().toISOString();
        const conf = 0.76;
        const oddDecimal = c.current_odd || c.entry_odd || 1.75;
        const stake = computeStake ? computeStake({ conf, oddDecimal }) : 1.5;

        const info = db.prepare(`
          INSERT INTO picks (
            ts, event_id, event, sport, market, selection, odd_decimal, conf, stake,
            f_prob_justa, f_avance, f_situacion, f_linea, conf_heuristic, conf_learned
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          nowTs,
          c.event_id,
          c.event,
          c.sport,
          c.market,
          c.selection,
          oddDecimal,
          conf,
          stake,
          0.72, // f_prob_justa
          0.85, // f_avance (minuto 75+)
          0.75, // f_situacion
          0.82, // f_linea (meseta estabilizada)
          conf,
          conf
        );

        pickId = info.lastInsertRowid;
        console.log(`[scanner] 📝 Pick Oficial Registrado en BD: ID #${pickId} (${c.event})`);
      }

      console.log(`[scanner] 🎯 Alerta Global Empate (Min ${c.elapsed_min}') emitida a Telegram para ${c.event}`);
      await sendStructuralDrawAlert(token, chatId, {
        id: pickId,
        event: c.event,
        sport: c.sport,
        score: `${c.score} (${c.live_time})`,
        market: c.market,
        selection: c.selection,
        current_odd: c.current_odd,
        variance: c.variance,
      });
    }
  } catch (e: any) {
    console.error('[scanner] Error en scanner global de empates 75+:', e.message);
  }
}
