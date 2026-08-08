/**
 * Backtest de los umbrales del Empate Estructural (flatline).
 *
 * Pregunta: relajar varianza 0.025 -> 0.035, muestras 10 -> 5 y el fallback
 * sin empate 15 -> 8, ¿mejora o diluye? Se cambió sin medir; esto lo mide.
 *
 * MÉTODO — replay hacia adelante sobre el universo, no sobre los picks emitidos.
 * Para cada evento de fútbol se recorre el tiempo hacia delante y, en cada
 * instante t, la señal se calcula SOLO con snapshots <= t (los 20 más recientes,
 * igual que producción). El primer instante que dispara es la entrada, y el
 * momio de entrada es el de ese instante. Sin look-ahead.
 *
 * Esto importa: un contrafactual sobre los picks ya emitidos es una identidad
 * (el acierto queda fijo por construcción) y no sirve como evidencia. La
 * conclusión del test de universo previo fue justamente esa.
 *
 * Se aplican las mismas guardas que globalDrawScanner emite en producción:
 * minuto >= 75, marcador empatado, momio > 1.30, sin e-sports, solo la selección
 * Empate del mercado 1x2/Resultado.
 *
 * Uso:  node scripts/backtest_draw_thresholds.js [dias]
 */
const fs = require('fs');
const path = require('path');
const { db } = require('../src/db');
const { computeStructuralDrawSignal } = require('../src/confidence');

const DAYS = Number(process.argv[2] || 3);
const SINCE = new Date(Date.now() - DAYS * 24 * 60 * 60 * 1000).toISOString();
const MIN_MINUTE = 75;
const MIN_ODD = 1.30;

// Mismos conjuntos de parámetros que se quieren comparar.
const VARIANTS = [
  { name: 'ESTRICTO (previo)', maxVariance: 0.025, minSamples: 10, minSamplesNoTie: 15 },
  { name: 'RELAJADO (actual)', maxVariance: 0.035, minSamples: 5,  minSamplesNoTie: 8  },
  // Intermedios, para ver si el óptimo está entre los dos o fuera.
  { name: 'var 0.030 / 5 / 8', maxVariance: 0.030, minSamples: 5,  minSamplesNoTie: 8  },
  { name: 'var 0.035 / 10 / 15', maxVariance: 0.035, minSamples: 10, minSamplesNoTie: 15 },
  { name: 'var 0.020 / 10 / 15', maxVariance: 0.020, minSamples: 10, minSamplesNoTie: 15 },
];

