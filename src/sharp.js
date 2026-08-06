// Fuente sharp de referencia: The Odds API (the-odds-api.com), con preferencia
// por Pinnacle y fallback a exchange (Betfair). Diseño BAJO DEMANDA para la
// cuota gratuita (~500 créditos/mes):
//
//   1. CHAMP_MAP traduce la liga de Altenar a sport_key SIN gastar créditos.
//      Si la liga no está cubierta, el pick se marca no_coverage y cuesta 0.
//   2. Si está cubierta, una sola llamada a /sports/{key}/odds trae los
//      partidos de la liga CON sus momios: 1 crédito, cacheado por liga.
//   3. El cierre reutiliza esa misma cache; solo paga si expiró.
//
// Nota histórica (2026-07-29): antes el matching usaba /events, que es gratis
// pero SOLO devuelve partidos futuros. Como el bot apuesta siempre en vivo, el
// matcher no podía ver ni uno de sus propios picks: 459 quedaron unmatched por
// esta causa, no por falta de cobertura. Medido: 177 eventos en 14 ligas, 0 en
// curso. El endpoint /odds sí incluye partidos iniciados.
//
// Coste: 1 crédito por liga consultada (no por pick), acotado además por
// SHARP_MAX_CREDITS_PER_DAY.
//
// Cobertura de mercados: ganador/empate (h2h), totales (totals), hándicap
// (spreads) y ambos marcan (btts). Se pide SOLO el mercado del pick (1 mercado
// = 1 crédito por llamada, igual que antes). Para totales/hándicap el outcome
// debe coincidir también en la línea (point); si el proveedor movió la línea,
// no hay match (comparar momios de líneas distintas no es CLV válido). El
// matching entre proveedores es por nombres de equipo normalizados + hora de
// inicio estimada ± 15 min (si conocemos el minuto de juego); los
// no-matcheados quedan registrados en picks.sharp_match.
//
// Config (.env): ODDS_API_KEY (obligatoria para activar), SHARP_SPORT_KEYS,
// SHARP_BOOKMAKERS, SHARP_CACHE_SECONDS, SHARP_MAX_REQ_PER_HOUR, SHARP_MIN_QUOTA.

const { parsePick } = require('./markets');

const BASE = 'https://api.the-odds-api.com/v4';

const DEFAULT_SPORT_KEYS = [
  'soccer_mexico_ligamx', 'soccer_usa_mls', 'soccer_brazil_campeonato',
  'soccer_argentina_primera_division', 'soccer_conmebol_copa_libertadores',
  'soccer_conmebol_copa_sudamericana', 'baseball_mlb',
  'cricket_international_t20', 'cricket_odi',
].join(',');

// minúsculas sin acentos, conservando palabras (a diferencia de normalizeTeam,
// que además descarta tokens tipo "fc"/"club" que aquí sí distinguen ligas)
const normText = s => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

// Liga de Altenar (normalizada, sin acentos) -> sport_key de The Odds API.
//
// Este mapa es la pieza que hace viable el matching en vivo: sin él habría que
// barrer las ~40 ligas configuradas por cada pick. Con él se consulta UNA sola
// liga (1 crédito) y solo cuando la liga está cubierta; si no aparece aquí, el
// pick se marca no_coverage sin gastar nada.
//
// Las claves se comparan por inclusión sobre el nombre normalizado, así que
// 'mls' captura también 'MLS Next Pro' — por eso el orden importa: las
// entradas más específicas van primero.
const CHAMP_MAP = [
  ['mls next pro', null],                 // filial: no cubierta, no gastar crédito
  ['mls', 'soccer_usa_mls'],
  ['brasileiro serie a', 'soccer_brazil_campeonato'],
  ['copa sudamericana', 'soccer_conmebol_copa_sudamericana'],
  ['copa libertadores', 'soccer_conmebol_copa_libertadores'],
  ['liga profesional', 'soccer_argentina_primera_division'],
  ['veikkausliiga', 'soccer_finland_veikkausliiga'],
  ['uefa champions league', 'soccer_uefa_champs_league_qualification'],
  ['liga mx', 'soccer_mexico_ligamx'],
  ['premier league', 'soccer_epl'],
  ['la liga', 'soccer_spain_la_liga'],
  ['serie a', 'soccer_italy_serie_a'],
  ['serie b', 'soccer_italy_serie_b'],
  ['bundesliga 2', 'soccer_germany_bundesliga2'],
  ['bundesliga', 'soccer_germany_bundesliga'],
  ['ligue 1', 'soccer_france_ligue_one'],
  ['eredivisie', 'soccer_netherlands_eredivisie'],
  ['primeira liga', 'soccer_portugal_primeira_liga'],
  ['championship', 'soccer_efl_champ'],
  ['eliteserien', 'soccer_norway_eliteserien'],
  ['allsvenskan', 'soccer_sweden_allsvenskan'],
  ['superettan', 'soccer_sweden_superettan'],
  ['ekstraklasa', 'soccer_poland_ekstraklasa'],
  ['super league', 'soccer_switzerland_superleague'],
  ['k league', 'soccer_korea_kleague1'],
  // descubiertas por scripts/diag-sharp-retro.js (2026-07-29): estos picks
  // existían en la fuente sharp y se perdían solo por falta de mapeo
  ['superligaen', 'soccer_denmark_superliga'],
  ['primera division', 'soccer_chile_campeonato'],
  ['mlb', 'baseball_mlb'],
  ['nhl', 'icehockey_nhl'],
  ['wnba', 'basketball_wnba'],
];

