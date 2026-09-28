// scripts/capturar-boleto.js
// Abre el perfil del dry run, va al último pick con cuota en la BD (o al que le pases),
// hace clic en la pata para abrir el boleto (con los mismos frenos que dryRunBetslip) y
// vuelca el HTML del boleto a un archivo, para diseñar limpiarBetslip con selectores reales.
// NO limpia el boleto ni pulsa "Apostar". No corre en modo solo lectura: hace un clic real
// sobre la cuota, igual que el flujo normal del dry run.
//
// Uso:
//   node scripts/capturar-boleto.js              → usa el pick más reciente de model_picks
//   node scripts/capturar-boleto.js <pick_id>
'use strict';

require('dotenv').config();
const fs       = require('fs');
const path     = require('path');
const Database = require('better-sqlite3');
const { iniciarContexto, cerrarContexto } = require('../src/dryRunBetslip');
const { regexEtiqueta } = require('../src/dryRunHelpers');

// Mismos selectores que dryRunBetslip.js (Shadow DOM abierto: los locators de Playwright lo
// atraviesan, document.querySelectorAll no).
const SEL_BOTON_CUOTA = 'button[class*="OddBoxButton"]';
const SEL_ETIQUETA    = '[class*="OddLabel"]';

const DB_FILE = process.env.DB_PATH || path.join(__dirname, '..', 'snapshots.db');
const db = new Database(DB_FILE, { readonly: true, timeout: 5000 });

const pickId = Number(process.argv[2]) || null;
const row = pickId
  ? db.prepare('SELECT * FROM model_picks WHERE id = ?').get(pickId)
  : db.prepare('SELECT * FROM model_picks WHERE odd_decimal IS NOT NULL ORDER BY id DESC LIMIT 1').get();

if (!row) { console.error('No encontré un pick usable en model_picks.'); process.exit(1); }

// model_picks no guarda sport_id (solo `sport`, texto); se resuelve por snapshots, igual que
// dry-run-pick.js. 66 = fútbol, por defecto.
let sportId = 66;
const sRow = db.prepare('SELECT sport_id FROM snapshots WHERE event_id = ? AND sport_id IS NOT NULL LIMIT 1').get(row.event_id);
if (sRow?.sport_id) sportId = sRow.sport_id;

console.log('Pick:', { id: row.id, event_id: row.event_id, sport_id: sportId, market: row.market, selection: row.selection });

(async () => {
  const ctx  = await iniciarContexto();
  const page = ctx.pages()[0] || await ctx.newPage();
  const url  = `https://www.playdoit.mx/#page=event&eventId=${row.event_id}&sportId=${sportId}`;
  await page.goto(url, { waitUntil: 'commit', timeout: 60_000 }).catch((e) => {
    if (!/Timeout/i.test(e.message)) throw e;
  });
  await page.waitForTimeout(2000);

  // Esperar a que el sportsbook pinte cuotas (hasta 60s, igual que dryRunBetslip).
  await page.locator(SEL_BOTON_CUOTA).first().waitFor({ state: 'visible', timeout: 60_000 }).catch(() => {});

  // Localizar por etiqueta exacta (no "contiene texto": "Menos de 3.5" también casaría
  // "Menos de 13.5" con un filtro laxo). Reintenta unos segundos por si el mercado carga tarde.
  const localizar = () => page.locator(SEL_BOTON_CUOTA)
    .filter({ has: page.locator(SEL_ETIQUETA).filter({ hasText: regexEtiqueta(row.selection) }) });
  let n = await localizar().count().catch(() => 0);
  const t0 = Date.now();
  while (n === 0 && Date.now() - t0 < 8000) {
    await page.waitForTimeout(500);
    n = await localizar().count().catch(() => 0);
  }
  if (n === 0) {
    console.error(`No encontré el botón de "${row.selection}" (mercado puede haber cambiado o el pick ya no está vivo).`);
    await page.screenshot({ path: path.join(__dirname, '..', 'scratch', '_boleto_sin_boton.png') }).catch(() => {});
    console.error('Captura de la página guardada en scratch/_boleto_sin_boton.png para revisar qué se ve.');
    await cerrarContexto();
    process.exit(1);
  }
  if (n > 1) console.warn(`Aviso: ${n} botones casan la etiqueta; se usa el primero.`);
  const btn = localizar().first();

  await btn.scrollIntoViewIfNeeded().catch(() => {});
  await btn.click({ delay: 60 });
  await page.waitForTimeout(1200);

  // El boleto se abre COLAPSADO (barra inferior "BOLETO n · MOMIOS +x"): hay que expandirlo
  // para ver las patas individuales y su botón de quitar.
  const cabecera = page.locator('[class*="BetSlipHeaderContainer" i][data-clickable="true"]').first();
  if (await cabecera.isVisible().catch(() => false)) {
    await cabecera.click({ delay: 60 });
    await page.waitForTimeout(800);
  } else {
    console.warn('No encontré la cabecera del boleto para expandirlo; se captura como esté.');
  }

  // Volcar el HTML de cualquier contenedor que huela a boleto/betslip. Con locator (no
  // document.querySelectorAll) para atravesar el Shadow DOM abierto del sportsbook.
  const SEL_BOLETO = '[class*="betslip" i], [class*="bet-slip" i], [class*="BetSlip" i], [class*="Slip" i]';
  const handles = await page.locator(SEL_BOLETO).elementHandles().catch(() => []);
  let html = '';
  for (const h of handles) {
    html += await h.evaluate((el) => `\n<!-- ${el.className} -->\n${el.outerHTML}\n`).catch(() => '');
  }
  if (!html) html = '(no se encontró ningún contenedor con esos selectores; revisa la captura de pantalla)';

  const outPath = path.join(__dirname, '..', 'scratch', '_boleto.html');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, html, 'utf8');
  console.log('HTML guardado en:', outPath);

  const ssPath = path.join(__dirname, '..', 'scratch', '_boleto.png');
  await page.screenshot({ path: ssPath, fullPage: false }).catch(() => {});
  console.log('Captura guardada en:', ssPath);

  console.log('\nRevisa ambos archivos y pega el contenido de _boleto.html (o la imagen) para ajustar limpiarBetslip.');
  console.log('Este script NO limpió el boleto — probablemente quede una pata pendiente para la próxima corrida.');
  await cerrarContexto();
})().catch((e) => { console.error('Error:', e.message); process.exit(1); });
