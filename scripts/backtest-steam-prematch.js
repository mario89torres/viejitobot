/**
 * scripts/backtest-steam-prematch.js
 * ─────────────────────────────────────────────────────────────────────────
 * ¿El movimiento de la cuota PRE-PARTIDO de Playdoit ("steam") predice el
 * resultado? Usa prematch_snapshots (piloto PREMATCH_PILOT) y los marcadores
 * finales de FotMob. Solo lectura: no toca picks, firewall ni modelo.
 *
 * DEFINICIONES
 *  - apertura = primera muestra; cierre = ultima muestra ANTES del kickoff.
 *  - movimiento m = cierre/apertura - 1. "Steam" = la cuota se acorto (m <= -umbral);
 *    "deriva" = subio (m >= +umbral); "plano" = el resto.
 *  - "Apertura" es la primera muestra del piloto (desde el 22-sep), no la
 *    apertura real del mercado.
 *
 * PRUEBA PRINCIPAL (fijada ANTES de ver resultados, para no elegir la mejor
 * de muchas): 1X2, umbral 3%, ROI a stake plano apostando AL CIERRE al lado
 * steam, MENOS el ROI de apostar a TODAS las selecciones al cierre. Si el
 * cierre fuera eficiente, la diferencia seria ~0 (ambos pierden el margen).
 * Todo lo demas se reporta como exploratorio.
 *
 * REGLAS PARA NO AUTOENGANARSE
 *  - Las selecciones de un mismo partido son dependientes: los intervalos de
 *    confianza (bootstrap) remuestrean PARTIDOS, no filas.
 *  - Un backtest es un candidato, no la respuesta: se reporta N e intervalo.
 *  - Marcador final: FotMob cuando existe; si no, el ultimo marcador de NUESTRO
 *    feed en vivo (src/marcadorFeed.js, solo si la ultima muestra fue minuto >= 85
 *    de la 2a parte). Ese marcador coincide ~93% con FotMob y se equivoca en el
 *    resultado 1X2 ~5% (gol en el descuento): el ruido de etiqueta diluye los
 *    efectos hacia cero, asi que un "no hay nada" con feed se lee con ese matiz.
 *    --solo-fotmob restringe a la muestra oficial (mas chica y sesgada a ligas
 *    que FotMob cubre). Sin ninguna de las dos fuentes = fuera de la muestra.
 *
 *   node scripts/backtest-steam-prematch.js [--umbral 3] [--span-h 6]
 */
const fs = require('fs');
const path = require('path');

// ───────────── funciones puras (probadas en tests/steam-backtest.test.js) ─────────────

const MERCADO_1X2 = 'Resultado Final (Tiempo Regular)';
const MERCADO_OU = 'Total 2.5';

/** ¿Gano esta seleccion? true/false, o null si no se puede resolver. */
function gano(mercado, seleccion, home, away, gl, gv) {
  if (!Number.isInteger(gl) || !Number.isInteger(gv)) return null;
  const s = String(seleccion).trim();
  if (mercado === MERCADO_1X2) {
    if (/^empate$/i.test(s)) return gl === gv;
    if (s === String(home).trim()) return gl > gv;
    if (s === String(away).trim()) return gv > gl;
    return null;
  }
  if (mercado === MERCADO_OU) {
    if (/^m[aá]s de 2\.5$/i.test(s)) return gl + gv > 2.5;
    if (/^menos de 2\.5$/i.test(s)) return gl + gv < 2.5;
    return null;
  }
  return null;
}

/** ROI (%) a stake plano de una lista de { odd, gano }. null si esta vacia. */
function roi(filas) {
  if (!filas.length) return null;
  const pl = filas.reduce((s, f) => s + (f.gano ? f.odd - 1 : -1), 0);
  return 100 * pl / filas.length;
}

/** De-vig proporcional: probabilidades que suman 1 a partir de cuotas decimales. */
function devigProporcional(cuotas) {
  const inv = cuotas.map(c => 1 / c);
  const s = inv.reduce((a, b) => a + b, 0);
  return inv.map(x => x / s);
}

