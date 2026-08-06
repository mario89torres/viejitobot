import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';

const healthPath = path.join(__dirname, '..', '..', 'src', 'health');
const metricsPath = path.join(__dirname, '..', '..', 'src', 'metrics');
const dbPath = path.join(__dirname, '..', '..', 'src', 'db');
const confPath = path.join(__dirname, '..', '..', 'src', 'confidence');

const dashboardDir = path.join(__dirname, '..', '..', 'dashboard');

const { calculateQuantitativeHealth } = require(healthPath);
const { stakeStats } = require(metricsPath);
const { db } = require(dbPath);
const { excludedSports, isBlockedMarket, isBlockedOver, isSuspensionOrInstabilityInWindow } = require(confPath);

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

        const accepted = rawPicks.filter((r: any) => {
          const isExclSport = excl.includes(normSport(r.sport));
          const isOver = isBlockedOver(r);
          const isMktBlocked = isBlockedMarket(r);
          const isWindowInvalid = isSuspensionOrInstabilityInWindow(r, 60);
          return !isExclSport && !isOver && !isMktBlocked && !isWindowInvalid;
        }).slice(0, 50).map((r: any) => {
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
          const isWindowInvalid = isSuspensionOrInstabilityInWindow(r, 60);
          return isExclSport || isOver || isMktBlocked || isWindowInvalid;
        }).map((r: any) => {
          let reason = 'Mercado Bloqueado';
          if (excl.includes(normSport(r.sport))) reason = 'Deporte Excluido';
          else if (isBlockedOver(r)) reason = 'Over en Fútbol Bloqueado';
          else if (isSuspensionOrInstabilityInWindow(r, 60)) reason = 'Suspensión/Inestabilidad en 1 min';
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

        const live = pending.map((p: any) => {
          // Historial de cuotas de los últimos 60 snapshots
          const history = db.prepare(`
            SELECT odd_decimal, ts, suspended
            FROM snapshots
            WHERE event_id = ? AND market = ? AND selection = ?
            ORDER BY ts DESC
            LIMIT 60
          `).all(p.event_id, p.market, p.selection) as any[];

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

          // Señal de alerta: movimiento brusco > 5% en últimos snapshots
          let alertSignal: string | null = null;
          if (liveCLV !== null && Math.abs(liveCLV) > 5) {
            alertSignal = liveCLV > 0 ? 'LINE_MOVED_AGAINST_US' : 'LINE_MOVED_FOR_US';
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
            // Mini-historial de cuotas para sparkline (últimos 20)
            sparkline: activeHistory.slice(0, 20).reverse().map((s: any) => s.odd_decimal),
          };
        });

        res.writeHead(200);
        res.end(JSON.stringify({ count: live.length, live }));
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

        // Calcular diagnóstico / trayectoria
        const activeOdds = timeline.filter((s: any) => !s.suspended && s.odd_decimal > 0).map((s: any) => s.odd_decimal);
        const minOdd = activeOdds.length > 0 ? Math.min(...activeOdds) : pick.odd_decimal;
        const maxOdd = activeOdds.length > 0 ? Math.max(...activeOdds) : pick.odd_decimal;
        const initialOdd = pick.odd_decimal;
        const lastOdd = activeOdds.length > 0 ? activeOdds.at(-1) : pick.odd_decimal;

        // Trayectoria: 'FAVORABLE', 'DESFAVORABLE', 'CRÍTICO'
        let trajectory = 'ESTABLE';
        let recommendation = 'MANTENER: Posición sin desviaciones extremas.';
        let recColor = '#98c379'; // verde

        if (pick.result === 'win') {
          trajectory = 'VICTORIA CONFIRMADA';
          recommendation = 'GANADO: Cobro total realizado.';
          recColor = '#98c379';
        } else if (pick.result === 'loss') {
          trajectory = 'PÉRDIDA CONFIRMADA';
          recommendation = pick.loss_minute ? `PERDIDO: Ocurrió colapso en min ${pick.loss_minute}'.` : 'PERDIDO: Evento finalizado en contra.';
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
            recommendation = '✅ EXCELENTE: La cuota bajó >20%. Probabilidad implícita en aumento constante.';
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
  });

  return server;
}

if (require.main === module) {
  createDashboardServer(3001);
}
