// Prueba de liquidación: inserta un pick + snapshot ficticios, simula el paso
// del tiempo y verifica que se registren result_source y línea de cierre.
const { db, logPicks, saveSnapshot } = require('../src/db');
const { processSettlements } = require('../src/results');

const EVENT_ID = 999999901;
const now = new Date().toISOString();

db.prepare('DELETE FROM picks WHERE event_id = ?').run(EVENT_ID);
db.prepare('DELETE FROM snapshots WHERE event_id = ?').run(EVENT_ID);

saveSnapshot([{
  ts: now, sport: 'Fútbol', sportId: 1, champ: 'Test Liga',
  eventId: EVENT_ID, event: 'Equipo A vs Equipo B',
  score: '2-0', liveTime: "88'",
  market: 'Ganador del partido', selection: 'Equipo A',
  oddDecimal: 1.10, oddAmerican: '-1000', suspended: 0,
}]);

logPicks([{
  ts: now, eventId: EVENT_ID, event: 'Equipo A vs Equipo B', sport: 'Fútbol',
  market: 'Ganador del partido', selection: 'Equipo A', oddDecimal: 1.20, conf: 0.8,
}]);

(async () => {
  const realNow = Date.now;
  const t0 = realNow();
  // 1ª pasada: el evento no está en vivo -> se marca como desaparecido
  await processSettlements(new Set());
  // Simular 16 minutos después (agota la escalera [2,5,15])
  Date.now = () => t0 + 16 * 60 * 1000;
  await processSettlements(new Set());
  Date.now = realNow;

  const pick = db.prepare('SELECT * FROM picks WHERE event_id = ?').get(EVENT_ID);
  console.log(JSON.stringify(pick, null, 2));

  const ok = pick.result === 'win' && pick.result_source === 'last_sample'
    && pick.closing_odd_decimal === 1.10 && pick.closing_ts === now
    && pick.final_score === '2-0';
  console.log(ok ? 'SETTLEMENT OK' : 'SETTLEMENT FALLO');

  db.prepare('DELETE FROM picks WHERE event_id = ?').run(EVENT_ID);
  db.prepare('DELETE FROM snapshots WHERE event_id = ?').run(EVENT_ID);
  process.exit(ok ? 0 : 1);
})();
