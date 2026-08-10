import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';

require('dotenv').config();

const healthPath = path.join(__dirname, '..', '..', 'src', 'health');
const metricsPath = path.join(__dirname, '..', '..', 'src', 'metrics');
const dbPath = path.join(__dirname, '..', '..', 'src', 'db');
const confPath = path.join(__dirname, '..', '..', 'src', 'confidence');
const marketsPath = path.join(__dirname, '..', '..', 'src', 'markets');

const dashboardDir = path.join(__dirname, '..', '..', 'dashboard');

const { calculateQuantitativeHealth } = require(healthPath);
const { stakeStats } = require(metricsPath);
const { db } = require(dbPath);
const { excludedSports, isBlockedMarket, isBlockedOver, isSuspensionOrInstabilityInWindow, computeStructuralDrawSignal, recentScoreChange } = require(confPath);
// decidedResult: solo devuelve resultado cuando ya es IRREVERSIBLE. Se usa para
// callar alertas sobre picks que en la practica ya terminaron.
const { decidedResult } = require(marketsPath);

const normSport = (s: string) => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

export function createDashboardServer(port = 3001) {
  const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
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
                 result, loss_minute
          FROM picks
          WHERE stake IS NOT NULL
          ORDER BY ts DESC
          LIMIT ?
        `).all(limit * 2);

        const accepted = rawPicks.filter((r: any) => {
          const isExclSport = excl.includes(normSport(r.sport));
          const isOver = isBlockedOver(r);
          const isMktBlocked = isBlockedMarket(r);
          return !isExclSport && !isOver && !isMktBlocked;
        }).slice(0, limit).map((r: any) => {
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

        const rejected = rawPicks.filter((r: any) => {
          const isExclSport = excl.includes(normSport(r.sport));
          const isOver = isBlockedOver(r);
          const isMktBlocked = isBlockedMarket(r);
          return isExclSport || isOver || isMktBlocked;
        }).map((r: any) => {
          let reason = 'Mercado Bloqueado';
          if (excl.includes(normSport(r.sport))) reason = 'Deporte Excluido';
          else if (isBlockedOver(r)) reason = 'Over en Fútbol Bloqueado';
          else if (/m[aá]s de/i.test(r.selection || '') && (r.market || '').match(/4\.5|5\.0|5\.5/)) reason = 'Over >= 4.5 Bloqueado';
          else if ((r.market || '').toLowerCase().includes('empate no accion')) reason = 'DNB Débil / No Cumple Edge';

          let statusTag = '⚪ Pendiente';
          if (r.result === 'win') {
            statusTag = `✅ Ganado (+${(r.stake * (r.odd_decimal - 1)).toFixed(2)}u)`;
          } else if (r.result === 'loss') {
            const minStr = r.loss_minute ? ` min ${r.loss_minute}'` : '';
            statusTag = `❌ Perdido (-${r.stake.toFixed(2)}u${minStr})`;
            savedUnits += r.stake;
            totalLossesAvoided += 1;
          } else if (r.result === 'push') {
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
        `).all() as any[];

        const liquidados = rows.filter((r: any) => r.result === 'win' || r.result === 'loss');
        const wins = liquidados.filter((r: any) => r.result === 'win').length;

        const porRegla: Record<string, { n: number; win: number; loss: number }> = {};
        for (const r of liquidados) {
          const k = r.reject_rule || '(sin regla)';
          porRegla[k] = porRegla[k] || { n: 0, win: 0, loss: 0 };
          porRegla[k].n++;
          if (r.result === 'win') porRegla[k].win++; else porRegla[k].loss++;
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
          rows: rows.map((r: any) => ({
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
          WHERE (p.result IS NULL OR p.result = 'unknown')
          ORDER BY p.ts DESC
          LIMIT 50
        `).all();

        const live = pending.map((p: any) => {
          // Historial de cuotas de los últimos 60 snapshots
          const history = db.prepare(`
            SELECT odd_decimal, ts, suspended, score, live_time
            FROM snapshots
            WHERE event_id = ? AND market = ? AND selection = ?
            ORDER BY ts DESC
            LIMIT 60
          `).all(p.event_id, p.market, p.selection) as any[];

          // Último marcador y minuto conocido (de cualquier snapshot, incluidos suspendidos)
          const latestWithScore = history.find((s: any) => s.score && s.score !== '');
          const latestScore = latestWithScore ? latestWithScore.score : null;
          const latestLiveTime = latestWithScore ? latestWithScore.live_time : null;

          const activeHistory = history.filter((s: any) => !s.suspended);
          const currentOdd = activeHistory.length > 0 ? activeHistory[0].odd_decimal : null;
          const prevOdd    = activeHistory.length > 1 ? activeHistory[1].odd_decimal : null;
          const oldestOdd  = activeHistory.length > 0 ? activeHistory.at(-1)!.odd_decimal : null;

          // Dirección del último movimiento
          let direction = 'stable';
          if (currentOdd != null && prevOdd != null) {
            if (currentOdd > prevOdd + 0.005) direction = 'up';
            else if (currentOdd < prevOdd - 0.005) direction = 'down';
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
          let alertSignal: string | null = null;
          let lockedProfitPct: number | null = null;
          let sniperSpikeRatio: number | null = null;

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
          const oddsArray = activeHistory.map((s: any) => s.odd_decimal);
          const scoreHistory = history.map((s: any) => s.score).filter(Boolean);
          const drawSignal = computeStructuralDrawSignal(oddsArray, latestScore || p.score, {
            selection: p.selection,
            scores: scoreHistory,
          });
          if (drawSignal.isStructuralDraw && !alertSignal) {
            alertSignal = 'STRUCTURAL_DRAW';
          }

          // Movimientos genéricos de línea (solo si no hay alerta prioritaria de LOCK, SNIPER o DRAW)
          if (!alertSignal && Math.abs(liveCLV || 0) > 5) {
            alertSignal = liveCLV! > 0 ? 'LINE_MOVED_AGAINST_US' : 'LINE_MOVED_FOR_US';
          }

          if (isSuspended) alertSignal = 'SUSPENDED';

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
            // Necesario para poder verificar 'gol reciente' al decidir el envio.
            score_history: scoreHistory,
            live_time: latestLiveTime,
            // Mini-historial de cuotas para sparkline (últimos 20)
            sparkline: activeHistory.slice(0, 20).reverse().map((s: any) => s.odd_decimal),
          };
        });

            // Filtrar picks activos (emitidos en las últimas 3 horas)
            const liveFiltered = live.filter(p => (p.elapsed_min || 0) <= 180);
            res.writeHead(200);
            res.end(JSON.stringify({ count: liveFiltered.length, live: liveFiltered }));
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
        // Lee de `query` y no de `url`: ahora `url` es solo el pathname.
        const pickId = query.get('id');

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
        const activeOdds = timeline.filter((s: any) => !s.suspended && s.odd_decimal > 0).map((s: any) => s.odd_decimal);
        const minOdd = activeOdds.length > 0 ? Math.min(...activeOdds) : pick.odd_decimal;
        const maxOdd = activeOdds.length > 0 ? Math.max(...activeOdds) : pick.odd_decimal;
        const initialOdd = pick.odd_decimal;
        const lastOdd = activeOdds.length > 0 ? activeOdds.at(-1) : pick.odd_decimal;

        // MFE Peak ROI (% Máximo de ganancia posible en el mejor momento del partido)
        const mfePeakRoi = (initialOdd && minOdd && minOdd < initialOdd)
          ? Number(((initialOdd - minOdd) / minOdd * 100).toFixed(1))
          : 0;

        const drawSignal = computeStructuralDrawSignal(
          activeOdds,
          pick.final_score || (timeline.length > 0 ? timeline.at(-1).score : ''),
          { selection: pick.selection, scores: timeline.map((t: any) => t.score).filter(Boolean).reverse() }
        );

        let trajectory = 'ESTABLE';
        let recommendation = 'MANTENER: Posición sin desviaciones extremas.';
        let recColor = '#98c379'; // verde

        if (drawSignal.isStructuralDraw && pick.result !== 'win' && pick.result !== 'loss') {
          trajectory = '🎯 EMPATE ESTRUCTURAL (FLATLINE)';
          recommendation = `🎯 SEÑAL EMPATE ESTRUCTURAL: La cuota entró en una meseta horizontal ultrastable (Varianza ${drawSignal.variance} en 20+ snaps). El partido entró en equilibrio táctico definitivo. Alta probabilidad de Empate / Under.`;
          recColor = '#56b6c2'; // cyan
        } else if (mfePeakRoi >= 30 && pick.result !== 'win') {
          trajectory = '⚡ PROFIT LOCK ALCANZADO';
          recommendation = `⚡ LOCK PROFIT / CASHOUT: Este pick alcanzó un pico máximo de ganancia de +${mfePeakRoi}% (cuota cayó a @${minOdd.toFixed(2)}). Recomendado asegurar ganancia.`;
          recColor = '#e5c07b'; // oro
        } else if (pick.result === 'win') {
          trajectory = 'VICTORIA CONFIRMADA';
          recommendation = `GANADO: Cobro total realizado. (Pico de ganancia alcanzado: +${mfePeakRoi}% MFE).`;
          recColor = '#98c379';
        } else if (pick.result === 'loss') {
          trajectory = mfePeakRoi >= 25 ? 'PÉRDIDA TRAS PICO CASHOUT' : 'PÉRDIDA CONFIRMADA';
          recommendation = mfePeakRoi >= 25
            ? `PERDIDO AL FINAL: El pick dio oportunidad de Cashout de +${mfePeakRoi}% (cuota @${minOdd.toFixed(2)}) antes del colapso en min ${pick.loss_minute || 'final'}.`
            : (pick.loss_minute ? `PERDIDO: Ocurrió colapso en min ${pick.loss_minute}'.` : 'PERDIDO: Evento finalizado en contra.');
          recColor = '#e06c75';
        } else {
          // Pick pendiente en vivo
          if (lastOdd > initialOdd * 1.5) {
            trajectory = 'DESFAVORABLE CRÍTICO';
            recommendation = '⚠️ ALERTA CASHOUT: La cuota subió >50%. Evaluar cashout o cobertura para salvar stake.';
            recColor = '#e06c75';
          } else if (lastOdd > initialOdd * 1.15) {
            trajectory = 'DESFAVORABLE MODERADO';
            recommendation = '⚠️ PRECAUCIÓN: La cuota subió >15%. Monitorear tendencia de goles/puntos.';
            recColor = '#e5c07b';
          } else if (lastOdd < initialOdd * 0.8) {
            trajectory = 'MUY FAVORABLE';
            recommendation = `✅ EXCELENTE: La cuota bajó >20%. MFE actual: +${mfePeakRoi}% ROI.`;
            recColor = '#98c379';
          } else if (lastOdd < initialOdd) {
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
    } catch (e: any) {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.writeHead(500);
      res.end(JSON.stringify({ error: e.message }));
    }
  });

  server.listen(port, () => {
    console.log(`[Dashboard API] Servidor Web y API de métricas cuantitativas activo en http://localhost:${port}`);

    // ── CACHE PERSISTENTE DE PICKS ALERTADOS (sobrevive reinicios) ──
    const isPickAlerted = (key: string): boolean => {
      try { return !!db.prepare('SELECT key FROM alerted_events WHERE key = ?').get(key); } catch { return false; }
    };
    const markPickAlerted = (key: string): void => {
      try { db.prepare('INSERT OR IGNORE INTO alerted_events (key, ts) VALUES (?, ?)').run(key, new Date().toISOString()); } catch {}
    };
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const vipChannelId = process.env.TELEGRAM_VIP_CHANNEL_ID;
    const personalChatId = process.env.TELEGRAM_CHAT_ID;
    const targetChatId = vipChannelId || personalChatId;

    if (token && targetChatId) {
      const { sendProfitLockAlert, sendStructuralDrawAlert, sendSniperAlert } = require(path.join(__dirname, '..', '..', 'src', 'telegram'));
      const { checkAndBroadcastGlobalDraws } = require(path.join(__dirname, '..', 'globalDrawScanner'));

      // Un Empate Estructural solo se anuncia con el marcador empatado de verdad.
      const isScoreTie = (score: string | null): boolean => {
        if (!score) return false;
        const parts = String(score).split('-');
        if (parts.length !== 2) return false;
        const left = Number(parts[0].trim());
        const right = Number(parts[1].trim());
        return !isNaN(left) && !isNaN(right) && left === right;
      };

      setInterval(async () => {
        try {
          // 1. Escanear todo el universo de partidos de fútbol en min 75+ (Global Draw Scanner)
          await checkAndBroadcastGlobalDraws(token, targetChatId);

          // 2. Escanear picks en desarrollo para Profit Lock / Sniper / Structural Draw
          const liveRes: any = await fetch(`http://localhost:${port}/api/live`).then(r => r.json());
          if (!liveRes?.live) return;

          for (const p of liveRes.live) {
            if (!p.alert) continue;
            const alertKey = `${p.id}:${p.alert}`;

            const sendToBoth = async (fn: Function) => {
              if (vipChannelId) {
                try { await fn(token, vipChannelId, p); } catch (e: any) { console.error(`[telegram] Error envio VIP: ${e.message}`); }
              }
              if (personalChatId && personalChatId !== vipChannelId) {
                try { await fn(token, personalChatId, p); } catch (e: any) { console.error(`[telegram] Error envio Personal: ${e.message}`); }
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
            const yaDecidido = decidedResult(
              { market: p.market, selection: p.selection, event: p.event, sport: p.sport },
              p.score
            );
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

            let sender: Function | null = null;
            let label = '';
            if (p.alert === 'PROFIT_LOCK') {
              sender = sendProfitLockAlert; label = '⚡ Profit Lock';
            } else if (p.alert === 'POSITION_DYING') {
              sender = sendSniperAlert; label = '⚠️ Posición deteriorada';
            } else if (p.alert === 'STRUCTURAL_DRAW' && isScoreTie(p.score)) {
              sender = sendStructuralDrawAlert; label = '🎯 Empate Estructural';
            }
            if (!sender) continue;

            if (isPickAlerted(alertKey)) continue;
            // Marcar justo antes de enviar: ante un crash es preferible perder
            // una alerta que repetirla en el canal.
            markPickAlerted(alertKey);
            await sendToBoth(sender);
            console.log(`[telegram] ${label} enviada para Pick #${p.id}`);
          }
        } catch (e: any) {
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
