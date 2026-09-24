/**
 * scripts/clv-report.js
 * ─────────────────────────────────────────────────────────────────────────
 * Closing Line Value, CORREGIDO. La primera version comparaba contra la
 * ULTIMA cuota vista antes de que la linea dejara de cotizar — en un mercado
 * EN VIVO eso casi siempre es a minutos del final, cuando el precio ya
 * refleja el resultado que esta a punto de darse. Esa version daba Spearman
 * 0.564 con el P/L, pero era en gran parte TAUTOLOGICO: un pick que va a
 * ganar mecanicamente ve su cuota caer hacia 1.0 segun el partido confirma
 * el resultado, no porque hubiera "valor" capturado en la entrada. No es lo
 * que mide la literatura (esa usa el cierre PRE-partido, fijo antes del
 * kickoff, donde nada del partido ha pasado todavia).
 *
 * FIX: en vez de "la ultima cuota vista", se usa la cuota a un HORIZONTE FIJO
 * despues de la entrada (por defecto 15 min) — un checkpoint temprano, igual
 * para todos los picks, que en la mayoria de los casos deja bastante partido
 * por jugarse. Ademas se descartan los picks que entraron tarde (f_avance
 * alto): si ya estas al 75' del partido, +15 min cae en el 90', otra vez
 * cerca de la resolucion. Con AVANCE_MAX=0.5 solo entran picks de la primera
 * mitad del partido (aprox.), dejando margen real tras el checkpoint.
 *
 * DEFINICION (precio crudo, no de-vigueado — mismo estandar que trackers de
 * la industria tipo Pikkit). Con cuotas DECIMALES, precio mas BAJO = el
 * mercado le asigna mas probabilidad:
 *
 *   CLV% = (oddEntrada / oddCheckpoint - 1) * 100   (positivo = el precio
 *   bajo despues de entrar: el mercado se movio a favor)
 *
 * Uso: node scripts/clv-report.js [dias=90] [heur|model] [horizonteMin=15]
 */
const path = require('path');
const Database = require('better-sqlite3');
const db = new Database(process.env.DB_PATH || path.join(__dirname, '..', 'snapshots.db'), { readonly: true });

const DIAS = Number(process.argv[2] || 90);
const SOURCE = process.argv[3] || 'heur';
const HORIZONTE_MIN = Number(process.argv[4] || 15);
const AVANCE_MAX = 0.6; // ~primera mitad + un poco: minimo para llegar a n~300
const TOLERANCIA_MIN = 6; // ventana +- alrededor del checkpoint para aceptar un snapshot
const desde = new Date(Date.now() - DIAS * 864e5).toISOString();
const tabla = SOURCE === 'model' ? 'model_picks' : 'picks';
const colEdge = SOURCE === 'model' ? 'edge_learned' : 'edge';
const colConf = SOURCE === 'model' ? 'conf_learned' : 'conf';
const colStake = SOURCE === 'model' ? '1' : 'IFNULL(stake,1)';
const colAvance = SOURCE === 'model' ? 'f_avance' : 'f_avance'; // ambas tablas lo tienen

const picks = db.prepare(`
  SELECT id, ts, event_id, market, selection, odd_decimal AS odd, result, ${colEdge} AS edge, ${colConf} AS conf,
    ${colStake} AS stake, ${colAvance} AS avance,
    CASE WHEN result='win' THEN ${colStake}*(odd_decimal-1) WHEN result='loss' THEN -${colStake} END AS pl
  FROM ${tabla}
  WHERE result IN ('win','loss') AND ts >= ? AND odd_decimal > 1
    AND ${colAvance} IS NOT NULL AND ${colAvance} <= ${AVANCE_MAX}
`).all(desde);
console.log(`source=${SOURCE} | ultimos ${DIAS} dias | horizonte +${HORIZONTE_MIN}min | avance<=${AVANCE_MAX} | picks candidatos: ${picks.length}`);

const checkpointStmt = db.prepare(`
  SELECT odd_decimal, ts, ABS(strftime('%s',ts) - strftime('%s', ?)) AS dist
  FROM snapshots
  WHERE event_id = ? AND market = ? AND selection = ?
    AND ts BETWEEN ? AND ? AND suspended = 0 AND odd_decimal > 1
  ORDER BY dist ASC LIMIT 1
`);

