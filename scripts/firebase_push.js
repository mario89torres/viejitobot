/**
 * scripts/firebase_push.js
 * ─────────────────────────────────────────────────────────────
 * Push SQLite local → Firestore (playdoit-monitor-bot).
 * Usa Application Default Credentials (ya autenticado con firebase login).
 * Corre: node scripts/firebase_push.js
 * ─────────────────────────────────────────────────────────────
 */

const path = require('path');
const admin = require('firebase-admin');
const { calculateQuantitativeHealth } = require('../src/health');
const { stakeStats } = require('../src/metrics');
const { db } = require('../src/db');
const { excludedSports, isBlockedOver, isBlockedMarket } = require('../src/confidence');

const PROJECT_ID = 'playdoit-monitor-bot';
const PUSH_INTERVAL_MS = 5 * 60 * 1000; // cada 5 minutos

function initFirebase() {
  // 1. Intenta con serviceAccountKey.json si existe
  const keyPath = path.join(__dirname, '..', 'serviceAccountKey.json');
  const fs = require('fs');
  try {
    if (fs.existsSync(keyPath)) {
      const serviceAccount = require(keyPath);
      admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
      console.log('[firebase_push] ✅ Usando serviceAccountKey.json');
    } else {
      // 2. Usa Application Default Credentials (firebase login ya autenticó)
      admin.initializeApp({
        credential: admin.credential.applicationDefault(),
        projectId: PROJECT_ID,
      });
      console.log('[firebase_push] ✅ Usando Application Default Credentials');
    }
  } catch (e) {
    console.error('[firebase_push] ❌ Error init Firebase:', e.message);
    process.exit(1);
  }
  return admin.firestore();
}

const normSport = (s) => (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();

async function pushData(firestoreDb) {
  const ts = new Date().toISOString();
  console.log(`\n[firebase_push] 🚀 Push @ ${ts}`);

  try {
    // ── 1. Summary + health metrics
    const health = calculateQuantitativeHealth({ windowDays: 30 });
    const stats = stakeStats();
    await firestoreDb.collection('dashboard').doc('summary').set({ health, stats, updatedAt: ts });
    console.log('[firebase_push] ✅ summary → Firestore');

    // ── 2. Accepted picks (últimos 50 pasando filtros doble capa)
    const excl = excludedSports();
    const rawPicks = db.prepare(`
      SELECT id, ts, event_id, event, sport, market, selection,
             odd_decimal, opening_odd_decimal, sharp_entry_odd, sharp_closing_odd,
             conf, conf_heuristic, conf_learned, edge,
             f_prob_justa, f_avance, f_situacion, f_linea, f_apertura,
             stake, stake_mode, score_version, result, loss_minute
      FROM picks
      WHERE stake IS NOT NULL AND result IN ('win', 'loss', 'push')
      ORDER BY ts DESC LIMIT 500
    `).all();

    const accepted = rawPicks
      .filter(r => !excl.includes(normSport(r.sport)) && !isBlockedOver(r) && !isBlockedMarket(r))
      .slice(0, 50)
      .map(r => {
        const profit = r.result === 'win' ? +(r.stake * (r.odd_decimal - 1)).toFixed(2)
                     : r.result === 'loss' ? -r.stake : 0;
        return {
          ...r,
          profit,
          confPct: (r.conf * 100).toFixed(1) + '%',
          confHeurPct: r.conf_heuristic != null ? (r.conf_heuristic * 100).toFixed(1) + '%' : null,
          confMLPct:   r.conf_learned   != null ? (r.conf_learned   * 100).toFixed(1) + '%' : null,
        };
      });

    await firestoreDb.collection('dashboard').doc('accepted').set({
      acceptedCount: accepted.length,
      accepted,
      updatedAt: ts,
    });
    console.log(`[firebase_push] ✅ accepted → Firestore (${accepted.length} picks)`);

    // ── 3. Rejected picks + unidades salvadas
    let savedUnits = 0, totalLossesAvoided = 0;
    const rawRej = db.prepare(`
      SELECT id, ts, event, sport, market, selection, odd_decimal, conf, result, stake, loss_minute
      FROM picks
      WHERE stake IS NOT NULL AND result IN ('win', 'loss', 'push')
      ORDER BY ts DESC LIMIT 300
    `).all();

    const rejected = rawRej
      .filter(r => excl.includes(normSport(r.sport)) || isBlockedOver(r) || isBlockedMarket(r))
      .map(r => {
        let reason = 'Mercado Bloqueado';
        if (excl.includes(normSport(r.sport))) reason = 'Deporte Excluido';
        else if (isBlockedOver(r)) reason = 'Over en Fútbol Bloqueado';
        else if (/m[aá]s de/i.test(r.selection || '') && (r.market || '').match(/4\.5|5\.0|5\.5/)) reason = 'Over >= 4.5 Bloqueado';
        else if (/menos de/i.test(r.selection || '') && (r.market || '').match(/5\.5|6\.0|6\.5/)) reason = 'Under >= 5.5 Bloqueado';
        else if ((r.market || '').toLowerCase().includes('empate no accion')) reason = 'DNB Débil';

        let statusTag = '⚪ Pendiente';
        if (r.result === 'win') {
          statusTag = `✅ Ganado (+${(r.stake * (r.odd_decimal - 1)).toFixed(2)}u)`;
        } else if (r.result === 'loss') {
          const m = r.loss_minute ? ` min ${r.loss_minute}'` : '';
          statusTag = `❌ Perdido (-${r.stake.toFixed(2)}u${m})`;
          savedUnits += r.stake;
          totalLossesAvoided++;
        } else {
          statusTag = '⚪ Nulo (0.00u)';
        }

        return { ...r, reason, statusTag };
      })
      .slice(0, 50);

    await firestoreDb.collection('dashboard').doc('rejected').set({
      rejectedCount: rejected.length,
      totalLossesAvoided,
      savedUnits: +savedUnits.toFixed(2),
      rejected,
      updatedAt: ts,
    });
    console.log(`[firebase_push] ✅ rejected → Firestore (${rejected.length} picks, ${savedUnits.toFixed(2)}u saved)`);
    console.log(`[firebase_push] ✨ Push completo @ ${new Date().toISOString()}`);

  } catch (e) {
    console.error('[firebase_push] ❌ Error push:', e.message);
  }
}

const firestoreDb = initFirebase();
pushData(firestoreDb);
setInterval(() => pushData(firestoreDb), PUSH_INTERVAL_MS);
