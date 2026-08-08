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
    const str = String(liveTimeStr).toLowerCase();
    // Descanso / HT / Half-time = minuto ~45, no supera el umbral de 75
    if (str.includes('descanso') || str.includes('half') || str.includes('ht') || str === 'break')
        return 45;
    const match = str.match(/(\d+)/);
    return match ? parseInt(match[1], 10) : null;
}
/** Devuelve true solo si el marcador es un empate real (ej: "0-0", "1-1", "2-2") */
function isScoreTie(score) {
    if (!score)
        return false;
    const parts = String(score).split('-');
    if (parts.length !== 2)
        return false;
    const left = Number(parts[0].trim());
    const right = Number(parts[1].trim());
    return !isNaN(left) && !isNaN(right) && left === right;
}
function scanGlobalDraws75() {
    const since = new Date(Date.now() - 90 * 60 * 1000).toISOString();
    const threeHoursAgo = new Date(Date.now() - 180 * 60 * 1000).toISOString();
    const recentEvents = db.prepare(`
    SELECT DISTINCT event_id, event, sport_id, sport, score, live_time
    FROM snapshots
    WHERE (sport_id = 66 OR LOWER(sport) LIKE '%futbol%' OR LOWER(sport) LIKE '%fútbol%' OR sport IS NULL)
      AND LOWER(sport) NOT LIKE 'e-%'
      AND LOWER(sport) NOT LIKE '%e-soccer%'
      AND LOWER(sport) NOT LIKE '%e-futbol%'
      AND LOWER(sport) NOT LIKE '%esoccer%'
      AND ts >= ?
    ORDER BY ts DESC
  `).all(since);
    const candidates = [];
    const addedEventIds = new Set();
    for (const ev of recentEvents) {
        const min = parseMinute(ev.live_time);
        // 🎯 CONDICIÓN 1: Minuto 75 o superior (descartar si es desconocido o menor a 75)
        if (min === null || min < 75)
            continue;
        // Obtener combinaciones de (market, selection) para este evento
        const markets = db.prepare(`
      SELECT DISTINCT market, selection
      FROM snapshots
      WHERE event_id = ? AND ts >= ? AND suspended = 0 AND odd_decimal > 0
    `).all(ev.event_id, since);
        for (const m of markets) {
            // 🎯 Solo mercado de Empate directo (1x2 / Resultado Final)
            const sel = (m.selection || '').trim().toLowerCase();
            const mkt = (m.market || '').trim().toLowerCase();
            const isDrawSelection = sel === 'empate';
            const isDrawMarket = mkt.includes('resultado') || mkt === '1x2' || mkt.includes('result');
            if (!isDrawSelection || !isDrawMarket)
                continue;
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
            // 🎯 CONDICIÓN 2 (Marcador Empatado) + CONDICIÓN 3 (Varianza Estable / Flatline)
            const drawSig = computeStructuralDrawSignal(activeOdds, ev.score);
            const eventScore = ev.score || (snaps.length ? snaps[0].score : null);
            if (drawSig.isStructuralDraw && isScoreTie(eventScore)) {
                candidates.push({
                    event_id: ev.event_id,
                    event: ev.event,
                    sport: ev.sport || 'Fútbol',
                    sport_id: ev.sport_id || 66,
                    score: eventScore || '0-0',
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
                addedEventIds.add(ev.event_id);
                break; // Máximo 1 señal por evento
            }
        }
    }
    // 🎯 Incluir también picks de empates globales registrados en BD que sigan pendientes
    const dbGlobalPicks = db.prepare(`
    SELECT event_id, event, sport, market, selection, odd_decimal, ts
    FROM picks
    WHERE source = 'global_draw'
      AND (result IS NULL OR result = 'unknown')
      AND ts >= ?
    ORDER BY ts DESC
  `).all(threeHoursAgo);
    for (const p of dbGlobalPicks) {
        if (addedEventIds.has(p.event_id))
            continue;
        const snaps = db.prepare(`
      SELECT odd_decimal, suspended, score, live_time, ts
      FROM snapshots
      WHERE event_id = ? AND market = ? AND selection = ?
      ORDER BY ts DESC
      LIMIT 30
    `).all(p.event_id, p.market, p.selection);
        const activeOdds = snaps.filter((s) => !s.suspended && s.odd_decimal > 0).map((s) => s.odd_decimal);
        const lastSnap = snaps.length ? snaps[0] : null;
        const drawSig = activeOdds.length >= 3 ? computeStructuralDrawSignal(activeOdds, lastSnap?.score) : { variance: 0.0100, mean: p.odd_decimal || 3.0, sampleCount: snaps.length || 1 };
        const elapsedMs = Date.now() - new Date(p.ts).getTime();
        const elapsedMin = Math.floor(elapsedMs / 60000);
        candidates.push({
            event_id: p.event_id,
            event: p.event,
            sport: p.sport || 'Fútbol',
            score: lastSnap?.score || 'Empate',
            live_time: lastSnap?.live_time || 'En juego',
            elapsed_min: elapsedMin,
            variance: drawSig.variance,
            mean_odd: drawSig.mean,
            sample_count: drawSig.sampleCount,
            market: p.market,
            selection: p.selection,
            entry_odd: p.odd_decimal,
            current_odd: activeOdds.length ? activeOdds[0] : p.odd_decimal,
        });
        addedEventIds.add(p.event_id);
    }
    return candidates;
}
// ── CACHE PERSISTENTE EN BD (sobrevive reinicios) ──────────────────────────
function isAlreadyAlerted(key) {
    const row = db.prepare('SELECT key FROM alerted_events WHERE key = ?').get(key);
    return !!row;
}
function markAsAlerted(key) {
    db.prepare('INSERT OR IGNORE INTO alerted_events (key, ts) VALUES (?, ?)').run(key, new Date().toISOString());
}
async function checkAndBroadcastGlobalDraws(token, chatId) {
    if (!token || !chatId)
        return;
    const personalChatId = process.env.TELEGRAM_CHAT_ID;
    try {
        const candidates = scanGlobalDraws75();
        for (const c of candidates) {
            const key = `${c.event_id}:global_draw_75`;
            if (isAlreadyAlerted(key))
                continue;
            // 🎯 Filtro de momio: solo picks con cuota empate > 1.30
            const momio = c.current_odd || c.entry_odd || 0;
            if (momio <= 1.30) {
                console.log(`[scanner] ⏭️ Descartado (momio @${momio.toFixed(2)} ≤ 1.30): ${c.event}`);
                continue;
            }
            // Marcar en BD ANTES de enviar para evitar duplicados en caso de crash
            markAsAlerted(key);
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
            f_prob_justa, f_avance, f_situacion, f_linea, conf_heuristic, conf_learned, source
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'global_draw')
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
