// Exporta los picks liquidados con los 4 features a dataset.csv (raíz del
// proyecto, o la ruta pasada como argumento) para scripts/train_weights.py.
// Excluye result='unknown' y picks sin los 4 features (anteriores a Etapa 2).
const path = require('path');
const fs = require('fs');
const { db } = require('../src/db');

const OUT = process.argv[2] || path.join(__dirname, '..', 'dataset.csv');

const rows = db.prepare(`
  SELECT ts, sport, market, odd_decimal, opening_odd_decimal,
    f_prob_justa, f_avance, f_situacion, f_linea, f_apertura,
    COALESCE(score_version, 1) AS score_version,
    CASE result WHEN 'win' THEN 1 ELSE 0 END AS y
  FROM picks
  WHERE result IN ('win','loss')
    AND f_prob_justa IS NOT NULL AND f_avance IS NOT NULL
    AND f_situacion IS NOT NULL AND f_linea IS NOT NULL AND f_apertura IS NOT NULL
  ORDER BY ts ASC
`).all();

const esc = v => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const header = 'ts,sport,market,odd_decimal,opening_odd_decimal,f_prob_justa,f_avance,f_situacion,f_linea,f_apertura,score_version,y';
const lines = rows.map(r => [
  r.ts, r.sport, r.market, r.odd_decimal, r.opening_odd_decimal,
  r.f_prob_justa, r.f_avance, r.f_situacion, r.f_linea, r.f_apertura, r.score_version, r.y,
].map(esc).join(','));

fs.writeFileSync(OUT, [header, ...lines].join('\n') + '\n');
console.log(`${rows.length} picks exportados a ${OUT}`);

// Reparto por versión de features: v1 y v2 no son comparables entre sí
// (v1 tenía f_linea saturada). El entrenador decide cuál usar con SCORE_VERSION.
const byVer = {};
for (const r of rows) byVer[r.score_version] = (byVer[r.score_version] || 0) + 1;
console.log('Por score_version:', Object.entries(byVer).map(([v, n]) => `v${v}=${n}`).join(', ') || '(ninguno)');
if (rows.length < 300) {
  console.log(`⚠️ Menos de 300 muestras: el entrenador usará calibración sigmoid (Platt) y los resultados serán poco estables.`);
}