// Deporte de Altenar (normalizado) -> prefijo de sport_key en The Odds API
const SPORT_PREFIX = {
  'futbol': 'soccer', 'futbol rapido': 'soccer',
  'tenis': 'tennis', 'baloncesto': 'basketball', 'beisbol': 'baseball',
  'hockey': 'icehockey', 'voleibol': 'volleyball', 'criquet': 'cricket',
  'futbol americano': 'americanfootball', 'boxeo': 'boxing', 'mma': 'mma',
};

// Devuelve el sport_key de una liga, o null si no está cubierta.
//
// Dos salvaguardas contra falsos positivos que costarían créditos en vano
// (medidos en vivo 2026-07-29): la comparación es por PALABRA COMPLETA — sin
// ella "MLBB Mid Season Cup" (esports) matcheaba con 'mlb' — y el deporte del
// pick debe corresponder al prefijo del sport_key, porque nombres genéricos
// como "Championship" o "Super League" aparecen en esports y críquet.
function keyForChamp(champ, sport) {
  const c = normText(champ);
  if (!c) return null;
  for (const [needle, key] of CHAMP_MAP) {
    const re = new RegExp(`\\b${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
    if (!re.test(c)) continue;
    if (!key) return null;                    // liga conocida pero sin cobertura
    if (sport !== undefined) {
      const prefix = SPORT_PREFIX[normText(sport)];
      if (!prefix || !key.startsWith(prefix + '_')) return null;  // deporte no concuerda
    }
    return key;
  }
  return null;
}


const cfg = () => ({
  apiKey: process.env.ODDS_API_KEY || '',
  sportKeys: (process.env.SHARP_SPORT_KEYS || DEFAULT_SPORT_KEYS).split(',').map(s => s.trim()).filter(Boolean),
  bookmakers: (process.env.SHARP_BOOKMAKERS || 'pinnacle,betfair_ex_eu,betfair_ex_uk').split(',').map(s => s.trim()).filter(Boolean),
  cacheSeconds: Number(process.env.SHARP_CACHE_SECONDS || 600),
  maxReqPerHour: Number(process.env.SHARP_MAX_REQ_PER_HOUR || 30),
  minQuota: Number(process.env.SHARP_MIN_QUOTA || 25),
});

// ---------- HTTP: rate limiting, cuota y caches ----------
let reqStamps = [];
let quotaRemaining = null;  // header x-requests-remaining del último request
let paidCalls = 0;          // contador de llamadas con coste (diagnóstico)
const eventsCache = new Map(); // sportKey -> { at, events }  (endpoint gratuito)
const oddsCache = new Map();   // 'sportKey|eventId' -> { at, ev } (dedupe de picks del mismo evento)
const leagueCache = new Map(); // sportKey -> { at, ev } (momios de liga completa)
const ODDS_CACHE_MS = 120_000;

// Presupuesto diario de créditos, PERSISTIDO en la BD.
//
// La primera versión llevaba el contador en memoria, y resultó inútil: cada
// reinicio del bot lo ponía a cero. En un día de desarrollo con varios
// reinicios se gastaron ~110 créditos pese a tener el tope en 15 — el guard
// nunca llegaba a activarse. Guardarlo en disco hace que el tope signifique
// realmente "al día" y no "desde el último arranque".
const budgetDb = require('./db').db;
budgetDb.exec(`CREATE TABLE IF NOT EXISTS sharp_budget (day TEXT PRIMARY KEY, credits INTEGER NOT NULL DEFAULT 0)`);
const budgetGet = budgetDb.prepare(`SELECT credits FROM sharp_budget WHERE day = ?`);
const budgetInc = budgetDb.prepare(`
  INSERT INTO sharp_budget (day, credits) VALUES (?, 1)
  ON CONFLICT(day) DO UPDATE SET credits = credits + 1
`);

const today = () => new Date().toISOString().slice(0, 10);
function creditsUsedToday() {
  const r = budgetGet.get(today());
  return r ? r.credits : 0;
}
function withinDailyBudget() {
  return creditsUsedToday() < Number(process.env.SHARP_MAX_CREDITS_PER_DAY || 15);
}
function spendToday() { budgetInc.run(today()); }

// El límite horario aplica a todas las llamadas; la guarda de cuota solo a las
// que consumen créditos (los /events son gratuitos).
function canRequest(paid) {
  const now = Date.now();
  reqStamps = reqStamps.filter(t => now - t < 3600_000);
  if (reqStamps.length >= cfg().maxReqPerHour) return false;
  if (paid && quotaRemaining !== null && quotaRemaining < cfg().minQuota) return false;
  return true;
}

async function fetchJson(url) {
  reqStamps.push(Date.now());
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  const rem = res.headers.get('x-requests-remaining');
  if (rem !== null) quotaRemaining = Number(rem);
  if (!res.ok) return { ok: false, status: res.status, data: null };
  return { ok: true, status: res.status, data: await res.json() };
}

// Calendario de un deporte: GRATIS (sin momios). Cache SHARP_CACHE_SECONDS.
async function fetchSchedule(sportKey) {
  const c = cfg();
  const hit = eventsCache.get(sportKey);
  if (hit && Date.now() - hit.at < c.cacheSeconds * 1000) return hit.events;
  if (!canRequest(false)) return hit ? hit.events : null;
  const r = await fetchJson(`${BASE}/sports/${sportKey}/events?apiKey=${c.apiKey}`);
  if (!r.ok) {
    console.error(`[sharp] events ${sportKey}: HTTP ${r.status}`);
    return hit ? hit.events : [];
  }
  eventsCache.set(sportKey, { at: Date.now(), events: r.data });
  return r.data;
}

// Momios h2h de TODA una liga: 1 crédito, e incluye los partidos EN CURSO.
//
// Reemplaza al matching vía /events, que solo devuelve partidos futuros y por
// tanto nunca podía ver lo que el bot apuesta (siempre en vivo): de ahí que
// 459 picks quedaran unmatched. Una sola llamada trae el evento Y sus momios,
// así que cuesta lo mismo que antes costaba solo localizarlo. La cache se
// comparte entre todos los picks de la misma liga.
async function fetchLeagueOdds(sportKey, market = 'h2h') {
  const c = cfg();
  const ck = `${sportKey}|${market}`;
  const hit = leagueCache.get(ck);
  if (hit && Date.now() - hit.at < c.cacheSeconds * 1000) return hit.ev;
  if (!canRequest(true) || !withinDailyBudget()) return hit ? hit.ev : null;
  paidCalls++;
  spendToday();
  const r = await fetchJson(`${BASE}/sports/${sportKey}/odds?apiKey=${c.apiKey}` +
    `&markets=${market}&oddsFormat=decimal&bookmakers=${c.bookmakers.join(',')}`);
  if (!r.ok) {
    if (r.status !== 404 && r.status !== 422) console.error(`[sharp] odds liga ${ck}: HTTP ${r.status}`);
    return hit ? hit.ev : null;
  }
  leagueCache.set(ck, { at: Date.now(), ev: r.data });
  return r.data;
}

// Momios de UN mercado de UN evento: 1 crédito. Cache corta para deduplicar
// varios picks del mismo partido/mercado en el mismo lote.
async function fetchEventOdds(sportKey, eventId, market = 'h2h') {
  const c = cfg();
  const cacheKey = `${sportKey}|${eventId}|${market}`;
  const hit = oddsCache.get(cacheKey);
  if (hit && Date.now() - hit.at < ODDS_CACHE_MS) return hit.ev;
  if (!canRequest(true)) return null;
  paidCalls++;
  const r = await fetchJson(`${BASE}/sports/${sportKey}/events/${eventId}/odds?apiKey=${c.apiKey}` +
    `&markets=${market}&oddsFormat=decimal&bookmakers=${c.bookmakers.join(',')}`);
  if (!r.ok) {
    // 404/422: el evento ya no está en el feed (terminó) — sin momios
    if (r.status !== 404 && r.status !== 422) console.error(`[sharp] odds ${cacheKey}: HTTP ${r.status}`);
    return null;
  }
  oddsCache.set(cacheKey, { at: Date.now(), ev: r.data });
  return r.data;
}

// ---------- matching de eventos ----------
const STOP_TOKENS = new Set(['fc', 'cf', 'sc', 'ac', 'cd', 'afc', 'cfc', 'club', 'de', 'the', 'if', 'fk', 'bk']);

function normalizeTeam(s) {
  return (s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t && !STOP_TOKENS.has(t))
    .join(' ');
}

// Distancia de edición (Levenshtein) para tolerar variantes ES/EN del mismo
// nombre: Zimbabue↔Zimbabwe, Banglades↔Bangladesh, Japon↔Japan…
function editDistance(a, b) {
  const m = a.length, n = b.length;
  if (Math.abs(m - n) > 2) return 99;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

// Tokens iguales, o casi iguales si son largos (tolera 1-2 letras de diferencia)
function tokenEq(x, y) {
  if (x === y) return true;
  const L = Math.max(x.length, y.length);
  if (L < 5) return false;
  return editDistance(x, y) <= (L >= 8 ? 2 : 1);
}

// Abreviaturas de ciudad al estilo MLB: cada token corto (≤3) puede consumir
// uno o más tokens consecutivos del nombre largo por prefijo o iniciales
// ("det"→Detroit, "sd"→San Diego, "ny"→New York, "stl"→St. Louis). Exige que
// TODOS los tokens de ambos lados queden alineados en orden, así "NY Yankees"
// no matchea "New York Mets".
function abbrevConsume(chars, tokens, ti) {
  if (!chars.length) return ti;
  if (ti >= tokens.length) return -1;
  for (let len = Math.min(chars.length, tokens[ti].length); len >= 1; len--) {
    if (tokens[ti].startsWith(chars.slice(0, len))) {
      const r = abbrevConsume(chars.slice(len), tokens, ti + 1);
      if (r >= 0) return r;
    }
  }
  return -1;
}

function abbrevAlign(ta, tb) {
  let j = 0;
  for (const t of ta) {
    if (j < tb.length && tokenEq(t, tb[j])) { j++; continue; }
    if (t.length < 2 || t.length > 3) return false;
    const r = abbrevConsume(t, tb, j);
    if (r < 0) return false;
    j = r;
  }
  return j === tb.length;
}

function teamsMatch(a, b) {
  const na = normalizeTeam(a), nb = normalizeTeam(b);
  if (!na || !nb) return false;
  if (na === nb || na.includes(nb) || nb.includes(na)) return true;
  const ta = na.split(' '), tb = nb.split(' ');
  let inter = 0;
  for (const t of ta) if (tb.some(u => tokenEq(t, u))) inter++;
  if (inter / (ta.length + tb.length - inter) >= 0.5) return true; // Jaccard difuso
  return abbrevAlign(ta, tb) || abbrevAlign(tb, ta);
}

const START_TOLERANCE_MS = 15 * 60 * 1000; // ± 15 min
const LIVE_WINDOW_MS = 8 * 60 * 60 * 1000; // evento en vivo: empezó hace < 8 h (ODIs de críquet son largos)

// pick: { event, ts, minute }. events: lista de /events (id, home_team,
// away_team, commence_time). Devuelve { ev, swapped } o null.
//
// Dos pasadas: (1) estricta, inicio estimado ± 15 min a partir del minuto de
// juego; (2) si nada matcheó, ventana amplia de "en vivo". La pasada 2 es
// necesaria porque el minuto del feed no incluye descansos ni tiempo añadido
// (un pick al 81' de fútbol implica un inicio real ~15-20 min antes del
// estimado); los nombres de equipo siguen siendo el discriminador principal.
function matchEvent(pick, events, now = Date.now()) {
  const parts = (pick.event || '').split(/\s+vs\.?\s+|\s+@\s+/i);
  if (parts.length < 2) return null;
  const [home, away] = parts;
  const estStart = pick.minute != null && pick.ts
    ? Date.parse(pick.ts) - pick.minute * 60000
    : null;

  const nameMatch = (ev) => {
    if (teamsMatch(home, ev.home_team) && teamsMatch(away, ev.away_team)) return { ev, swapped: false };
    if (teamsMatch(home, ev.away_team) && teamsMatch(away, ev.home_team)) return { ev, swapped: true };
    return null;
  };
  const passes = [
    (commence) => estStart !== null && Math.abs(commence - estStart) <= START_TOLERANCE_MS,
    (commence) => commence <= now + START_TOLERANCE_MS && now - commence <= LIVE_WINDOW_MS,
  ];
  for (const timeOk of passes) {
    for (const ev of events || []) {
      const commence = Date.parse(ev.commence_time);
      if (Number.isNaN(commence) || !timeOk(commence)) continue;
      const m = nameMatch(ev);
      if (m) return m;
    }
  }
  return null;
}

// Primer bookmaker de la lista de prioridad con el mercado pedido disponible
function selectBookmaker(ev, market = 'h2h') {
  const priority = cfg().bookmakers;
  const byKey = new Map((ev.bookmakers || []).map(b => [b.key, b]));
  for (const key of priority) {
    const bm = byKey.get(key);
    const mk = bm && (bm.markets || []).find(m => m.key === market);
    if (mk && mk.outcomes && mk.outcomes.length >= 2) return { key, outcomes: mk.outcomes };
  }
  return null;
}

// Tipo de pick (parsePick) -> mercado de The Odds API. Lo que no está aquí
// (doble oportunidad…) queda como unsupported_market.
const MARKET_FOR_TYPE = {
  winner: 'h2h', draw: 'h2h', total: 'totals', handicap: 'spreads', btts: 'btts',
};

// Mapea la selección del pick al outcome sharp del mercado correspondiente.
// 'swapped' indica que el local de Altenar es el away_team del proveedor.
// En totals/spreads el outcome debe coincidir también en la línea (point).
function pickOutcomeIndex(parsed, ev, swapped, outcomes) {
  const teamFor = side => side === 'home'
    ? (swapped ? ev.away_team : ev.home_team)
    : (swapped ? ev.home_team : ev.away_team);
  const nameEq = (o, name) => (o.name || '').toLowerCase() === name.toLowerCase();
  const pointEq = (o, p) => o.point != null && Math.abs(Number(o.point) - p) < 1e-9;

  switch (parsed.type) {
    case 'draw':
      return { idx: outcomes.findIndex(o => nameEq(o, 'draw')), target: 'Draw', point: null };
    case 'winner': {
      const target = teamFor(parsed.side);
      return { idx: outcomes.findIndex(o => o.name === target), target, point: null };
    }
    case 'total': {
      if (parsed.line == null) return { idx: -1, target: null, point: null };
      const target = parsed.over ? 'Over' : 'Under';
      const idx = outcomes.findIndex(o => nameEq(o, target) && pointEq(o, parsed.line));
      return { idx, target, point: parsed.line };
    }
    case 'handicap': {
      const target = teamFor(parsed.side);
      const idx = outcomes.findIndex(o => o.name === target && pointEq(o, parsed.hcp));
      return { idx, target, point: parsed.hcp };
    }
    case 'btts': {
      const target = parsed.yes ? 'Yes' : 'No';
      return { idx: outcomes.findIndex(o => nameEq(o, target)), target, point: null };
    }
  }
  return { idx: -1, target: null, point: null };
}

function keysForSport(sportName) {
  const norm = (sportName || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const prefix = SPORT_PREFIX[norm];
  if (!prefix) return [];
  return cfg().sportKeys.filter(k => k.startsWith(prefix + '_') || k === prefix);
}

function buildMarketJson(bmKey, market, target, point, idx, outcomes) {
  return JSON.stringify({
    bookmaker: bmKey,
    market,
    target,
    point: point ?? null,
    idx,
    outcomes: outcomes.map(o =>
      o.point != null ? { name: o.name, price: o.price, point: o.point } : { name: o.name, price: o.price }),
  });
}

// ---------- captura de ENTRADA (al emitir el pick) ----------
// Matching gratis vía /events; 1 solo crédito si hay match (momios del evento).
// pick en memoria (tiene minute): { event, sport, market, selection, ts, minute }
// Devuelve { status } con status ∈ matched|unmatched|no_key|no_coverage|unsupported_market,
// y en matched: { odd, source, eventId, marketJson }.
async function captureForPick(pick) {
  if (!cfg().apiKey) return { status: 'no_key' };
  const parsed = parsePick(pick);
  const marketKey = parsed && MARKET_FOR_TYPE[parsed.type];
  if (!marketKey) return { status: 'unsupported_market' };

  // El mapa de ligas decide ANTES de gastar: si la liga no está cubierta se
  // corta aquí sin consumir crédito. Antes se barrían las ~40 ligas del deporte.
  const key = keyForChamp(pick.champ, pick.sport);
  if (!key) return { status: 'no_coverage' };

  // 1 crédito: trae los partidos de la liga (incluidos los EN CURSO) con momios
  let events;
  try { events = await fetchLeagueOdds(key, marketKey); } catch (e) {
    console.error(`[sharp] ${key}: ${e.message}`);
    return { status: 'unmatched' };
  }
  if (!events || !events.length) return { status: 'unmatched' };

  const m = matchEvent(pick, events);
  if (!m) return { status: 'unmatched' };

  const bm = selectBookmaker(m.ev, marketKey);
  if (!bm) return { status: 'unmatched' };
  const { idx, target, point } = pickOutcomeIndex(parsed, m.ev, m.swapped, bm.outcomes);
  if (idx < 0) return { status: 'unmatched' };
  return {
    status: 'matched',
    odd: bm.outcomes[idx].price,
    source: `theoddsapi:${bm.key}`,
    eventId: `${key}|${m.ev.id}`,
    marketJson: buildMarketJson(bm.key, marketKey, target, point, idx, bm.outcomes),
  };
}

// ---------- captura de CIERRE (una sola vez, al terminar el partido) ----------
// row: pick de BD con sharp_event_id y sharp_closing_market. 1 crédito.
// Devuelve { odd, marketJson } o null (evento ya fuera del feed sharp: se
// conserva el último valor visto, que como mínimo es el de la entrada).
async function captureClosingForPick(row) {
  if (!cfg().apiKey || !row.sharp_event_id) return null;
  const [key, evId] = String(row.sharp_event_id).split('|');
  if (!key || !evId) return null;
  let prev;
  try { prev = JSON.parse(row.sharp_closing_market); } catch { return null; }
  if (!prev || !prev.target) return null;
  const market = prev.market || 'h2h'; // filas anteriores a la cobertura multi-mercado

  // Se reutiliza la consulta de liga: si otro pick ya la trajo dentro de la
  // ventana de cache, el cierre sale gratis. Buscar el evento por id dentro de
  // la respuesta de liga evita una segunda llamada por evento.
  const events = await fetchLeagueOdds(key, market);
  const evOdds = (events || []).find(e => e.id === evId);
  if (!evOdds) return null;
  const bm = selectBookmaker(evOdds, market);
  if (!bm) return null;
  // mismo outcome y, si aplica, la MISMA línea; si el proveedor la movió al
  // cierre, no hay cierre comparable y se conserva el último valor visto
  const idx = bm.outcomes.findIndex(o =>
    (o.name || '').toLowerCase() === prev.target.toLowerCase() &&
    (prev.point == null || (o.point != null && Math.abs(Number(o.point) - prev.point) < 1e-9)));
  if (idx < 0) return null;
  return {
    odd: bm.outcomes[idx].price,
    marketJson: buildMarketJson(bm.key, market, prev.target, prev.point ?? null, idx, bm.outcomes),
  };
}

function status() {
  return {
    enabled: !!cfg().apiKey, quotaRemaining, paidCalls,
    creditsToday: creditsUsedToday(),
    dailyBudget: Number(process.env.SHARP_MAX_CREDITS_PER_DAY || 15),
    cachedSports: [...eventsCache.keys()],
  };
}

module.exports = {
  captureForPick, captureClosingForPick, status,
  // internos expuestos para tests
  _internal: {
    normalizeTeam, teamsMatch, matchEvent, selectBookmaker, pickOutcomeIndex, keysForSport,
    keyForChamp, normText, fetchLeagueOdds,
    fetchSchedule, fetchEventOdds,
    clearCaches: () => { eventsCache.clear(); oddsCache.clear(); leagueCache.clear(); },
  },
};
