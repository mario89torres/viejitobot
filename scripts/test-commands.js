// Verifica la lógica de /top, /seguras y /stats sin enviar mensajes a Telegram.
require('dotenv').config();
const { fetchAllLive } = require('../src/fetcher');
const { normalize } = require('../src/normalize');
const { topPicks } = require('../src/analyze');
const { safestPicks } = require('../src/confidence');
const { getStats } = require('../src/db');

(async () => {
  const rows = normalize(await fetchAllLive());
  console.log(`rows: ${rows.length}`);

  const top = topPicks(rows, { minOdds: 1.05, maxOdds: 100, excludeSports: [], topN: 10 });
  console.log(`/top -> ${top.length} picks; primero: ${top[0] ? `${top[0].event} @ ${top[0].oddDecimal}` : 'n/a'}`);

  const safe = safestPicks(rows.filter(r => !r.sport.toLowerCase().startsWith('e-')), 3);
  console.log(`/seguras -> ${safe.length} picks`);
  for (const p of safe) console.log(`  ${p.event} | ${p.selection} @ ${p.oddDecimal} | conf ${(p.conf * 100).toFixed(0)}%`);

  const { buckets, pending } = getStats();
  console.log(`/stats -> buckets: ${JSON.stringify(buckets)}, pendientes: ${pending}`);
  process.exit(0);
})().catch(e => { console.error('FALLO:', e); process.exit(1); });
