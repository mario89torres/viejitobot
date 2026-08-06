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

module.exports = { fetchAllLive, fetchSportLive, getLiveSports };
