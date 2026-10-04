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
const { teamsMatch } = require('./teamMatch');

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
const START_TOL_MS = 15 * 60 * 1000;   // el partido ya tenia que haber empezado (± reloj)
const MAX_EN_CURSO_MS = 8 * 3600e3;    // ...y no hace mas de 8 h del pick
const esFutbol = (sport) => (sport || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim() === 'futbol';

// Elige el partido de FotMob al que corresponde un pick: mismos equipos (en
// cualquier orden) y que haya EMPEZADO antes del pick, hace menos de 8 h. Sin
// esa ventana, dos partidos entre los mismos equipos en dias distintos (ida y
// vuelta, copas) compararian contra el equivocado. Puro: no toca red ni BD.
// cands: [{ id, home, away, commenceTime }]. Devuelve { ev, swapped } o null.
function elegirPartidoFotmob(pick, cands) {
  const t = splitTeams(pick.event);
  const tp = Date.parse(pick.ts);
  if (!t || Number.isNaN(tp)) return null;
  let mejor = null;
  for (const ev of cands || []) {
    const ko = Date.parse(ev.commenceTime);
    if (!ev.home || !ev.away || Number.isNaN(ko)) continue;
    if (ko > tp + START_TOL_MS || tp - ko > MAX_EN_CURSO_MS) continue;
    const directo = teamsMatch(t[0], ev.home) && teamsMatch(t[1], ev.away);
    const cruzado = !directo && teamsMatch(t[0], ev.away) && teamsMatch(t[1], ev.home);
    if (!directo && !cruzado) continue;
    const dist = Math.abs(tp - ko);
    if (!mejor || dist < mejor.dist) mejor = { ev, swapped: cruzado, dist };
  }
  return mejor ? { ev: mejor.ev, swapped: mejor.swapped } : null;
}

// Marcador "local-visita" en el ORDEN del evento de playdoit.
const marcadorOficial = (home, away, swapped) => (swapped ? `${away}-${home}` : `${home}-${away}`);

// Segunda fuente, gratuita: FotMob, solo futbol y solo los picks que The Odds
// API no pudo verificar (ligas fuera de SHARP_SPORT_KEYS: juveniles, reservas,
// ligas menores). Un partido sin terminar o sin match NO cuenta como verificado.
// Devuelve { verificados: [{ pick, oficial }], pendientes, sinMatch }.
async function verificarConFotmob(picks, { scheduledToday, fetchMarcadorFinal, maxEventos = 80 } = require('./fotmobScraper')) {
  const out = { verificados: [], pendientes: 0, sinMatch: 0 };
  const dia = (ms) => new Date(ms).toISOString().slice(0, 10);
  const cal = new Map();
  const calendario = async (d) => {
    if (!cal.has(d)) { try { cal.set(d, await scheduledToday(d)); } catch { cal.set(d, []); } }
    return cal.get(d);
  };
  const finales = new Map();
  for (const p of picks.filter(x => esFutbol(x.sport)).slice(0, maxEventos)) {
    const tp = Date.parse(p.ts);
    if (Number.isNaN(tp)) { out.sinMatch++; continue; }
    const cands = [];
    for (const d of new Set([dia(tp - 86400e3), dia(tp), dia(tp + 86400e3)])) cands.push(...await calendario(d));
    const m = elegirPartidoFotmob(p, cands);
    if (!m) { out.sinMatch++; continue; }
    if (!finales.has(m.ev.id)) {
      try { finales.set(m.ev.id, await fetchMarcadorFinal(m.ev.id)); } catch { finales.set(m.ev.id, null); }
    }
    const f = finales.get(m.ev.id);
    if (!f || !f.finished) { out.pendientes++; continue; }
    out.verificados.push({ pick: p, oficial: marcadorOficial(f.home, f.away, m.swapped) });
  }
  return out;
}

async function validateSettlements({ hours = MAX_DAYS * 24, apiKey = process.env.ODDS_API_KEY, fotmob = true } = {}) {
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
  const out = {
    n: picks.length, checked: 0, ok: 0, mismatch: [], resultChanges: [], leagues: porLiga.size, hours: h,
    porFuente: { oddsapi: 0, fotmob: 0 },
  };
  // Un pick se cuenta como verificado UNA vez, venga de la fuente que venga.
  const verificados = new Set();
  const registrar = (p, oficial, fuente) => {
    verificados.add(p.id);
    out.checked++; out.porFuente[fuente]++;
    if (oficial === p.final_score) { out.ok++; return; }
    // el marcador difiere: ¿cambia el resultado del pick?
    const nuevo = gradePick({ market: p.market, selection: p.selection, event: p.event }, oficial);
    const entry = { ...p, oficial, nuevo, fuente };
    out.mismatch.push(entry);
    if (nuevo && nuevo !== p.result) out.resultChanges.push(entry);
  };

  for (const [key, ps] of apiKey ? porLiga : []) {
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
      registrar(p, swapped ? `${ev.as}-${ev.hs}` : `${ev.hs}-${ev.as}`, 'oddsapi');
    }
  }
  out.credits = credits;

  // Segunda pasada (gratuita) sobre lo que The Odds API no cubrio.
  if (fotmob) {
    try {
      const f = await verificarConFotmob(picks.filter(p => !verificados.has(p.id)));
      for (const { pick, oficial } of f.verificados) registrar(pick, oficial, 'fotmob');
      out.fotmobSinMatch = f.sinMatch;
      out.fotmobPendientes = f.pendientes;
    } catch (e) {
      out.fotmobError = e.message; // la segunda fuente nunca tumba el informe
    }
  }
  return out;
}

module.exports = { validateSettlements, _internal: { elegirPartidoFotmob, marcadorOficial, verificarConFotmob, esFutbol } };
