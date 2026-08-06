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
    const ct = res.headers()['content-type'] || '';
    if (ct.includes('json') && res.status() === 200) {
      try {
        const body = await res.text();
        if (body.length > 200) apiCalls.push({ url, size: body.length, sample: body.slice(0, 500) });
      } catch {}
    }
  });

  console.log('Cargando playdoit.mx...');
  await page.goto('https://www.playdoit.mx/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(10000);

  console.log('URL actual:', page.url());
  console.log('Titulo:', await page.title());

  // Buscar enlaces a secciones en vivo
  const links = await page.$$eval('a', as => as.map(a => ({ href: a.href, text: a.innerText.trim().slice(0, 50) }))
    .filter(l => /vivo|live|in-play|deporte|sport/i.test(l.href + ' ' + l.text)).slice(0, 40));
  console.log('\nEnlaces relevantes:');
  links.forEach(l => console.log(' -', l.text, '|', l.href));

  fs.writeFileSync('probe_home.html', await page.content());
  await page.screenshot({ path: 'probe_home.png', fullPage: false });

  fs.writeFileSync('probe_api.json', JSON.stringify(apiCalls.map(a => ({ url: a.url, size: a.size })), null, 2));
  fs.writeFileSync('probe_api_samples.json', JSON.stringify(apiCalls, null, 2));
  console.log('\nLlamadas API JSON capturadas:', apiCalls.length);
  apiCalls.slice(0, 20).forEach(a => console.log(' -', a.size, 'bytes |', a.url.slice(0, 120)));

  await browser.close();
})();
