const ratelimit = require('./ratelimit');

const BASE = 'https://sb2frontend-altenar2.biahosted.com/api/widget';
const COMMON = 'culture=es-ES&timezoneOffset=360&integration=playdoit2&deviceType=1&numFormat=en-GB&countryCode=MX';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
  'Referer': 'https://www.playdoit.mx/',
  'Origin': 'https://www.playdoit.mx',
  'Accept': 'application/json',
};

async function getJson(url, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      await ratelimit.acquire();
      const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      if (i === retries - 1) throw e;
      await new Promise(r => setTimeout(r, 2000 * (i + 1)));
    }
  }
}

async function getLiveSports() {
  const overview = await getJson(`${BASE}/GetLiveOverview?${COMMON}`);
  return overview.liveSports.filter(s => s.count > 0);
}

async function fetchSportLive(sport) {
  const data = await getJson(`${BASE}/GetLiveOverview?${COMMON}&sportId=${sport.id}`);
  return { sport, data };
}

async function fetchAllLive() {
  const sports = await getLiveSports();
  const results = [];
  for (const sport of sports) {
    try {
      results.push(await fetchSportLive(sport));
    } catch (e) {
      console.error(`  [warn] fallo deporte ${sport.name}: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 500));
  }
  return results;
}

// Detalle de UN evento. Es la unica via a los mercados que el overview no
// trae — corners, tarjetas, especiales por jugador — y cuesta una llamada por
// partido, frente a una por deporte del overview. Solo lo usa el piloto de
// corners (src/corners.js), que trae su propio tope e intervalo.
//
// `retries = 1`: si el detalle de un partido falla, se salta y ya. Reintentar
// multiplicaria las llamadas de un camino que ya es el caro, y el piloto puede
// perder muestras sin consecuencia — no decide nada.
async function fetchEventDetails(eventId) {
  return getJson(`${BASE}/GetEventDetails?${COMMON}&eventId=${eventId}`, 1);
}

// Calendario PRE-PARTIDO de un deporte: todos los eventos programados (no solo
// los que ya estan en vivo), con mercados y cuotas incluidos en la misma
// respuesta — una sola llamada trae TODO lo pre-partido de ese deporte (31
// dias hacia adelante en futbol, medido el 2026-09-22), a diferencia del
// piloto de corners que necesita una llamada por partido. Misma forma que
// GetLiveOverview (`markets`, `odds`, `events`, `champs`, `competitors`), asi
// que normalize() la procesa sin cambios — solo que aqui `ev.startDate` es
// futuro y `ev.status === 0` (no iniciado). Piloto de solo lectura
// (src/prematchScanner.js): no emite ni decide nada.
async function fetchPrematch(sportId) {
  return getJson(`${BASE}/GetEvents?${COMMON}&sportId=${sportId}`, 1);
}

module.exports = { fetchAllLive, fetchSportLive, getLiveSports, fetchEventDetails, fetchPrematch };
