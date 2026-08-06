require('dotenv').config();
const { db } = require('../src/db');
const { parsePick } = require('../src/markets');

console.log('=== Calculando el minuto exacto de pérdida para picks fallidos ===');

const lostPicks = db.prepare(`
  SELECT id, ts, event_id, event, sport, market, selection, odd_decimal, conf, result, final_score, settled_ts, loss_minute
  FROM picks
  WHERE result = 'loss'
`).all();

console.log(`Picks perdidos encontrados: ${lostPicks.length}`);

const parseMin = lt => {
  if (!lt) return null;
  const m = String(lt).match(/^(\d+)/);
  return m ? Number(m[1]) : null;
};

const updateStmt = db.prepare('UPDATE picks SET loss_minute = ? WHERE id = ?');

let updatedCount = 0;
for (const p of lostPicks) {
  // Buscar en snapshots el momento en que se superó la línea o se definió la pérdida
  const snapshots = db.prepare(`
    SELECT ts, score, live_time
    FROM snapshots
    WHERE event_id = ? AND ts >= ?
    ORDER BY ts ASC
  `).all(p.event_id, p.ts);

  const parsed = parsePick(p);
  let lossMin = null;

  if (parsed && parsed.type === 'total') {
    // Para Totales (Over/Under), buscar el primer snapshot donde los goles alcanzaron o superaron la línea
    for (const snap of snapshots) {
      const mScore = (snap.score || '').match(/^(\d+)-(\d+)$/);
      if (mScore) {
        const currentGoals = Number(mScore[1]) + Number(mScore[2]);
        if (!parsed.over && currentGoals >= parsed.line) {
          lossMin = parseMin(snap.live_time);
          break;
        } else if (parsed.over && currentGoals < parsed.line && snap.live_time && snap.live_time.includes('90')) {
          lossMin = parseMin(snap.live_time);
        }
      }
    }
  }

  // Fallback: si no se encontró en snapshots intermedios, buscar en el último snapshot o al final del partido
  if (lossMin === null && snapshots.length > 0) {
    const lastSnap = snapshots[snapshots.length - 1];
    lossMin = parseMin(lastSnap.live_time);
  }

  if (lossMin !== null) {
    updateStmt.run(lossMin, p.id);
    updatedCount++;
    console.log(`Pick ID ${p.id} | ${p.event} | ${p.market} -> ${p.selection} | Pérdida registrada en min ${lossMin}'`);
  } else {
    console.log(`Pick ID ${p.id} | ${p.event} | Sin snapshot de minuto específico.`);
  }
}

console.log(`Completado. ${updatedCount}/${lostPicks.length} picks perdidos tienen ahora su minuto asignado.`);
