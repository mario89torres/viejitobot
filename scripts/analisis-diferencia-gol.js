/**
 * scripts/analisis-diferencia-gol.js
 * ─────────────────────────────────────────────────────────────────────────
 * Dos preguntas sobre los picks del HEURISTICO, con el historial liquidado:
 *  A. ¿Mejoraria el winrate un castigo (o veto) para los picks emitidos con el
 *     partido a UN gol de diferencia?
 *  B. ¿Mejora el winrate vetar "Ambos anotan: No" cuando el partido va 2-0 (de
 *     cualquier lado)?
 *
 * Marcador al emitir: ultimo snapshot del evento anterior o igual al ts del pick
 * (idx_snapshots_event); 89% de los picks lo tienen. Excluye source='global_draw',
 * score_version=0 y los picks emitidos mientras decidia el modelo aprendido
 * (model_mode='learned', ventanas del incidente de adopcion).
 *
 * REGLAS PARA NO AUTOENGANARSE
 *  - Intervalos por bootstrap sobre PARTIDOS (picks de un mismo partido no son
 *    independientes), no sobre picks.
 *  - Todo grupo se compara contra el resto DEL MISMO PERIODO, nunca contra su pasado.
 *  - Se reporta N e IC, y se parte el periodo en dos mitades para ver si el efecto se
 *    sostiene. Muchas rebanadas => alguna saldra "significativa" por azar: la
 *    pregunta principal (A: diff=1 vs resto, todos los mercados) se fija antes.
 *  - Replica en los picks del modelo aprendido (model_picks, entry_score guardado).
 *  - Un backtest es un candidato, no la respuesta.
 *
 *   node scripts/analisis-diferencia-gol.js [--min-conf 0.70]
 */
const fs = require('fs');
const path = require('path');

// ───────────── funciones puras (tests/analisis-diferencia-gol.test.js) ─────────────

/** "2-0" -> { a: 2, b: 0, diff: 2, menor: 0, total: 2 }; null si no es un marcador. */
function parseMarcador(score) {
  const m = String(score || '').match(/^(\d+)-(\d+)$/);
  if (!m) return null;
  const a = Number(m[1]), b = Number(m[2]);
  return { a, b, diff: Math.abs(a - b), menor: Math.min(a, b), total: a + b };
}

/** Intervalo de Wilson (95%) para k exitos de n. */
function wilson(k, n, z = 1.96) {
  if (!n) return [NaN, NaN];
  const p = k / n, d = 1 + z * z / n;
  const c = (p + z * z / (2 * n)) / d, h = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}

const wr = (rows) => (rows.length ? rows.filter(r => r.gano).length / rows.length : null);
const roi = (rows) => (rows.length ? 100 * rows.reduce((s, r) => s + (r.gano ? r.odd - 1 : -1), 0) / rows.length : null);

/**
 * Efecto de un castigo de `delta` sobre la confianza de los picks con diferencia de
 * 1 gol: se quitan los que caen por debajo de `minConf`. delta=Infinity = veto total.
 * Devuelve { quitados, retenidos } (listas de picks).
 */
function aplicarCastigo(picks, delta, minConf = 0.70) {
  const quitados = [], retenidos = [];
  for (const p of picks) {
    if (p.diff === 1 && p.conf - delta < minConf) quitados.push(p); else retenidos.push(p);
  }
  return { quitados, retenidos };
}

/** ¿Es "Ambos anotan: No" con el partido 2-0 (o 0-2)? */
const esBttsNoDosCero = (p) => p.familia === 'btts' && p.btts === 'no' && p.diff === 2 && p.menor === 0;

module.exports = { parseMarcador, wilson, wr, roi, aplicarCastigo, esBttsNoDosCero };
if (require.main === module) main();