function parseMinute(liveTimeStr) {
  if (!liveTimeStr) return null;
  const str = String(liveTimeStr).toLowerCase();
  if (str.includes('descanso') || str.includes('half') || str.includes('ht') || str === 'break') return 45;
  const m = str.match(/(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

function isTie(score) {
  if (!score) return false;
  const p = String(score).split('-');
  if (p.length !== 2) return false;
  const a = Number(p[0].trim()), b = Number(p[1].trim());
  return !isNaN(a) && !isNaN(b) && a === b;
}

console.log('='.repeat(70));
console.log('BACKTEST — umbrales del Empate Estructural');
console.log(`ventana: últimos ${DAYS} días (desde ${SINCE.slice(0, 16)})`);
console.log('='.repeat(70));

// ── 1. Universo: toda la selección Empate del mercado de resultado en fútbol ──
// snapshots.db pesa ~17.6 GB y no hay índice por selection, asi que este filtro
// obliga a recorrer el rango de ts entero: ~26 s por cada 6 h de datos. Se paga
// una sola vez y se cachea en un fichero aparte para poder iterar el análisis
// sin repetir el escaneo. Borra el cache (o usa --refresh) para regenerarlo.
const CACHE = path.join(__dirname, '..', `draw_universe_${DAYS}d.json`);
let rows;
if (fs.existsSync(CACHE) && !process.argv.includes('--refresh')) {
  const cached = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
  rows = cached.rows;
  console.log(`\nUniverso desde cache (${cached.builtAt.slice(0, 16)}): ${rows.length.toLocaleString()} snapshots`);
  console.log('  usa --refresh para volver a escanear');
} else {
  // El escaneo compite por I/O con el bot en vivo, que escribe cada
  // SAMPLE_MINUTES: la BD pesa 17.6 GB y no hay indice sobre `selection`, asi
  // que una ventana de varios dias puede tardar mas de 1h por contencion, no
  // por volumen (CPU real medida ~0.1s vs decenas de s de reloj). Se avisa del
  // riesgo en vez de bloquear en silencio.
  console.log('\nEscaneando universo de snapshots (compite por I/O con el bot en vivo)...');
  const t0 = Date.now();
  rows = db.prepare(`
    SELECT event_id, event, sport, market, selection, odd_decimal, suspended, score, live_time, ts
    FROM snapshots
    WHERE ts >= ?
      AND selection = 'Empate'
      AND (sport_id = 66 OR LOWER(sport) LIKE '%futbol%' OR LOWER(sport) LIKE '%fútbol%')
      AND LOWER(sport) NOT LIKE 'e-%'
      AND LOWER(sport) NOT LIKE '%esoccer%'
    ORDER BY event_id, ts
  `).all(SINCE);
  fs.writeFileSync(CACHE, JSON.stringify({ builtAt: new Date().toISOString(), since: SINCE, rows }));
  console.log(`  ${rows.length.toLocaleString()} snapshots en ${((Date.now() - t0) / 1000).toFixed(0)} s -> ${path.basename(CACHE)}`);
}

// Agrupar por evento conservando el orden temporal ascendente.
const byEvent = new Map();
for (const r of rows) {
  const mkt = (r.market || '').toLowerCase();
  if (!(mkt.includes('resultado') || mkt === '1x2' || mkt.includes('result'))) continue;
  if (!byEvent.has(r.event_id)) byEvent.set(r.event_id, []);
  byEvent.get(r.event_id).push(r);
}
console.log(`  ${byEvent.size.toLocaleString()} eventos con mercado de resultado`);

// ── 2. Desenlace real de cada evento: último marcador conocido ──
// Misma limitación que producción: es el último muestreado, no el oficial.
const outcome = new Map();
for (const [eid, list] of byEvent) {
  let last = null;
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].score) { last = list[i].score; break; }
  }
  outcome.set(eid, last);
}

// ── 3. Replay hacia adelante por evento y variante ──
function replay(params) {
  const picks = [];
  for (const [eid, list] of byEvent) {
    const activeSoFar = []; // momios activos, más reciente al frente
    for (const snap of list) {
      const isActive = !snap.suspended && snap.odd_decimal > 0;
      if (isActive) activeSoFar.unshift(snap.odd_decimal);
      if (!isActive) continue;

      const min = parseMinute(snap.live_time);
      if (min === null || min < MIN_MINUTE) continue;
      if (!isTie(snap.score)) continue;
      if (snap.odd_decimal <= MIN_ODD) continue;

      const sig = computeStructuralDrawSignal(activeSoFar, snap.score, params);
      if (!sig.isStructuralDraw) continue;

      picks.push({
        event_id: eid, event: snap.event, ts: snap.ts,
        entry_odd: snap.odd_decimal, variance: sig.variance,
        minute: min, final_score: outcome.get(eid),
      });
      break; // una señal por evento, igual que producción
    }
  }
  return picks;
}

function summarize(picks) {
  let w = 0, l = 0, unknown = 0, profit = 0, oddSum = 0;
  for (const p of picks) {
    if (!p.final_score) { unknown++; continue; }
    oddSum += p.entry_odd;
    if (isTie(p.final_score)) { w++; profit += p.entry_odd - 1; }
    else { l++; profit -= 1; }
  }
  const n = w + l;
  return {
    n, w, l, unknown,
    wr: n ? w / n : 0,
    roi: n ? profit / n : 0,
    avgOdd: n ? oddSum / n : 0,
    profit,
  };
}

