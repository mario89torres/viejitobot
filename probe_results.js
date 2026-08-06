// Explora endpoints candidatos de resultados/detalle de evento en Altenar
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
    const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(15000) });
    const text = await res.text();
    console.log(`${name}: HTTP ${res.status}, ${text.length} bytes`);
    if (res.ok && text.length > 20) {
      fs.writeFileSync(`probe_res_${name}.json`, text);
      console.log('  sample:', text.slice(0, 250).replace(/\s+/g, ' '));
    }
  } catch (e) {
    console.log(`${name}: ERROR ${e.message}`);
  }
}

(async () => {
  // Necesitamos un event_id reciente ya terminado; usamos uno de la BD
  const Database = require('better-sqlite3');
  const db = new Database('snapshots.db', { readonly: true });
  const old = db.prepare(`SELECT event_id, event, MAX(ts) mt FROM snapshots GROUP BY event_id ORDER BY mt ASC LIMIT 3`).all();
  const live = db.prepare(`SELECT event_id, event, MAX(ts) mt FROM snapshots GROUP BY event_id ORDER BY mt DESC LIMIT 1`).all();
  console.log('Eventos viejos (probablemente terminados):', JSON.stringify(old));
  console.log('Evento reciente:', JSON.stringify(live));
  const finishedId = old[0].event_id;
  const liveId = live[0].event_id;

  for (const [name, url] of [
    ['EventDetails_fin', `${BASE}/GetEventDetails?${COMMON}&eventId=${finishedId}`],
    ['EventDetails_live', `${BASE}/GetEventDetails?${COMMON}&eventId=${liveId}`],
    ['Event_fin', `${BASE}/GetEvent?${COMMON}&eventId=${finishedId}`],
    ['Results', `${BASE}/GetResults?${COMMON}`],
    ['ResultsByEvent', `${BASE}/GetResults?${COMMON}&eventId=${finishedId}`],
    ['EventResult', `${BASE}/GetEventResult?${COMMON}&eventId=${finishedId}`],
    ['GetScoreboard', `${BASE}/GetScoreboard?${COMMON}&eventId=${finishedId}`],
  ]) {
    await tryGet(name, url);
    await new Promise(r => setTimeout(r, 400));
  }
})();
