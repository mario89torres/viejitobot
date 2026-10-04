/**
 * scripts/backtest-steam-football-data.js
 * ─────────────────────────────────────────────────────────────────────────
 * ¿Existe el patron "el lado cuya cuota SUBE gana menos de lo que implica el
 * cierre" en un mercado SHARP con miles de partidos? Contrasta lo que se midio
 * en Playdoit (scripts/backtest-steam-prematch.js, ~146 partidos, sin efecto
 * distinguible de cero) con los CSV publicos de football-data.co.uk: resultados
 * y cuotas previas al cierre + de cierre de Pinnacle, Bet365 y el promedio del
 * mercado, ~18 ligas, varias temporadas. Solo lectura; descarga a
 * scratch/football-data/ (cache: no vuelve a bajar lo que ya tiene).
 *
 * LO QUE ESTO SI Y NO PRUEBA
 *  - Si: si el movimiento apertura->cierre predice el resultado MAS ALLA del
 *    precio de cierre en un mercado eficiente (Pinnacle) y en uno blando
 *    (Bet365/promedio), con N en decenas de miles. Si aqui no hay nada, lo
 *    de Playdoit era ruido casi seguro.
 *  - No: si Playdoit es explotable. Otra casa, otras ligas (top europeas), y
 *    la "apertura" NO es la apertura real: segun las notas del sitio son las
 *    cuotas recogidas el viernes por la tarde (partidos de fin de semana) o el
 *    martes (entre semana) — una ventana de 1-3 dias antes del cierre.
 *
 * PRUEBA PRINCIPAL (fijada antes de mirar): Pinnacle, umbral 3%, 1X2, todas las
 * ligas y temporadas juntas: exceso = aciertos reales - probabilidad implicita
 * (sin margen) al cierre, por seleccion, para el lado steam (cuota baja >= 3%).
 * Todo lo demas es exploratorio. IC95 por bootstrap sobre PARTIDOS.
 *
 *   node scripts/backtest-steam-football-data.js [--umbral 3] [--desde 1516]
 */
const fs = require('fs');
const path = require('path');

const LIGAS = ['E0', 'E1', 'E2', 'E3', 'SC0', 'D1', 'D2', 'I1', 'I2', 'SP1', 'SP2', 'F1', 'F2', 'N1', 'B1', 'P1', 'T1', 'G1'];
const TEMPORADAS = ['1516', '1617', '1718', '1819', '1920', '2021', '2122', '2223', '2324', '2425', '2526'];
// casa -> columnas [apertura H,D,A] y [cierre H,D,A]
const CASAS = {
  Pinnacle: { open: ['PSH', 'PSD', 'PSA'], close: ['PSCH', 'PSCD', 'PSCA'] },
  Bet365: { open: ['B365H', 'B365D', 'B365A'], close: ['B365CH', 'B365CD', 'B365CA'] },
  Promedio: { open: ['AvgH', 'AvgD', 'AvgA'], close: ['AvgCH', 'AvgCD', 'AvgCA'] },
};

// ───────────── funciones puras (probadas en tests/steam-football-data.test.js) ─────────────

/** CSV simple con soporte de comillas. Devuelve filas como objetos por cabecera. */
function parseCsv(texto) {
  const lineas = texto.replace(/^﻿/, '').split(/\r?\n/).filter(l => l.trim() !== '');
  if (!lineas.length) return [];
  const campos = (l) => {
    const out = []; let cur = '', q = false;
    for (let i = 0; i < l.length; i++) {
      const c = l[i];
      if (c === '"') { if (q && l[i + 1] === '"') { cur += '"'; i++; } else q = !q; }
      else if (c === ',' && !q) { out.push(cur); cur = ''; }
      else cur += c;
    }
    out.push(cur);
    return out;
  };
  const cab = campos(lineas[0]).map(s => s.trim());
  return lineas.slice(1).map(l => { const v = campos(l); const o = {}; cab.forEach((c, i) => { o[c] = v[i] === undefined ? '' : v[i].trim(); }); return o; });
}

const num = (x) => { const n = Number(x); return Number.isFinite(n) && n > 1 ? n : null; };

/** Cuotas [H,D,A] de una fila para unas columnas; null si falta alguna o no es > 1. */
function cuotas(fila, columnas) {
  const v = columnas.map(c => num(fila[c]));
  return v.every(x => x != null) ? v : null;
}

const devig = (c) => { const inv = c.map(x => 1 / x), s = inv.reduce((a, b) => a + b, 0); return inv.map(x => x / s); };

/** Posicion (0=H,1=D,2=A) que gano segun FTR, o null. */
const ganador = (ftr) => ({ H: 0, D: 1, A: 2 }[String(ftr).trim()] ?? null);

