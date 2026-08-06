require('dotenv').config();
const { db } = require('../src/db');

console.log('=== Picks recientes con stake ===');
const recent = db.prepare(`
  SELECT id, ts, event_id, event, sport, market, selection, odd_decimal, conf, result, final_score, settled_ts, stake, stake_mode, f_prob_justa, f_avance, f_situacion, f_linea, conf_heuristic, conf_learned, edge, source
  FROM picks
  WHERE stake IS NOT NULL
  ORDER BY id DESC
  LIMIT 25
`).all();

for (const p of recent) {
  console.log(`ID: ${p.id} | ${p.ts} | ${p.event} (${p.sport})`);
  console.log(`   Mercado: ${p.market} -> ${p.selection} @ ${p.odd_decimal}`);
  console.log(`   Result: ${p.result} | Final: ${p.final_score}`);
  console.log(`   Conf: ${(100*p.conf).toFixed(1)}% | Edge: ${(100*p.edge).toFixed(1)}% | Stake: ${p.stake}u (${p.stake_mode})`);
  console.log(`   Conf Heurístico: ${p.conf_heuristic ? (100*p.conf_heuristic).toFixed(1)+'%' : 'N/A'} | Conf Learned: ${p.conf_learned ? (100*p.conf_learned).toFixed(1)+'%' : 'N/A'}`);
  console.log(`   Factores: prob=${p.f_prob_justa?.toFixed(3)}, avance=${p.f_avance?.toFixed(3)}, sit=${p.f_situacion?.toFixed(3)}, linea=${p.f_linea?.toFixed(3)}`);
  console.log('--------------------------------------------------');
}

console.log('\n=== Picks perdidos con mayor stake ===');
const highStakeLoss = db.prepare(`
  SELECT id, ts, event_id, event, sport, market, selection, odd_decimal, conf, result, final_score, settled_ts, stake, stake_mode, f_prob_justa, f_avance, f_situacion, f_linea, conf_heuristic, conf_learned, edge, source
  FROM picks
  WHERE stake IS NOT NULL AND result = 'loss'
  ORDER BY stake DESC
  LIMIT 10
`).all();

for (const p of highStakeLoss) {
  console.log(`ID: ${p.id} | ${p.ts} | ${p.event} (${p.sport})`);
  console.log(`   Mercado: ${p.market} -> ${p.selection} @ ${p.odd_decimal}`);
  console.log(`   Result: ${p.result} | Final: ${p.final_score}`);
  console.log(`   Conf: ${(100*p.conf).toFixed(1)}% | Edge: ${(100*p.edge).toFixed(1)}% | Stake: ${p.stake}u (${p.stake_mode})`);
  console.log(`   Conf Heurístico: ${p.conf_heuristic ? (100*p.conf_heuristic).toFixed(1)+'%' : 'N/A'} | Conf Learned: ${p.conf_learned ? (100*p.conf_learned).toFixed(1)+'%' : 'N/A'}`);
  console.log(`   Factores: prob=${p.f_prob_justa?.toFixed(3)}, avance=${p.f_avance?.toFixed(3)}, sit=${p.f_situacion?.toFixed(3)}, linea=${p.f_linea?.toFixed(3)}`);
  console.log('--------------------------------------------------');
}
