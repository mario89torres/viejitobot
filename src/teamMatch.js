// Matcher de equipos entre nombres de fuentes distintas — extraido de
// src/sharp.js (donde nacio para emparejar playdoit <-> The Odds API), para
// reusarlo tal cual con la segunda fuente de corners (SofaScore, luego
// FotMob). Es el MISMO codigo, no una reescritura: ya paso por el bug de
// abreviaturas estilo MLB documentado en sharp-coverage-diagnosis, y
// reinventarlo arriesgaria repetirlo.
const STOP_TOKENS = new Set(['fc', 'cf', 'sc', 'ac', 'cd', 'afc', 'cfc', 'club', 'de', 'the', 'if', 'fk', 'bk']);

// "Sub-19"/"Sub 19" (playdoit) == "U19" (otras fuentes): mismo torneo
// juvenil, notacion distinta. Sin esto "club brugge sub 19" y "club brugge
// u19" no comparten ni un token — Levenshtein no ayuda porque "sub" y "u19"
// no se parecen como cadenas. Se unifica ANTES de tokenizar, asi que las dos
// fuentes llegan al mismo token "u19" y el resto del matcher no necesita
// saber que esto existe. Hallado el 2026-09-08 emparejando SofaScore contra
// playdoit (el piloto vigente entonces):
// la Liga Juvenil UEFA SI estaba en el barrido (posicion 12) y aun asi no
// matcheaba — no era falta de cobertura, era esto.
//
// 2026-09-23 (medido sobre 933 eventos playdoit vs. calendario FotMob: el
// matcher empareja 46.2%, y 9.2 pp mas eran fallos de NOMBRE, no de cobertura):
//  - Selecciones en espanol ("Paises Bajos", "Italia") contra ingles ("Netherlands",
//    "Italy"): tabla PAISES, aplicada solo al nombre COMPLETO (sin sufijo de
//    categoria) para que "Irlanda" e "Irlanda del Norte" sigan siendo distintos.
//  - "(F)" (playdoit) == "(W)" / "Women" (otras fuentes): antes eran los tokens
//    "f" y "w", que nunca se igualan.
//  - Letras que NFD no descompone (o, ae, ss...): "Nykobing"/"Nykoebing" ya
//    quedaban a 1-2 ediciones, pero la o barrada se convertia en un separador y
//    partia el nombre en dos tokens.
const PAISES = {
  'alemania': 'germany', 'paises bajos': 'netherlands', 'holanda': 'netherlands', 'republica checa': 'czechia', 'chequia': 'czechia',
  'czech republic': 'czechia', 'grecia': 'greece', 'francia': 'france', 'espana': 'spain', 'inglaterra': 'england', 'italia': 'italy',
  'belgica': 'belgium', 'bielorrusia': 'belarus', 'turquia': 'turkey', 'turkiye': 'turkey', 'noruega': 'norway', 'dinamarca': 'denmark',
  'hungria': 'hungary', 'ucrania': 'ukraine', 'irlanda': 'ireland', 'irlanda del norte': 'northern ireland', 'escocia': 'scotland',
  'gales': 'wales', 'suiza': 'switzerland', 'suecia': 'sweden', 'rumania': 'romania', 'polonia': 'poland', 'croacia': 'croatia',
  'bosnia y herzegovina': 'bosnia and herzegovina', 'eslovenia': 'slovenia', 'islas feroe': 'faroe islands', 'kazajistan': 'kazakhstan',
  'kazajstan': 'kazakhstan', 'macedonia del norte': 'north macedonia', 'eslovaquia': 'slovakia', 'moldavia': 'moldova',
  'islandia': 'iceland', 'letonia': 'latvia', 'lituania': 'lithuania', 'chipre': 'cyprus', 'luxemburgo': 'luxembourg',
  'finlandia': 'finland', 'azerbaiyan': 'azerbaijan', 'rusia': 'russia', 'argelia': 'algeria', 'egipto': 'egypt', 'marruecos': 'morocco',
  'tunez': 'tunisia', 'camerun': 'cameroon', 'rd congo': 'dr congo', 'guinea ecuatorial': 'equatorial guinea', 'costa de marfil': 'ivory coast',
  'cote d ivoire': 'ivory coast', 'republica centroafricana': 'central african republic', 'cabo verde': 'cape verde', 'sudafrica': 'south africa',
  'estados unidos': 'usa', 'united states': 'usa', 'corea del sur': 'south korea', 'korea republic': 'south korea',
  'corea del norte': 'north korea', 'dpr korea': 'north korea', 'japon': 'japan', 'brasil': 'brazil', 'arabia saudita': 'saudi arabia',
  'irak': 'iraq', 'jordania': 'jordan', 'siria': 'syria', 'libano': 'lebanon', 'catar': 'qatar', 'emiratos arabes unidos': 'united arab emirates',
  'filipinas': 'philippines', 'tailandia': 'thailand', 'timor oriental': 'timor leste', 'nueva zelanda': 'new zealand',
  'santa lucia': 'saint lucia', 'san martin': 'saint martin', 'islas caiman': 'cayman islands',
  'islas turcas y caicos': 'turks and caicos islands',
};
const TRANSLIT = { 'ø': 'o', 'æ': 'ae', 'œ': 'oe', 'ß': 'ss', 'ð': 'd', 'þ': 'th', 'ł': 'l', 'đ': 'd' };

