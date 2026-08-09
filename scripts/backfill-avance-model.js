/**
 * Backfill de picks.f_avance_model — cierra el train/serve skew de f_avance.
 *
 * EL BUG: la columna `f_avance` guarda el avance CRUDO (bot.js pasaba
 * `fAvance: p.progress`), pero el modelo consume una versión transformada
 * (para un "Más de X" con la línea aún sin alcanzar, es `1 - progress`).
 * export-dataset.js exportaba la columna cruda, así que train_weights.py
 * entrenaba con un valor y model.js recibía en vivo el ESPEJO de ese valor en
 * cada pick Over. El coeficiente aprendido de f_avance (+1.735) está ajustado
 * sobre una feature que en producción nunca se sirvió tal cual.
 *
 * EL ARREGLO: `f_avance_model` guarda el valor realmente servido. Este script
 * lo reconstruye para el histórico usando `avanceForModel()` — la MISMA función
 * pura que usa scoreRow en producción, importada, no reimplementada. El
 * marcador al momento de emitir se recupera del snapshot inmediatamente
 * anterior al ts del pick (recuperable al 100%: la exención de poda para
 * eventos con picks preservó justo esos snapshots).
 *
 * No toca `f_avance`: el firewall y sus backtests dependen del crudo.
 *
 * Uso:
 *   node scripts/backfill-avance-model.js            # dry-run, no escribe
 *   node scripts/backfill-avance-model.js --apply    # escribe
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { db } = require('../src/db');
const { parsePick } = require('../src/markets');
const { avanceForModel } = require('../src/confidence');

const APPLY = process.argv.includes('--apply');

const rows = db.prepare(`
  SELECT id, ts, event_id, event, market, selection, f_avance
  FROM picks
  WHERE f_avance IS NOT NULL AND f_avance_model IS NULL
  ORDER BY ts
`).all();

const snapAt = db.prepare(`
  SELECT score FROM snapshots
  WHERE event_id = ? AND ts <= ? AND score IS NOT NULL
  ORDER BY ts DESC LIMIT 1
`);

console.log(`Picks pendientes de backfill: ${rows.length}`);
if (!rows.length) { console.log('Nada que hacer.'); process.exit(0); }

const updates = [];
let noScore = 0, changed = 0, identical = 0, nonTotal = 0;
const bad = [];

for (const r of rows) {
  const snap = snapAt.get(r.event_id, r.ts);
  const score = snap ? snap.score : null;
  if (!score) noScore++;

  let parsed = null;
  try { parsed = parsePick(r); } catch { parsed = null; }

  const served = avanceForModel(r.f_avance, parsed, score);

  // Invariante: si NO es un total, la transformación es la identidad. Si esto
  // se rompe, la reconstrucción está mal y no hay que escribir nada.
  const isTotal = parsed && parsed.type === 'total';
  if (!isTotal) {
    nonTotal++;
    if (served !== r.f_avance) bad.push({ id: r.id, market: r.market, selection: r.selection, crudo: r.f_avance, servido: served });
  }

  if (Math.abs(served - r.f_avance) > 1e-12) changed++; else identical++;
  updates.push({ id: r.id, v: served });
}

console.log(`  sin marcador recuperable : ${noScore} (usan 0-0 como total actual, igual que producción)`);
console.log(`  no-totales (identidad)   : ${nonTotal}`);
console.log(`  valor DISTINTO del crudo : ${changed}   <- los que sufrían el skew`);
console.log(`  valor idéntico al crudo  : ${identical}`);

if (bad.length) {
  console.error(`\n❌ INVARIANTE ROTA en ${bad.length} pick(s) no-total: la identidad no se respetó.`);
  console.error(bad.slice(0, 5));
  console.error('No se escribe nada. Revisar avanceForModel/parsePick antes de reintentar.');
  process.exit(1);
}

// Muestra de los que cambian, para inspección a ojo antes de aplicar
const sample = updates.filter((u, i) => Math.abs(u.v - rows[i].f_avance) > 1e-12).slice(0, 8);
if (sample.length) {
  console.log('\nMuestra de valores reconstruidos:');
  for (const s of sample) {
    const r = rows.find(x => x.id === s.id);
    console.log(`  #${r.id} ${(r.market + ' ' + r.selection).slice(0, 34).padEnd(34)} crudo=${r.f_avance.toFixed(3)} -> servido=${s.v.toFixed(3)}`);
  }
}

if (!APPLY) {
  console.log('\n(dry-run) Nada escrito. Repite con --apply para persistir.');
  process.exit(0);
}

const upd = db.prepare('UPDATE picks SET f_avance_model = ? WHERE id = ?');
const run = db.transaction(list => { for (const u of list) upd.run(u.v, u.id); });
run(updates);

const left = db.prepare('SELECT COUNT(*) n FROM picks WHERE f_avance IS NOT NULL AND f_avance_model IS NULL').get().n;
console.log(`\n✅ ${updates.length} filas actualizadas. Pendientes restantes: ${left}`);