// Indices del vector por partido: 3 clases x [n, ganados, prob implicita cierre, P/L cierre, P/L apertura] + brier + 1
const CLASES = ['steam', 'plano', 'deriva'];
const K = 5;
const LEN = CLASES.length * K + 1;

/**
 * Agrega un partido a un vector fijo: por clase (steam/plano/deriva segun el
 * movimiento cierre/apertura - 1 contra `umbral`) suma n, ganados, probabilidad
 * implicita al cierre y P/L a stake plano al cierre y a la apertura; al final,
 * Brier(apertura) - Brier(cierre) del 1X2 (>0: el cierre predijo mejor). Pura.
 */
function agregarPartido(abre, cierra, resultado, umbral) {
  const w = ganador(resultado);
  if (w == null || !abre || !cierra) return null;
  const v = new Float64Array(LEN);
  const pc = devig(cierra), po = devig(abre);
  for (let i = 0; i < 3; i++) {
    const m = cierra[i] / abre[i] - 1;
    const c = m <= -umbral ? 0 : m >= umbral ? 2 : 1;
    const o = c * K, gano = i === w ? 1 : 0;
    v[o] += 1; v[o + 1] += gano; v[o + 2] += pc[i];
    v[o + 3] += gano ? cierra[i] - 1 : -1;
    v[o + 4] += gano ? abre[i] - 1 : -1;
  }
  let bo = 0, bc = 0;
  for (let i = 0; i < 3; i++) { const y = i === w ? 1 : 0; bo += (po[i] - y) ** 2; bc += (pc[i] - y) ** 2; }
  v[LEN - 1] = bo - bc;
  return v;
}

/** Suma de vectores por partido (o de una remuestra por indices). */
function sumar(vectores, indices) {
  const s = new Float64Array(LEN);
  if (indices) for (const i of indices) { const v = vectores[i]; for (let j = 0; j < LEN; j++) s[j] += v[j]; }
  else for (const v of vectores) for (let j = 0; j < LEN; j++) s[j] += v[j];
  return s;
}

/** Metricas (en pp o %) desde una suma de vectores. */
function metricas(s) {
  const m = { n: {}, exceso: {}, roiCierre: {}, roiApertura: {} };
  let nT = 0, wT = 0, pT = 0, plC = 0;
  CLASES.forEach((c, k) => {
    const o = k * K, n = s[o];
    nT += n; wT += s[o + 1]; pT += s[o + 2]; plC += s[o + 3];
    m.n[c] = n;
    m.exceso[c] = n ? 100 * (s[o + 1] - s[o + 2]) / n : null;
    m.roiCierre[c] = n ? 100 * s[o + 3] / n : null;
    m.roiApertura[c] = n ? 100 * s[o + 4] / n : null;
  });
  m.roiCierre.todas = nT ? 100 * plC / nT : null;
  m.dif = (m.roiCierre.steam != null && m.roiCierre.todas != null) ? m.roiCierre.steam - m.roiCierre.todas : null;
  m.brier = s[LEN - 1] / (nT / 3);
  return m;
}

function rngSemilla(semilla) { let s = semilla >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

/** IC95 bootstrap remuestreando PARTIDOS; `extraer(metricas)` devuelve el numero a resumir. */
function bootstrap(vectores, extraer, B = 400, semilla = 11) {
  if (!vectores.length) return null;
  const rng = rngSemilla(semilla), vals = [], M = vectores.length, idx = new Int32Array(M);
  for (let b = 0; b < B; b++) {
    for (let i = 0; i < M; i++) idx[i] = Math.floor(rng() * M);
    const v = extraer(metricas(sumar(vectores, idx)));
    if (v != null && Number.isFinite(v)) vals.push(v);
  }
  if (vals.length < B / 2) return null;
  vals.sort((a, b) => a - b);
  return [vals[Math.floor(0.025 * vals.length)], vals[Math.floor(0.975 * vals.length)]];
}

module.exports = { parseCsv, cuotas, ganador, agregarPartido, sumar, metricas, bootstrap, CLASES, LEN, CASAS };

// ───────────── ejecucion ─────────────
if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });

async function descargar(dir, temporada, liga) {
  const destino = path.join(dir, `${temporada}_${liga}.csv`);
  if (fs.existsSync(destino)) return fs.readFileSync(destino, 'utf8');
  const url = `https://www.football-data.co.uk/mmz4281/${temporada}/${liga}.csv`;
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(20000) });
    if (r.status !== 200) return null;
    const t = await r.text();
    if (!/^Div|^﻿Div/.test(t)) return null;   // 200 con una pagina de error
    fs.writeFileSync(destino, t);
    await new Promise(res => setTimeout(res, 150));
    return t;
  } catch { return null; }
}

