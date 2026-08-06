// Etapa 5: rellena opening_odd_decimal y f_apertura en picks históricos usando
// la primera observación en vivo de cada mercado (snapshots). Idempotente:
// solo toca picks donde f_apertura es NULL. Sin fuga de datos: la primera
// observación siempre es anterior al pick.
const { db } = require('../src/db');
const { aperturaFactor } = require('../src/confidence');

const picks = db.prepare(`
  SELECT id, event_id, market, selection, odd_decimal FROM picks WHERE f_apertura IS NULL
`).all();
const firstStmt = db.prepare(`
  SELECT odd_decimal FROM snapshots
  WHERE event_id = ? AND market = ? AND selection = ? AND suspended = 0
  ORDER BY ts ASC LIMIT 1
`);
const upd = db.prepare(`UPDATE picks SET opening_odd_decimal = ?, f_apertura = ? WHERE id = ?`);

let done = 0, skipped = 0;
for (const p of picks) {
  const first = firstStmt.get(p.event_id, p.market, p.selection);
  if (!first) { skipped++; continue; }
  upd.run(first.odd_decimal, aperturaFactor(first.odd_decimal, p.odd_decimal), p.id);
  done++;
}
console.log(`Backfill apertura: ${done} picks actualizados, ${skipped} sin snapshots (quedan NULL).`);
