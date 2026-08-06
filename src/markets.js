function normText(s) {
  return (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

const clamp = x => Math.max(0, Math.min(1, x));

// Mercados de "quién anota el gol nº N" (Primer Gol, Quinto Gol...). Devolver
// null los deja fuera del sistema, que es lo correcto: el marcador final no
// dice quién anotó cada gol, así que no hay forma de calificarlos.
//
// Antes caían en la rama 'winner' porque la selección es un nombre de equipo, y
// se evaluaban como "¿ganó el partido?". Resultado: 52 picks marcados como
// ganados SIN EXCEPCIÓN, 16 de ellos con menos goles en total que el número
// apostado — el gol nº N jamás ocurrió. Inflaban el ROI del fútbol en +23.3u.
const NTH_GOAL = /^(primer|segundo|tercer|cuarto|quinto|sexto|septimo|octavo|noveno|decimo)\s+gol\b/;

// Interpreta mercado+selección en una estructura evaluable; null si no se reconoce
function parsePick(row) {
  const market = normText(row.market);
  const sel = normText(row.selection);
  if (NTH_GOAL.test(market)) return null;
  const parts = row.event.split(/\s+vs\.?\s+|\s+@\s+/i);
  const home = normText(parts[0] || '').trim();
  const away = normText(parts[1] || '').trim();
  const key = s => s.slice(0, 12);
  const matchesHome = !!home && sel.includes(key(home));
  const matchesAway = !!away && sel.includes(key(away));

  if (/^mas de|^menos de/.test(sel)) {
    const lineM = sel.match(/de (\d+(?:\.\d+)?)/) || market.match(/(\d+(?:\.\d+)?)\s*$/);
    return { type: 'total', over: sel.startsWith('mas de'), line: lineM ? Number(lineM[1]) : null };
  }
  if (market.includes('ambos equipos marcan') || market.includes('ambos marcan')) {
    return { type: 'btts', yes: /(^|\s)si($|\s)/.test(sel) };
  }
  if (market.includes('doble oportunidad')) {
    return { type: 'dc', coversHome: matchesHome, coversAway: matchesAway, coversDraw: sel.includes('empate') };
  }
  const hM = row.selection.match(/\(([+-]\d+(?:\.\d+)?)\)/);
  if (market.includes('handicap') && hM && (matchesHome || matchesAway)) {
    return { type: 'handicap', side: matchesHome ? 'home' : 'away', hcp: Number(hM[1]) };
  }
  if (sel === 'empate' || sel === 'x') return { type: 'draw' };
  // Empate No Acción (draw no bet): el empate DEVUELVE la apuesta, no la pierde.
  // Se distingue de 'winner' para que gradePick lo trate como nulo y no como
  // derrota; contarlo mal daba -39.6% de ROI sobre resultados que ni existían.
  if (market.includes('no accion') && (matchesHome || matchesAway)) {
    return { type: 'dnb', side: matchesHome ? 'home' : 'away' };
  }
  if (matchesHome || matchesAway) return { type: 'winner', side: matchesHome ? 'home' : 'away' };
  return null;
}

function isTennisSport(sport = '') {
  const s = (sport || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  return s.includes('tenis') || s.includes('tennis');
}

// Factor [0..1] según qué tan favorable es el estado actual del juego para el pick
function situationFactor(row, parsed, progress, params) {
  const m = (row.score || '').match(/^(\d+)-(\d+)$/);
  if (!m || !parsed) return 0.5;
  const a = Number(m[1]), b = Number(m[2]), total = a + b, mg = params.margin;

  const isTennis = isTennisSport(row.sport);
  if (isTennis) {
    const marketName = (row.market || '').toLowerCase();
    // En tenis/tenis de mesa el marcador live es de SETS (ej: "1-0").
    // Solo podemos evaluar la situación para Ganador de Partido y Hándicap de Sets.
    if (parsed.type === 'winner' || parsed.type === 'dnb') {
      const diff = parsed.side === 'home' ? a - b : b - a;
      return clamp(0.5 + 0.5 * diff / (params.margin || 1));
    }
    if (parsed.type === 'handicap' && marketName.includes('set')) {
      const diff = (parsed.side === 'home' ? a - b : b - a) + parsed.hcp;
      return clamp(0.5 + 0.5 * diff / (params.margin || 1));
    }
    // Para Totales de Juegos/Puntos y Hándicap de Juegos/Puntos se devuelve 0.5 (neutro)
    return 0.5;
  }

  switch (parsed.type) {
    case 'winner':
    case 'dnb': {
      const diff = parsed.side === 'home' ? a - b : b - a;
      return clamp(0.5 + 0.5 * diff / mg);
    }
    case 'draw':
      return clamp(0.5 - 0.5 * Math.abs(a - b) / mg);
    case 'handicap': {
      const diff = (parsed.side === 'home' ? a - b : b - a) + parsed.hcp;
      return clamp(0.5 + 0.5 * diff / mg);
    }
    case 'dc': {
      if (parsed.coversHome && parsed.coversAway) return clamp(0.5 + 0.5 * Math.abs(a - b) / mg);
      const uncoveredLead = parsed.coversHome ? b - a : a - b;
      return clamp(0.5 - 0.5 * uncoveredLead / mg + (parsed.coversDraw ? 0.1 : 0));
    }
    case 'total': {
      if (parsed.line === null) return 0.5;
      if (total > parsed.line) return parsed.over ? 1 : 0; // ya decidido
      if (progress <= 0.1) return 0.5;
      const expected = total / progress; // ritmo de anotación proyectado al final
      const diff = parsed.over ? expected - parsed.line : parsed.line - expected;
      return clamp(0.5 + 0.5 * diff / mg);
    }
    case 'btts': {
      const both = a > 0 && b > 0;
      if (parsed.yes) return both ? 1 : clamp(0.6 - 0.6 * progress);
      return both ? 0 : clamp(0.3 + 0.7 * progress);
    }
  }
  return 0.5;
}

// Califica el pick contra un marcador final: 'win' | 'loss' | null (no calificable/push)
function gradePick(row, finalScore) {
  const parsed = parsePick(row);
  const m = (finalScore || '').match(/^(\d+)-(\d+)$/);
  if (!m || !parsed) return null;
  const a = Number(m[1]), b = Number(m[2]), total = a + b;

  const isTennis = isTennisSport(row.sport);
  if (isTennis) {
    const marketName = (row.market || '').toLowerCase();
    // En tenis el marcador final registrado es de SETS (ej: "2-1").
    // Solo son calificables el Ganador del Partido y el Hándicap de Sets.
    if (parsed.type === 'winner' || parsed.type === 'dnb') {
      if (a === b) return null;
      return (parsed.side === 'home' ? a > b : b > a) ? 'win' : 'loss';
    }
    if (parsed.type === 'handicap' && marketName.includes('set')) {
      const d = (parsed.side === 'home' ? a - b : b - a) + parsed.hcp;
      if (d === 0) return null;
      return d > 0 ? 'win' : 'loss';
    }
    // Totales de Juegos/Puntos, Hándicap de Juegos/Puntos y Sets específicos no son calificables con marcador de sets.
    return null;
  }

  switch (parsed.type) {
    case 'winner': return (parsed.side === 'home' ? a > b : b > a) ? 'win' : 'loss';
    // draw no bet: el empate anula la apuesta (null = no computa en métricas)
    case 'dnb':
      if (a === b) return null;
      return (parsed.side === 'home' ? a > b : b > a) ? 'win' : 'loss';
    case 'draw': return a === b ? 'win' : 'loss';
    case 'handicap': {
      const d = (parsed.side === 'home' ? a - b : b - a) + parsed.hcp;
      if (d === 0) return null;
      return d > 0 ? 'win' : 'loss';
    }
    case 'dc': {
      const win = (parsed.coversHome && a > b) || (parsed.coversAway && b > a) || (parsed.coversDraw && a === b);
      return win ? 'win' : 'loss';
    }
    case 'total':
      if (parsed.line === null || total === parsed.line) return null;
      return (parsed.over ? total > parsed.line : total < parsed.line) ? 'win' : 'loss';
    case 'btts': {
      const both = a > 0 && b > 0;
      return (parsed.yes ? both : !both) ? 'win' : 'loss';
    }
  }
  return null;
}

module.exports = { parsePick, situationFactor, gradePick };