function main() {
  const { db } = require('../src/db');
  const { parsePick } = require('../src/markets');
  const { bootstrapPorPartido } = require('./backtest-steam-prematch');
  const i = process.argv.indexOf('--min-conf');
  const MIN_CONF = i > 0 ? Number(process.argv[i + 1]) : Number(process.env.MIN_CONF || 0.70);

  const FAM = { total: 'totales', winner: 'ganador/DNB/doble', dnb: 'ganador/DNB/doble', dc: 'ganador/DNB/doble', draw: 'ganador/DNB/doble', handicap: 'handicap', btts: 'ambos anotan' };
  const scoreAntes = db.prepare('SELECT score FROM snapshots WHERE event_id = ? AND ts <= ? AND score IS NOT NULL ORDER BY ts DESC LIMIT 1');
  const construir = (r, marcador) => {
    const m = parseMarcador(marcador);
    if (!m) return null;
    const parsed = parsePick(r);
    return {
      id: r.id, evento: r.event_id, ts: r.ts, conf: r.conf, odd: r.odd_decimal, gano: r.result === 'win', stake: r.stake ?? 1,
      diff: m.diff, menor: m.menor, total: m.total, avance: r.f_avance,
      familia: parsed ? parsed.type : 'otro', famTxt: parsed ? (FAM[parsed.type] || 'otro') : 'otro',
      btts: parsed && parsed.type === 'btts' ? (parsed.yes ? 'si' : 'no') : null,
    };
  };

  // Heuristico: emitidos (sin global_draw ni ventanas donde decidia el learned)
  const filas = db.prepare(`SELECT id, ts, event_id, market, selection, event, sport, odd_decimal, conf, result, stake, f_avance
    FROM picks WHERE result IN ('win','loss') AND COALESCE(source,'') <> 'global_draw' AND COALESCE(score_version,1) <> 0
      AND COALESCE(model_mode,'shadow') <> 'learned'`).all();
  const H = [];
  for (const r of filas) { const s = scoreAntes.get(r.event_id, r.ts); const p = s && construir(r, s.score); if (p) H.push(p); }
  // Learned (replica): entry_score ya guardado
  const filasM = db.prepare(`SELECT id, ts, event_id, market, selection, event, sport, odd_decimal, conf_learned AS conf, result, entry_score AS score, NULL AS f_avance, 1 AS stake
    FROM model_picks WHERE result IN ('win','loss') AND entry_score IS NOT NULL`).all();
  const M = filasM.map(r => construir(r, r.score)).filter(Boolean);
  console.log(`heuristico: ${H.length} picks con marcador al emitir (de ${filas.length}) | learned (replica): ${M.length}\n`);

  const porEvento = (rows) => { const m = new Map(); for (const r of rows) { if (!m.has(r.evento)) m.set(r.evento, []); m.get(r.evento).push(r); } return [...m.values()]; };
  const pct = (x, d = 1) => (x == null ? '  n/d' : (100 * x).toFixed(d) + '%');
  const ic = (ci) => (ci ? `[${ci[0].toFixed(1)}, ${ci[1].toFixed(1)}]` : '[n/d]');
  const linea = (nombre, rows) => {
    const k = rows.filter(r => r.gano).length, [lo, hi] = wilson(k, rows.length);
    console.log(`  ${nombre.padEnd(22)} n=${String(rows.length).padStart(4)}  WR ${pct(wr(rows)).padStart(6)}  (IC95 ${(100 * lo).toFixed(1)}-${(100 * hi).toFixed(1)})  ROI plano ${roi(rows) == null ? '  n/d' : (roi(rows) >= 0 ? '+' : '') + roi(rows).toFixed(1) + '%'}`);
  };
  // WR(grupo) - WR(resto) en pp, IC por bootstrap sobre partidos
  const difWr = (rows, esGrupo) => {
    const f = (m) => { const g = m.filter(esGrupo), o = m.filter(r => !esGrupo(r)); return g.length && o.length ? 100 * (wr(g) - wr(o)) : null; };
    return { punto: f(rows), ic: bootstrapPorPartido(porEvento(rows), f, 1500, 11) };
  };
  const fmtDif = (d) => `${d.punto == null ? 'n/d' : (d.punto >= 0 ? '+' : '') + d.punto.toFixed(1)} pp  IC95 ${ic(d.ic)}`;

  // ══ A. diferencia de 1 gol ══
  console.log('═══ A. Picks del heuristico segun la diferencia de goles al emitir ═══');
  for (const [nombre, f] of [['0 goles (empate)', r => r.diff === 0], ['1 gol', r => r.diff === 1], ['2 goles', r => r.diff === 2], ['3+ goles', r => r.diff >= 3]]) linea(nombre, H.filter(f));
  console.log('  --- PRUEBA PRINCIPAL (fijada antes): WR de "1 gol" menos WR del resto, todos los mercados ---');
  console.log('  heuristico:', fmtDif(difWr(H, r => r.diff === 1)));
  console.log('  learned (replica):', fmtDif(difWr(M, r => r.diff === 1)));
  const mitad = (rows) => { const ord = [...rows].sort((a, b) => (a.ts < b.ts ? -1 : 1)); const k = Math.floor(ord.length / 2); return [ord.slice(0, k), ord.slice(k)]; };
  const [H1, H2] = mitad(H);
  console.log(`  1a mitad (${H1[0].ts.slice(0, 10)}..${H1[H1.length - 1].ts.slice(0, 10)}):`, fmtDif(difWr(H1, r => r.diff === 1)));
  console.log(`  2a mitad (${H2[0].ts.slice(0, 10)}..${H2[H2.length - 1].ts.slice(0, 10)}):`, fmtDif(difWr(H2, r => r.diff === 1)));

  console.log('\n  Por tipo de mercado (heuristico): 1 gol vs resto del mismo tipo (exploratorio)');
  for (const fam of ['totales', 'ganador/DNB/doble', 'ambos anotan', 'handicap']) {
    const rows = H.filter(r => r.famTxt === fam), g = rows.filter(r => r.diff === 1);
    console.log(`   ${fam.padEnd(20)} n=${String(rows.length).padStart(4)}  con 1 gol: n=${String(g.length).padStart(4)} WR ${pct(wr(g)).padStart(6)} | resto WR ${pct(wr(rows.filter(r => r.diff !== 1))).padStart(6)} | dif ${fmtDif(difWr(rows, r => r.diff === 1))}`);
  }
  const confMed = (rows) => (rows.length ? rows.reduce((s, r) => s + r.conf, 0) / rows.length : NaN).toFixed(3);
  console.log(`\n  conf media: 1 gol ${confMed(H.filter(r => r.diff === 1))} | resto ${confMed(H.filter(r => r.diff !== 1))}  (¿el modelo ya castiga o premia estos picks?)`);

  console.log(`\n  ── Castigo sobre conf (MIN_CONF=${MIN_CONF}): se quitan los de 1 gol que caen bajo el piso ──`);
  console.log('   castigo   quitados  WR quitados   retenidos  WR retenido  dWR vs base   ROI retenido  P/L quitado(u)');
  const base = wr(H), roiBase = roi(H);
  console.log(`   (base)        -           -       ${String(H.length).padStart(6)}     ${pct(base).padStart(6)}        -          ${roiBase.toFixed(1)}%`);
  for (const d of [0.01, 0.02, 0.03, 0.05, 0.08, 0.10, Infinity]) {
    const { quitados, retenidos } = aplicarCastigo(H, d, MIN_CONF);
    const dif = (wr(retenidos) - base) * 100;
    const plQuit = quitados.reduce((s, r) => s + (r.gano ? r.odd - 1 : -1), 0);
    console.log(`   ${(d === Infinity ? 'veto' : '-' + d.toFixed(2)).padEnd(8)} ${String(quitados.length).padStart(6)}   ${pct(wr(quitados)).padStart(8)}     ${String(retenidos.length).padStart(6)}     ${pct(wr(retenidos)).padStart(6)}      ${(dif >= 0 ? '+' : '') + dif.toFixed(2)} pp      ${roi(retenidos).toFixed(1).padStart(5)}%       ${(plQuit >= 0 ? '+' : '') + plQuit.toFixed(1)}`);
  }
  const vetoRet = aplicarCastigo(H, Infinity, MIN_CONF).retenidos;
  const ci = bootstrapPorPartido(porEvento(H), (m) => { const r = m.filter(x => x.diff !== 1); return m.length && r.length ? 100 * (wr(r) - wr(m)) : null; }, 1500, 13);
  console.log(`   veto total de 1 gol: dWR ${((wr(vetoRet) - base) * 100).toFixed(2)} pp, IC95 ${ic(ci)} (bootstrap por partido)`);

  // ══ B. Ambos anotan: No con el partido 2-0 ══
  console.log('\n═══ B. "Ambos anotan: No" segun el marcador al emitir ═══');
  const bttsNo = (rows) => rows.filter(r => r.familia === 'btts' && r.btts === 'no');
  for (const [etq, rows] of [['heuristico', H], ['learned (replica)', M]]) {
    const no = bttsNo(rows);
    console.log(`  ${etq}: ${no.length} picks "No"`);
    for (const [nombre, f] of [['0-0', r => r.total === 0], ['1-0 / 0-1', r => r.diff === 1 && r.menor === 0], ['1-1 o mas parejo', r => r.menor >= 1], ['2-0 / 0-2', r => r.diff === 2 && r.menor === 0], ['3-0 o mas', r => r.diff >= 3 && r.menor === 0]]) linea('   ' + nombre, no.filter(f));
  }
  const noH = bttsNo(H), dosCero = noH.filter(esBttsNoDosCero);
  console.log('\n  Veto a "No" con 2-0 (heuristico):');
  const sin = noH.filter(r => !esBttsNoDosCero(r));
  console.log(`   quitaria ${dosCero.length} picks (WR ${pct(wr(dosCero))}); WR de los "No" pasaria de ${pct(wr(noH))} a ${pct(wr(sin))}; P/L quitado ${(dosCero.reduce((s, r) => s + (r.gano ? r.odd - 1 : -1), 0)).toFixed(1)}u`);
  console.log('   WR global del heuristico:', pct(wr(H)), '->', pct(wr(H.filter(r => !esBttsNoDosCero(r)))));
  console.log('   2-0 vs otros "No":', fmtDif(difWr(noH, esBttsNoDosCero)));
  const dcM = bttsNo(M).filter(esBttsNoDosCero);
  console.log(`   learned (replica): n=${dcM.length} con 2-0, WR ${pct(wr(dcM))}`);
  // por avance del partido (los "No" ganan mas cuanto menos falta)
  console.log('   "No" con 2-0 por avance del partido (heuristico):');
  for (const [nombre, f] of [['avance < 0.75', r => r.avance != null && r.avance < 0.75], ['avance >= 0.75', r => r.avance != null && r.avance >= 0.75]]) linea('    ' + nombre, dosCero.filter(f));

  fs.writeFileSync(path.join(__dirname, '..', 'scratch', '_analisis_dif_gol.json'), JSON.stringify({ nH: H.length, nM: M.length }));
}
