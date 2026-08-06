const API_URL = 'http://localhost:3001/api';

async function diagnose() {
  // 1. HTML
  const r1 = await fetch('http://localhost:3001/');
  const html = await r1.text();
  console.log('HTML bytes:', html.length);
  const ver = html.match(/app\.js\?v=[\d.]+/)?.[0] ?? 'no version';
  console.log('app.js version en HTML:', ver);

  // 2. /api/accepted
  const r2 = await fetch(API_URL + '/accepted');
  const d2 = await r2.json();
  console.log('/api/accepted count:', d2.acceptedCount);
  const p = d2.accepted ? d2.accepted[0] : null;
  if (p) console.log('Pick[0]:', JSON.stringify({ id: p.id, result: p.result, loss_minute: p.loss_minute, stake: p.stake, profit: p.profit, event: p.event }));

  // 3. /api/summary
  const r3 = await fetch(API_URL + '/summary');
  const d3 = await r3.json();
  const h = d3.health;
  console.log('Summary health.roi:', h ? h.roi : 'N/A');
  console.log('byDay length:', d3.stats ? d3.stats.byDay.length : 0);
  console.log('bySport length:', d3.stats ? d3.stats.bySport.length : 0);

  // 4. /api/rejected
  const r4 = await fetch(API_URL + '/rejected');
  const d4 = await r4.json();
  console.log('/api/rejected count:', d4.rejected ? d4.rejected.length : 0, 'savedUnits:', d4.savedUnits);
}

diagnose().catch(function(e) { console.error('ERROR:', e.message); });