function rngSemilla(semilla) { let s = semilla >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

/**
 * Intervalo bootstrap 95% de `estadistico(filas)` remuestreando PARTIDOS
 * (grupos), no filas. grupos: Map/obj clave -> filas[]. Determinista por semilla.
 */
function bootstrapPorPartido(grupos, estadistico, B = 2000, semilla = 7) {
  const lista = Array.isArray(grupos) ? grupos : [...grupos.values()];
  if (!lista.length) return null;
  const rng = rngSemilla(semilla), vals = [];
  for (let b = 0; b < B; b++) {
    const muestra = [];
    for (let i = 0; i < lista.length; i++) muestra.push(...lista[Math.floor(rng() * lista.length)]);
    const v = estadistico(muestra);
    if (v != null && Number.isFinite(v)) vals.push(v);
  }
  if (vals.length < B / 2) return null;
  vals.sort((a, b) => a - b);
  return [vals[Math.floor(0.025 * vals.length)], vals[Math.floor(0.975 * vals.length)]];
}

/** Clasifica un movimiento relativo m contra un umbral (fraccion, p. ej. 0.03). */
function claseMovimiento(m, umbral) {
  if (m <= -umbral) return 'steam';
  if (m >= umbral) return 'deriva';
  return 'plano';
}

module.exports = { gano, roi, devigProporcional, bootstrapPorPartido, claseMovimiento, MERCADO_1X2, MERCADO_OU };

// ───────────── ejecucion ─────────────
if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });

async function main() {
  require('dotenv').config();
  const { db } = require('../src/db');
  const { scheduledToday, fetchMarcadorFinal } = require('../src/fotmobScraper');
  const { teamsMatch } = require('../src/teamMatch');

  const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? Number(process.argv[i + 1]) : d; };
  const UMBRAL = arg('umbral', 3) / 100;
  const SPAN_MIN_H = arg('span-h', 6);
  const CACHE = path.join(__dirname, '..', 'scratch', '_steam_resultados.json');
  const cache = fs.existsSync(CACHE) ? JSON.parse(fs.readFileSync(CACHE, 'utf8')) : {};

  // ── 1. eventos con curva y kickoff pasado
  const eventos = db.prepare(`
    SELECT event_id, event, MAX(start_date) start_date FROM prematch_snapshots
    WHERE start_date < strftime('%Y-%m-%dT%H:%M:%SZ','now') AND ts < start_date
    GROUP BY event_id HAVING COUNT(DISTINCT ts) >= 2
  `).all();
  console.log(`eventos con curva y kickoff pasado: ${eventos.length}`);

  // ── 2. marcador final desde FotMob (cacheado)
  const dia = ms => new Date(ms).toISOString().slice(0, 10);
  const calCache = new Map();
  const cal = async d => { if (!calCache.has(d)) { try { calCache.set(d, await scheduledToday(d)); } catch { calCache.set(d, []); } } return calCache.get(d); };
  // Marcador desde NUESTRO feed en vivo (src/marcadorFeed.js) para lo que FotMob no
  // cubre. No es oficial: coincide ~93% con FotMob y se equivoca en el resultado 1X2
  // ~5% (gol en el descuento tras la ultima muestra). Va marcado fuente:'feed'.
  const { marcadorFinalCreible, ultimaMuestraConMarcador } = require('../src/marcadorFeed');
  const SOLO_FOTMOB = process.argv.includes('--solo-fotmob');
  const viaFeed = (ev, ko) => {
    const m = marcadorFinalCreible(ultimaMuestraConMarcador(db, ev.event_id), ko);
    return m ? { final: true, gl: m.gl, gv: m.gv, fuente: 'feed' } : null;
  };
  let sinMatch = 0, sinFinal = 0, conMarcador = 0, nFotmob = 0, nFeed = 0;
  for (const ev of eventos) {
    const previo = cache[ev.event_id];
    if (previo?.final && !(SOLO_FOTMOB && previo.fuente === 'feed')) { conMarcador++; previo.fuente === 'feed' ? nFeed++ : nFotmob++; continue; }
    if (previo?.final) { sinMatch++; continue; }   // --solo-fotmob: ignora lo que vino del feed
    const t = ev.event.split(/\s+vs\.?\s+/i).map(s => s.trim());
    const ko = Date.parse(ev.start_date);
    if (t.length < 2 || Number.isNaN(ko)) { sinMatch++; continue; }
    let c = []; for (const d of new Set([dia(ko - 86400e3), dia(ko), dia(ko + 86400e3)])) c.push(...await cal(d));
    c = c.filter(e => e.home && e.away && e.commenceTime && Math.abs(Date.parse(e.commenceTime) - ko) <= 3 * 3600e3 && teamsMatch(t[0], e.home) && teamsMatch(t[1], e.away));
    if (c.length !== 1) {
      // sin partido en FotMob: se intenta el feed propio (salvo --solo-fotmob)
      const f2 = SOLO_FOTMOB ? null : viaFeed(ev, ko);
      if (f2) { cache[ev.event_id] = f2; conMarcador++; nFeed++; } else sinMatch++;
      continue;
    }
    let f = null; try { f = await fetchMarcadorFinal(c[0].id); } catch { /* sin final */ }
    if (!f?.finished) { sinFinal++; continue; }
    cache[ev.event_id] = { final: true, gl: f.home, gv: f.away, fotmob: c[0].id, fuente: 'fotmob' };
    conMarcador++; nFotmob++;
    await new Promise(r => setTimeout(r, 150));
  }
  fs.mkdirSync(path.dirname(CACHE), { recursive: true });
  fs.writeFileSync(CACHE, JSON.stringify(cache));
  console.log(`con marcador final: ${conMarcador} (FotMob ${nFotmob} + feed propio ${nFeed}${SOLO_FOTMOB ? ' [--solo-fotmob]' : ''}) | sin marcador: ${sinMatch} | FotMob sin final aun: ${sinFinal}\n`);

  // ── 3. curvas de las selecciones de interes (solo 1X2 y Total 2.5, antes del kickoff)
  const consulta = db.prepare(`
    SELECT ts, market, selection, odd_decimal FROM prematch_snapshots
    WHERE event_id = ? AND ts < ? AND market IN (?, ?) AND odd_decimal IS NOT NULL AND suspended = 0
    ORDER BY ts
  `);
  const filas = [];           // una por (evento, seleccion): apertura, cierre, T-3h, resultado
  const briers = [];          // por evento 1X2: Brier apertura vs cierre
  for (const ev of eventos) {
    const r = cache[ev.event_id]; if (!r?.final || (SOLO_FOTMOB && r.fuente === 'feed')) continue;
    const t = ev.event.split(/\s+vs\.?\s+/i).map(s => s.trim());
    const ko = Date.parse(ev.start_date);
    const muestras = consulta.all(ev.event_id, ev.start_date, MERCADO_1X2, MERCADO_OU);
    const porMercadoSel = new Map();
    for (const m of muestras) {
      const k = m.market + '||' + m.selection;
      if (!porMercadoSel.has(k)) porMercadoSel.set(k, []);
      porMercadoSel.get(k).push({ ts: Date.parse(m.ts), odd: m.odd_decimal });
    }
    for (const [k, serie] of porMercadoSel) {
      if (serie.length < 2) continue;
      const [mercado, seleccion] = k.split('||');
      const ap = serie[0], ci = serie[serie.length - 1];
      if ((ci.ts - ap.ts) / 3600e3 < SPAN_MIN_H) continue;
      const g = gano(mercado, seleccion, t[0], t[1], r.gl, r.gv);
      if (g == null) continue;
      // muestra mas cercana a T-3h del kickoff (±45 min), para la variante accionable
      const objetivo = ko - 3 * 3600e3;
      const cerca = serie.filter(x => Math.abs(x.ts - objetivo) <= 45 * 60e3 && x.ts > ap.ts).sort((a, b) => Math.abs(a.ts - objetivo) - Math.abs(b.ts - objetivo))[0] || null;
      filas.push({ evento: ev.event_id, mercado, seleccion, apertura: ap.odd, cierre: ci.odd, spanH: (ci.ts - ap.ts) / 3600e3, gano: g, t3: cerca ? cerca.odd : null });
    }
    // Brier apertura vs cierre (1X2 completo: 3 selecciones con cuota en ambos instantes)
    const sels = [...porMercadoSel.entries()].filter(([k]) => k.startsWith(MERCADO_1X2 + '||'));
    if (sels.length === 3 && sels.every(([, s]) => s.length >= 2 && (s[s.length - 1].ts - s[0].ts) / 3600e3 >= SPAN_MIN_H)) {
      const ys = sels.map(([k]) => gano(MERCADO_1X2, k.split('||')[1], t[0], t[1], r.gl, r.gv));
      if (ys.every(y => y != null)) {
        const po = devigProporcional(sels.map(([, s]) => s[0].odd)), pc = devigProporcional(sels.map(([, s]) => s[s.length - 1].odd));
        const br = (p) => p.reduce((s, x, i) => s + (x - (ys[i] ? 1 : 0)) ** 2, 0);
        briers.push([{ dif: br(po) - br(pc) }]); // >0: el cierre predijo mejor que la apertura
      }
    }
  }
  const eventosUsados = new Set(filas.map(f => f.evento)).size;
  console.log(`selecciones analizables: ${filas.length} en ${eventosUsados} partidos (span >= ${SPAN_MIN_H} h, umbral steam ${(UMBRAL * 100).toFixed(0)}%)\n`);

  // ── 4. reporte
  const porEvento = (lista) => { const m = new Map(); for (const f of lista) { if (!m.has(f.evento)) m.set(f.evento, []); m.get(f.evento).push(f); } return [...m.values()]; };
  const fmt = (x, d = 1) => (x == null ? '   n/d' : (x >= 0 ? '+' : '') + x.toFixed(d) + '%');
  const ic = (ci) => (ci ? `[${ci[0].toFixed(1)}, ${ci[1].toFixed(1)}]` : '[n/d]');
  const wr = (l) => (l.length ? (100 * l.filter(f => f.gano).length / l.length).toFixed(1) + '%' : '  n/d');
  const linea = (nombre, lista, precio) => {
    const r = lista.map(f => ({ odd: f[precio], gano: f.gano })).filter(f => f.odd != null);
    const ci = bootstrapPorPartido(porEvento(lista.filter(f => f[precio] != null)).map(g => g.map(f => ({ odd: f[precio], gano: f.gano }))), roi);
    console.log(`  ${nombre.padEnd(26)} n=${String(r.length).padStart(4)}  WR ${wr(lista).padStart(6)}  ROI ${fmt(roi(r)).padStart(8)}  IC95 ${ic(ci)}`);
    return r;
  };

  for (const [titulo, mercado] of [['1X2', MERCADO_1X2], ['Over/Under 2.5', MERCADO_OU], ['AMBOS', null]]) {
    const base = filas.filter(f => !mercado || f.mercado === mercado);
    const clase = (f) => claseMovimiento(f.cierre / f.apertura - 1, UMBRAL);
    console.log(`── ${titulo} (${base.length} selecciones, ${new Set(base.map(f => f.evento)).size} partidos) ──`);
    for (const precio of ['cierre', 'apertura']) {
      console.log(` Apostando al ${precio.toUpperCase()}:`);
      linea('TODAS (referencia)', base, precio);
      for (const c of ['steam', 'plano', 'deriva']) linea(c, base.filter(f => clase(f) === c), precio);
      // diferencia steam - referencia, con IC por partido
      const grupos = porEvento(base);
      const dif = (muestra) => {
        const s = muestra.filter(f => clase(f) === 'steam').map(f => ({ odd: f[precio], gano: f.gano }));
        return s.length ? roi(s) - roi(muestra.map(f => ({ odd: f[precio], gano: f.gano }))) : null;
      };
      const d = dif(base);
      console.log(`  >> steam MENOS referencia (${precio}): ${fmt(d)} pp  IC95 ${ic(bootstrapPorPartido(grupos, dif))}${mercado === MERCADO_1X2 && precio === 'cierre' ? '   <- PRUEBA PRINCIPAL' : ''}`);
    }
    // variante accionable: la senal se observa a T-3h y se apuesta al precio de T-3h
    const t3 = base.filter(f => f.t3 != null);
    if (t3.length) {
      console.log(` Accionable (senal y precio a T-3h; n=${t3.length}):`);
      const claseT = (f) => claseMovimiento(f.t3 / f.apertura - 1, UMBRAL);
      linea('TODAS (referencia)', t3, 't3');
      for (const c of ['steam', 'deriva']) linea(c, t3.filter(f => claseT(f) === c), 't3');
    }
    console.log('');
  }

  // ── 4b. MEDIDA CORREGIDA: aciertos reales menos lo que implica el precio de cierre.
  // La prueba principal de arriba compara el ROI del lado steam (casi siempre el
  // favorito) contra TODAS las selecciones (mezcla con muchos no favoritos), asi
  // que mezcla el efecto del movimiento con el sesgo favorito-longshot. Aqui se
  // controla el nivel de precio: exceso = aciertos reales - suma de probabilidades
  // justas (de-vig) al cierre, en puntos porcentuales por seleccion. Se agrego
  // DESPUES de ver los primeros resultados: tratala como exploratoria.
  const completas = new Map();
  for (const f of filas) { const k = f.evento + '|' + f.mercado; if (!completas.has(k)) completas.set(k, []); completas.get(k).push(f); }
  const conP = [];
  for (const g of completas.values()) {
    if (g.length !== (g[0].mercado === MERCADO_1X2 ? 3 : 2)) continue;
    const p = devigProporcional(g.map(f => f.cierre));
    g.forEach((f, i) => conP.push({ ...f, p: p[i] }));
  }
  const exceso = (l) => (l.length ? 100 * (l.filter(f => f.gano).length - l.reduce((s, f) => s + f.p, 0)) / l.length : null);
  console.log('── MEDIDA CORREGIDA: aciertos reales MENOS probabilidad implicita al cierre (pp/seleccion) ──');
  for (const [titulo, mk] of [['1X2', MERCADO_1X2], ['O/U 2.5', MERCADO_OU], ['AMBOS', null]]) {
    const base = conP.filter(f => !mk || f.mercado === mk);
    for (const c of ['steam', 'plano', 'deriva']) {
      const l = base.filter(f => claseMovimiento(f.cierre / f.apertura - 1, UMBRAL) === c);
      if (!l.length) continue;
      const real = 100 * l.filter(f => f.gano).length / l.length;
      const impl = 100 * l.reduce((s, f) => s + f.p, 0) / l.length;
      const cn = bootstrapPorPartido(porEvento(l), exceso);
      console.log(`  ${titulo.padEnd(8)} ${c.padEnd(7)} n=${String(l.length).padStart(3)}  real ${real.toFixed(1).padStart(5)}%  implicito ${impl.toFixed(1).padStart(5)}%  exceso ${(exceso(l) >= 0 ? '+' : '') + exceso(l).toFixed(1)} pp  IC95 ${ic(cn)}`);
    }
  }
  console.log('');

  // ── 5. ¿el cierre predice mejor que la apertura? (Brier 1X2 por partido; >0 = cierre mejor)
  if (briers.length) {
    const media = (m) => m.reduce((s, f) => s + f.dif, 0) / m.length;
    const ci = bootstrapPorPartido(briers, media);
    console.log(`── Brier 1X2, apertura MENOS cierre (>0: el cierre predice mejor), ${briers.length} partidos ──`);
    console.log(`  ${media(briers.map(b => b[0])).toFixed(5)}  IC95 [${ci ? ci[0].toFixed(5) + ', ' + ci[1].toFixed(5) : 'n/d'}]`);
  }

  // ── 6. sensibilidad al umbral (exploratorio) sobre la prueba principal
  console.log('\n── Sensibilidad del umbral, 1X2 al cierre: steam MENOS referencia (exploratorio) ──');
  const base1x2 = filas.filter(f => f.mercado === MERCADO_1X2), g1 = porEvento(base1x2);
  for (const u of [0.02, 0.03, 0.05, 0.08, 0.12]) {
    const dif = (m) => { const s = m.filter(f => claseMovimiento(f.cierre / f.apertura - 1, u) === 'steam').map(f => ({ odd: f.cierre, gano: f.gano })); return s.length ? roi(s) - roi(m.map(f => ({ odd: f.cierre, gano: f.gano }))) : null; };
    const n = base1x2.filter(f => claseMovimiento(f.cierre / f.apertura - 1, u) === 'steam').length;
    console.log(`  umbral ${(u * 100).toFixed(0).padStart(2)}%  n_steam=${String(n).padStart(3)}  dif ${fmt(dif(base1x2)).padStart(8)} pp  IC95 ${ic(bootstrapPorPartido(g1, dif))}`);
  }
  fs.writeFileSync(path.join(__dirname, '..', 'scratch', '_steam_filas.json'), JSON.stringify(filas));
}