const filas = [];
let sinCheckpoint = 0;
for (const p of picks) {
  const objetivo = new Date(Date.parse(p.ts) + HORIZONTE_MIN * 60000).toISOString();
  const desdeVentana = new Date(Date.parse(objetivo) - TOLERANCIA_MIN * 60000).toISOString();
  const hastaVentana = new Date(Date.parse(objetivo) + TOLERANCIA_MIN * 60000).toISOString();
  const c = checkpointStmt.get(objetivo, p.event_id, p.market, p.selection, desdeVentana, hastaVentana);
  if (!c) { sinCheckpoint++; continue; }
  const clvPct = (p.odd / c.odd_decimal - 1) * 100;
  filas.push({ ...p, oddCheckpoint: c.odd_decimal, clvPct });
}
console.log(`con checkpoint a +${HORIZONTE_MIN}min: ${filas.length} | sin checkpoint en la ventana: ${sinCheckpoint}`);

if (filas.length < 30) { console.log('\nMuestra insuficiente para reportar.'); process.exit(0); }

const media = (a) => a.reduce((s, x) => s + x, 0) / (a.length || 1);
const percentil = (a, q) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * q))]; };
const wr = (l) => l.length ? (100 * l.filter(f => f.result === 'win').length / l.length).toFixed(1) + '%' : '-';
const roi = (l) => l.length ? (100 * l.reduce((s, f) => s + f.pl, 0) / l.reduce((s, f) => s + f.stake, 0)).toFixed(2) + '%' : '-';

const clvs = filas.map(f => f.clvPct);
console.log(`\nCLV%: media ${media(clvs).toFixed(2)}%  mediana ${percentil(clvs, .5).toFixed(2)}%  p10 ${percentil(clvs, .1).toFixed(2)}%  p90 ${percentil(clvs, .9).toFixed(2)}%`);
const positivo = filas.filter(f => f.clvPct > 0), negativo = filas.filter(f => f.clvPct <= 0);
console.log(`CLV positivo (mejora en +${HORIZONTE_MIN}min): ${positivo.length} (${(100 * positivo.length / filas.length).toFixed(1)}%) | CLV negativo/nulo: ${negativo.length}`);

console.log(`\n¿El CLV a +${HORIZONTE_MIN}min predice el resultado del pick? (WR / ROI por grupo)`);
console.log('  CLV positivo:', 'n=' + positivo.length, 'WR', wr(positivo), 'ROI', roi(positivo));
console.log('  CLV negativo:', 'n=' + negativo.length, 'WR', wr(negativo), 'ROI', roi(negativo));

console.log('\nPor decil de CLV (1=peor, 10=mejor):');
const ordenado = [...filas].sort((a, b) => a.clvPct - b.clvPct);
const decilN = Math.floor(ordenado.length / 10);
for (let d = 0; d < 10; d++) {
  const ini = d * decilN, fin = d === 9 ? ordenado.length : (d + 1) * decilN;
  const grupo = ordenado.slice(ini, fin);
  if (!grupo.length) continue;
  console.log(`  decil ${d + 1}: n=${grupo.length}  CLV medio ${media(grupo.map(g => g.clvPct)).toFixed(1)}%  WR ${wr(grupo)}  ROI ${roi(grupo)}`);
}

function rank(arr) { const idx = arr.map((v, i) => i).sort((a, b) => arr[a] - arr[b]); const r = new Array(arr.length); idx.forEach((oi, ri) => r[oi] = ri); return r; }
const roiUnit = filas.map(f => f.pl / f.stake);
const rc = rank(clvs), rr = rank(roiUnit);
const n = rc.length, mc = media(rc), mr = media(rr);
let num = 0, dc = 0, dr = 0;
for (let i = 0; i < n; i++) { num += (rc[i] - mc) * (rr[i] - mr); dc += (rc[i] - mc) ** 2; dr += (rr[i] - mr) ** 2; }
console.log(`\nSpearman CLV(+${HORIZONTE_MIN}min) vs P/L unitario: ${(num / Math.sqrt(dc * dr)).toFixed(3)}  (n=${n})`);

console.log('\nCLV medio por bucket de edge de entrada:');
function bucket(e) {
  if (e == null) return null;
  if (e < 0) return 'a) <0%'; if (e < 0.02) return 'b) 0-2%'; if (e < 0.04) return 'c) 2-4%';
  if (e < 0.06) return 'd) 4-6%'; if (e < 0.08) return 'e) 6-8%'; if (e < 0.10) return 'f) 8-10%';
  if (e < 0.15) return 'g) 10-15%'; if (e < 0.20) return 'h) 15-20%'; return 'i) >=20%';
}
const buckets = {};
for (const f of filas) { const b = bucket(f.edge); if (!b) continue; (buckets[b] ||= []).push(f); }
for (const k of Object.keys(buckets).sort()) {
  const g = buckets[k];
  console.log(`  ${k.padEnd(10)} n=${String(g.length).padStart(4)}  CLV medio ${media(g.map(x => x.clvPct)).toFixed(1)}%  WR ${wr(g)}  ROI ${roi(g)}`);
}
