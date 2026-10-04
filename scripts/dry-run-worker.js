#!/usr/bin/env node
// Worker de la cola UI del dry-run. Solo consume trabajos list_only: abre el
// evento y lee la cuota visible; no abre el boleto, no escribe importe y no
// puede confirmar una apuesta. Para validar boleto se conserva el runner
// manual scripts/dry-run-pick.js.
'use strict';

require('dotenv').config();
const crypto = require('crypto');
const { acquireNamed } = require('../src/singleInstance');
const {
  claimNextDryRunJob, finishDryRunJob, getDryRunCircuit, setDryRunCircuit,
  countDryRunStartedSince,
} = require('../src/db');
const { ejecutarDryRun, iniciarContexto, cerrarContexto } = require('../src/dryRunBetslip');

const args = new Set(process.argv.slice(2));
const ONCE = args.has('--once');
const RESET_CIRCUIT = args.has('--reset-circuit');
const ENABLED = /^(1|true|on|si|sí)$/i.test(process.env.DRYRUN_WORKER_ENABLED || '');
const POLL_MS = Math.max(2000, Math.min(60000, Number(process.env.DRYRUN_WORKER_POLL_MS || 5000)));
const LEASE_MS = Math.max(90000, Math.min(15 * 60000, Number(process.env.DRYRUN_WORKER_LEASE_MS || 180000)));
const MAX_PER_HOUR = Math.max(1, Math.min(60, Number(process.env.DRYRUN_WORKER_MAX_PER_HOUR || 12)));
const workerId = `dryrun-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;

function retryDelayMs(attempt) {
  // 15 s, 30 s, 60 s... acotado. La cuota puede rehidratarse, pero no se debe
  // martillar el sitio ni repetir indefinidamente un evento ya retirado.
  return Math.min(5 * 60000, 15000 * 2 ** Math.max(0, attempt - 1));
}

function esCritico(status) {
  return status === 'cleanup_failed' || String(status || '').startsWith('bloqueado');
}

async function procesarUno() {
  const circuit = getDryRunCircuit();
  if (circuit.circuit_open) return { kind: 'circuit' };

  const horaAtras = new Date(Date.now() - 3600000).toISOString();
  if (countDryRunStartedSince(horaAtras) >= MAX_PER_HOUR) return { kind: 'rate_limited' };

  const job = claimNextDryRunJob(workerId, { leaseMs: LEASE_MS });
  if (!job) return { kind: 'empty' };

  let result;
  try {
    await iniciarContexto();
    result = await ejecutarDryRun({
      pickId: job.pick_id, eventId: job.event_id, sportId: job.sport_id,
      sport: job.sport, market: job.market, selection: job.selection,
      oddDecimal: job.odd_emit, ts: job.pick_ts,
    }, {
      source: job.source, jobId: job.id, attempt: job.attempts, mode: 'list_only',
    });
  } catch (e) {
    result = { status: 'error', error_msg: e.message, run_id: null };
    console.error(`[dry-run-worker] job ${job.id}:`, e.message);
  }

  if (esCritico(result.status)) {
    setDryRunCircuit(true, `job ${job.id}: ${result.status} — ${result.error_msg || 'sin detalle'}`);
    finishDryRunJob({ id: job.id, workerId, status: 'failed', lastError: result.error_msg, lastRunId: result.run_id });
    console.error(`[dry-run-worker] CIRCUITO ABIERTO por job ${job.id} (${result.status})`);
    return { kind: 'circuit_opened' };
  }

  const reintentable = ['timeout', 'error'].includes(result.status);
  if (reintentable && job.attempts < job.max_attempts) {
    const delay = retryDelayMs(job.attempts);
    finishDryRunJob({
      id: job.id, workerId, status: 'retry', lastError: result.error_msg || result.status,
      lastRunId: result.run_id, retryAfterMs: delay,
    });
    console.warn(`[dry-run-worker] job ${job.id} → retry en ${Math.round(delay / 1000)} s (${result.status})`);
    return { kind: 'retry' };
  }

  const status = reintentable ? 'failed' : 'completed';
  finishDryRunJob({ id: job.id, workerId, status, lastError: result.error_msg, lastRunId: result.run_id });
  console.log(`[dry-run-worker] job ${job.id} → ${status} (${result.status})`);
  return { kind: status };
}

async function shutdown(code = 0) {
  await cerrarContexto();
  process.exit(code);
}

async function main() {
  if (RESET_CIRCUIT) {
    setDryRunCircuit(false);
    console.log('[dry-run-worker] circuito restablecido');
    return shutdown(0);
  }
  if (!ENABLED) {
    console.error('[dry-run-worker] bloqueado: define DRYRUN_WORKER_ENABLED=1 para consumir la cola.');
    return shutdown(2);
  }
  if (!acquireNamed('dry-run-worker')) return shutdown(1);

  console.log(`[dry-run-worker] iniciado (${workerId}) · list_only · max ${MAX_PER_HOUR}/h · poll ${POLL_MS}ms`);
  if (ONCE) {
    await procesarUno();
    return shutdown(0);
  }

  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try { await procesarUno(); }
    finally { running = false; }
  };
  await tick();
  setInterval(() => tick().catch(e => console.error('[dry-run-worker] tick:', e.message)), POLL_MS);
}

main().catch((e) => {
  console.error('[dry-run-worker] fatal:', e.message);
  cerrarContexto().finally(() => process.exit(1));
});
