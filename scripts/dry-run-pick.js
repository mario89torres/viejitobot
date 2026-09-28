#!/usr/bin/env node
// scripts/dry-run-pick.js
// ─────────────────────────────────────────────────────────────────────────────
// Runner manual del Dry-Run: toma el pick más reciente de model_picks (sin
// resultado aún) y ejecuta el flujo UI completo en modo Dry-Run.
//
// Uso:
//   node scripts/dry-run-pick.js                  → pick más reciente de model
//   node scripts/dry-run-pick.js <pick_id>         → pick específico de model_picks
//   node scripts/dry-run-pick.js --heur            → pick más reciente de picks
//   node scripts/dry-run-pick.js --event <eventId> --sport <sportId> --market "Menos de 2.5" --sel "Menos 2.5" --odd 1.85
//
// Flags de entorno:
//   DRYRUN_IMPORTE_MXN=10   (default)
//   DRYRUN_MAX_WAIT_MS=15000
//   ODD_REJECT_PCT=3
//   DRYRUN_PROFILE_DIR=.chrome-profile

'use strict';

require('dotenv').config();
const Database = require('better-sqlite3');
const path     = require('path');
const { ejecutarDryRun, iniciarContexto, cerrarContexto } = require('../src/dryRunBetslip');

const DB_FILE = process.env.DB_PATH || path.join(__dirname, '..', 'snapshots.db');
const db = new Database(DB_FILE, { readonly: true, timeout: 5000 });

// ── Parseo de argumentos ─────────────────────────────────────────────────────
const args   = process.argv.slice(2);
const isHeur = args.includes('--heur');
const idxEvt = args.indexOf('--event');
const idxSp  = args.indexOf('--sport');
const idxMkt = args.indexOf('--market');
const idxSel = args.indexOf('--sel');
const idxOdd = args.indexOf('--odd');

let item;

if (idxEvt !== -1) {
  // Modo ad-hoc por parámetros
  item = {
    source:     'adhoc',
    pickId:     null,
    eventId:    Number(args[idxEvt + 1]),
    sportId:    Number(args[idxSp  + 1] || 66),
    market:     args[idxMkt + 1] || '',
    selection:  args[idxSel + 1] || '',
    oddDecimal: Number(args[idxOdd + 1] || 2),
    ts:         new Date().toISOString(),
  };
  console.log('[dry-run-pick] Modo ad-hoc:', item);
} else {
  // Modo automático: buscar en BD
  const tabla  = isHeur ? 'picks' : 'model_picks';
  const pickId = args[0] ? Number(args[0]) : null;

  let row;
  if (pickId) {
    row = db.prepare(
      `SELECT id, event_id, sport, market, selection, odd_decimal, ts
       FROM ${tabla} WHERE id = ?`
    ).get(pickId);
  } else {
    // Último pick sin resultado o el más reciente del día
    row = db.prepare(
      `SELECT id, event_id, sport, market, selection, odd_decimal, ts
       FROM ${tabla}
       WHERE result IS NULL
       ORDER BY ts DESC
       LIMIT 1`
    ).get();

    if (!row) {
      // Si no hay pendientes, tomar el más reciente de hoy (para prueba)
      const hoy = new Date().toISOString().slice(0, 10);
      row = db.prepare(
        `SELECT id, event_id, sport, market, selection, odd_decimal, ts
         FROM ${tabla}
         WHERE ts >= ?
         ORDER BY ts DESC
         LIMIT 1`
      ).get(hoy + 'T00:00:00.000Z');
    }
  }

  if (!row) {
    console.error(`[dry-run-pick] No se encontró ningún pick en ${tabla}. Usa --event para modo ad-hoc.`);
    process.exit(1);
  }

  console.log(`[dry-run-pick] Pick seleccionado de ${tabla}:`, row);

  let sportId = 66;
  try {
    const sRow = db.prepare('SELECT sport_id FROM snapshots WHERE event_id = ? AND sport_id IS NOT NULL LIMIT 1').get(row.event_id);
    if (sRow?.sport_id) sportId = sRow.sport_id;
  } catch { /* ignorar */ }

  item = {
    source:     isHeur ? 'heur' : 'model',
    pickId:     row.id,
    eventId:    row.event_id,
    sportId,
    market:     row.market,
    selection:  row.selection,
    oddDecimal: row.odd_decimal,
    ts:         row.ts,
  };
}

// ── Ejecutar ─────────────────────────────────────────────────────────────────
(async () => {
  try {
    await iniciarContexto();
    const resultado = await ejecutarDryRun(item);

    console.log('\n── Resultado ─────────────────────────────────────────');
    console.log('status          :', resultado.status);
    console.log('odd_emit        :', item.oddDecimal);
    console.log('odd_betslip     :', resultado.odd_betslip ?? '(no leída)');
    console.log('drift           :', resultado.odd_drift_pct != null
      ? `${resultado.odd_drift_pct.toFixed(2)}%`
      : '—');
    console.log('rechazo (>3%)   :', resultado.odd_drift_pct < -3 ? 'SÍ' : 'no');
    console.log('latencia total  :', resultado.latencia_total_ms != null
      ? `${resultado.latencia_total_ms} ms`
      : '—');
    if (resultado.error_msg) console.log('detalle         :', resultado.error_msg);
    console.log('──────────────────────────────────────────────────────\n');

  } finally {
    await cerrarContexto();
  }
})();
