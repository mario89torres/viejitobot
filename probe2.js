const { chromium } = require('playwright');
const fs = require('fs');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
    locale: 'es-MX',
  });

  const apiCalls = [];
  page.on('response', async (res) => {
    const url = res.url();
    if (url.includes('biahosted.com') && res.status() === 200) {
      try {
        const body = await res.text();
        apiCalls.push({ url, size: body.length, sample: body.slice(0, 1500) });
      } catch {}
    }
  });

  console.log('Cargando seccion en vivo...');
  await page.goto('https://www.playdoit.mx/es/sports#/live', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(15000);
  console.log('URL actual:', page.url());

  await page.screenshot({ path: 'probe_live.png' });
  fs.writeFileSync('probe_live_api.json', JSON.stringify(apiCalls, null, 2));
  console.log('\nLlamadas Altenar capturadas:', apiCalls.length);
  apiCalls.forEach(a => console.log(' -', a.size, 'bytes |', a.url.slice(0, 160)));

  await browser.close();
})();
