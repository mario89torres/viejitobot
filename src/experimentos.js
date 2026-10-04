// Estado de los picks EXPERIMENTALES que el bot avisa por Telegram (botón "🧪 Experimentos"). PURO: sin BD ni
// red, bot.js hace las consultas.
//   - Corners en registro (tabla corner_picks, src/cornerPicks.js): 🚩 CORNERS — experimento.
//   - Rescate del modelo (picks con source='rescue'): 🛟 RESCATE DEL MODELO — experimento.
// Todo a 1u plano por pick (no son apuestas con stake real): el ROI es una medida de si el experimento sirve,
// no un P/L. Con pocos liquidados el resultado es ruido: el texto lo dice, y no concluye nada bajo MIN_N.

const MIN_N = 30; // por debajo de esto el ROI de un grupo no se interpreta (convención del proyecto: candidato, no conclusión)

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function wilson(k, n, z = 1.96) {
  if (!n) return null;
  const p = k / n, d = 1 + z * z / n, c = p + z * z / (2 * n), m = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
  return [Math.max(0, (c - m) / d), Math.min(1, (c + m) / d)];
}

/** rows: [{ odd, result }] con result 'win'|'loss'|'push'|null. Devuelve conteos y ROI a 1u plano. */
function resumirGrupo(rows) {
  const g = { n: rows.length, w: 0, l: 0, push: 0, pend: 0, pl: 0 };
  for (const r of rows) {
    if (r.result === 'win') { g.w++; g.pl += (Number(r.odd) || 0) - 1; }
    else if (r.result === 'loss') { g.l++; g.pl -= 1; }
    else if (r.result === 'push') g.push++;
    else g.pend++;
  }
  g.dec = g.w + g.l;
  g.roi = g.dec ? g.pl / g.dec : null;
  g.ic = wilson(g.w, g.dec);
  return g;
}

const icono = (r) => (r === 'win' ? '✅' : r === 'loss' ? '❌' : r === 'push' ? '➖' : '⏳');

function bloque(titulo, filas, lineaDe, { max = 6 } = {}) {
  const NL = '\n';
  if (!filas.length) return `${titulo}${NL}Aún no hay ninguno registrado.${NL}`;
  const g = resumirGrupo(filas.map((f) => ({ odd: f.odd, result: f.result })));
  let t = `${titulo}${NL}`;
  t += `${g.n} registrados · ${g.dec} liquidados (${g.w}✅ ${g.l}❌${g.push ? ` ${g.push}➖` : ''}) · ${g.pend} pendientes${NL}`;
  if (g.dec) {
    t += `Acierto ${(100 * g.w / g.dec).toFixed(0)}% (IC95 ${(100 * g.ic[0]).toFixed(0)}-${(100 * g.ic[1]).toFixed(0)}%) · ROI a 1u ${g.roi >= 0 ? '+' : ''}${(100 * g.roi).toFixed(1)}% (${g.pl >= 0 ? '+' : ''}${g.pl.toFixed(1)}u)${NL}`;
    if (g.dec < MIN_N) t += `<i>⚠️ ${g.dec} liquidados: muy pocos para concluir nada (mínimo ${MIN_N}).</i>${NL}`;
  } else t += `<i>Ninguno liquidado todavía.</i>${NL}`;
  t += NL + filas.slice(0, max).map((f) => `${icono(f.result)} ${lineaDe(f)}`).join(NL) + NL;
  return t;
}

/**
 * @param {{corners: object[], rescate: object[]}} datos filas más recientes primero.
 *   corners: { id, event, linea, lado, odd, minuto, result, final_count }
 *   rescate: { id, event, market, selection, odd_decimal, result, final_score }
 */
function textoExperimentos({ corners = [], rescate = [] } = {}, opts = {}) {
  const NL = '\n';
  let t = `🧪 <b>Experimentos</b> — picks sin ventaja demostrada, solo para medirlos${NL}${NL}`;
  t += bloque('🚩 <b>Corners</b>', corners.map((c) => ({ ...c, odd: c.odd })),
    (c) => `#C${c.id} ${esc(String(c.event).trim())} — ${c.lado === 'over' ? 'Más' : 'Menos'} de ${c.linea} @ ${Number(c.odd).toFixed(2)}${c.final_count != null ? ` (final ${c.final_count})` : c.result ? '' : ` · min ${Math.floor(c.minuto ?? 0)}`}`, opts) + NL;
  t += bloque('🛟 <b>Rescate del modelo</b>', rescate.map((r) => ({ ...r, odd: r.odd_decimal })),
    (r) => `#${r.id} ${esc(String(r.event).trim())} — ${esc(r.selection)} @ ${Number(r.odd_decimal).toFixed(2)}${r.final_score ? ` (${esc(r.final_score)})` : ''}`, opts);
  return t.trimEnd();
}

module.exports = { textoExperimentos, resumirGrupo, wilson, MIN_N };
