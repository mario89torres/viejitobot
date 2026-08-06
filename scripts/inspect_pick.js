const { db } = require('../src/db');
const p = db.prepare(`
  SELECT id, ts, event, sport, market, selection,
         odd_decimal, opening_odd_decimal, sharp_entry_odd, sharp_closing_odd,
         conf, conf_heuristic, conf_learned, edge,
         f_prob_justa, f_avance, f_situacion, f_linea, f_apertura,
         stake, stake_mode, score_version,
         result, loss_minute
  FROM picks
  WHERE stake IS NOT NULL AND result IN ('win', 'loss', 'push')
  ORDER BY ts DESC LIMIT 1
`).get();
console.log(JSON.stringify(p, null, 2));
