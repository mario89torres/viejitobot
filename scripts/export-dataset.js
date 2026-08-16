// Exporta los picks liquidados con los 4 features a dataset.csv (raíz del
// proyecto, o la ruta pasada como argumento) para scripts/train_weights.py.
// Excluye result='unknown' y picks sin los 4 features (anteriores a Etapa 2).
const path = require('path');
const fs = require('fs');
const { db } = require('../src/db');

const OUT = process.argv[2] || path.join(__dirname, '..', 'dataset.csv');

// f_avance se exporta desde f_avance_model — el valor REALMENTE SERVIDO al
// modelo, no el avance crudo. Exportar la columna cruda (como se hacía hasta
// 2026-08-09) era un train/serve skew: para cada "Más de X" con la línea sin
// alcanzar, el entrenamiento veía `progress` y producción servía `1 - progress`.
// Afectaba a 368 de 2228 picks. Backfill: scripts/backfill-avance-model.js.
// El nombre de la columna en el CSV se mantiene como `f_avance` para no tocar
// train_weights.py, que ya la espera así.
// UNION con rejected_picks (grupo de control) desde 2026-08-11. Hasta ahora el
// entrenamiento solo veía picks que YA habían pasado MIN_CONF/MIN_EDGE/firewall
// — puro sesgo de selección: comprime el 80% de las conf en 9pp y deja al
// clasificador SIN NEGATIVOS de verdad, así que nunca puede aprender dónde
// está la frontera (ver memoria por-que-no-entrena). Medido el 2026-08-11:
//
//               N      WR       f_prob_justa (rango)
//   picks      1932   69.8%     [0.228, 0.921]
//   rejected   2036   47.6%     [0.070, 0.713]   <- cubre zona que picks NUNCA vio
//   combinado  3968   58.4%
//
// rejected_picks no tiene opening_odd_decimal (esa columna ni se usa como
// feature en train_weights.py, solo viaja sin tocar en el CSV) — se exporta
// NULL para esas filas y no rompe nada.
// La columna `origin` NO es opcional: es la que permite a train_weights.py
// evaluar la regla de adopción sobre la población que REALMENTE se apuesta.
// Sin ella, el 2026-08-16 se adoptó un modelo que mejoraba +0.0070 de Brier en
// el agregado pero EMPEORABA -0.0026 sobre los picks emitidos — el 95% del pool
// de evaluación eran rechazados, así que el agregado medía sobre todo la
// capacidad de distinguir "rechazado típico" de "pick típico", que es trivial y
// no vale dinero. Ver model.json:disabled_reason.
const rows = db.prepare(`
  SELECT ts, sport, market, odd_decimal, opening_odd_decimal,
    f_prob_justa, f_avance_model AS f_avance, f_situacion, f_linea, f_apertura,
    COALESCE(score_version, 1) AS score_version,
    'picks' AS origin,
    CASE result WHEN 'win' THEN 1 ELSE 0 END AS y
  FROM picks
  WHERE result IN ('win','loss')
    AND f_prob_justa IS NOT NULL AND f_avance_model IS NOT NULL
    AND f_situacion IS NOT NULL AND f_linea IS NOT NULL AND f_apertura IS NOT NULL
    -- score_version = 0 marca features FABRICADAS, no calculadas: las 224 filas
    -- que globalDrawScanner.ts insertó con constantes hardcodeadas antes del
    -- arreglo de 2026-08-09 (ver scripts/mark-fabricated-global-draws.js).
    -- Hoy esas filas ya caen por f_apertura IS NULL, pero eso es un accidente:
    -- un backfill de f_apertura las readmitiría en silencio, que es exactamente
    -- lo que acaba de pasar con f_avance_model. Este filtro lo hace explícito.
    AND COALESCE(score_version, 1) > 0

  UNION ALL

  SELECT ts, sport, market, odd_decimal, NULL AS opening_odd_decimal,
    f_prob_justa, f_avance_model AS f_avance, f_situacion, f_linea, f_apertura,
    COALESCE(score_version, 1) AS score_version,
    'rejected' AS origin,
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

const header = 'ts,sport,market,odd_decimal,opening_odd_decimal,f_prob_justa,f_avance,f_situacion,f_linea,f_apertura,score_version,origin,y';
const lines = rows.map(r => [
  r.ts, r.sport, r.market, r.odd_decimal, r.opening_odd_decimal,
  r.f_prob_justa, r.f_avance, r.f_situacion, r.f_linea, r.f_apertura, r.score_version, r.origin, r.y,
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
