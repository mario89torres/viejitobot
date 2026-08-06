const BASE = 'https://sb2frontend-altenar2.biahosted.com/api/widget';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
  'Referer': 'https://www.playdoit.mx/',
  'Origin': 'https://www.playdoit.mx',
  'Accept': 'application/json',
  'Content-Type': 'application/json',
  'integration': 'playdoit2',
  'deviceType': '1',
  'culture': 'es-ES',
  'timezoneOffset': '360',
  'countryCode': 'MX'
};

async function testPostWithHeaders() {
  const sportRes = await fetch(`${BASE}/GetLiveOverview?culture=es-ES&timezoneOffset=360&integration=playdoit2&deviceType=1&numFormat=en-GB&countryCode=MX&sportId=66`, { headers: HEADERS });
  const data = await sportRes.json();
  const oddId = data.odds?.[0]?.id;
  console.log(`🎯 Real Odd ID: ${oddId}`);

  if (!oddId) return;

  const COMMON = 'culture=es-ES&timezoneOffset=360&integration=playdoit2&deviceType=1&numFormat=en-GB&countryCode=MX';

  const actions = [
    { name: 'AddBetCode odds', url: `${BASE}/AddBetCode?${COMMON}`, body: { odds: [oddId] } },
    { name: 'AddBetCode oddIds', url: `${BASE}/AddBetCode?${COMMON}`, body: { oddIds: [oddId] } },
    { name: 'AddBetCode selectionIds', url: `${BASE}/AddBetCode?${COMMON}`, body: { selectionIds: [oddId] } },
    { name: 'AddBetCode Selections', url: `${BASE}/AddBetCode?${COMMON}`, body: { Selections: [{ Id: oddId }] } },
    { name: 'GetBetCode odds', url: `${BASE}/GetBetCode?${COMMON}`, body: { odds: [oddId] } },
    { name: 'SaveBetCode odds', url: `${BASE}/SaveBetCode?${COMMON}`, body: { odds: [oddId] } },
    { name: 'ShareBet odds', url: `${BASE}/ShareBet?${COMMON}`, body: { odds: [oddId] } },
    { name: 'CreateBetCode odds', url: `${BASE}/CreateBetCode?${COMMON}`, body: { odds: [oddId] } },
  ];

  for (const act of actions) {
    try {
      const r = await fetch(act.url, {
        method: 'POST',
        headers: HEADERS,
        body: JSON.stringify(act.body)
      });
      const txt = await r.text();
      console.log(`\n[${act.name}] Status: ${r.status}`);
      console.log(`Response: ${txt.slice(0, 300)}`);
    } catch (e) {
      console.log(`Error: ${e.message}`);
    }
  }
}

testPostWithHeaders().catch(console.error);
