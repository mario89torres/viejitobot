// Línea de xG PREPARTIDO para los avisos de Telegram. PURO: sin BD ni red, bot.js hace la consulta.
//
// SOLO INFORMA. El xG prepartido ya está en el precio (p=0.60 sobre el mercado, n=2,925 partidos)
// y no entra en conf, edge, firewall ni stake: esta línea no puntúa, no filtra y no emite nada
// (mismo criterio de solo lectura que PREMATCH_XG_PILOT, ver CLAUDE.md).
//
// COBERTURA REAL (medido 2026-10-04, picks desde el 23-sep): solo el 1.5% de los picks emitidos
// (6/407) y el 2.2% de los del modelo (36/1,641) tienen xG. Que exista la fila de prematch_xg_scan
// no basta: 860 de 962 traen xg_esperado_* NULL (FotMob no publica xG para esa liga). Por eso la
// línea sale pocas veces; no es un fallo.
//
// MUESTRA MÍNIMA: con pocos partidos jugados el xG es ruido (Tailandia-Vietnam daba 20.7 con 1
// partido por lado). Se omite si algún equipo tiene menos de MIN_PARTIDOS partidos, y cuando se
// muestra lleva la base ("base N partidos") para que quien lee juzgue cuánto pesa la cifra.
const MIN_PARTIDOS_XG = Math.max(1, Number(process.env.XG_AVISO_MIN_PARTIDOS) || 5);

const num = (x) => (x === null || x === undefined || x === '' ? NaN : Number(x));

/**
 * @param {object|null} r fila de prematch_xg_scan:
 *   { xg_esperado_local, xg_esperado_visita, xg_esperado_total, home_played, away_played }
 * @returns {string} línea HTML de Telegram (sin salto de línea final), o '' si no hay dato usable.
 */
function lineaXg(r, { minPartidos = MIN_PARTIDOS_XG } = {}) {
  if (!r) return '';
  const total = num(r.xg_esperado_total);
  if (!Number.isFinite(total) || total <= 0) return '';
  const base = Math.min(num(r.home_played), num(r.away_played));
  if (!Number.isFinite(base) || base < minPartidos) return '';
  const l = num(r.xg_esperado_local), v = num(r.xg_esperado_visita);
  const lado = Number.isFinite(l) && Number.isFinite(v) ? ` (local ${l.toFixed(1)} · visita ${v.toFixed(1)})` : '';
  return `<i>📊 xG prepartido ${total.toFixed(1)}${lado} · base ${base} partidos</i>`;
}

module.exports = { lineaXg, MIN_PARTIDOS_XG };
