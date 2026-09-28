// scripts/medir-correlacion-parlay.js
//
// FASE 0 del combinador de parlays: ¿los resultados de picks combinables (mismo partido, o mismo
// día distinto partido) están correlacionados, o multiplicar sus probabilidades como si fueran
// independientes es razonable? Sin esto, cualquier "edge" de un parlay calculado por producto de
// probabilidades es una suposición, no una medición.
//
// Método: por cada par de picks liquidados (win=1/loss=0) que podrían combinarse en un parlay,
// compara la tasa de victorias CONJUNTA observada contra la que predice independencia (p̄² con la
// tasa base del propio conjunto de picks involucrados). El intervalo de confianza se hace por
// BOOTSTRAP AGRUPADO POR DÍA (no por par): los pares de un mismo día comparten información (mismo
// régimen de mercado, mismos eventos), así que tratarlos como observaciones independientes
// subestimaría el error — mismo criterio que ya usa el proyecto en otros backtests (ver memoria
// "comparar en la misma ventana").
//
// Solo lectura. Uso: node scripts/medir-correlacion-parlay.js [tabla=picks] [dias=90]
'use strict';

const Database = require('better-sqlite3');
const path = require('path');

const DB_FILE = process.env.DB_PATH || path.join(__dirname, '..', 'snapshots.db');
const db = new Database(DB_FILE, { readonly: true, timeout: 20000 });

const TABLA = process.argv[2] || 'picks';
const DIAS = Number(process.argv[3]) || 90;
const N_BOOT = 2000;

if (!['picks', 'model_picks'].includes(TABLA)) {
  console.error('tabla debe ser "picks" o "model_picks"');
  process.exit(1);
}

const rows = db.prepare(
  `SELECT id, ts, event_id, result FROM ${TABLA}
     WHERE result IN ('win','loss') AND ts >= datetime('now', ?)`
).all(`-${DIAS} days`).map((r) => ({
  ...r,
  win: r.result === 'win' ? 1 : 0,
  dia: r.ts.slice(0, 10),
}));

console.log(`${TABLA}: ${rows.length} picks liquidados en los últimos ${DIAS} días.`);
if (rows.length < 100) {
  console.log('Muy pocos para medir nada; aborto.');
  process.exit(0);
}

// Agrupar por día
const porDia = new Map();
for (const r of rows) {
  if (!porDia.has(r.dia)) porDia.set(r.dia, []);
  porDia.get(r.dia).push(r);
}

// Generar pares: mismo partido (cualquier día) y mismo día/partido distinto.
function generarPares() {
  const mismoPartido = [];
  const cruzado = [];
  for (const [dia, picksDelDia] of porDia) {
    // mismo partido: agrupar por event_id dentro del día (un evento no cruza medianoche en la práctica)
    const porEvento = new Map();
    for (const p of picksDelDia) {
      if (!porEvento.has(p.event_id)) porEvento.set(p.event_id, []);
      porEvento.get(p.event_id).push(p);
    }
    const eventos = [...porEvento.values()];
    for (const ps of eventos) {
      for (let i = 0; i < ps.length; i++)
        for (let j = i + 1; j < ps.length; j++)
          mismoPartido.push({ dia, a: ps[i], b: ps[j] });
    }
    // cruzado: distinto evento, mismo día
    for (let i = 0; i < eventos.length; i++)
      for (let j = i + 1; j < eventos.length; j++)
        for (const a of eventos[i])
          for (const b of eventos[j])
            cruzado.push({ dia, a, b });
  }
  return { mismoPartido, cruzado };
}

const { mismoPartido, cruzado } = generarPares();

// Estadístico: lift = P(ambos ganan) observado / (p̄² esperado bajo independencia).
// p̄ se calcula sobre el conjunto de picks EN EL SUBGRUPO analizado (no fuga desde el otro grupo).
function medir(pares, etiqueta) {
  if (pares.length < 30) {
    console.log(`\n${etiqueta}: solo ${pares.length} pares, insuficiente para medir con confianza.`);
    return;
  }
  const idsInvolucrados = new Set();
  for (const { a, b } of pares) { idsInvolucrados.add(a.id); idsInvolucrados.add(b.id); }
  const involucrados = rows.filter((r) => idsInvolucrados.has(r.id));
  const pBase = involucrados.reduce((s, r) => s + r.win, 0) / involucrados.length;

  const statFor = (subset) => {
    const obs = subset.reduce((s, { a, b }) => s + a.win * b.win, 0) / subset.length;
    const esperado = pBase * pBase;
    return { obs, esperado, lift: esperado > 0 ? obs / esperado : null, n: subset.length };
  };

  const real = statFor(pares);

  // Bootstrap agrupado por día: cada iteración resamplea los DÍAS con reemplazo, no los pares.
  const dias = [...new Set(pares.map((p) => p.dia))];
  const paresPorDia = new Map();
  for (const p of pares) { if (!paresPorDia.has(p.dia)) paresPorDia.set(p.dia, []); paresPorDia.get(p.dia).push(p); }
  const lifts = [];
  for (let b = 0; b < N_BOOT; b++) {
    const muestra = [];
    for (let i = 0; i < dias.length; i++) {
      const d = dias[Math.floor(Math.random() * dias.length)];
      muestra.push(...paresPorDia.get(d));
    }
    if (muestra.length < 10) continue;
    const s = statFor(muestra);
    if (s.lift !== null && Number.isFinite(s.lift)) lifts.push(s.lift);
  }
  lifts.sort((x, y) => x - y);
  const pct = (q) => lifts[Math.floor(q * lifts.length)];

  console.log(`\n${etiqueta}: n=${real.n} pares, ${dias.length} días, ${involucrados.length} picks involucrados (base win% del subgrupo: ${(pBase * 100).toFixed(1)}%)`);
  console.log(`  P(ambos ganan) observado : ${(real.obs * 100).toFixed(2)}%`);
  console.log(`  P(ambos ganan) esperado (independencia, p̄²) : ${(real.esperado * 100).toFixed(2)}%`);
  console.log(`  lift = observado/esperado : ${real.lift.toFixed(3)}  (1.0 = independencia; >1 = correlación positiva; <1 = negativa)`);
  console.log(`  IC 95% del lift (bootstrap por día, ${lifts.length} iteraciones válidas) : [${pct(0.025).toFixed(3)}, ${pct(0.975).toFixed(3)}]`);
  const incluyeUno = pct(0.025) <= 1 && pct(0.975) >= 1;
  console.log(`  ¿el IC incluye 1.0 (sin evidencia de correlación)? ${incluyeUno ? 'SÍ' : 'NO'}`);
}

console.log('─'.repeat(70));
medir(mismoPartido, 'MISMO PARTIDO (2+ patas del mismo evento, cualquier mercado)');
medir(cruzado, 'MISMO DÍA, PARTIDO DISTINTO (candidato a parlay cross-match)');
console.log('─'.repeat(70));
console.log('Nota: "mismo día" agrupa por fecha UTC del ts de emisión, no por proximidad horaria');
console.log('real entre partidos — una medida más fina (misma franja, misma liga) queda para después');
console.log('si esto muestra señal.');
