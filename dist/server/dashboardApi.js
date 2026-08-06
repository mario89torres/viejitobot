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
exports.createDashboardServer = createDashboardServer;
const http = __importStar(require("http"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const healthPath = path.join(__dirname, '..', '..', 'src', 'health');
const metricsPath = path.join(__dirname, '..', '..', 'src', 'metrics');
const dbPath = path.join(__dirname, '..', '..', 'src', 'db');
const confPath = path.join(__dirname, '..', '..', 'src', 'confidence');
const dashboardDir = path.join(__dirname, '..', '..', 'dashboard');
const { calculateQuantitativeHealth } = require(healthPath);
const { stakeStats } = require(metricsPath);
const { db } = require(dbPath);
const { excludedSports, isBlockedMarket, isBlockedOver, isSuspensionOrInstabilityInWindow, computeStructuralDrawSignal } = require(confPath);
const normSport = (s) => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
function createDashboardServer(port = 3001) {
    const server = http.createServer((req, res) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
        if (req.method === 'OPTIONS') {
            res.writeHead(204);
            res.end();
            return;
        }
        const url = req.url || '/';
        try {
            // 1. API Summary
            if (url === '/api/summary') {
                res.setHeader('Content-Type', 'application/json; charset=utf-8');
                const health = calculateQuantitativeHealth({ windowDays: 30 });
                const stats = stakeStats();
                res.writeHead(200);
                res.end(JSON.stringify({ health, stats }));
                return;
            }
            // 2. API Accepted Picks (Últimos 50 picks emitidos que pasaron los filtros)
            if (url === '/api/accepted') {
                res.setHeader('Content-Type', 'application/json; charset=utf-8');
                const excl = excludedSports();
                const rawPicks = db.prepare(`
          SELECT id, ts, event_id, event, sport, market, selection,
                 odd_decimal, opening_odd_decimal, sharp_entry_odd, sharp_closing_odd,
                 conf, conf_heuristic, conf_learned, edge,
                 f_prob_justa, f_avance, f_situacion, f_linea, f_apertura,
                 stake, stake_mode, score_version,
                 result, loss_minute
          FROM picks
          WHERE stake IS NOT NULL AND result IN ('win', 'loss', 'push')
          ORDER BY ts DESC
          LIMIT 500
        `).all();
                const accepted = rawPicks.filter((r) => {
                    const isExclSport = excl.includes(normSport(r.sport));
                    const isOver = isBlockedOver(r);
                    const isMktBlocked = isBlockedMarket(r);
                    return !isExclSport && !isOver && !isMktBlocked;
                }).slice(0, 50).map((r) => {
                    const profit = r.result === 'win' ? (r.stake * (r.odd_decimal - 1)) : (r.result === 'loss' ? -r.stake : 0);
                    return {
                        ...r,
                        profit: Number(profit.toFixed(2)),
                        confPct: (r.conf * 100).toFixed(1) + '%',
                        confHeurPct: r.conf_heuristic != null ? (r.conf_heuristic * 100).toFixed(1) + '%' : null,
                        confMLPct: r.conf_learned != null ? (r.conf_learned * 100).toFixed(1) + '%' : null,
                    };
                });
                res.writeHead(200);
                res.end(JSON.stringify({ acceptedCount: accepted.length, accepted }));
                return;
            }
            // 3. API Rejected Picks (Picks bloqueados por la doble capa o ventana de confirmación)
            if (url === '/api/rejected') {
                res.setHeader('Content-Type', 'application/json; charset=utf-8');
                const excl = excludedSports();
                const rawPicks = db.prepare(`
          SELECT id, ts, event_id, event, sport, market, selection, odd_decimal, conf, result, final_score, stake, loss_minute
          FROM picks
          WHERE stake IS NOT NULL AND result IN ('win', 'loss', 'push')
          ORDER BY ts DESC
          LIMIT 300
        `).all();
                let savedUnits = 0;
                let totalLossesAvoided = 0;
                const rejected = rawPicks.filter((r) => {
                    const isExclSport = excl.includes(normSport(r.sport));
                    const isOver = isBlockedOver(r);
                    const isMktBlocked = isBlockedMarket(r);
                    return isExclSport || isOver || isMktBlocked;
                }).map((r) => {
                    let reason = 'Mercado Bloqueado';
                    if (excl.includes(normSport(r.sport)))
                        reason = 'Deporte Excluido';
                    else if (isBlockedOver(r))
                        reason = 'Over en Fútbol Bloqueado';
                    else if (/m[aá]s de/i.test(r.selection || '') && (r.market || '').match(/4\.5|5\.0|5\.5/))
                        reason = 'Over >= 4.5 Bloqueado';
                    else if ((r.market || '').toLowerCase().includes('empate no accion'))
                        reason = 'DNB Débil / No Cumple Edge';
                    let statusTag = '⚪ Pendiente';
                    if (r.result === 'win') {
                        statusTag = `✅ Ganado (+${(r.stake * (r.odd_decimal - 1)).toFixed(2)}u)`;
                    }
                    else if (r.result === 'loss') {
                        const minStr = r.loss_minute ? ` min ${r.loss_minute}'` : '';
                        statusTag = `❌ Perdido (-${r.stake.toFixed(2)}u${minStr})`;
                        savedUnits += r.stake;
                        totalLossesAvoided += 1;
                    }
                    else if (r.result === 'push') {
                        statusTag = `⚪ Nulo (0.00u)`;
                    }
                    return { ...r, reason, statusTag };
                });
                res.writeHead(200);
                res.end(JSON.stringify({
                    rejectedCount: rejected.length,
                    totalLossesAvoided,
                    savedUnits: Number(savedUnits.toFixed(2)),
                    rejected
                }));
                return;
            }
            // 4. API Live — picks pendientes con tracking de cuota en tiempo real
            if (url === '/api/live') {
                res.setHeader('Content-Type', 'application/json; charset=utf-8');
                // Picks emitidos sin resultado aún
                const pending = db.prepare(`
          SELECT p.id, p.ts, p.event_id, p.event, p.sport, p.market, p.selection,
                 p.odd_decimal   AS entry_odd,
                 p.opening_odd_decimal,
                 p.conf, p.conf_heuristic, p.conf_learned,
                 p.edge, p.stake, p.stake_mode, p.score_version,
                 p.f_prob_justa, p.f_avance, p.f_situacion, p.f_linea, p.f_apertura
          FROM picks p
          WHERE p.stake IS NOT NULL
            AND (p.result IS NULL OR p.result NOT IN ('win','loss','push'))
          ORDER BY p.ts DESC
          LIMIT 50
        `).all();
                const live = pending.map((p) => {
                    // Historial de cuotas de los últimos 60 snapshots
                    const history = db.prepare(`
            SELECT odd_decimal, ts, suspended
            FROM snapshots
            WHERE event_id = ? AND market = ? AND selection = ?
            ORDER BY ts DESC
            LIMIT 60
          `).all(p.event_id, p.market, p.selection);
                    const activeHistory = history.filter((s) => !s.suspended);
                    const currentOdd = activeHistory.length > 0 ? activeHistory[0].odd_decimal : null;
                    const prevOdd = activeHistory.length > 1 ? activeHistory[1].odd_decimal : null;
                    const oldestOdd = activeHistory.length > 0 ? activeHistory.at(-1).odd_decimal : null;
                    // Dirección del último movimiento
                    let direction = 'stable';
                    if (currentOdd != null && prevOdd != null) {
                        if (currentOdd > prevOdd + 0.005)
                            direction = 'up';
                        else if (currentOdd < prevOdd - 0.005)
                            direction = 'down';
                    }
                    // Live CLV = (entry_odd - current_odd) / entry_odd * 100
                    // Positivo = la línea se movió EN CONTRA nuestra posición (favorable para nosotros si apostamos Under/Over)
                    const liveCLV = (currentOdd != null && p.entry_odd != null)
                        ? Number(((p.entry_odd - currentOdd) / p.entry_odd * 100).toFixed(2))
                        : null;
                    // Drift total desde el inicio (% cambio apertura→actual)
                    const totalDrift = (currentOdd != null && oldestOdd != null && oldestOdd > 0)
                        ? Number(((currentOdd - oldestOdd) / oldestOdd * 100).toFixed(2))
                        : null;
                    // Tiempo transcurrido desde emisión
                    const elapsedMs = Date.now() - new Date(p.ts).getTime();
                    const elapsedMin = Math.floor(elapsedMs / 60000);
                    // ¿Cuota suspendida? Puede indicar inicio de partido o resolución
                    const isSuspended = history.length > 0 && history[0].suspended === 1;
                    // ── INNOVACIÓN 1: Detección de PROFIT LOCK, SNIPER VALUE & EMPATE ESTRUCTURAL ──
                    let alertSignal = null;
                    let lockedProfitPct = null;
                    let sniperSpikeRatio = null;
                    if (currentOdd != null && p.entry_odd != null) {
                        const dropRatio = (p.entry_odd - currentOdd) / p.entry_odd;
                        const spikeRatio = currentOdd / p.entry_odd;
                        // PROFIT LOCK: Cuota cayó 30%+ a nuestro favor (ej: 1.70 -> 1.10 = +54.5% profit)
                        if (dropRatio >= 0.30 || (liveCLV || 0) >= 30) {
                            alertSignal = 'PROFIT_LOCK';
                            lockedProfitPct = Number(((p.entry_odd - currentOdd) / currentOdd * 100).toFixed(1));
                        }
                        // SNIPER VALUE: Cuota subió 35%+ por sobre-reacción del mercado (ej: 1.70 -> 3.40)
                        else if (spikeRatio >= 1.35 && (p.f_avance || 0.5) >= 0.40) {
                            alertSignal = 'SNIPER_VALUE';
                            sniperSpikeRatio = Number(spikeRatio.toFixed(2));
                        }
                        else if (Math.abs(liveCLV || 0) > 5) {
                            alertSignal = liveCLV > 0 ? 'LINE_MOVED_AGAINST_US' : 'LINE_MOVED_FOR_US';
                        }
                    }
                    // SEÑAL DE EMPATE ESTRUCTURAL (Flatline)
                    const oddsArray = activeHistory.map((s) => s.odd_decimal);
                    const drawSignal = computeStructuralDrawSignal(oddsArray, p.score);
                    if (drawSignal.isStructuralDraw && !alertSignal) {
                        alertSignal = 'STRUCTURAL_DRAW';
                    }
                    if (isSuspended)
                        alertSignal = 'SUSPENDED';
                    return {
                        ...p,
                        current_odd: currentOdd,
                        prev_odd: prevOdd,
                        direction,
                        live_clv: liveCLV,
                        total_drift: totalDrift,
                        elapsed_min: elapsedMin,
                        snapshot_count: history.length,
                        is_suspended: isSuspended,
                        alert: alertSignal,
                        locked_profit_pct: lockedProfitPct,
                        sniper_spike_ratio: sniperSpikeRatio,
                        structural_draw: drawSignal,
                        // Mini-historial de cuotas para sparkline (últimos 20)
                        sparkline: activeHistory.slice(0, 20).reverse().map((s) => s.odd_decimal),
                    };
                });
                res.writeHead(200);
                res.end(JSON.stringify({ count: live.length, live }));
                return;
            }
            // 4.b API Global Draws (Minuto 75+ — Universo completo de partidos de fútbol con Empate Estructural)
            if (url === '/api/global-draws') {
                res.setHeader('Content-Type', 'application/json; charset=utf-8');
                const { scanGlobalDraws75 } = require(path.join(__dirname, '..', 'globalDrawScanner'));
                const draws = scanGlobalDraws75();
                res.writeHead(200);
                res.end(JSON.stringify({ count: draws.length, draws }));
                return;
            }
            // 5. API Pick Timeline — Detalle de snapshots e historial completo de un pick específico
            if (url.startsWith('/api/pick-timeline')) {
                res.setHeader('Content-Type', 'application/json; charset=utf-8');
                const urlObj = new URL(url, 'http://localhost:3001');
                const pickId = urlObj.searchParams.get('id');
                if (!pickId) {
                    res.writeHead(400);
                    res.end(JSON.stringify({ error: 'Falta id del pick' }));
                    return;
                }
                const pick = db.prepare(`
          SELECT * FROM picks WHERE id = ?
        `).get(pickId);
                if (!pick) {
                    res.writeHead(404);
                    res.end(JSON.stringify({ error: 'Pick no encontrado' }));
                    return;
                }
                // Obtener TODOS los snapshots para este evento, mercado y selección
                const snapshots = db.prepare(`
          SELECT id, ts, score, live_time, odd_decimal, odd_american, suspended
          FROM snapshots
          WHERE event_id = ? AND market = ? AND selection = ?
          ORDER BY ts ASC
        `).all(pick.event_id, pick.market, pick.selection);
                // Si no hay snapshots directos con el mercado exacto, traer snapshots del evento
                const eventSnapshots = snapshots.length > 0 ? [] : db.prepare(`
          SELECT id, ts, score, live_time, odd_decimal, suspended
          FROM snapshots
          WHERE event_id = ?
          ORDER BY ts ASC
          LIMIT 100
        `).all(pick.event_id);
                const timeline = snapshots.length > 0 ? snapshots : eventSnapshots;
                // ── INNOVACIÓN 2: Cálculo de MFE & SEÑAL DE EMPATE ESTRUCTURAL (Flatline) ──
                const activeOdds = timeline.filter((s) => !s.suspended && s.odd_decimal > 0).map((s) => s.odd_decimal);
                const minOdd = activeOdds.length > 0 ? Math.min(...activeOdds) : pick.odd_decimal;
                const maxOdd = activeOdds.length > 0 ? Math.max(...activeOdds) : pick.odd_decimal;
                const initialOdd = pick.odd_decimal;
                const lastOdd = activeOdds.length > 0 ? activeOdds.at(-1) : pick.odd_decimal;
                // MFE Peak ROI (% Máximo de ganancia posible en el mejor momento del partido)
                const mfePeakRoi = (initialOdd && minOdd && minOdd < initialOdd)
                    ? Number(((initialOdd - minOdd) / minOdd * 100).toFixed(1))
                    : 0;
                const drawSignal = computeStructuralDrawSignal(activeOdds, pick.final_score || (timeline.length > 0 ? timeline.at(-1).score : ''));
                let trajectory = 'ESTABLE';
                let recommendation = 'MANTENER: Posición sin desviaciones extremas.';
                let recColor = '#98c379'; // verde
                if (drawSignal.isStructuralDraw && pick.result !== 'win' && pick.result !== 'loss') {
                    trajectory = '🎯 EMPATE ESTRUCTURAL (FLATLINE)';
                    recommendation = `🎯 SEÑAL EMPATE ESTRUCTURAL: La cuota entró en una meseta horizontal ultrastable (Varianza ${drawSignal.variance} en 20+ snaps). El partido entró en equilibrio táctico definitivo. Alta probabilidad de Empate / Under.`;
                    recColor = '#56b6c2'; // cyan
                }
                else if (mfePeakRoi >= 30 && pick.result !== 'win') {
                    trajectory = '⚡ PROFIT LOCK ALCANZADO';
                    recommendation = `⚡ LOCK PROFIT / CASHOUT: Este pick alcanzó un pico máximo de ganancia de +${mfePeakRoi}% (cuota cayó a @${minOdd.toFixed(2)}). Recomendado asegurar ganancia.`;
                    recColor = '#e5c07b'; // oro
                }
                else if (pick.result === 'win') {
                    trajectory = 'VICTORIA CONFIRMADA';
                    recommendation = `GANADO: Cobro total realizado. (Pico de ganancia alcanzado: +${mfePeakRoi}% MFE).`;
                    recColor = '#98c379';
                }
                else if (pick.result === 'loss') {
                    trajectory = mfePeakRoi >= 25 ? 'PÉRDIDA TRAS PICO CASHOUT' : 'PÉRDIDA CONFIRMADA';
                    recommendation = mfePeakRoi >= 25
                        ? `PERDIDO AL FINAL: El pick dio oportunidad de Cashout de +${mfePeakRoi}% (cuota @${minOdd.toFixed(2)}) antes del colapso en min ${pick.loss_minute || 'final'}.`
                        : (pick.loss_minute ? `PERDIDO: Ocurrió colapso en min ${pick.loss_minute}'.` : 'PERDIDO: Evento finalizado en contra.');
                    recColor = '#e06c75';
                }
                else {
                    // Pick pendiente en vivo
                    if (lastOdd > initialOdd * 1.5) {
                        trajectory = 'DESFAVORABLE CRÍTICO';
                        recommendation = '⚠️ ALERTA CASHOUT: La cuota subió >50%. Evaluar cashout o cobertura para salvar stake.';
                        recColor = '#e06c75';
                    }
                    else if (lastOdd > initialOdd * 1.15) {
                        trajectory = 'DESFAVORABLE MODERADO';
                        recommendation = '⚠️ PRECAUCIÓN: La cuota subió >15%. Monitorear tendencia de goles/puntos.';
                        recColor = '#e5c07b';
                    }
                    else if (lastOdd < initialOdd * 0.8) {
                        trajectory = 'MUY FAVORABLE';
                        recommendation = `✅ EXCELENTE: La cuota bajó >20%. MFE actual: +${mfePeakRoi}% ROI.`;
                        recColor = '#98c379';
                    }
                    else if (lastOdd < initialOdd) {
                        trajectory = 'FAVORABLE';
                        recommendation = '✅ LÍNEA A FAVOR: Movimiento positivo de cuota.';
                        recColor = '#98c379';
                    }
                }
                res.writeHead(200);
                res.end(JSON.stringify({
                    pick: {
                        ...pick,
                        confPct: (pick.conf * 100).toFixed(1) + '%',
                        confHeurPct: pick.conf_heuristic != null ? (pick.conf_heuristic * 100).toFixed(1) + '%' : null,
                        confMLPct: pick.conf_learned != null ? (pick.conf_learned * 100).toFixed(1) + '%' : null,
                    },
                    analytics: {
                        initialOdd,
                        lastOdd,
                        minOdd,
                        maxOdd,
                        mfePeakRoi,
                        snapshotCount: timeline.length,
                        trajectory,
                        recommendation,
                        recColor,
                    },
                    timeline,
                }));
                return;
            }
            // 4. Archivos Estáticos del Dashboard
            // Limpiar query string (?v=x) del URL antes de buscar el archivo
            const cleanUrl = (url === '/' ? 'index.html' : url.split('?')[0]);
            let filePath = path.join(dashboardDir, cleanUrl);
            if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
                const ext = path.extname(filePath);
                const contentType = ext === '.html' ? 'text/html; charset=utf-8' :
                    ext === '.js' ? 'application/javascript; charset=utf-8' :
                        ext === '.css' ? 'text/css; charset=utf-8' : 'text/plain';
                res.setHeader('Content-Type', contentType);
                res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
                res.setHeader('Pragma', 'no-cache');
                res.setHeader('Expires', '0');
                res.writeHead(200);
                res.end(fs.readFileSync(filePath));
                return;
            }
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.writeHead(404);
            res.end(JSON.stringify({ error: 'Endpoint no encontrado' }));
        }
        catch (e) {
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.writeHead(500);
            res.end(JSON.stringify({ error: e.message }));
        }
    });
    server.listen(port, () => {
        console.log(`[Dashboard API] Servidor Web y API de métricas cuantitativas activo en http://localhost:${port}`);
        // ── MONITOR EN VIVO Y DISPARADOR DE ALERTAS A TELEGRAM (CANAL VIP / CHAT) ──
        const alertedPicks = new Set();
        const token = process.env.TELEGRAM_BOT_TOKEN;
        const vipChannelId = process.env.TELEGRAM_VIP_CHANNEL_ID;
        const personalChatId = process.env.TELEGRAM_CHAT_ID;
        const targetChatId = vipChannelId || personalChatId;
        if (token && targetChatId) {
            const { sendProfitLockAlert, sendStructuralDrawAlert, sendSniperAlert } = require(path.join(__dirname, '..', 'telegram'));
            const { checkAndBroadcastGlobalDraws } = require(path.join(__dirname, '..', 'globalDrawScanner'));
            setInterval(async () => {
                try {
                    // 1. Escanear todo el universo de partidos de fútbol en min 75+ (Global Draw Scanner)
                    await checkAndBroadcastGlobalDraws(token, targetChatId);
                    // 2. Escanear picks en desarrollo para Profit Lock / Sniper / Structural Draw
                    const liveRes = await fetch(`http://localhost:${port}/api/live`).then(r => r.json());
                    if (!liveRes?.live)
                        return;
                    for (const p of liveRes.live) {
                        if (!p.alert)
                            continue;
                        const alertKey = `${p.id}:${p.alert}`;
                        if (alertedPicks.has(alertKey))
                            continue;
                        alertedPicks.add(alertKey);
                        const sendToBoth = async (fn) => {
                            if (vipChannelId) {
                                try {
                                    await fn(token, vipChannelId, p);
                                }
                                catch (e) {
                                    console.error(`[telegram] Error envio VIP: ${e.message}`);
                                }
                            }
                            if (personalChatId && personalChatId !== vipChannelId) {
                                try {
                                    await fn(token, personalChatId, p);
                                }
                                catch (e) {
                                    console.error(`[telegram] Error envio Personal: ${e.message}`);
                                }
                            }
                        };
                        if (p.alert === 'PROFIT_LOCK') {
                            await sendToBoth(sendProfitLockAlert);
                            console.log(`[telegram] ⚡ Alerta Profit Lock enviada para Pick #${p.id}`);
                        }
                        else if (p.alert === 'SNIPER_VALUE') {
                            await sendToBoth(sendSniperAlert);
                            console.log(`[telegram] 🎯 Alerta Sniper Value enviada para Pick #${p.id}`);
                        }
                        else if (p.alert === 'STRUCTURAL_DRAW') {
                            await sendToBoth(sendStructuralDrawAlert);
                            console.log(`[telegram] 🎯 Alerta Empate Estructural enviada para Pick #${p.id}`);
                        }
                    }
                }
                catch (e) {
                    // Ignorar errores temporales de conexión
                }
            }, 30000);
        }
    });
    return server;
}
if (require.main === module) {
    createDashboardServer(3001);
}
