"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.scanGlobalDraws75 = scanGlobalDraws75;
exports.checkAndBroadcastGlobalDraws = checkAndBroadcastGlobalDraws;
const path = __importStar(require("path"));
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
 * Agrupa los snapshots por (market, selection) para calcular la varianza estricta
 * de cada línea sin mezclar cuotas entre mercados distintos.
 */
function parseMinute(liveTimeStr) {
    if (!liveTimeStr)
        return null;
    const match = String(liveTimeStr).match(/(\d+)/);
    return match ? parseInt(match[1], 10) : null;
}
function scanGlobalDraws75() {
    const since = new Date(Date.now() - 35 * 60 * 1000).toISOString();
    const recentEvents = db.prepare(`
    SELECT DISTINCT event_id, event, sport_id, sport, score, live_time
    FROM snapshots
    WHERE (sport_id = 66 OR LOWER(sport) LIKE '%futbol%' OR LOWER(sport) LIKE '%fútbol%' OR sport IS NULL)
      AND ts >= ?
    ORDER BY ts DESC
  `).all(since);
    const candidates = [];
    for (const ev of recentEvents) {
        const min = parseMinute(ev.live_time);
        if (min !== null && min < 75)
            continue;
        // Obtener combinaciones de (market, selection) para este evento
        const markets = db.prepare(`
      SELECT DISTINCT market, selection
      FROM snapshots
      WHERE event_id = ? AND ts >= ? AND suspended = 0 AND odd_decimal > 0
    `).all(ev.event_id, since);
        for (const m of markets) {
            const snaps = db.prepare(`
        SELECT odd_decimal, suspended, score, ts
        FROM snapshots
        WHERE event_id = ? AND market = ? AND selection = ? AND ts >= ?
        ORDER BY ts DESC
        LIMIT 30
      `).all(ev.event_id, m.market, m.selection, since);
            const activeOdds = snaps.filter((s) => !s.suspended && s.odd_decimal > 0).map((s) => s.odd_decimal);
            if (activeOdds.length < 5)
                continue;
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
                    market: m.market,
                    selection: m.selection,
                    entry_odd: drawSig.mean,
                    current_odd: activeOdds[0],
                });
                break; // Máximo 1 señal por evento
            }
        }
    }
    return candidates;
}
const alertedGlobalEvents = new Set();
async function checkAndBroadcastGlobalDraws(token, chatId) {
    if (!token || !chatId)
        return;
    const personalChatId = process.env.TELEGRAM_CHAT_ID;
    try {
        const candidates = scanGlobalDraws75();
        for (const c of candidates) {
            const key = `${c.event_id}:global_draw_75`;
            if (alertedGlobalEvents.has(key))
                continue;
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
        `).run(nowTs, c.event_id, c.event, c.sport, c.market, c.selection, oddDecimal, conf, stake, 0.72, 0.85, 0.75, 0.82, conf, conf);
                pickId = info.lastInsertRowid;
                console.log(`[scanner] 📝 Pick Oficial Registrado en BD: ID #${pickId} (${c.event})`);
            }
            console.log(`[scanner] 🎯 Alerta Global Empate (Min ${c.elapsed_min}') emitida a Telegram para ${c.event}`);
            const alertPayload = {
                id: pickId,
                event: c.event,
                sport: c.sport,
                score: `${c.score} (${c.live_time})`,
                market: c.market,
                selection: c.selection,
                current_odd: c.current_odd,
                variance: c.variance,
            };
            // Enviar a Canal VIP
            try {
                await sendStructuralDrawAlert(token, chatId, alertPayload);
            }
            catch (e) {
                console.error(`[scanner] Error enviando a Canal VIP: ${e.message}`);
            }
            // Enviar también a Chat Personal si es distinto
            if (personalChatId && personalChatId !== chatId) {
                try {
                    await sendStructuralDrawAlert(token, personalChatId, alertPayload);
                }
                catch (e) {
                    console.error(`[scanner] Error enviando a Chat Personal: ${e.message}`);
                }
            }
        }
    }
    catch (e) {
        console.error('[scanner] Error en scanner global de empates 75+:', e.message);
    }
}
