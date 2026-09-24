/**
 * scripts/entrenar-nb-fotmob.js
 * ─────────────────────────────────────────────────────────────────────────
 * Calibra el NB de corners contra los finales REALES de FotMob y escribe
 * fotmob_nb.json (lo lee src/nbCalibrado.js cuando STATS_NB_CALIBRADO=on).
 * Sucesor de scripts/entrenar-nb-corners.js, que ajustaba sobre el conteo
 * inferido de playdoit (90% censurado).
 *
 * QUE AJUSTA
 *  - (mu, r): MLE de una NB sobre el TOTAL final de cada partido. Sin
 *    censura: el final viene directo de FotMob.
 *  - F(t): perfil de intensidad, fraccion esperada del total ya ocurrida al
 *    minuto t (razon de sumas por bloque de 5', ubicada en el minuto medio
 *    real del bloque, monotona por regresion isotonica). Reemplaza al t/90.
 *
 * DATOS
 *  - fotmob_corner_snapshots desde el arranque del piloto FotMob
 *    (2026-09-16T01:40Z; antes los IDs eran de SofaScore) y el final real de
 *    cada partido terminado, pedido a FotMob y cacheado en
 *    scratch/_fotmob_finales.json. Los partidos NO terminados se vuelven a
 *    pedir en cada corrida.
 *  - Un snapshot por partido por bloque de 5' (el descanso duplica la misma
 *    lectura ~5 veces).
 *
 * VALIDACION
 *  - Corte CRONOLOGICO por partido: 70% mas antiguo entrena, 30% mas reciente
 *    es test intacto. Metrica: log-verosimilitud de lo que FALTABA (por
 *    partido, cada partido pesa igual) contra el NB actual. IC95 por bootstrap
 *    sobre partidos.
 *  - Solo se escribe el archivo si la mejora en test es distinguible de cero
 *    (IC95 inferior > 0) — o con --forzar. El archivo final se reajusta con
 *    TODOS los datos.
 *
 * RESULTADO DE LA PRIMERA CORRIDA (2026-09-19, 211 partidos, 147 train / 64 test):
 *  - mu 12.985 -> 9.75 (media real 9.77), r 7.3 -> 22.5.
 *  - El modelo viejo predecia 1.68 corners restantes entre el 65' y el 85' y
 *    caian 2.62 (ratio 1.56); ~15% de los corners caen tras el '90 nominal.
 *  - Test intacto: loglik/partido -2.511 -> -2.285 (+0.226, IC95 [0.095, 0.372],
 *    mejora en 44 de 64 partidos). Sesgo de lo que falta en train: 1.00-1.03
 *    en todos los tramos (antes 0.86 a 1.56).
 *
 * PROBADO Y DESCARTADO (2026-09-19): multiplicador de ritmo con centros
 * precisos / toques en area rival (FotMob) sobre la tasa de lo que falta.
 * Sobre 163 partidos NINGUNA de 144 configuraciones mejoro al NB base (mejor
 * caso -0.003, IC95 [-0.007, +0.001]) y el ratio real/esperado de lo que falta
 * no sube con el ritmo (cuartiles Q1..Q4 de centros: 1.03, 1.13, 1.10, 1.01).
 * La correlacion 0.43 vista con el total final era acumulacion simultanea
 * con el tiempo, no informacion incremental sobre el conteo ya visto.
 *
 *   node scripts/entrenar-nb-fotmob.js            # reporta y escribe si valida
 *   node scripts/entrenar-nb-fotmob.js --forzar   # escribe aunque no valide
 *   node scripts/entrenar-nb-fotmob.js --seco     # solo reporta
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { db } = require('../src/db');
const { fetchJson, extraerTeamStats, estadoDesde } = require('../src/fotmobScraper');
const { posteriorNB, MINUTOS_PARTIDO } = require('../src/matchStats');
const { numDe, minutoDeStatus, fraccion } = require('../src/nbCalibrado');
const nb = require('../src/negBinomial');

const DESDE = '2026-09-16T01:40:00Z';
const CACHE = path.join(__dirname, '..', 'scratch', '_fotmob_finales.json');
const SALIDA = path.join(__dirname, '..', 'fotmob_nb.json');
const FORZAR = process.argv.includes('--forzar');
const SECO = process.argv.includes('--seco');
const media = (a) => a.reduce((s, x) => s + x, 0) / (a.length || 1);

function seedRng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

async function cargarFinales(ids) {
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(CACHE, 'utf8')); } catch {}
  const faltan = ids.filter(id => !cache[id] || !cache[id].fin);
  console.log(`finales en cache: ${ids.length - faltan.length}, por pedir: ${faltan.length}`);
  let i = 0;
  async function worker() {
    while (i < faltan.length) {
      const id = faltan[i++];
      try {
        const d = await fetchJson(`/data/matchDetails?matchId=${id}`, { timeoutMs: 15000 });
        const { statusType } = estadoDesde(d?.header?.status || d?.general?.status);
        const { corners } = extraerTeamStats(d);
        cache[id] = statusType === 'finished' && corners
          ? { fin: true, final: numDe(corners.home) + numDe(corners.away) }
          : { fin: false };
      } catch (e) {
        cache[id] = { fin: false, err: e.message };
      }
      await new Promise(r => setTimeout(r, 80));
    }
  }
  await Promise.all(Array.from({ length: 6 }, worker));
  fs.mkdirSync(path.dirname(CACHE), { recursive: true });
  fs.writeFileSync(CACHE, JSON.stringify(cache));
  return cache;
}

function construir(finales) {
  const filas = db.prepare(`
    SELECT fotmob_event_id id, ts, status, corners_home ch, corners_away ca
    FROM fotmob_corner_snapshots WHERE ts >= ? ORDER BY fotmob_event_id, ts
  `).all(DESDE);
  const ev = new Map();
  for (const r of filas) {
    const fin = finales[r.id];
    if (!fin || !fin.fin) continue;
    if (!ev.has(r.id)) ev.set(r.id, { id: r.id, t0: r.ts, final: fin.final, s: new Map() });
    const min = minutoDeStatus(r.status);
    if (min == null || min < 5 || min > 105 || r.ch == null || r.ca == null) continue;
    const c = r.ch + r.ca;
    if (fin.final < c) continue; // final menor que lo ya visto: lectura/emparejado malo
    ev.get(r.id).s.set(Math.floor(min / 5), { min, c });
  }
  const todos = [...ev.values()].map(e => ({ ...e, s: [...e.s.values()] })).sort((a, b) => a.t0.localeCompare(b.t0));
  return { todos, conSerie: todos.filter(e => e.s.length >= 2) };
}

// Regresion isotonica (pool-adjacent-violators) ponderada: ajusta y[] no decreciente.
function isotonica(y, w) {
  const bloques = [];
  for (let i = 0; i < y.length; i++) {
    bloques.push({ v: y[i], w: w[i], n: 1 });
    while (bloques.length > 1 && bloques[bloques.length - 2].v > bloques[bloques.length - 1].v) {
      const b = bloques.pop(), a = bloques.pop();
      bloques.push({ v: (a.v * a.w + b.v * b.w) / (a.w + b.w), w: a.w + b.w, n: a.n + b.n });
    }
  }
  return bloques.flatMap(b => Array(b.n).fill(b.v));
}

// Perfil F(t) = fraccion esperada del total ya ocurrida al minuto t. Por bloque
// de 5': razon de sumas c/final (estimador consistente si los corners llegan
// como Poisson con una tasa por partido) colocada en el MINUTO MEDIO REAL de
// los snapshots del bloque. Ubicarla en un nudo fijo usando el ultimo snapshot
// anterior subestimaba c (esta en promedio ~1.5' atras) y sesgaba F a la baja,
// o sea sobrestimaba lo que falta en la segunda mitad. Los bloques con pocas
// observaciones se omiten; monotonia por regresion isotonica; F=1 en NUDO_FIN.
const MIN_OBS_BLOQUE = 15;
const NUDO_FIN = 115; // ningun partido regular pasa de ~115' de reloj
function ajustarPerfil(eventos) {
  const bloques = new Map();
  for (const e of eventos) for (const p of e.s) {
    const b = Math.floor(p.min / 5);
    if (!bloques.has(b)) bloques.set(b, { sc: 0, sf: 0, sm: 0, n: 0 });
    const x = bloques.get(b);
    x.sc += p.c; x.sf += e.final; x.sm += p.min; x.n++;
  }
  const pts = [...bloques.entries()].sort((a, b) => a[0] - b[0])
    .map(([, x]) => x).filter(x => x.n >= MIN_OBS_BLOQUE && x.sf > 0)
    .map(x => ({ t: x.sm / x.n, f: x.sc / x.sf, w: x.n }));
  const iso = isotonica(pts.map(p => p.f), pts.map(p => p.w));
  const nudos = [0], F = [0];
  pts.forEach((p, i) => {
    if (p.t <= nudos[nudos.length - 1] || p.t >= NUDO_FIN) return;
    nudos.push(+p.t.toFixed(2)); F.push(Math.min(1, Math.max(iso[i], F[F.length - 1])));
  });
  nudos.push(NUDO_FIN); F.push(1);
  return { nudos, F };
}

function ajustar(eventosConFinal, eventosSerie) {
  const fit = nb.fit(eventosConFinal.map(e => ({ count: e.final, censored: false })));
  return { mu: fit.mu, r: fit.r, ...ajustarPerfil(eventosSerie), _fit: fit };
}

// Log-verosimilitud media por PARTIDO de lo que faltaba. cal=null -> NB actual.
function evaluar(eventos, cal, minMax) {
  return eventos.map(e => {
    let s = 0, n = 0;
    for (const p of e.s) {
      if (p.min > minMax) continue;
      let m, a;
      if (cal) {
        const f = fraccion(cal, p.min);
        a = cal.r + p.c;
        m = a * (1 - f) / (cal.r / cal.mu + f);
      } else {
        const post = posteriorNB(p.c, p.min, undefined, undefined); // modelo actual (sin calibrar)
        m = post.muRestante; a = post.alphaPost;
      }
      s += nb.logPmf(e.final - p.c, Math.max(m, 1e-9), a); n++;
    }
    return n ? s / n : 0;
  });
}

function bootstrap(dif, B = 4000) {
  const rng = seedRng(11), n = dif.length, m = [];
  for (let b = 0; b < B; b++) { let s = 0; for (let i = 0; i < n; i++) s += dif[Math.floor(rng() * n)]; m.push(s / n); }
  m.sort((a, b) => a - b);
  return { lo: m[Math.floor(0.025 * B)], hi: m[Math.floor(0.975 * B)] };
}

// Sesgo por tramo del partido: real vs esperado de lo que falta.
function sesgoPorMinuto(eventos, cal) {
  const filas = [];
  for (const [lo, hi] of [[5, 25], [25, 45], [45, 65], [65, 85]]) {
    let real = 0, esp = 0, n = 0;
    for (const e of eventos) for (const p of e.s) {
      if (p.min < lo || p.min >= hi) continue;
      real += e.final - p.c;
      esp += cal
        ? (() => { const f = fraccion(cal, p.min); return (cal.r + p.c) * (1 - f) / (cal.r / cal.mu + f); })()
        : posteriorNB(p.c, p.min, undefined, undefined).muRestante;
      n++;
    }
    if (n) filas.push(`min ${lo}-${hi}: real ${(real / n).toFixed(2)} vs esperado ${(esp / n).toFixed(2)} -> ratio ${(real / esp).toFixed(3)} (n=${n})`);
  }
  return filas;
}

async function main() {
  if (String(process.env.STATS_NB_CALIBRADO || 'off').toLowerCase() === 'on') {
    console.log('AVISO: STATS_NB_CALIBRADO=on en este entorno; la comparacion "actual" usa el modelo SIN calibrar (mu/r y t/90 explicitos).');
  }
  const ids = db.prepare('SELECT DISTINCT fotmob_event_id id FROM fotmob_corner_snapshots WHERE ts >= ?').all(DESDE).map(r => r.id);
  const finales = await cargarFinales(ids);
  const { todos, conSerie } = construir(finales);
  console.log(`partidos terminados: ${todos.length} | con serie utilizable: ${conSerie.length}`);
  if (conSerie.length < 60) { console.log('Muy pocos partidos para calibrar con solidez (< 60).'); process.exit(0); }

  const corte = Math.floor(conSerie.length * 0.7);
  const train = conSerie.slice(0, corte), test = conSerie.slice(corte);
  const t0Test = test[0].t0;
  const totalesTrain = todos.filter(e => e.t0 < t0Test);
  console.log(`train: ${train.length} partidos (${totalesTrain.length} totales) | test: ${test.length} partidos (desde ${t0Test.slice(0, 16)})\n`);

  const calTrain = ajustar(totalesTrain, train);
  console.log(`ajuste en train: mu=${calTrain.mu.toFixed(2)} r=${calTrain.r.toFixed(2)} (dispersion ${calTrain._fit.dispersion.toFixed(2)})`);
  console.log('perfil F(t): ' + calTrain.nudos.map((k, i) => `${k}':${calTrain.F[i].toFixed(3)}`).join('  '));

  const base = evaluar(test, null, 85), cal = evaluar(test, calTrain, 85);
  const dif = cal.map((v, i) => v - base[i]);
  const ic = bootstrap(dif);
  console.log(`\n=== TEST INTACTO (${test.length} partidos, loglik por partido, minutos <= 85) ===`);
  console.log(`  NB actual: ${media(base).toFixed(4)}   calibrado: ${media(cal).toFixed(4)}   mejora: ${media(dif) >= 0 ? '+' : ''}${media(dif).toFixed(4)}  IC95 [${ic.lo.toFixed(4)}, ${ic.hi.toFixed(4)}]`);
  console.log(`  partidos donde mejora: ${dif.filter(d => d > 0).length}/${dif.length}`);
  console.log('\nSesgo de lo que falta en test (real / esperado; 1.0 = calibrado):');
  console.log('  ACTUAL:     ' + sesgoPorMinuto(test, null).join('\n              '));
  console.log('  CALIBRADO:  ' + sesgoPorMinuto(test, calTrain).join('\n              '));

  console.log('\nMismo sesgo EN TRAIN (dentro de muestra, para distinguir sesgo estructural de ruido del periodo de test):');
  console.log('  CALIBRADO:  ' + sesgoPorMinuto(train, calTrain).join('\n              '));

  const valida = ic.lo > 0;
  console.log(valida ? '\nVEREDICTO: la mejora es distinguible de cero en el test intacto.' : '\nVEREDICTO: la mejora NO es distinguible de cero en el test intacto.');
  if (SECO) return;
  if (!valida && !FORZAR) { console.log('No se escribe fotmob_nb.json (usa --forzar para escribirlo igual).'); return; }

  const final = ajustar(todos, conSerie);
  const out = {
    version: 1, generado: new Date().toISOString(), desde: DESDE,
    mu: +final.mu.toFixed(4), r: +final.r.toFixed(4),
    nudos: final.nudos, F: final.F.map(x => +x.toFixed(4)),
    nTotales: todos.length, nSerie: conSerie.length,
    validacion: {
      nTrain: train.length, nTest: test.length,
      mejoraLoglikTest: +media(dif).toFixed(4), ic95: [+ic.lo.toFixed(4), +ic.hi.toFixed(4)],
      distinguibleDeCero: valida,
    },
  };
  fs.writeFileSync(SALIDA, JSON.stringify(out, null, 2));
  console.log(`\nEscrito ${SALIDA} (mu=${out.mu}, r=${out.r}, n=${out.nSerie}). Activar con STATS_NB_CALIBRADO=on y reiniciar el bot.`);
}

// Exportado para scripts/backtest-picks-nb-fotmob.js (validacion cruzada).
module.exports = { DESDE, cargarFinales, construir, ajustar, ajustarPerfil };

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