async function main() {
  const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; };
  const UMBRAL = Number(arg('umbral', 3)) / 100;
  const DESDE = arg('desde', TEMPORADAS[0]);
  const dir = path.join(__dirname, '..', 'scratch', 'football-data');
  fs.mkdirSync(dir, { recursive: true });

  // 1. descarga (con cache) y parseo
  const partidos = [];   // { temporada, liga, fila }
  let archivos = 0, bytes = 0, faltan = 0;
  for (const t of TEMPORADAS.filter(t => t >= DESDE)) {
    for (const l of LIGAS) {
      const txt = await descargar(dir, t, l);
      if (!txt) { faltan++; continue; }
      archivos++; bytes += txt.length;
      for (const fila of parseCsv(txt)) partidos.push({ temporada: t, liga: l, fila });
    }
  }
  console.log(`archivos: ${archivos} (${(bytes / 1e6).toFixed(1)} MB) | no disponibles: ${faltan} | filas: ${partidos.length}\n`);

  const fmt = (x, d = 1) => (x == null ? ' n/d' : (x >= 0 ? '+' : '') + x.toFixed(d));
  const ic = (c) => (c ? `[${c[0].toFixed(1)}, ${c[1].toFixed(1)}]` : '[n/d]');

  for (const [casa, cols] of Object.entries(CASAS)) {
    const vec = [], meta = [];
    for (const p of partidos) {
      const a = cuotas(p.fila, cols.open), c = cuotas(p.fila, cols.close);
      const v = agregarPartido(a, c, p.fila.FTR, UMBRAL);
      if (v) { vec.push(v); meta.push(p.temporada); }
    }
    if (!vec.length) { console.log(`== ${casa}: sin datos ==\n`); continue; }
    const tot = metricas(sumar(vec));
    console.log(`══ ${casa}: ${vec.length} partidos, umbral ${(UMBRAL * 100).toFixed(0)}% ══`);
    console.log('  Aciertos reales MENOS probabilidad implicita al cierre (pp por seleccion):');
    for (const c of ['steam', 'plano', 'deriva']) {
      const ci = bootstrap(vec, (m) => m.exceso[c]);
      console.log(`    ${c.padEnd(7)} n=${String(tot.n[c]).padStart(6)}  exceso ${fmt(tot.exceso[c], 2).padStart(7)} pp  IC95 ${ic(ci)}${casa === 'Pinnacle' && c === 'steam' ? '   <- PRUEBA PRINCIPAL' : ''}`);
    }
    console.log('  ROI a stake plano AL CIERRE (%):');
    for (const c of ['steam', 'plano', 'deriva', 'todas']) console.log(`    ${c.padEnd(7)} ${fmt(tot.roiCierre[c], 2).padStart(8)}%`);
    const ciDif = bootstrap(vec, (m) => m.dif);
    console.log(`    steam MENOS todas: ${fmt(tot.dif, 2)} pp  IC95 ${ic(ciDif)}`);
    console.log(`  Brier apertura MENOS cierre (>0: el cierre predice mejor): ${tot.brier.toFixed(5)}  IC95 [${(() => { const c = bootstrap(vec, (m) => m.brier); return c ? c[0].toFixed(5) + ', ' + c[1].toFixed(5) : 'n/d'; })()}]`);

    // estabilidad por temporada (steam y deriva)
    const porTemp = new Map();
    vec.forEach((v, i) => { if (!porTemp.has(meta[i])) porTemp.set(meta[i], []); porTemp.get(meta[i]).push(v); });
    console.log('  Por temporada (exceso pp):  temporada  partidos  steam  deriva');
    for (const [t, vs] of [...porTemp.entries()].sort()) {
      const m = metricas(sumar(vs));
      console.log(`    ${t}   ${String(vs.length).padStart(5)}   ${fmt(m.exceso.steam, 2).padStart(7)}  ${fmt(m.exceso.deriva, 2).padStart(7)}`);
    }
    if (casa === 'Pinnacle') {
      console.log('  Sensibilidad al umbral (exceso steam / deriva, pp):');
      for (const u of [0.02, 0.03, 0.05, 0.08]) {
        const v2 = []; for (const p of partidos) { const x = agregarPartido(cuotas(p.fila, cols.open), cuotas(p.fila, cols.close), p.fila.FTR, u); if (x) v2.push(x); }
        const m = metricas(sumar(v2));
        console.log(`    umbral ${(u * 100).toFixed(0)}%  n_steam=${String(m.n.steam).padStart(6)}  steam ${fmt(m.exceso.steam, 2).padStart(7)}  deriva ${fmt(m.exceso.deriva, 2).padStart(7)}`);
      }
    }
    console.log('');
  }
}