function normalizeTeam(s) {
  let t = (s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[øæœßðþłđ]/g, c => TRANSLIT[c])
    .replace(/\((?:f|w)\)/g, ' w ')
    .replace(/\b(?:women|womens|femenino|feminino|femenil)\b/g, ' w ')
    .replace(/\bsub[\s-]*(\d+)\b/g, 'u$1')
    .replace(/\s+/g, ' ')
    .trim();
  // Pais en espanol -> ingles, solo si TODO el nombre (sin sufijo de categoria)
  // es un pais conocido.
  const m = t.match(/^(.*?)((?:\s+(?:w|u\d+))*)$/);
  const pais = m && PAISES[m[1].replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim()];
  if (pais) t = pais + m[2];
  return t
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

// Categoria (femenino "w", juvenil "u21"...) y calificador geografico: dos
// nombres que difieren en ellos son equipos distintos aunque uno contenga al
// otro. Sin esto "Liverpool (F)" casaba con "Liverpool" (el equipo de mayores) y
// "Ireland" con "Northern Ireland" por la regla de inclusion de abajo — y el
// piloto de xG habria colgado el xG del equipo equivocado.
const QUALIFIERS = new Set(['north', 'northern', 'south', 'southern', 'east', 'eastern', 'west', 'western']);
const esCategoria = t => /^(?:w|u\d+)$/.test(t);
const distintaCategoria = (ta, tb) => {
  const sig = (ts, pred) => ts.filter(pred).sort().join(',');
  const qual = t => QUALIFIERS.has(t);
  return sig(ta, esCategoria) !== sig(tb, esCategoria) || sig(ta, qual) !== sig(tb, qual);
};

function teamsMatch(a, b) {
  const na = normalizeTeam(a), nb = normalizeTeam(b);
  if (!na || !nb) return false;
  const todosA = na.split(' '), todosB = nb.split(' ');
  if (distintaCategoria(todosA, todosB)) return false;
  if (na === nb || na.includes(nb) || nb.includes(na)) return true;
  // Jaccard y siglas SOLO sobre los tokens del nombre: la categoria ya se exigio
  // igual arriba, y contarla aqui inflaba la similitud ("Paraguay Sub-20 (F)"
  // casaba con "Italy U20 (W)": comparten "u20" y "w" -> 2/4 = 0.5). Lo detecto
  // el chequeo de duplicados contra datos reales, no los tests unitarios.
  const ta = todosA.filter(t => !esCategoria(t)), tb = todosB.filter(t => !esCategoria(t));
  if (!ta.length || !tb.length) return false;
  let inter = 0;
  for (const t of ta) if (tb.some(u => tokenEq(t, u))) inter++;
  if (inter / (ta.length + tb.length - inter) >= 0.5) return true; // Jaccard difuso
  return abbrevAlign(ta, tb) || abbrevAlign(tb, ta);
}

const START_TOLERANCE_MS = 15 * 60 * 1000; // ± 15 min
const LIVE_WINDOW_MS = 8 * 60 * 60 * 1000; // evento en vivo: empezó hace < 8 h (ODIs de críquet son largos)

// pick: { event, ts, minute }. events: lista de candidatos con home_team,
// away_team, commence_time (ISO o parseable por Date.parse). Devuelve
// { ev, swapped } o null.
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

module.exports = {
  normalizeTeam, teamsMatch, matchEvent,
  START_TOLERANCE_MS, LIVE_WINDOW_MS,
  _internal: { editDistance, tokenEq, abbrevAlign, abbrevConsume },
};
