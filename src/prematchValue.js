// Escaneo de valor PRE-PARTIDO: compara la cuota de Playdoit contra una casa
// sharp (Pinnacle/Betfair, vía src/sharp.js) EN EL MISMO INSTANTE — a
// diferencia de "steam" (que necesita semanas de historial propio de
// apertura/cierre), esto no espera nada: si Playdoit ya paga mas que la
// referencia sharp ahora mismo, esa discrepancia es la señal.
//
// Validado a mano el 2026-09-22 sobre EPL + La Liga: 100% de emparejamiento
// por nombre de equipo, cuotas casi siempre cercanas (margen normal de casa),
// con al menos un caso real de diferencia grande (Man City vs Ipswich:
// Playdoit @12 vs Pinnacle @10.38 en Ipswich, ~16% mejor).
//
// SOLO LECTURA. No decide nada, no emite picks, no toca el firewall ni el
// modelo — guarda comparaciones en prematch_value_scan para poder medir
// despues (con resultados reales, via FotMob) si estas discrepancias
// predicen algo o son solo ruido de margen. Mismo criterio que
// STATS_PILOT/FOTMOB_PILOT/PREMATCH_PILOT.
const { db } = require('./db');
const { _internal } = require('./sharp');
const { teamsMatch } = require('./teamMatch');

const MERCADO_PLAYDOIT = 'Resultado Final (Tiempo Regular)';
const VENTANA_KICKOFF_MS = 20 * 60 * 1000; // +-20 min para emparejar por hora

const playdoitCercaStmt = db.prepare(`
  SELECT DISTINCT event, event_id FROM prematch_snapshots
  WHERE start_date BETWEEN ? AND ?
`);
const playdoitCuotasStmt = db.prepare(`
  SELECT selection, odd_decimal FROM prematch_snapshots
  WHERE event_id = ? AND market = ? AND suspended = 0
  ORDER BY ts DESC LIMIT 3
`);

function emparejarEvento(evSharp) {
  const desde = new Date(Date.parse(evSharp.commence_time) - VENTANA_KICKOFF_MS).toISOString();
  const hasta = new Date(Date.parse(evSharp.commence_time) + VENTANA_KICKOFF_MS).toISOString();
  const candidatos = playdoitCercaStmt.all(desde, hasta);
  for (const c of candidatos) {
    const partes = c.event.split(/\s+vs\.?\s+/i);
    if (partes.length < 2) continue;
    const [a, b] = partes;
    if ((teamsMatch(a, evSharp.home_team) && teamsMatch(b, evSharp.away_team)) ||
        (teamsMatch(a, evSharp.away_team) && teamsMatch(b, evSharp.home_team))) {
      return c;
    }
  }
  return null;
}

/**
 * Escanea UNA liga (1 credito sharp, ya presupuestado por src/sharp.js —
 * withinDailyBudget/canRequest). Devuelve las filas listas para
 * savePrematchValueScan; no escribe nada por si mismo.
 */
async function escanearLiga(sportKey) {
  const eventosSharp = await _internal.fetchLeagueOdds(sportKey, 'h2h');
  if (!eventosSharp) return [];
  const ts = new Date().toISOString();
  const filas = [];
  for (const ev of eventosSharp) {
    const match = emparejarEvento(ev);
    if (!match) continue;
    const bm = _internal.selectBookmaker(ev, 'h2h');
    if (!bm) continue;
    const cuotasPlaydoit = playdoitCuotasStmt.all(match.event_id, MERCADO_PLAYDOIT);
    if (!cuotasPlaydoit.length) continue;
    const [homeName, awayName] = ev.home_team && ev.away_team ? [ev.home_team, ev.away_team] : [null, null];
    for (const o of bm.outcomes) {
      // Mapear el outcome sharp (nombre de equipo o "Draw") a la seleccion de Playdoit.
      const esEmpate = /^draw$/i.test(o.name);
      const pd = cuotasPlaydoit.find(p => esEmpate
        ? /^empate$/i.test(p.selection)
        : teamsMatch(p.selection, o.name));
      if (!pd || !(pd.odd_decimal > 1) || !(o.price > 1)) continue;
      filas.push({
        ts, eventId: match.event_id, event: match.event, champ: ev.sport_title || null,
        sportKey, market: 'h2h', bookmaker: bm.key,
        selection: esEmpate ? 'Empate' : o.name,
        sharpOdd: o.price, playdoitOdd: pd.odd_decimal,
        edgePct: Number(((pd.odd_decimal / o.price - 1) * 100).toFixed(2)),
        startDate: ev.commence_time,
      });
    }
  }
  return filas;
}

module.exports = { escanearLiga };
