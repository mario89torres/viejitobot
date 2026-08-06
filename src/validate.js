// Validación de liquidaciones contra marcadores oficiales.
//
// Por qué hace falta: el bot liquida con `last_sample`, el último marcador que
// alcanzó a ver antes de que el evento desapareciera del feed de Altenar. Si el
// partido siguió anotando después de esa última muestra, el pick se califica
// con un marcador incompleto y el resultado puede ser incorrecto — un error que
// contamina TODAS las métricas (ROI, calibración, entrenamiento) sin dejar
// rastro. Esto lo mide.
//
// Fuente: endpoint /scores de The Odds API, que devuelve el marcador final
// oficial de los partidos ya jugados (hasta 3 días atrás). Cuesta 2 créditos
// por liga, así que solo se consultan las ligas que realmente tienen picks.

const { db } = require('./db');
const { gradePick } = require('./markets');
const { _internal } = require('./sharp');

const BASE = 'https://api.the-odds-api.com/v4';
const MAX_DAYS = 3;   // límite del endpoint /scores

const splitTeams = (event) => {
  const p = (event || '').split(/\s+vs\.?\s+|\s+@\s+/i);
  return p.length >= 2 ? [p[0].trim(), p[1].trim()] : null;
};

// Trae los partidos terminados de una liga, con marcador oficial. 2 créditos.
async function fetchScores(sportKey, apiKey) {
  const r = await fetch(`${BASE}/sports/${sportKey}/scores/?daysFrom=${MAX_DAYS}&apiKey=${apiKey}`,
    { signal: AbortSignal.timeout(20000) });
  if (!r.ok) return { events: [], credits: 0, error: `HTTP ${r.status}` };
  const data = await r.json();
  const events = [];
  for (const e of data) {
    if (!e.completed || !e.scores) continue;
    const h = e.scores.find(s => s.name === e.home_team);
    const a = e.scores.find(s => s.name === e.away_team);
    if (h && a) events.push({
      home: e.home_team, away: e.away_team,
      hs: Number(h.score), as: Number(a.score),
      start: Date.parse(e.commence_time),
    });
  }
  return { events, credits: Number(r.headers.get('x-requests-last') || 2) };
}

// Valida las liquidaciones recientes. Devuelve un informe sin escribir en la BD:
// corregir automáticamente un resultado a partir de una fuente que también puede
// equivocarse sería peor que reportarlo.
// `hours` acota qué picks se comparan (por su hora de LIQUIDACIÓN, que es
// cuando el resultado quedó fijado). Ojo con el coste: la API cobra por liga
// consultada, no por pick, y siempre devuelve los mismos 3 días. Una ventana
// corta ahorra solo porque toca menos ligas — por pick sale más cara.
async function validateSettlements({ hours = MAX_DAYS * 24, apiKey = process.env.ODDS_API_KEY } = {}) {
  if (!apiKey) return { error: 'sin ODDS_API_KEY' };
  const h = Math.min(Math.max(Number(hours) || 1, 1), MAX_DAYS * 24);

  const since = new Date(Date.now() - h * 3600e3).toISOString();
  const picks = db.prepare(`
    SELECT id, ts, settled_ts, sport, event, event_id, market, selection, final_score, result, result_source
    FROM picks
    WHERE COALESCE(settled_ts, ts) >= ? AND result IN ('win','loss') AND final_score IS NOT NULL
  `).all(since);
  if (!picks.length) return { n: 0, checked: 0, hours: h };

  // agrupar por liga cubierta: solo esas se pueden verificar
  const champOf = db.prepare('SELECT champ FROM snapshots WHERE event_id=? LIMIT 1');
  const porLiga = new Map();
  for (const p of picks) {
    const c = champOf.get(p.event_id);
    const key = _internal.keyForChamp(c ? c.champ : '', p.sport);
    if (!key) continue;
    if (!porLiga.has(key)) porLiga.set(key, []);
    porLiga.get(key).push(p);
  }

  let credits = 0;
  const out = { n: picks.length, checked: 0, ok: 0, mismatch: [], resultChanges: [], leagues: porLiga.size, hours: h };
  for (const [key, ps] of porLiga) {
    let res;
    try { res = await fetchScores(key, apiKey); } catch (e) { continue; }
    credits += res.credits;
    for (const p of ps) {
      const t = splitTeams(p.event);
      if (!t) continue;
      // Puede haber VARIOS partidos entre los mismos equipos en 3 días (dobles
      // jornadas del béisbol, series consecutivas). Elegir por nombre a secas
      // compara contra el partido equivocado y genera falsas alarmas: se toma
      // el que empezó antes del pick y más cerca de él.
      const tp = Date.parse(p.ts);
      const cands = res.events.filter(e =>
        (_internal.teamsMatch(t[0], e.home) && _internal.teamsMatch(t[1], e.away)) ||
        (_internal.teamsMatch(t[0], e.away) && _internal.teamsMatch(t[1], e.home)));
      const previos = cands.filter(e => e.start <= tp);
      const ev = (previos.length ? previos : cands)
        .sort((a, b) => Math.abs(tp - a.start) - Math.abs(tp - b.start))[0];
      if (!ev) continue;
      if (cands.length > 1) out.ambiguous = (out.ambiguous || 0) + 1;
      const swapped = !_internal.teamsMatch(t[0], ev.home);
      const oficial = swapped ? `${ev.as}-${ev.hs}` : `${ev.hs}-${ev.as}`;
      out.checked++;
      if (oficial === p.final_score) { out.ok++; continue; }

      // el marcador difiere: ¿cambia el resultado del pick?
      const nuevo = gradePick({ market: p.market, selection: p.selection, event: p.event }, oficial);
      const entry = { ...p, oficial, nuevo };
      out.mismatch.push(entry);
      if (nuevo && nuevo !== p.result) out.resultChanges.push(entry);
    }
  }
  out.credits = credits;
  return out;
}

module.exports = { validateSettlements };
