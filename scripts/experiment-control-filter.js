/**
 * ¿Qué pasa si se excluyen del entrenamiento ciertos tipos de rechazo?
 *
 * La verificación del 2026-08-16 encontró que el grupo de control NO es
 * homogéneo. Por regla de rechazo, sobre las 6726 filas usadas:
 *
 *   min_conf           81.9%   WR 44.5%   0-0  8.4%
 *   firewall            6.9%   WR 50.2%   0-0 10.9%
 *   mercado_bloqueado   5.8%   WR 68.4%   0-0 24.4%   <- WR y 0-0 anómalos
 *   guardas5            3.3%   WR 72.5%   0-0 23.0%   <- WR y 0-0 anómalos
 *   min_edge            2.1%   WR 75.9%   0-0  2.1%
 *
 * `guardas5` (suspensión/inestabilidad del feed) y `mercado_bloqueado` no se
 * rechazan por SEÑAL sino por condiciones del proveedor. Su WR es ~2x el de
 * min_conf, así que como "negativos" son cualitativamente distintos: meterlos
 * sin distinguir puede enseñarle al modelo una frontera que no existe.
 *
 * Este script SOLO prepara los datos para el experimento en Python
 * (experiment-control-filter.py), que replica el pipeline de train_weights.py.
 * Se separa así porque el CSV de producción (export-dataset.js) no lleva
 * reject_rule y NO conviene añadírselo solo para un experimento exploratorio.
 *
 * Uso: node scripts/experiment-control-filter.js [salida.csv]
 */
const path = require('path');
const fs = require('fs');
const { db } = require('../src/db');

const OUT = process.argv[2] || path.join(__dirname, '..', 'dataset_con_regla.csv');

// Mismo WHERE que export-dataset.js, más reject_rule para poder segmentar.
// `origin` distingue la población que recibe dinero de la que no.
const rows = db.prepare(`
  SELECT ts, sport, market, odd_decimal,
    f_prob_justa, f_avance_model AS f_avance, f_situacion, f_linea, f_apertura,
    COALESCE(score_version, 1) AS score_version,
    'picks' AS origin, '' AS reject_rule,
    CASE result WHEN 'win' THEN 1 ELSE 0 END AS y
  FROM picks
  WHERE result IN ('win','loss')
    AND f_prob_justa IS NOT NULL AND f_avance_model IS NOT NULL
    AND f_situacion IS NOT NULL AND f_linea IS NOT NULL AND f_apertura IS NOT NULL
    AND COALESCE(score_version, 1) > 0

  UNION ALL

  SELECT ts, sport, market, odd_decimal,
    f_prob_justa, f_avance_model AS f_avance, f_situacion, f_linea, f_apertura,
    COALESCE(score_version, 1) AS score_version,
    'rejected' AS origin, COALESCE(reject_rule, '(sin regla)') AS reject_rule,
    CASE result WHEN 'win' THEN 1 ELSE 0 END AS y
  FROM rejected_picks
  WHERE result IN ('win','loss')
    AND f_prob_justa IS NOT NULL AND f_avance_model IS NOT NULL
    AND f_situacion IS NOT NULL AND f_linea IS NOT NULL AND f_apertura IS NOT NULL
    AND COALESCE(score_version, 1) > 0

  ORDER BY ts ASC
`).all();

const esc = v => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const header = 'ts,sport,market,odd_decimal,f_prob_justa,f_avance,f_situacion,f_linea,f_apertura,score_version,origin,reject_rule,y';
const lines = rows.map(r => [
  r.ts, r.sport, r.market, r.odd_decimal,
  r.f_prob_justa, r.f_avance, r.f_situacion, r.f_linea, r.f_apertura,
  r.score_version, r.origin, r.reject_rule, r.y,
].map(esc).join(','));

fs.writeFileSync(OUT, [header, ...lines].join('\n') + '\n');
console.log(`${rows.length} filas -> ${OUT}`);

const porRegla = {};
for (const r of rows) {
  if (r.origin !== 'rejected') continue;
  const a = (porRegla[r.reject_rule] = porRegla[r.reject_rule] || { n: 0, w: 0 });
  a.n++; if (r.y === 1) a.w++;
}
console.log(`picks: ${rows.filter(r => r.origin === 'picks').length}`);
for (const [k, a] of Object.entries(porRegla).sort((x, y) => y[1].n - x[1].n)) {
  console.log(`  ${k.padEnd(20)} N=${String(a.n).padStart(5)}  WR=${(a.w / a.n * 100).toFixed(1)}%`);
}
