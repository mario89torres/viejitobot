/**
 * scripts/recolectar-xg-fotmob.js
 * ─────────────────────────────────────────────────────────────────────────
 * Baja de FotMob, para ligas y temporadas COMPLETAS ya jugadas, el xG por partido
 * (local y visita) y los goles, y los guarda en scratch/fotmob-xg/ para el
 * backtest de si el xG de temporada predice los goles (scripts/backtest-xg-goles.js).
 * Con cache y reanudable: no vuelve a pedir un partido ya guardado. Solo lectura.
 *
 * Por que hace falta: el piloto prematch_xg_scan solo tiene un partido con
 * resultado (el xG "de temporada" que guarda es el acumulado ANTES de cada
 * partido, y FotMob solo sirve el acumulado actual). Para probar la señal con
 * miles de partidos se reconstruye ese acumulado a partir del xG de cada
 * partido jugado.
 *
 *   node scripts/recolectar-xg-fotmob.js [--conc 3]
 */
const fs = require('fs');
const path = require('path');

const LIGAS = [
  { id: 47, nombre: 'Premier League', csv: 'E0' },
  { id: 87, nombre: 'LaLiga', csv: 'SP1' },
  { id: 54, nombre: 'Bundesliga', csv: 'D1' },
  { id: 55, nombre: 'Serie A', csv: 'I1' },
  { id: 53, nombre: 'Ligue 1', csv: 'F1' },
];
const TEMPORADAS = ['2024/2025', '2025/2026'];

/** {home, away} de un xG "0.14" / 0.14 / null; null si falta o no es numerico. */
function parseXg(extra) {
  const x = extra && extra['Expected goals (xG)'];
  if (!x) return null;
  const h = Number(x.home), a = Number(x.away);
  return Number.isFinite(h) && Number.isFinite(a) ? { home: h, away: a } : null;
}

module.exports = { parseXg, LIGAS, TEMPORADAS };

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });

async function main() {
  require('dotenv').config();
  const { fetchJson, extraerTeamStats } = require('../src/fotmobScraper');
  const i = process.argv.indexOf('--conc');
  const CONC = i > 0 ? Number(process.argv[i + 1]) : 3;
  const dir = path.join(__dirname, '..', 'scratch', 'fotmob-xg');
  fs.mkdirSync(dir, { recursive: true });

  for (const liga of LIGAS) {
    for (const temp of TEMPORADAS) {
      const archivo = path.join(dir, `${liga.id}_${temp.replace('/', '-')}.json`);
      const guardados = fs.existsSync(archivo) ? JSON.parse(fs.readFileSync(archivo, 'utf8')) : [];
      const porId = new Map(guardados.map(r => [r.id, r]));

      let calendario;
      try { calendario = (await fetchJson(`/data/leagues?id=${liga.id}&season=${encodeURIComponent(temp)}&ccode3=MEX`, { timeoutMs: 30000 })).fixtures?.allMatches || []; }
      catch (e) { console.log(`${liga.nombre} ${temp}: sin calendario (${e.message})`); continue; }
      const jugados = calendario.filter(m => m.status?.finished && !m.status?.cancelled);
      const faltan = jugados.filter(m => !porId.has(String(m.id)));
      console.log(`${liga.nombre} ${temp}: ${jugados.length} jugados, ${porId.size} en cache, ${faltan.length} por bajar`);

      let hechos = 0;
      const cola = [...faltan];
      const trabajador = async () => {
        while (cola.length) {
          const m = cola.shift();
          for (let intento = 0; intento < 2; intento++) {
            try {
              const d = await fetchJson(`/data/matchDetails?matchId=${m.id}`, { timeoutMs: 20000 });
              const tm = d?.header?.teams || [];
              const xg = parseXg(extraerTeamStats(d).extra);
              porId.set(String(m.id), {
                id: String(m.id), liga: liga.id, temp, fecha: m.status.utcTime, ronda: m.round,
                home: m.home?.name, away: m.away?.name, homeId: m.home?.id, awayId: m.away?.id,
                gl: Number.isInteger(tm[0]?.score) ? tm[0].score : null, gv: Number.isInteger(tm[1]?.score) ? tm[1].score : null,
                xgH: xg ? xg.home : null, xgA: xg ? xg.away : null,
              });
              break;
            } catch (e) { if (intento === 1) porId.set(String(m.id), { id: String(m.id), liga: liga.id, temp, fecha: m.status.utcTime, error: e.message }); }
          }
          hechos++;
          if (hechos % 60 === 0) { fs.writeFileSync(archivo, JSON.stringify([...porId.values()])); console.log(`  ${liga.nombre} ${temp}: ${hechos}/${faltan.length}`); }
          await new Promise(r => setTimeout(r, 120));
        }
      };
      await Promise.all(Array.from({ length: CONC }, trabajador));
      fs.writeFileSync(archivo, JSON.stringify([...porId.values()]));
      const conXg = [...porId.values()].filter(r => r.xgH != null).length;
      console.log(`  ${liga.nombre} ${temp}: guardados ${porId.size}, con xG ${conXg}`);
    }
  }
  console.log('recoleccion terminada');
}
