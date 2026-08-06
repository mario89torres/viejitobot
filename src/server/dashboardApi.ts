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
const { excludedSports, isBlockedMarket, isBlockedOver } = require(confPath);

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
      // 1. API Endpoints
      if (url === '/api/summary') {
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        const health = calculateQuantitativeHealth({ windowDays: 30 });
        const stats = stakeStats();
        res.writeHead(200);
        res.end(JSON.stringify({ health, stats }));
        return;
      }

      if (url === '/api/rejected') {
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        const excl = excludedSports();
        const rawPicks = db.prepare(`
          SELECT id, ts, event_id, event, sport, market, selection, odd_decimal, conf, result, final_score, stake, loss_minute
          FROM picks
          WHERE stake IS NOT NULL AND result IN ('win', 'loss')
          ORDER BY ts DESC
          LIMIT 200
        `).all();

        const rejected = rawPicks.filter((r: any) => {
          const isExclSport = excl.includes(normSport(r.sport));
          const isOver = isBlockedOver(r);
          const isMktBlocked = isBlockedMarket(r);
          return isExclSport || isOver || isMktBlocked;
        }).map((r: any) => {
          let reason = 'Mercado Bloqueado';
          if (excl.includes(normSport(r.sport))) reason = 'Deporte Excluido';
          else if (isBlockedOver(r)) reason = 'Over en Fútbol Bloqueado';
          else if (/m[aá]s de|menos de/i.test(r.selection) && (r.market || '').includes('4.5')) reason = 'Línea >= 4.5 Bloqueada';
          else if ((r.market || '').toLowerCase().includes('empate no accion')) reason = 'DNB Débil / No Cumple Edge';
          return { ...r, reason };
        });

        res.writeHead(200);
        res.end(JSON.stringify({ rejectedCount: rejected.length, rejected }));
        return;
      }

      // 2. Archivos Estáticos del Dashboard (/ -> index.html, /app.js)
      let filePath = path.join(dashboardDir, url === '/' ? 'index.html' : url);
      if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        const ext = path.extname(filePath);
        const contentType = ext === '.html' ? 'text/html; charset=utf-8' :
                            ext === '.js' ? 'application/javascript; charset=utf-8' :
                            ext === '.css' ? 'text/css; charset=utf-8' : 'text/plain';
        res.setHeader('Content-Type', contentType);
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
