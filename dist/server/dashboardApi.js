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
const crypto = __importStar(require("crypto"));
require('dotenv').config();
// Auth básica opcional — necesaria en cuanto el panel deja de ser solo
// localhost (túnel/hosting público). Si no hay credenciales en el .env, el
// panel queda abierto igual que hasta ahora (uso local sin fricción).
const DASHBOARD_USER = process.env.DASHBOARD_USER || '';
const DASHBOARD_PASS = process.env.DASHBOARD_PASS || '';
function checkAuth(req) {
    if (!DASHBOARD_USER || !DASHBOARD_PASS)
        return true;
    const expected = Buffer.from(`Basic ${Buffer.from(`${DASHBOARD_USER}:${DASHBOARD_PASS}`).toString('base64')}`);
    const given = Buffer.from(String(req.headers['authorization'] || ''));
    // timingSafeEqual exige igual longitud, y por diseño no la revela — de ahí el
    // padding: comparar solo cuando coinciden ya filtraría la longitud por timing.
    if (given.length !== expected.length) {
        crypto.timingSafeEqual(expected, expected);
        return false;
    }
    return crypto.timingSafeEqual(given, expected);
}
const healthPath = path.join(__dirname, '..', '..', 'src', 'health');
const metricsPath = path.join(__dirname, '..', '..', 'src', 'metrics');
const dbPath = path.join(__dirname, '..', '..', 'src', 'db');
const confPath = path.join(__dirname, '..', '..', 'src', 'confidence');
const marketsPath = path.join(__dirname, '..', '..', 'src', 'markets');
const fotmobLivePath = path.join(__dirname, '..', '..', 'src', 'fotmobLive');
const prematchFotmobPath = path.join(__dirname, '..', '..', 'src', 'prematchFotmob');
const dashboardDir = path.join(__dirname, '..', '..', 'dashboard');
const { calculateQuantitativeHealth } = require(healthPath);
const { stakeStats } = require(metricsPath);
const { db, getForecastHistory } = require(dbPath);
const { excludedSports, isBlockedMarket, isBlockedOver, isSuspensionOrInstabilityInWindow, computeStructuralDrawSignal, recentScoreChange } = require(confPath);
// decidedResult: solo devuelve resultado cuando ya es IRREVERSIBLE. Se usa para
// callar alertas sobre picks que en la practica ya terminaron.
const { decidedResult } = require(marketsPath);
// Cruce EN VIVO playdoit<->FotMob + pronostico (binomial negativa),
// compartido con bot.js (que lo usa para persistir el historial de
// pronosticos) — ver src/fotmobLive.js.
const { computeDosFuentes } = require(fotmobLivePath);
const { datosFotmobDeEvento } = require(prematchFotmobPath);
const normSport = (s) => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
// ── Encadenado de línea para el timeline del pick ──────────────────────────
// Mercados de linea (Mas/Menos de N) se retiran y reaparecen con otro N a
// medida que el partido avanza (ej. corners: al caer el 4o, la casa quita
// "Mas de 3.5" y sube "Mas de 4.5"). Antes, el timeline de un pick se cortaba
// ahi porque solo se leian los snapshots de event_id+market+selection EXACTOS
// — la grafica quedaba plana el resto del partido aunque el mercado siguiera
// vivo con otra linea. Pedido explicito del usuario el 2026-09-14: seguir la
// linea inferior (la mas cercana por abajo) cuando la actual desaparece, y
// marcar en la misma grafica donde ocurrio el cambio.
function numDeSeleccion(sel) {
    const m = String(sel || '').match(/(\d+(?:\.\d+)?)/);
    return m ? parseFloat(m[1]) : null;
}
function ladoDeSeleccion(sel) {
    const s = String(sel || '').toLowerCase();
    if (s.includes('mas') || s.includes('más') || s.includes('over'))
        return 'over';
    if (s.includes('menos') || s.includes('under'))
        return 'under';
    return null;
}
function timelineEncadenado(eventId, marketInicial, seleccionInicial) {
    const cambios = [];
    let market = marketInicial;
    let selection = seleccionInicial;
    let acumulado = [];
    const vistos = new Set();
    for (let i = 0; i < 6; i++) { // tope de eslabones, por seguridad
        const key = `${market}|||${selection}`;
        if (vistos.has(key))
            break;
        vistos.add(key);
        const tramo = db.prepare(`
      SELECT id, ts, score, live_time, odd_decimal, odd_american, suspended
      FROM snapshots WHERE event_id = ? AND market = ? AND selection = ?
      ORDER BY ts ASC
    `).all(eventId, market, selection);
        if (!tramo.length)
            break;
        acumulado = acumulado.concat(tramo.map(r => ({ ...r, selection })));
        const ultimoTs = tramo[tramo.length - 1].ts;
        const numActual = numDeSeleccion(selection);
        const lado = ladoDeSeleccion(selection);
        if (numActual == null || !lado)
            break; // mercado sin linea numerica (1x2, etc): no hay a que encadenar
        const candidatas = db.prepare(`
      SELECT DISTINCT selection FROM snapshots
      WHERE event_id = ? AND market = ? AND selection != ? AND ts > ?
    `).all(eventId, market, selection, ultimoTs);
        // Preferencia: la linea INFERIOR mas cercana (pedido del usuario). Si
        // ninguna quedo por debajo, se toma la disponible mas cercana en
        // cualquier direccion para no cortar el seguimiento de mas.
        let mejor = null, mejorNum = null;
        for (const c of candidatas) {
            const n = numDeSeleccion(c.selection);
            if (n == null || ladoDeSeleccion(c.selection) !== lado)
                continue;
            if (n < numActual && (mejor == null || n > mejorNum)) {
                mejor = c.selection;
                mejorNum = n;
            }
        }
        if (mejor == null) {
            for (const c of candidatas) {
                const n = numDeSeleccion(c.selection);
                if (n == null || ladoDeSeleccion(c.selection) !== lado)
                    continue;
                if (mejor == null || Math.abs(n - numActual) < Math.abs(mejorNum - numActual)) {
                    mejor = c.selection;
                    mejorNum = n;
                }
            }
        }
        if (mejor == null)
            break;
        cambios.push({ enTs: ultimoTs, de: selection, a: mejor });
        selection = mejor;
    }
    return { timeline: acumulado, cambios };
}
function createDashboardServer(port = 3001) {
    const server = http.createServer((req, res) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
        if (req.method === 'OPTIONS') {
            res.writeHead(204);
            res.end();
            return;
        }
        if (!checkAuth(req)) {
            res.setHeader('WWW-Authenticate', 'Basic realm="playdoit dashboard"');
            res.writeHead(401);
            res.end('Auth requerida');
            return;
        }
        const rawUrl = req.url || '/';
        // Se enruta por PATHNAME, no por la URL cruda. Antes se comparaba
        // `url === '/api/accepted'`, así que cualquier query string rompía el
        // enrutado en silencio y caía en el 404 — por eso no se podía parametrizar
        // ningún endpoint. Las comparaciones exactas de abajo siguen funcionando
        // igual porque el pathname es lo que ya comparaban.
        const qIdx = rawUrl.indexOf('?');
        const url = qIdx === -1 ? rawUrl : rawUrl.slice(0, qIdx);
        const query = new URLSearchParams(qIdx === -1 ? '' : rawUrl.slice(qIdx + 1));
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
            // 2. API Accepted Picks — picks emitidos que pasaron los filtros.
            //
            // El tope era 50 FIJO (LIMIT 500 en SQL y luego .slice(0,50)), así que con
            // 90 picks en un solo día el dashboard escondía los 40 más viejos sin
            // avisar. Ahora es ?limit=N con default 500: cubre varios días completos.
            // El tope duro de 5000 evita que un ?limit=999999 se traiga la tabla
            // entera y tumbe el navegador.
            if (url === '/api/accepted') {
                res.setHeader('Content-Type', 'application/json; charset=utf-8');
                const excl = excludedSports();
                const reqLimit = Number(query.get('limit')) || 500;
                const limit = Math.min(5000, Math.max(1, reqLimit));
                // Se piden más filas de las que se devuelven porque el filtrado por
                // deporte/mercado ocurre DESPUÉS: sin ese margen, un tramo con muchos
                // picks excluidos devolvería menos de `limit` aun habiendo más.
                const rawPicks = db.prepare(`
          SELECT id, ts, event_id, event, sport, market, selection,
                 odd_decimal, opening_odd_decimal, sharp_entry_odd, sharp_closing_odd,
                 conf, conf_heuristic, conf_learned, edge,
                 f_prob_justa, f_avance, f_situacion, f_linea, f_apertura,
                 stake, stake_mode, score_version,
                 result, loss_minute, settled_ts
          FROM picks
          WHERE stake IS NOT NULL
          ORDER BY ts DESC
          LIMIT ?
        `).all(limit * 2);
                const accepted = rawPicks.filter((r) => {
                    const isExclSport = excl.includes(normSport(r.sport));
                    const isOver = isBlockedOver(r);
                    const isMktBlocked = isBlockedMarket(r);
                    return !isExclSport && !isOver && !isMktBlocked;
                }).slice(0, limit).map((r) => {
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
            // 3b. API Grupo de Control — candidatos RECHAZADOS por el firewall o los
            // filtros (min_conf, min_edge, guardas), con su resultado real una vez
            // liquidados. No confundir con /api/rejected: ese lee de `picks` (jugadas
            // que sí se emitieron y luego el dashboard filtra por deporte/mercado);
            // este lee de `rejected_picks`, la tabla de near-miss que nunca se
            // emitieron. Ver src/db.js y bot.js:captureRejectedControls.
            if (url === '/api/control-group') {
                res.setHeader('Content-Type', 'application/json; charset=utf-8');
                const rows = db.prepare(`
          SELECT id, ts, event, sport, market, selection, odd_decimal, conf, edge,
                 reject_rule, result, final_score, settled_ts
          FROM rejected_picks
          ORDER BY ts DESC
          LIMIT 500
        `).all();
                const liquidados = rows.filter((r) => r.result === 'win' || r.result === 'loss');
                const wins = liquidados.filter((r) => r.result === 'win').length;
                const porRegla = {};
                for (const r of liquidados) {
                    const k = r.reject_rule || '(sin regla)';
                    porRegla[k] = porRegla[k] || { n: 0, win: 0, loss: 0 };
                    porRegla[k].n++;
                    if (r.result === 'win')
                        porRegla[k].win++;
                    else
                        porRegla[k].loss++;
                }
                res.writeHead(200);
                res.end(JSON.stringify({
                    total: rows.length,
                    pendientes: rows.length - liquidados.length,
                    liquidados: liquidados.length,
                    // WR de lo que se DESCARTÓ: si sube mucho, el firewall/umbral está
                    // dejando dinero en la mesa; si es bajo, está haciendo su trabajo.
                    wrDescartado: liquidados.length ? Number((wins / liquidados.length * 100).toFixed(1)) : null,
                    porRegla,
                    rows: rows.map((r) => ({
                        ...r,
                        resultLabel: r.result === 'win' ? '✅ Habría ganado'
                            : r.result === 'loss' ? '❌ Habría perdido'
                                : r.result === 'push' ? '⚪ Anulada'
                                    : r.result === 'unknown' ? '❔ No calificable'
                                        : '⏳ En curso',
                    })),
                }));
                return;
            }
            // 3c. API Model Picks — la SOMBRA del modelo aprendido. Picks que el
            // modelo habria emitido si decidiera el; nunca se apuestan. Viven en
            // model_picks, tabla aparte, para que el dataset de `picks` no se
            // contamine (ver bot.js:emitirPicksModelo).
            //
            // P/L se calcula a stake PLANO de 1u y se dice asi en la respuesta: la
            // sombra no tiene stake asignado, y presentarla con el escalonado del bot
            // real seria inventarse una exposicion que nunca existio.
            if (url === '/api/model-picks') {
                res.setHeader('Content-Type', 'application/json; charset=utf-8');
                const reqLimit = Number(query.get('limit')) || 500;
                const limit = Math.min(5000, Math.max(1, reqLimit));
                // El estado en vivo se calcula SOLO para las filas sin liquidar.
                //
                // Antes las cuatro subconsultas corrian para TODAS las filas, y cada una
                // busca por event_id y luego escanea las ~300 filas de ese evento
                // filtrando mercado y seleccion en memoria (no hay indice que cubra
                // (event_id, market, selection)). Sobre una tabla de 113 millones de
                // filas y 18 GB, en frio son ~18 ms por subconsulta. Con 338 filas x 4
                // subconsultas el endpoint tardaba 11.2 s — y el panel lo pedia cada 15.
                // Una fila liquidada no tiene estado en vivo que mostrar, asi que ese
                // trabajo era enteramente desperdiciado.
                const rows = db.prepare(`
          SELECT m.id, m.ts, m.event_id, m.event, m.sport, m.champ, m.market, m.selection,
                 m.odd_decimal, m.conf_learned, m.conf_heuristic, m.edge_learned,
                 m.tambien_heuristico, m.result, m.final_score, m.settled_ts,
                 m.entry_score, m.entry_minute, m.entry_live_time,
                 m.f_avance, m.f_linea, m.f_apertura
          FROM model_picks m
          ORDER BY m.ts DESC
          LIMIT ?
        `).all(limit);
                const vivoStmt = db.prepare(`
          SELECT
            (SELECT s.score FROM snapshots s WHERE s.event_id = ? AND s.score != ''
              ORDER BY s.ts DESC LIMIT 1) AS live_score,
            (SELECT s.live_time FROM snapshots s WHERE s.event_id = ?
              ORDER BY s.ts DESC LIMIT 1) AS live_time,
            (SELECT MAX(s.ts) FROM snapshots s WHERE s.event_id = ?) AS last_seen_ts,
            (SELECT s.odd_decimal FROM snapshots s
              WHERE s.event_id = ? AND s.market = ? AND s.selection = ? AND s.suspended = 0
              ORDER BY s.ts DESC LIMIT 1) AS current_odd
        `);
                for (const r of rows) {
                    if (r.result) {
                        r.live_score = null;
                        r.live_time = null;
                        r.last_seen_ts = null;
                        r.current_odd = null;
                        continue;
                    }
                    Object.assign(r, vivoStmt.get(r.event_id, r.event_id, r.event_id, r.event_id, r.market, r.selection));
                }
                let pl = 0, wins = 0, losses = 0, pendientes = 0, solapan = 0;
                const enriched = rows.map((r) => {
                    const profit = r.result === 'win' ? (r.odd_decimal - 1) : (r.result === 'loss' ? -1 : 0);
                    if (r.result === 'win')
                        wins++;
                    else if (r.result === 'loss')
                        losses++;
                    else if (!r.result)
                        pendientes++;
                    if (r.tambien_heuristico)
                        solapan++;
                    pl += profit;
                    // Termometro de los pendientes: cuota que baja = el mercado se movio
                    // a favor. Es el unico indicador transversal a todos los mercados.
                    let drift = null;
                    if (!r.result && r.current_odd != null && r.odd_decimal) {
                        drift = Number((((r.current_odd - r.odd_decimal) / r.odd_decimal) * 100).toFixed(1));
                    }
                    const staleMin = r.last_seen_ts
                        ? Math.round((Date.now() - new Date(r.last_seen_ts).getTime()) / 60000)
                        : null;
                    return {
                        ...r,
                        profit: Number(profit.toFixed(2)),
                        drift,
                        staleMin,
                        isLive: !r.result && staleMin != null && staleMin <= 25,
                        confMLPct: r.conf_learned != null ? (r.conf_learned * 100).toFixed(1) + '%' : null,
                        confHeurPct: r.conf_heuristic != null ? (r.conf_heuristic * 100).toFixed(1) + '%' : null,
                        resultLabel: r.result === 'win' ? '✅ Habría ganado'
                            : r.result === 'loss' ? '❌ Habría perdido'
                                : r.result === 'push' ? '⚪ Anulada'
                                    : '⏳ En curso',
                    };
                });
                const liquidados = wins + losses;
                res.writeHead(200);
                res.end(JSON.stringify({
                    total: rows.length,
                    liquidados,
                    pendientes,
                    wins,
                    losses,
                    // Cuantos de estos habria emitido tambien el heuristico. Si el numero
                    // es bajo, los dos motores no discrepan en los margenes: miran
                    // poblaciones distintas, y comparar sus ROI no compara decisores.
                    solapan,
                    solapePct: rows.length ? Number((solapan / rows.length * 100).toFixed(1)) : null,
                    wr: liquidados ? Number((wins / liquidados * 100).toFixed(1)) : null,
                    pl: Number(pl.toFixed(2)),
                    roi: liquidados ? Number((pl / liquidados * 100).toFixed(1)) : null,
                    stakeMode: 'plano 1u (la sombra no tiene stake asignado)',
                    rows: enriched,
                }));
                return;
            }
            // 4. API Live — picks pendientes con tracking de cuota en tiempo real
            // Estado del partido: SIEMPRE por evento, nunca por (evento, mercado,
            // seleccion). El marcador es propiedad del partido; la cuota es propiedad
            // de la seleccion. Leer el marcador del historial filtrado por seleccion
            // lo congelaba en cuanto esa linea dejaba de cotizarse — lo normal en un
            // "Menos de 1.5" en cuanto caen dos goles. Medido el 2026-08-25: 4 de 5
            // picks pendientes mostraban marcador viejo, uno de ellos 0-1 min 57
            // cuando el partido iba 2-2 min 81, con el pick ya muerto.
            const eventStateStmt = db.prepare(`
        SELECT score, live_time, ts
        FROM snapshots
        WHERE event_id = ? AND score != ''
        ORDER BY ts DESC LIMIT 1
      `);
            const eventState = (eventId) => {
                const r = eventStateStmt.get(eventId);
                return {
                    score: r ? r.score : null,
                    live_time: r ? r.live_time : null,
                    score_ts: r ? r.ts : null,
                    // Minutos desde la ultima lectura del marcador. Si crece, el evento
                    // salio del feed y lo que se muestra ya no es "ahora".
                    score_age_min: r ? Math.round((Date.now() - new Date(r.ts).getTime()) / 60000) : null,
                };
            };
            if (url === '/api/live') {
                res.setHeader('Content-Type', 'application/json; charset=utf-8');
                // Picks emitidos sin resultado aún
                // El corte de 3 horas va en SQL, no despues del mapeo.
                //
                // Antes se traian los 50 pendientes mas recientes, se hacia el trabajo
                // caro de cada uno (un escaneo de 60 snapshots del evento + el estado
                // del partido) y SOLO ENTONCES se descartaban los de mas de 3 horas.
                // Medido el 2026-08-26: 101 pendientes en total y solo 3 dentro de la
                // ventana, asi que 47 de los 50 se consultaban para tirarlos.
                const liveCutoff = new Date(Date.now() - 180 * 60 * 1000).toISOString();
                const pending = db.prepare(`
          SELECT p.id, p.ts, p.event_id, p.event, p.sport, p.market, p.selection,
                 p.odd_decimal   AS entry_odd,
                 p.opening_odd_decimal,
                 p.conf, p.conf_heuristic, p.conf_learned,
                 p.edge, p.stake, p.stake_mode, p.score_version,
                 p.f_prob_justa, p.f_avance, p.f_situacion, p.f_linea, p.f_apertura
          FROM picks p
          WHERE (p.result IS NULL OR p.result = 'unknown') AND p.ts >= ?
          ORDER BY p.ts DESC
          LIMIT 50
        `).all(liveCutoff);
                const live = pending.map((p) => {
                    // Historial de cuotas de los últimos 60 snapshots
                    const history = db.prepare(`
            SELECT odd_decimal, ts, suspended, score, live_time
            FROM snapshots
            WHERE event_id = ? AND market = ? AND selection = ?
            ORDER BY ts DESC
            LIMIT 60
          `).all(p.event_id, p.market, p.selection);
                    // Último marcador y minuto conocido (de cualquier snapshot, incluidos suspendidos)
                    const estado = eventState(p.event_id);
                    const latestScore = estado.score;
                    const latestLiveTime = estado.live_time;
                    const activeHistory = history.filter((s) => !s.suspended);
                    const currentOdd = activeHistory.length > 0 ? activeHistory[0].odd_decimal : null;
                    const prevOdd = activeHistory.length > 1 ? activeHistory[1].odd_decimal : null;
                    const oldestOdd = activeHistory.length > 0 ? activeHistory.at(-1).odd_decimal : null;
                    // LINEA RETIRADA. El marcador se lee del evento y siempre esta fresco;
                    // la cuota se lee de (evento, mercado, seleccion) y se congela cuando
                    // la casa deja de ofrecer esa linea — que es justo lo que pasa cuando
                    // la apuesta queda resuelta. Sin esta marca la tarjeta enseña un
                    // precio de hace 20 minutos como si fuera vigente, con su CLV y todo.
                    // Caso real (2026-08-25): Under 3.5 con el partido 3-2; el ultimo
                    // precio era de cuando iba 1-1 y la casa ya habia subido la linea a 5.5.
                    const oddTs = activeHistory.length > 0 ? activeHistory[0].ts : null;
                    const oddAgeMin = oddTs ? Math.round((Date.now() - new Date(oddTs).getTime()) / 60000) : null;
                    // Retirada = el evento sigue reportando pero su linea no. Se compara
                    // contra la lectura del marcador, no contra el reloj: si el partido
                    // entero salio del feed, no hay retirada, hay silencio general.
                    const lineWithdrawn = !!(oddTs && estado.score_ts
                        && (new Date(estado.score_ts).getTime() - new Date(oddTs).getTime()) > 3 * 60 * 1000);
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
                        // POSICIÓN DETERIORADA (antes "SNIPER VALUE", y estaba invertida).
                        // Se presentaba como oportunidad —"el mercado sobre-reaccionó, hay
                        // valor"— pero los datos dicen lo contrario: medido sobre 700 picks
                        // liquidados, el WR cae de forma monótona conforme sube la cuota
                        // desde la entrada (spike <1.05 -> 81.7%; >=1.60 -> 2.8%). Los 94
                        // disparos históricos de SNIPER_VALUE acertaron el 3.2%.
                        // El mercado no se equivoca al repreciar en contra: lo hace porque
                        // la posición va perdiendo. La señal servía, el signo estaba mal.
                        else if (spikeRatio >= 1.35 && (p.f_avance || 0.5) >= 0.40) {
                            alertSignal = 'POSITION_DYING';
                            sniperSpikeRatio = Number(spikeRatio.toFixed(2));
                        }
                    }
                    // EMPATE ESTRUCTURAL. Ahora se le pasan `selection` y el historial de
                    // marcadores: sin eso disparaba en CUALQUIER mercado (el 100% de sus
                    // 145 disparos fueron fuera del mercado de empate), con marcador no
                    // empatado (76%) y sin mirar si acababa de haber gol — con la línea
                    // aún sin repreciar, su planitud no significa nada.
                    const oddsArray = activeHistory.map((s) => s.odd_decimal);
                    const scoreHistory = history.map((s) => s.score).filter(Boolean);
                    const drawSignal = computeStructuralDrawSignal(oddsArray, latestScore || p.score, {
                        selection: p.selection,
                        scores: scoreHistory,
                    });
                    if (drawSignal.isStructuralDraw && !alertSignal) {
                        alertSignal = 'STRUCTURAL_DRAW';
                    }
                    // Movimiento generico de linea (solo si no hay alerta prioritaria de
                    // LOCK, SNIPER o DRAW). Ajustado el 2026-09-12, pedido explicito del
                    // usuario, en dos pasos:
                    //  1. Al activar el ENVIO de esta alerta (antes se calculaba pero
                    //     nunca se mandaba a Telegram), resulto obvio que un umbral de
                    //     5% no distingue un cambio real de estado del ruido normal —
                    //     docs/alertas-valor.md ya media que el movimiento de precio de
                    //     un pick tipico es p50 25%, p75 51%; con 5% esto dispararia en
                    //     casi todos los picks vivos.
                    //  2. Se restringe a SOLO "el momio subio" (spikeRatio > 1, cuota
                    //     actual por encima de la de entrada) y no a ambas direcciones:
                    //     un momio que BAJA es buena noticia para la posicion (el
                    //     mercado se mueve a favor) y ya lo cubre Profit Lock con su
                    //     propio umbral afinado (30%) — avisar tambien aqui de una
                    //     caida de apenas 15% no informa de un cambio real, solo
                    //     duplica ruido de una buena noticia pequeña. Que el momio suba
                    //     es lo que de verdad significa que la posicion se esta
                    //     deteriorando, y Posicion Deteriorada (35% + avance del
                    //     partido) ya cubre el caso grave — esta es la señal de
                    //     respaldo para una subida notoria que aun no llega ahi.
                    const spikeRatioGenerico = (currentOdd != null && p.entry_odd)
                        ? currentOdd / p.entry_odd : null;
                    if (!alertSignal && spikeRatioGenerico != null && spikeRatioGenerico >= 1.15) {
                        alertSignal = 'LINE_MOVED_AGAINST_US';
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
                        score: latestScore,
                        score_ts: estado.score_ts,
                        score_age_min: estado.score_age_min,
                        odd_ts: oddTs,
                        odd_age_min: oddAgeMin,
                        line_withdrawn: lineWithdrawn,
                        // Necesario para poder verificar 'gol reciente' al decidir el envio.
                        score_history: scoreHistory,
                        live_time: latestLiveTime,
                        // Mini-historial de cuotas para sparkline (últimos 20)
                        sparkline: activeHistory.slice(0, 20).reverse().map((s) => s.odd_decimal),
                    };
                });
                // Filtrar picks activos (emitidos en las últimas 3 horas)
                const liveFiltered = live.filter(p => (p.elapsed_min || 0) <= 180);
                // ── SOMBRA DEL MODELO ──
                // Los picks del modelo aprendido, en curso, para el mismo radar. Van en
                // un array APARTE y no dentro de `live` por tres razones concretas:
                //   1. `count` y el badge del rail cuentan exposicion real. Sumar sombra
                //      ahi diria que hay mas dinero en juego del que hay.
                //   2. Los ids de model_picks colisionan con los de picks. Las tarjetas
                //      de sombra SI son clicables, pero abren /api/pick-timeline con
                //      ?source=model; sin ese parametro se abriria OTRO pick.
                //   3. Las alertas (PROFIT_LOCK, posicion deteriorada) hablan de una
                //      posicion abierta. La sombra no tiene ninguna, asi que no se calculan.
                const modelPending = db.prepare(`
          SELECT m.id, m.ts, m.event_id, m.event, m.sport, m.champ, m.market, m.selection,
                 m.odd_decimal AS entry_odd, m.conf_learned, m.conf_heuristic,
                 m.edge_learned, m.tambien_heuristico
          FROM model_picks m
          WHERE m.result IS NULL AND m.ts >= ?
          ORDER BY m.ts DESC
          LIMIT 50
        `).all(liveCutoff);
                const modelLive = modelPending.map((p) => {
                    const history = db.prepare(`
            SELECT odd_decimal, ts, suspended, score, live_time
            FROM snapshots
            WHERE event_id = ? AND market = ? AND selection = ?
            ORDER BY ts DESC
            LIMIT 60
          `).all(p.event_id, p.market, p.selection);
                    const estado = eventState(p.event_id);
                    const activeHistory = history.filter((s) => !s.suspended);
                    const currentOdd = activeHistory.length > 0 ? activeHistory[0].odd_decimal : null;
                    const prevOdd = activeHistory.length > 1 ? activeHistory[1].odd_decimal : null;
                    // Misma deteccion de linea retirada que en los picks reales.
                    const oddTs = activeHistory.length > 0 ? activeHistory[0].ts : null;
                    const oddAgeMin = oddTs ? Math.round((Date.now() - new Date(oddTs).getTime()) / 60000) : null;
                    const lineWithdrawn = !!(oddTs && estado.score_ts
                        && (new Date(estado.score_ts).getTime() - new Date(oddTs).getTime()) > 3 * 60 * 1000);
                    let direction = 'stable';
                    if (currentOdd != null && prevOdd != null) {
                        if (currentOdd > prevOdd + 0.005)
                            direction = 'up';
                        else if (currentOdd < prevOdd - 0.005)
                            direction = 'down';
                    }
                    const liveCLV = (currentOdd != null && p.entry_odd)
                        ? Number(((p.entry_odd - currentOdd) / p.entry_odd * 100).toFixed(2))
                        : null;
                    return {
                        ...p,
                        current_odd: currentOdd,
                        direction,
                        live_clv: liveCLV,
                        elapsed_min: Math.floor((Date.now() - new Date(p.ts).getTime()) / 60000),
                        snapshot_count: history.length,
                        is_suspended: history.length > 0 && history[0].suspended === 1,
                        score: estado.score,
                        live_time: estado.live_time,
                        score_ts: estado.score_ts,
                        score_age_min: estado.score_age_min,
                        odd_ts: oddTs,
                        odd_age_min: oddAgeMin,
                        line_withdrawn: lineWithdrawn,
                        sparkline: activeHistory.slice(0, 20).reverse().map((s) => s.odd_decimal),
                    };
                }).filter((p) => (p.elapsed_min || 0) <= 180);
                res.writeHead(200);
                res.end(JSON.stringify({
                    count: liveFiltered.length,
                    live: liveFiltered,
                    modelCount: modelLive.length,
                    modelLive,
                }));
                return;
            }
            // 5. API Pick Timeline — Detalle de snapshots e historial completo de un pick específico
            if (url.startsWith('/api/pick-timeline')) {
                res.setHeader('Content-Type', 'application/json; charset=utf-8');
                // Lee de `query` y no de `url`: ahora `url` es solo el pathname.
                const pickId = query.get('id');
                if (!pickId) {
                    res.writeHead(400);
                    res.end(JSON.stringify({ error: 'Falta id del pick' }));
                    return;
                }
                // `?source=model` lee de model_picks en vez de picks. Es el mismo
                // timeline —los snapshots son del evento/mercado/seleccion, no del
                // pick— pero la fila de origen es otra tabla y los ids COLISIONAN
                // entre ambas, asi que el origen tiene que venir explicito.
                const isShadow = query.get('source') === 'model';
                const pick = isShadow
                    ? (() => {
                        const m = db.prepare(`SELECT * FROM model_picks WHERE id = ?`).get(pickId);
                        if (!m)
                            return null;
                        // Se normaliza a la forma que espera el resto del handler:
                        // `conf` es la del modelo (es quien decidio) y no hay stake.
                        return { ...m, conf: m.conf_learned, edge: m.edge_learned, stake: null, loss_minute: null };
                    })()
                    : db.prepare(`SELECT * FROM picks WHERE id = ?`).get(pickId);
                if (!pick) {
                    res.writeHead(404);
                    res.end(JSON.stringify({ error: 'Pick no encontrado' }));
                    return;
                }
                // Obtener los snapshots del evento/mercado/seleccion, encadenando
                // hacia la linea inferior si la original deja de cotizarse a medio
                // partido (ver timelineEncadenado arriba).
                const { timeline: snapshots, cambios: cambiosLinea } = timelineEncadenado(pick.event_id, pick.market, pick.selection);
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
                const drawSignal = computeStructuralDrawSignal(activeOdds, pick.final_score || (timeline.length > 0 ? timeline.at(-1).score : ''), { selection: pick.selection, scores: timeline.map((t) => t.score).filter(Boolean).reverse() });
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
                // La sombra no tiene posicion abierta: hablarle de cashout, asegurar
                // ganancia o salvar stake seria inventarse una exposicion inexistente.
                // La trayectoria (el movimiento de linea) si aplica y se conserva.
                if (isShadow) {
                    recommendation = pick.result === 'win'
                        ? `Habría ganado. Pico de recorrido de línea: +${mfePeakRoi}%.`
                        : pick.result === 'loss'
                            ? `Habría perdido. Pico de recorrido de línea antes del giro: +${mfePeakRoi}%.`
                            : lastOdd > initialOdd * 1.15
                                ? 'La línea se movió en contra de la selección del modelo.'
                                : lastOdd < initialOdd * 0.8
                                    ? `La línea se movió con fuerza a favor (MFE +${mfePeakRoi}%).`
                                    : lastOdd < initialOdd
                                        ? 'La línea se mueve a favor de la selección del modelo.'
                                        : 'Línea estable desde la entrada.';
                    recommendation += ' Pick de sombra: no apostado, sin exposición.';
                }
                res.writeHead(200);
                res.end(JSON.stringify({
                    isShadow,
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
                    cambiosLinea,
                }));
                return;
            }
            // 6. API Piloto de Estadísticas — log de la captura de solo lectura.
            //
            // No es un panel de rendimiento y no debe leerse como tal: el piloto no
            // emite ni apuesta nada. Lo que responde es si la CAPTURA se sostiene y
            // si sale ETIQUETA, que es lo que decide si esto puede entrenar algo.
            // Ver src/matchStats.js.
            if (url === '/api/stats-pilot' || url === '/api/corners-pilot') {
                res.setHeader('Content-Type', 'application/json; charset=utf-8');
                const horas = Math.min(168, Math.max(1, Number(query.get('horas')) || 24));
                const desde = new Date(Date.now() - horas * 3600 * 1000).toISOString();
                const fam = query.get('familia');
                const filtroFam = fam ? ' AND familia = ?' : '';
                const argsFam = fam ? [desde, fam] : [desde];
                const resumen = db.prepare(`
          SELECT COUNT(*) filas,
                 COUNT(DISTINCT event_id) eventos,
                 COUNT(DISTINCT ts) muestras,
                 SUM(CASE WHEN conteo IS NOT NULL THEN 1 ELSE 0 END) filasConConteo,
                 SUM(suspended) suspendidas,
                 MIN(ts) desde, MAX(ts) hasta
          FROM stat_snapshots WHERE ts >= ?${filtroFam}
        `).get(...argsFam) || {};
                const porFamilia = db.prepare(`
          SELECT familia, COUNT(*) filas, COUNT(DISTINCT event_id) eventos,
                 SUM(CASE WHEN conteo IS NOT NULL THEN 1 ELSE 0 END) filasConConteo
          FROM stat_snapshots WHERE ts >= ? GROUP BY familia ORDER BY filas DESC
        `).all(desde);
                // ETIQUETAS. Es la cifra que decide: sin `y` no se entrena nada, y
                // cuantas líneas se quedan sin etiquetar mide si el canal aguanta.
                const etiquetas = db.prepare(`
          SELECT COUNT(*) lineas,
                 COUNT(DISTINCT event_id) partidos,
                 SUM(CASE WHEN lado_ganador IS NOT NULL THEN 1 ELSE 0 END) conEtiqueta,
                 SUM(CASE WHEN metodo = 'monotonia' THEN 1 ELSE 0 END) porMonotonia,
                 SUM(CASE WHEN metodo = 'precio_colapsado' THEN 1 ELSE 0 END) porPrecio,
                 SUM(CASE WHEN metodo = 'conteo' THEN 1 ELSE 0 END) porConteo,
                 SUM(CASE WHEN certeza = 'cierta' THEN 1 ELSE 0 END) ciertas,
                 SUM(CASE WHEN certeza = 'probable' THEN 1 ELSE 0 END) probables,
                 SUM(CASE WHEN conteo_censurado = 1 THEN 1 ELSE 0 END) censuradas,
                 SUM(CASE WHEN serie_fiable = 0 THEN 1 ELSE 0 END) serieNoFiable
          FROM stat_results
        `).get() || {};
                const etiquetasPorFamilia = db.prepare(`
          SELECT familia, COUNT(*) lineas,
                 SUM(CASE WHEN lado_ganador IS NOT NULL THEN 1 ELSE 0 END) conEtiqueta
          FROM stat_results GROUP BY familia
        `).all();
                const ultimasEtiquetas = db.prepare(`
          SELECT event, familia, linea, lado_ganador, metodo, certeza, conteo_final,
                 conteo_max, serie_fiable, conteo_censurado, ultimo_minuto,
                 n_muestras, settled_ts
          FROM stat_results ORDER BY settled_ts DESC, event_id, linea LIMIT 120
        `).all();
                // Estado actual por partido: la última muestra de cada evento.
                const ultimas = db.prepare(`
          SELECT c.* FROM stat_snapshots c
          JOIN (SELECT event_id, MAX(ts) mts FROM stat_snapshots
                WHERE ts >= ? GROUP BY event_id) u
            ON c.event_id = u.event_id AND c.ts = u.mts
          WHERE 1=1${filtroFam}
        `).all(...(fam ? [desde, fam] : [desde]));
                // La línea PRINCIPAL viene en el nombre del mercado global ("Total
                // Tiros De Esquina 10.5" / "Total de tarjetas 6.5"). Los de equipo y los
                // de mitad llevan prefijo y se excluyen: mezclarlos daría una "línea del
                // partido" que no existe.
                const esGlobal = (m) => /^total\s+(tiros?\s+de\s+esquina|de\s+tarjetas)/i.test((m || '').trim());
                const lineaDelMercado = (m) => {
                    const x = (m || '').match(/([\d.]+)\s*$/);
                    return x ? Number(x[1]) : null;
                };
                const clave = (r) => `${r.event_id}|${r.familia}`;
                const porEvento = new Map();
                for (const r of ultimas) {
                    const k = clave(r);
                    if (!porEvento.has(k)) {
                        porEvento.set(k, {
                            eventId: r.event_id, event: r.event, champ: r.champ, familia: r.familia,
                            ts: r.ts, liveTime: r.live_time, minute: r.minute, conteo: r.conteo,
                            lineaActual: null, lineas: [], suspendidas: 0,
                        });
                    }
                    const e = porEvento.get(k);
                    if (r.suspended)
                        e.suspendidas++;
                    if (esGlobal(r.market)) {
                        if (e.lineaActual == null)
                            e.lineaActual = lineaDelMercado(r.market);
                        e.lineas.push({ linea: r.linea, lado: r.lado, odd: r.odd_decimal, justa: r.fair_prob, susp: r.suspended });
                    }
                }
                // Deriva de la línea: primera vista vs actual. Es la "tendencia" en el
                // único sentido sostenible hoy — hacia dónde mueve el mercado, no si
                // acierta. Eso solo lo dirán las etiquetas, cuando haya suficientes.
                const primeras = db.prepare(`
          SELECT c.event_id, c.familia, c.market FROM stat_snapshots c
          JOIN (SELECT event_id, familia, MIN(ts) mts FROM stat_snapshots
                WHERE ts >= ? GROUP BY event_id, familia) u
            ON c.event_id = u.event_id AND c.familia = u.familia AND c.ts = u.mts
        `).all(desde);
                const lineaInicial = new Map();
                for (const r of primeras) {
                    const k = clave(r);
                    if (esGlobal(r.market) && !lineaInicial.has(k))
                        lineaInicial.set(k, lineaDelMercado(r.market));
                }
                const eventos = [...porEvento.entries()].map(([k, e]) => {
                    const ini = lineaInicial.get(k) ?? null;
                    const pares = new Map();
                    for (const l of e.lineas) {
                        if (!pares.has(l.linea))
                            pares.set(l.linea, { linea: l.linea });
                        pares.get(l.linea)[l.lado] = { odd: l.odd, justa: l.justa, susp: l.susp };
                    }
                    const escalera = [...pares.values()].sort((a, b) => a.linea - b.linea);
                    // Pivote: la línea cuya probabilidad justa está más cerca de 0.5, o sea
                    // donde el mercado de verdad cree que va a caer el total.
                    let pivote = null;
                    for (const pr of escalera) {
                        if (!pr.over || pr.over.justa == null)
                            continue;
                        if (!pivote || Math.abs(pr.over.justa - 0.5) < Math.abs(pivote.over.justa - 0.5))
                            pivote = pr;
                    }
                    return {
                        eventId: e.eventId, event: e.event, champ: e.champ, familia: e.familia, ts: e.ts,
                        liveTime: e.liveTime, minute: e.minute, conteo: e.conteo,
                        lineaInicial: ini, lineaActual: e.lineaActual,
                        deriva: (ini != null && e.lineaActual != null) ? +(e.lineaActual - ini).toFixed(1) : null,
                        suspendidas: e.suspendidas, pivote, escalera,
                    };
                }).sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
                const conConteo = eventos.filter(e => e.familia === 'corner' && e.conteo != null).length;
                const deCorner = eventos.filter(e => e.familia === 'corner').length;
                // LOG LEGIBLE: una fila por OBSERVACION, no por selección.
                //
                // Antes era un volcado crudo: cada instante de cada partido generaba una
                // docena de filas casi idénticas —mismo evento, mismo mercado, mismo
                // minuto— que solo se diferenciaban en la línea y el lado, con el nombre
                // del mercado truncado. Leerlo era imposible. Ahora cada fila es "este
                // partido, en este instante" y la escalera de líneas va dentro.
                //
                // Solo el mercado GLOBAL. Los de equipo y los de mitad se capturan y
                // siguen en la BD, pero mezclarlos aquí devolvía el mismo amontonamiento
                // que se está arreglando.
                const crudas = db.prepare(`
          SELECT ts, familia, event_id, event, live_time, minute, conteo,
                 conteo_indices, market, selection, linea, lado, odd_decimal,
                 fair_prob, p_poisson, suspended
          FROM stat_snapshots WHERE ts >= ?${filtroFam}
          ORDER BY ts DESC, event_id, familia, linea LIMIT 4000
        `).all(...argsFam);
                const obs = new Map();
                for (const r of crudas) {
                    if (!esGlobal(r.market))
                        continue;
                    const k = `${r.ts}|${r.event_id}|${r.familia}`;
                    if (!obs.has(k)) {
                        obs.set(k, {
                            ts: r.ts, familia: r.familia, event: r.event, liveTime: r.live_time,
                            minute: r.minute, conteo: r.conteo, indices: r.conteo_indices,
                            lineaPrincipal: lineaDelMercado(r.market), escalera: [], suspendidas: 0,
                        });
                    }
                    const o = obs.get(k);
                    if (r.suspended)
                        o.suspendidas++;
                    let par = o.escalera.find((x) => x.linea === r.linea);
                    if (!par) {
                        par = { linea: r.linea };
                        o.escalera.push(par);
                    }
                    par[r.lado] = r.odd_decimal;
                    // Discrepancia Poisson vs mercado, en el lado UNDER por convenio (los
                    // dos lados dan la misma cifra con signo opuesto). Es el sitio donde
                    // mirar si el modelo dice algo distinto del precio; NO es un edge
                    // medido — la lambda es provisional y no hay etiquetas que lo validen.
                    if (r.lado === 'under') {
                        par.justaUnder = r.fair_prob;
                        par.poisson = r.p_poisson;
                        par.dif = (r.p_poisson != null && r.fair_prob != null)
                            ? +(r.p_poisson - r.fair_prob).toFixed(4) : null;
                    }
                    if (r.lado === 'over')
                        par.justaOver = r.fair_prob;
                }
                const log = [...obs.values()]
                    .map(o => ({ ...o, escalera: o.escalera.sort((a, b) => a.linea - b.linea) }))
                    .slice(0, 120);
                res.writeHead(200);
                res.end(JSON.stringify({
                    activo: /^(1|true|on|si|sí)$/i.test(process.env.STATS_PILOT || process.env.CORNERS_PILOT || ''),
                    horas, familia: fam || null,
                    resumen: {
                        ...resumen,
                        eventosConConteo: conConteo,
                        coberturaConteo: deCorner ? +(100 * conConteo / deCorner).toFixed(1) : null,
                    },
                    porFamilia,
                    etiquetas: {
                        ...etiquetas,
                        porFamilia: etiquetasPorFamilia,
                        cobertura: etiquetas.lineas ? +(100 * etiquetas.conEtiqueta / etiquetas.lineas).toFixed(1) : null,
                    },
                    ultimasEtiquetas,
                    eventos,
                    log,
                }));
                return;
            }
            // 6b. API Piloto FotMob — segunda fuente de corners (conteo directo).
            //
            // Panel simple: ¿cuánto matchea contra playdoit, y cuando matchea,
            // coincide con la etiqueta que ya derivaba el piloto original? No mide
            // rendimiento (esto no emite ni apuesta nada) — mide si la fuente sirve.
            if (url === '/api/fotmob-pilot') {
                res.setHeader('Content-Type', 'application/json; charset=utf-8');
                const horas = Math.min(168, Math.max(1, Number(query.get('horas')) || 24));
                const desde = new Date(Date.now() - horas * 3600 * 1000).toISOString();
                const resumen = db.prepare(`
          SELECT COUNT(*) filas, COUNT(DISTINCT fotmob_event_id) eventos,
                 MIN(ts) desde, MAX(ts) hasta
          FROM fotmob_corner_snapshots WHERE ts >= ?
        `).get(desde) || {};
                // Cobertura de match: de las lineas de corners liquidadas por el
                // piloto de playdoit en la ventana, cuantas tienen match de FotMob.
                const match = db.prepare(`
          SELECT COUNT(*) lineas, COUNT(DISTINCT event_id) partidos,
                 SUM(CASE WHEN fotmob_event_id IS NOT NULL THEN 1 ELSE 0 END) lineasConMatch,
                 COUNT(DISTINCT CASE WHEN fotmob_event_id IS NOT NULL THEN event_id END) partidosConMatch
          FROM stat_results WHERE familia = 'corner' AND settled_ts >= ?
        `).get(desde) || {};
                // Comparacion: de lo que SI matcheo (conteo real conocido), cuanto
                // coincide con lo que el piloto de playdoit ya habia derivado.
                // Solo cuenta donde AMBOS lados tienen etiqueta — un NULL de
                // cualquiera de los dos no es ni acierto ni error, es sin dato.
                const comparacion = db.prepare(`
          SELECT COUNT(*) total,
                 SUM(CASE WHEN lado_ganador = fotmob_lado_ganador THEN 1 ELSE 0 END) coinciden,
                 SUM(CASE WHEN lado_ganador IS NOT NULL AND lado_ganador != fotmob_lado_ganador THEN 1 ELSE 0 END) difieren,
                 SUM(CASE WHEN lado_ganador IS NULL THEN 1 ELSE 0 END) soloFotmob
          FROM stat_results
          WHERE familia = 'corner' AND fotmob_lado_ganador IS NOT NULL AND settled_ts >= ?
        `).get(desde) || {};
                const comparadas = db.prepare(`
          SELECT event, linea, lado_ganador, certeza, conteo_final,
                 fotmob_conteo_final, fotmob_lado_ganador, settled_ts
          FROM stat_results
          WHERE familia = 'corner' AND fotmob_lado_ganador IS NOT NULL AND settled_ts >= ?
          ORDER BY settled_ts DESC LIMIT 100
        `).all(desde);
                // Capturas crudas: ULTIMA lectura de cada partido de FotMob visto
                // en la ventana, igual patron que "Estado por partido" del piloto
                // original — es lo que "sale de FotMob" tal cual, sin cruzar con
                // playdoit todavia.
                const capturas = db.prepare(`
          SELECT c.* FROM fotmob_corner_snapshots c
          JOIN (SELECT fotmob_event_id, MAX(ts) mts FROM fotmob_corner_snapshots
                WHERE ts >= ? GROUP BY fotmob_event_id) u
            ON c.fotmob_event_id = u.fotmob_event_id AND c.ts = u.mts
          ORDER BY c.ts DESC LIMIT 150
        `).all(desde);
                // PARTIDOS CON DOS FUENTES, EN VIVO — cruce en memoria, sin Chromium
                // (fetch plano, ver src/fotmobScraper.js).
                //
                // Distinto de `comparadas`: eso solo muestra lineas ya LIQUIDADAS por
                // playdoit (el partido termino). Esto muestra el partido MIENTRAS
                // sigue en curso en ambas fuentes. Se recalcula en cada llamada
                // (ventana corta, ~20 min) en vez de guardarse: es una vista, no un
                // dato a conservar (el HISTORIAL de pronosticos si se guarda, ver
                // saveForecastSnapshot en src/db.js, alimentado desde el ciclo del
                // piloto en bot.js — no desde aqui).
                //
                // Logica compartida con bot.js en src/fotmobLive.js: antes vivia solo
                // aqui, duplicarla para persistir snapshots hubiera arriesgado que
                // el fix de un bug (p.ej. el de signo de `sugerida`, encontrado el
                // 2026-09-10) solo se aplicara a una de las dos copias.
                const dosFuentes = computeDosFuentes(db);
                res.writeHead(200);
                res.end(JSON.stringify({
                    activo: /^(1|true|on|si|sí)$/i.test(process.env.FOTMOB_PILOT || ''),
                    horas,
                    resumen,
                    match: {
                        ...match,
                        coberturaLineas: match.lineas ? +(100 * match.lineasConMatch / match.lineas).toFixed(1) : null,
                        coberturaPartidos: match.partidos ? +(100 * match.partidosConMatch / match.partidos).toFixed(1) : null,
                    },
                    comparacion: {
                        ...comparacion,
                        porcentajeCoincidencia: comparacion.total ? +(100 * comparacion.coinciden / comparacion.total).toFixed(1) : null,
                    },
                    comparadas,
                    capturas,
                    dosFuentes,
                }));
                return;
            }
            // 6b-2. Escaneo de valor PRE-PARTIDO vs. casa sharp (src/prematchValue.js).
            // No espera a "steam" (semanas de historial propio) — compara la cuota
            // de Playdoit contra Pinnacle/Betfair en el mismo instante en que se
            // guardo. Solo lectura, no decide nada; ver PREMATCH_SHARP_SCAN en bot.js.
            if (url === '/api/prematch-value') {
                res.setHeader('Content-Type', 'application/json; charset=utf-8');
                const horas = Math.min(168, Math.max(1, Number(query.get('horas')) || 48));
                const desde = new Date(Date.now() - horas * 3600 * 1000).toISOString();
                const destacadoPct = Number(process.env.PREMATCH_SHARP_SCAN_DESTACADO_PCT || 5);
                const resumen = db.prepare(`
          SELECT COUNT(*) filas, COUNT(DISTINCT event_id) partidos,
                 SUM(CASE WHEN ABS(edge_pct) >= ? THEN 1 ELSE 0 END) destacadas,
                 MIN(ts) desde, MAX(ts) hasta
          FROM prematch_value_scan WHERE ts >= ?
        `).get(destacadoPct, desde) || {};
                // Ultima comparacion por (evento, selection): evita mostrar la misma
                // discrepancia repetida en cada ciclo del escaneo mientras el
                // partido sigue sin arrancar.
                const filas = db.prepare(`
          SELECT s.* FROM prematch_value_scan s
          JOIN (
            SELECT event_id, selection, MAX(ts) mts FROM prematch_value_scan
            WHERE ts >= ? GROUP BY event_id, selection
          ) u ON s.event_id = u.event_id AND s.selection = u.selection AND s.ts = u.mts
          WHERE s.start_date > datetime('now')
          ORDER BY ABS(s.edge_pct) DESC LIMIT 150
        `).all(desde);
                res.writeHead(200);
                res.end(JSON.stringify({
                    activo: /^(1|true|on|si|sí)$/i.test(process.env.PREMATCH_SHARP_SCAN || ''),
                    horas, destacadoPct, resumen, filas,
                }));
                return;
            }
            // 6b-3. Visor de partidos de HOY (pre-partido), sobre prematch_snapshots
            // (src/fetcher.js: fetchPrematch). Solo lectura — es un catalogo para
            // navegar, no decide ni emite nada. "Hoy" en horario CDMX, igual criterio
            // que rangoHoyCDMX en bot.js (00:00 CDMX = 06:00 UTC).
            if (url === '/api/prematch-hoy') {
                res.setHeader('Content-Type', 'application/json; charset=utf-8');
                const diaCDMX = query.get('dia') || new Date(Date.now() - 6 * 3600 * 1000).toISOString().slice(0, 10);
                const inicio = new Date(`${diaCDMX}T06:00:00.000Z`).toISOString();
                const fin = new Date(new Date(inicio).getTime() + 24 * 3600 * 1000).toISOString();
                // Ultima cuota vista de cada (evento, mercado, seleccion) con kickoff en el dia.
                const filas = db.prepare(`
          SELECT s.event_id, s.event, s.champ, s.start_date, s.market, s.selection, s.odd_decimal, s.suspended
          FROM prematch_snapshots s
          JOIN (
            SELECT event_id, market, selection, MAX(ts) mts FROM prematch_snapshots
            WHERE start_date >= ? AND start_date < ? GROUP BY event_id, market, selection
          ) u ON s.event_id = u.event_id AND s.market = u.market AND s.selection = u.selection AND s.ts = u.mts
        `).all(inicio, fin);
                // Agrupar por partido; dentro, por mercado -> lista de {selection, odd}.
                const porEvento = new Map();
                for (const f of filas) {
                    if (!porEvento.has(f.event_id)) {
                        porEvento.set(f.event_id, {
                            eventId: f.event_id, event: f.event, champ: f.champ, startDate: f.start_date, mercados: {},
                        });
                    }
                    const ev = porEvento.get(f.event_id);
                    (ev.mercados[f.market] ||= []).push({ selection: f.selection, odd: f.odd_decimal, suspended: !!f.suspended });
                }
                const partidos = [...porEvento.values()].sort((a, b) => Date.parse(a.startDate) - Date.parse(b.startDate));
                res.writeHead(200);
                res.end(JSON.stringify({ dia: diaCDMX, total: partidos.length, partidos }));
                return;
            }
            // 6b-4. Detalle FotMob de UN partido pre-partido (estadio, arbitro,
            // forma reciente) — bajo demanda, al hacer clic en el visor "Hoy"
            // (src/prematchFotmob.js). No corre en ningun ciclo; solo cuando se pide.
            if (url === '/api/prematch-fotmob') {
                res.setHeader('Content-Type', 'application/json; charset=utf-8');
                const eventId = query.get('eventId');
                if (!eventId) {
                    res.writeHead(400);
                    res.end(JSON.stringify({ error: 'falta eventId' }));
                    return;
                }
                // El handler del server no es async (todo lo demas es sqlite sincrono);
                // esta ruta si necesita red (FotMob), asi que se resuelve aparte.
                datosFotmobDeEvento(Number(eventId))
                    .then((datos) => { res.writeHead(200); res.end(JSON.stringify(datos || { sinMatch: true })); })
                    .catch((e) => { res.writeHead(200); res.end(JSON.stringify({ error: e.message })); });
                return;
            }
            // 6b-5. xG de temporada por equipo, pre-partido (src/prematchXg.js).
            // Señal que NO depende de otra casa (a diferencia del escaneo sharp) ni
            // de esperar movimiento de linea (a diferencia de steam): viene del
            // rendimiento medido del equipo. Solo lectura; ver PREMATCH_XG_PILOT.
            if (url === '/api/prematch-xg') {
                res.setHeader('Content-Type', 'application/json; charset=utf-8');
                const horas = Math.min(720, Math.max(1, Number(query.get('horas')) || 168));
                const desde = new Date(Date.now() - horas * 3600 * 1000).toISOString();
                const resumen = db.prepare(`
          SELECT COUNT(*) filas,
                 SUM(CASE WHEN xg_esperado_total IS NOT NULL THEN 1 ELSE 0 END) conXg,
                 MIN(ts) desde, MAX(ts) hasta
          FROM prematch_xg_scan WHERE ts >= ?
        `).get(desde) || {};
                const filas = db.prepare(`
          SELECT event_id, event, start_date, fotmob_match_id,
                 home_played, home_xg_for, home_xg_against,
                 away_played, away_xg_for, away_xg_against,
                 xg_esperado_local, xg_esperado_visita, xg_esperado_total
          FROM prematch_xg_scan
          WHERE ts >= ? AND xg_esperado_total IS NOT NULL AND start_date > datetime('now')
          ORDER BY start_date ASC LIMIT 150
        `).all(desde);
                res.writeHead(200);
                res.end(JSON.stringify({
                    activo: /^(1|true|on|si|sí)$/i.test(process.env.PREMATCH_XG_PILOT || ''),
                    horas, resumen, filas,
                }));
                return;
            }
            // 6c. Historial de pronosticos de un partido — lo que se ve al hacer
            // clic en el indicador de direccion (↑Mas/↓Menos) de la tabla en vivo.
            // Cada fila es un snapshot guardado por el ciclo del piloto de FotMob
            // en bot.js (ver saveForecastSnapshot en src/db.js): la sugerencia del
            // modelo en ESE momento, con la cuota que tenia entonces — no se
            // recalcula sobre datos actuales, es historia.
            if (url === '/api/fotmob-pilot/historial') {
                res.setHeader('Content-Type', 'application/json; charset=utf-8');
                const eventId = query.get('eventId');
                if (!eventId) {
                    res.writeHead(400);
                    res.end(JSON.stringify({ error: 'falta eventId' }));
                    return;
                }
                const limite = Math.min(200, Math.max(1, Number(query.get('limite')) || 50));
                const historial = getForecastHistory(eventId, limite);
                res.writeHead(200);
                res.end(JSON.stringify({ eventId, historial }));
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
        // ── CACHE PERSISTENTE DE PICKS ALERTADOS (sobrevive reinicios) ──
        const isPickAlerted = (key) => {
            try {
                return !!db.prepare('SELECT key FROM alerted_events WHERE key = ?').get(key);
            }
            catch {
                return false;
            }
        };
        const markPickAlerted = (key) => {
            try {
                db.prepare('INSERT OR IGNORE INTO alerted_events (key, ts) VALUES (?, ?)').run(key, new Date().toISOString());
            }
            catch { }
        };
        const token = process.env.TELEGRAM_BOT_TOKEN;
        const vipChannelId = process.env.TELEGRAM_VIP_CHANNEL_ID;
        const personalChatId = process.env.TELEGRAM_CHAT_ID;
        const targetChatId = vipChannelId || personalChatId;
        if (token && targetChatId) {
            const { sendProfitLockAlert, sendStructuralDrawAlert, sendSniperAlert, sendLineDriftAlert } = require(path.join(__dirname, '..', '..', 'src', 'telegram'));
            // Un Empate Estructural solo se anuncia con el marcador empatado de verdad.
            const isScoreTie = (score) => {
                if (!score)
                    return false;
                const parts = String(score).split('-');
                if (parts.length !== 2)
                    return false;
                const left = Number(parts[0].trim());
                const right = Number(parts[1].trim());
                return !isNaN(left) && !isNaN(right) && left === right;
            };
            setInterval(async () => {
                try {
                    // Escanear picks en desarrollo para Profit Lock / Sniper / Structural Draw.
                    // Llamada interna al propio server: necesita las mismas credenciales que
                    // exige checkAuth desde que el panel puede estar detrás de un túnel
                    // público, si no cada tick devuelve 401 y este loop nunca vuelve a
                    // funcionar. AbortSignal.timeout por el mismo motivo que ya costó un
                    // incidente entero: un fetch sin tope puede colgarse indefinidamente y
                    // no hay quien lo note salvo por el log de "ciclo fallido".
                    const liveHeaders = {};
                    if (DASHBOARD_USER && DASHBOARD_PASS) {
                        liveHeaders['Authorization'] = 'Basic ' + Buffer.from(`${DASHBOARD_USER}:${DASHBOARD_PASS}`).toString('base64');
                    }
                    const liveRes = await fetch(`http://localhost:${port}/api/live`, {
                        headers: liveHeaders,
                        signal: AbortSignal.timeout(10000),
                    }).then(r => r.json());
                    if (!liveRes?.live)
                        return;
                    for (const p of liveRes.live) {
                        if (!p.alert)
                            continue;
                        const alertKey = `${p.id}:${p.alert}`;
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
                        // Se decide PRIMERO y se marca DESPUES. Antes se marcaba nada mas
                        // entrar al bucle, asi que toda alerta que no superara su condicion
                        // quemaba la clave y quedaba muda para siempre: un STRUCTURAL_DRAW
                        // visto con marcador desigual no volvia a dispararse aunque el
                        // partido se empatara un minuto despues.
                        // VERIFICAR EL RESULTADO ANTES DE ENVIAR. Si el marcador actual ya
                        // decide el pick de forma irreversible (un "Menos de 2.5" con 3
                        // goles ya está perdido, pase lo que pase), cualquier alerta sobre
                        // él es ruido: informa de un movimiento de mercado en algo que ya
                        // terminó. Se calla y se deja para la liquidación.
                        const yaDecidido = decidedResult({ market: p.market, selection: p.selection, event: p.event, sport: p.sport }, p.score);
                        if (yaDecidido) {
                            console.log(`[telegram] alerta omitida en Pick #${p.id}: ya decidido (${yaDecidido})`);
                            continue;
                        }
                        // Gol reciente: el mercado aún está repreciando y cualquier lectura
                        // del movimiento es prematura. Es el falso positivo que más ensucia
                        // las alertas de spike.
                        if (recentScoreChange(p.score_history || [], 10)) {
                            console.log(`[telegram] alerta omitida en Pick #${p.id}: gol reciente, mercado sin repreciar`);
                            continue;
                        }
                        let sender = null;
                        let label = '';
                        if (p.alert === 'PROFIT_LOCK') {
                            sender = sendProfitLockAlert;
                            label = '⚡ Profit Lock';
                        }
                        else if (p.alert === 'POSITION_DYING') {
                            sender = sendSniperAlert;
                            label = '⚠️ Posición deteriorada';
                        }
                        else if (p.alert === 'STRUCTURAL_DRAW' && isScoreTie(p.score)) {
                            sender = sendStructuralDrawAlert;
                            label = '🎯 Empate Estructural';
                        }
                        else if (p.alert === 'LINE_MOVED_AGAINST_US') {
                            // Señal de respaldo (solo cuando el momio SUBE, ver el comentario
                            // junto a spikeRatioGenerico mas arriba): se calculaba desde
                            // siempre pero nunca tenia sender asignado, asi que se quedaba
                            // sin avisar a nadie. Pedido explicito del usuario el
                            // 2026-09-12: que el drift de cuota SI se envie, pero solo
                            // cuando de verdad indica un cambio real de estado del pick.
                            sender = sendLineDriftAlert;
                            label = '📊 Movimiento de línea';
                        }
                        if (!sender)
                            continue;
                        if (isPickAlerted(alertKey))
                            continue;
                        // Marcar justo antes de enviar: ante un crash es preferible perder
                        // una alerta que repetirla en el canal.
                        markPickAlerted(alertKey);
                        await sendToBoth(sender);
                        console.log(`[telegram] ${label} enviada para Pick #${p.id}`);
                    }
                }
                catch (e) {
                    // Los fallos de red contra el propio localhost son transitorios, pero
                    // tragarse TODO dejaba invisible cualquier bug del pipeline de alertas
                    // — que es justo como la caida de Profit Lock y Sniper paso inadvertida.
                    console.error(`[alertas] ciclo fallido: ${e && e.message ? e.message : e}`);
                }
            }, 30000);
        }
    });
    return server;
}
if (require.main === module) {
    // Mismo valor que lee bot.js para /dashboard: si difieren, el bot sondearia
    // un puerto y el panel abriria otro.
    createDashboardServer(Number(process.env.DASHBOARD_PORT || 3001));
}