// ── 4. Validación del método de calificación contra los resultados guardados ──
// Si calificar por "último marcador empatado" no reprodujera los resultados que
// el bot ya liquidó, el backtest entero sería ruido.
const settled = db.prepare(`
  SELECT event_id, result FROM picks
  WHERE source = 'global_draw' AND result IN ('win','loss') AND ts >= ?
`).all(SINCE);
let agree = 0, checked = 0;
for (const s of settled) {
  const fin = outcome.get(s.event_id);
  if (!fin) continue;
  checked++;
  const predicted = isTie(fin) ? 'win' : 'loss';
  if (predicted === s.result) agree++;
}
console.log(`\nValidación del calificador: ${agree}/${checked} coinciden con los resultados liquidados` +
            (checked ? ` (${(100 * agree / checked).toFixed(1)}%)` : ''));
if (checked && agree / checked < 0.9) {
  console.log('  ⚠️  Concordancia baja: los números de abajo no son fiables.');
}

// ── 5. Resultados ──
console.log('\n' + '='.repeat(70));
console.log('variante'.padEnd(21), 'N'.padStart(4), 'WR'.padStart(7), 'ROI'.padStart(8), 'momio'.padStart(7), 'u'.padStart(8));
console.log('-'.repeat(70));

const results = [];
for (const v of VARIANTS) {
  const picks = replay(v);
  const s = summarize(picks);
  results.push({ v, picks, s });
  console.log(
    v.name.padEnd(21),
    String(s.n).padStart(4),
    `${(100 * s.wr).toFixed(1)}%`.padStart(7),
    `${(100 * s.roi).toFixed(1)}%`.padStart(8),
    s.avgOdd.toFixed(2).padStart(7),
    s.profit.toFixed(1).padStart(8),
  );
}

// ── 6. Análisis marginal: qué añade exactamente el relajamiento ──
const strict = results.find(r => r.v.name.startsWith('ESTRICTO'));
const loose = results.find(r => r.v.name.startsWith('RELAJADO'));
if (strict && loose) {
  const strictIds = new Set(strict.picks.map(p => p.event_id));
  const marginal = loose.picks.filter(p => !strictIds.has(p.event_id));
  const ms = summarize(marginal);
  console.log('\n' + '='.repeat(70));
  console.log('PICKS MARGINALES — los que solo existen por haber relajado');
  console.log('-'.repeat(70));
  console.log(`  N liquidables : ${ms.n}   (${ms.w}W / ${ms.l}L)`);
  console.log(`  Acierto       : ${(100 * ms.wr).toFixed(1)}%   vs ${(100 * strict.s.wr).toFixed(1)}% del núcleo estricto`);
  console.log(`  ROI           : ${(100 * ms.roi).toFixed(1)}%   vs ${(100 * strict.s.roi).toFixed(1)}% del núcleo estricto`);
  console.log(`  Momio medio   : ${ms.avgOdd.toFixed(2)}`);
  console.log(`  Unidades      : ${ms.profit.toFixed(1)}`);
  const alsoLost = loose.picks.length - marginal.length;
  console.log(`\n  (el relajado conserva ${alsoLost} de los ${strict.picks.length} del estricto)`);

  console.log('\n' + '='.repeat(70));
  if (ms.n < 30) {
    console.log('VEREDICTO: MUESTRA INSUFICIENTE en el margen (N=' + ms.n + ' < 30).');
    console.log('No se puede afirmar nada del relajamiento con estos datos.');
  } else if (ms.roi < 0 && strict.s.roi > 0) {
    console.log('VEREDICTO: el relajamiento DILUYE. Los picks que añade pierden');
    console.log('dinero mientras el núcleo estricto gana. Revertir los umbrales.');
  } else if (ms.roi > strict.s.roi) {
    console.log('VEREDICTO: el relajamiento APORTA. Los picks marginales rinden');
    console.log('por encima del núcleo; el umbral previo estaba dejando valor fuera.');
  } else {
    console.log('VEREDICTO: el relajamiento añade volumen a un ROI menor que el');
    console.log('núcleo. Positivo pero dilutivo: decidir según el objetivo.');
  }
  console.log('='.repeat(70));
}
