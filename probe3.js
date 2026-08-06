const fs = require('fs');

const BASE = 'https://sb2frontend-altenar2.biahosted.com/api/widget';
const COMMON = 'culture=es-ES&timezoneOffset=360&integration=playdoit2&deviceType=1&numFormat=en-GB&countryCode=MX';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
  'Referer': 'https://www.playdoit.mx/',
  'Origin': 'https://www.playdoit.mx',
  'Accept': 'application/json',
};

async function tryGet(name, url) {
  try {
    const res = await fetch(url, { headers: HEADERS });
    const text = await res.text();
    console.log(`${name}: HTTP ${res.status}, ${text.length} bytes`);
    if (res.ok && text.length > 50) {
      fs.writeFileSync(`probe3_${name}.json`, text);
      console.log('  sample:', text.slice(0, 300).replace(/\s+/g, ' '));
    }
  } catch (e) {
    console.log(`${name}: ERROR ${e.message}`);
  }
}

(async () => {
  await tryGet('SportMenu', `${BASE}/GetSportMenu?${COMMON}&period=0`);
  await tryGet('LiveSportMenu', `${BASE}/GetSportMenu?${COMMON}&period=1`);
  await tryGet('Overview', `${BASE}/GetOverviewWithGroups?${COMMON}`);
  await tryGet('LiveOverview', `${BASE}/GetLiveOverview?${COMMON}`);
  await tryGet('Events', `${BASE}/GetEvents?${COMMON}&sportId=66&eventCount=10&eventPhase=1`);
})();
