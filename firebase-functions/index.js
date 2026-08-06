const functions = require('firebase-functions');
const admin = require('firebase-admin');

admin.initializeApp();
const db = admin.firestore();

// ─────────────────────────────────────────────────
// Helpers compartidos
// ─────────────────────────────────────────────────
function cors(res) {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
}

// ─────────────────────────────────────────────────
// /api/summary  →  lee documento "summary" en Firestore
// ─────────────────────────────────────────────────
exports.api = functions.https.onRequest(async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }

  const path = (req.path || '/').replace(/^\/api/, '');

  try {
    if (path === '/summary' || path === '/summary/') {
      const snap = await db.collection('dashboard').doc('summary').get();
      if (!snap.exists) { res.status(404).json({ error: 'No hay datos aún. Espera el próximo push del bot.' }); return; }
      res.json(snap.data());
      return;
    }

    if (path === '/accepted' || path === '/accepted/') {
      const snap = await db.collection('dashboard').doc('accepted').get();
      if (!snap.exists) { res.json({ acceptedCount: 0, accepted: [] }); return; }
      res.json(snap.data());
      return;
    }

    if (path === '/rejected' || path === '/rejected/') {
      const snap = await db.collection('dashboard').doc('rejected').get();
      if (!snap.exists) { res.json({ rejectedCount: 0, rejected: [], savedUnits: 0, totalLossesAvoided: 0 }); return; }
      res.json(snap.data());
      return;
    }

    res.status(404).json({ error: 'Endpoint no encontrado' });
  } catch (e) {
    console.error('API error:', e);
    res.status(500).json({ error: e.message });
  }
});
