// scripts/abrir-perfil.js
// Abre el perfil de Chrome del dry run (.chrome-profile) en Playdoit para que INICIES SESIÓN
// A MANO. No escribe credenciales ni pulsa nada. Cierra la ventana cuando termines.
// La sesión queda guardada en el perfil y la reutilizan las corridas del dry run.
// Uso: node scripts/abrir-perfil.js   (con el bot de dry run y otras corridas cerradas)
'use strict';

require('dotenv').config();
const { iniciarContexto, cerrarContexto, guardarSesion } = require('../src/dryRunBetslip');

// Cierra el aviso de cookies si aparece (tapa visualmente el botón de iniciar sesión).
async function cerrarBannerCookies(page) {
  try {
    await page.evaluate(() => {
      const close = document.querySelector('[class*="cookie"] button, [class*="cookie"] [class*="close"]');
      if (close) { close.click(); return; }
      for (const btn of document.querySelectorAll('button, a')) {
        const t = (btn.innerText || '').toLowerCase().trim();
        if (t === 'acepto' || t === 'accept' || t === 'aceptar') { btn.click(); return; }
      }
    });
  } catch { /* sin banner */ }
}

(async () => {
  const ctx = await iniciarContexto();
  const page = ctx.pages()[0] || await ctx.newPage();
  await page.goto('https://playdoit.mx/', { waitUntil: 'commit', timeout: 60_000 }).catch(() => {});
  await page.waitForTimeout(1500);
  await cerrarBannerCookies(page);
  console.log('Inicia sesión en la ventana.');
  console.log('Cuando termines, vuelve AQUÍ (esta terminal) y presiona Enter — no cierres la');
  console.log('ventana de Chrome a mano: si Chrome no se cierra del todo (queda en segundo');
  console.log('plano), la próxima corrida reutiliza esa instancia vieja y el login no se guarda.');
  await new Promise((res) => process.stdin.once('data', res));
  // La cookie de login es de sesión y Chrome la descarta al cerrarse: se guarda aparte para que
  // las corridas siguientes la restauren (ver guardarSesion en dryRunBetslip.js).
  const n = await guardarSesion();
  console.log(`Sesión guardada (${n} cookies) en el perfil. Las siguientes corridas la restauran solas.`);
  await cerrarContexto();   // ctx.close() de verdad, no solo esperar a que el usuario cierre la ventana
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
