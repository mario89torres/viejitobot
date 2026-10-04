// Picks de CORNERS para Telegram — EXPERIMENTO en registro, no picks validados. PURO: sin BD ni red.
//
// POR QUÉ NO SON PICKS CON EDGE. El predictor NB de corners no ha mostrado ventaja sobre las cuotas
// de Playdoit (memoria nb-corners-sin-ventaja-vs-mercado, validación cruzada, 88 partidos,
// 2026-09-19): el original perdía ~-25% ROI y el calibrado quedó estadísticamente empatado con el
// mercado (Brier 0.212 vs 0.204, IC incluye 0; ROI -8% a +7%, IC ±23pp). Una simulación simple
// sobre el histórico (2026-10-04) sale positiva pero NO es confiable: 62 partidos con ~5 señales
// correlacionadas cada uno, y el calibrado se ajustó con esos mismos finales. Por eso esto:
//   - solo emite con el modelo CALIBRADO (nb-cal-1), nunca con el original ya descartado;
//   - no tiene stake, no entra en picks/model_picks ni en ninguna métrica de rendimiento;
//   - se liquida solo contra el conteo final de FotMob (tabla corner_picks) para que, con N
//     fuera de muestra, se pueda decir con datos si hay ventaja o no.
// Los umbrales por defecto son PROVISIONALES: no se optimizaron sobre el histórico.
//
// Fuente: `dosFuentes` de src/fotmobLive.js:computeDosFuentes — la línea "sugerida" de cada partido
// (la de mayor diferencia modelo-mercado) con el conteo REAL de FotMob.

function configCorner(env = process.env) {
  const n = (k, d) => { const v = Number(env[k]); return env[k] !== undefined && env[k] !== '' && Number.isFinite(v) ? v : d; };
  return {
    minEdge: n('CORNER_MIN_EDGE', 0.15),      // diferencia modelo-mercado en probabilidad (0.15 = 15 pp)
    minMinuto: n('CORNER_MIN_MINUTO', 15),    // antes, el conteo dice poco y el prior manda
    maxMinuto: n('CORNER_MAX_MINUTO', 80),    // después, el mercado está casi resuelto
    oddMin: n('CORNER_ODD_MIN', 1.30),
    oddMax: n('CORNER_ODD_MAX', 3.50),
    maxPorHora: n('CORNER_MAX_POR_HORA', 6),
  };
}

/**
 * Candidatos de una pasada. Una sola línea por partido (la sugerida). `dosFuentes` es la salida de
 * computeDosFuentes. Devuelve objetos listos para registrar.
 */
function candidatosCorners(dosFuentes, cfg = configCorner()) {
  const out = [];
  for (const d of dosFuentes || []) {
    const p = d && d.poisson, sug = p && p.sugerida;
    if (!sug || !p.calibrado) continue;                       // solo el modelo calibrado
    const ch = d.fotmob && d.fotmob.cornersHome, ca = d.fotmob && d.fotmob.cornersAway;
    if (ch == null || ca == null) continue;                   // sin conteo real no hay pronóstico fiable
    const conteo = Number(ch) + Number(ca);
    const minuto = p.minuto;
    if (!Number.isFinite(conteo) || minuto == null || minuto < cfg.minMinuto || minuto > cfg.maxMinuto) continue;
    if (!(sug.edge >= cfg.minEdge)) continue;
    if (!(sug.odd >= cfg.oddMin && sug.odd <= cfg.oddMax)) continue;
    if (conteo > sug.linea) continue;                         // línea ya decidida: la casa debería haberla retirado
    out.push({
      eventId: Math.trunc(Number(d.playdoit.eventId)), fotmobEventId: d.fotmob.fotmobEventId,
      event: String(d.playdoit.event || '').trim(), champ: d.playdoit.champ || null,
      minuto, conteoReal: conteo, linea: sug.linea, lado: sug.lado, odd: sug.odd,
      pModelo: sug.pModelo, pMercado: sug.pMercado, edge: sug.edge,
      esperados: p.esperados ?? null, nbVersion: 'nb-cal-1',
    });
  }
  return out.sort((a, b) => b.edge - a.edge);
}

/** Resultado de un pick de corners contra el conteo final. Líneas .5: no hay push; null si no se puede decir. */
function resultadoCorner(lado, linea, conteoFinal) {
  if (conteoFinal == null || !Number.isFinite(Number(conteoFinal)) || !Number.isFinite(Number(linea))) return null;
  const c = Number(conteoFinal), l = Number(linea);
  if (c === l) return 'push';
  if (lado === 'over') return c > l ? 'win' : 'loss';
  if (lado === 'under') return c < l ? 'win' : 'loss';
  return null;
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const pct = (x) => `${Math.round(100 * x)}%`;

/** Mensaje de Telegram (HTML). `ids` paralelo a `picks` (null donde no se registró). */
function mensajeCorners(picks, ids = []) {
  const NL = '\n';
  let m = `🚩 <b>CORNERS — experimento</b> · solo registro, sin stake${NL}`;
  m += `<i>El modelo de corners no ha mostrado ventaja sobre el mercado (n=88, 19-sep). Esto es para medirlo, no un pick validado.</i>${NL}${NL}`;
  picks.forEach((p, i) => {
    const lado = p.lado === 'over' ? 'Más' : 'Menos';
    const idTag = ids[i] != null ? `<b>#C${ids[i]}</b> · ` : '';
    m += `${idTag}<b>${esc(p.event)}</b>${NL}`;
    m += `Corners ahora: <b>${p.conteoReal}</b> al minuto ${Math.floor(p.minuto)}${NL}`;
    m += `Total corners: <b>${lado} de ${p.linea} @ ${Number(p.odd).toFixed(2)}</b>${NL}`;
    m += `modelo ${pct(p.pModelo)} · mercado ${pct(p.pMercado)} · diferencia <b>+${(100 * p.edge).toFixed(0)} pp</b>${NL}${NL}`;
  });
  return m.trimEnd();
}

module.exports = { configCorner, candidatosCorners, resultadoCorner, mensajeCorners };
