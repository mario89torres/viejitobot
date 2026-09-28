// scripts/probar-freno.js
// Comprueba, en Chrome real, que el freno de red de dryRunBetslip ABORTA las escrituras a
// endpoints de apuesta. No toca Playdoit: las peticiones de prueba van a un host inexistente
// (.invalid), así que aunque el freno fallara no llegarían a ningún servidor de apuestas.
//
// Como abortar y fallar el DNS dan el mismo "Failed to fetch", la prueba NO se fía del
// resultado del fetch: cuenta las peticiones que el freno reporta como bloqueadas.
//
// Uso: node scripts/probar-freno.js
'use strict';

require('dotenv').config();
const { iniciarContexto, cerrarContexto } = require('../src/dryRunBetslip');

const HOST = 'https://freno-prueba.invalid';
const CASOS = [
  { ruta: '/api/widget/placeWidget',        method: 'POST', debeBloquear: true },
  { ruta: '/api/aamsApi/Bet/PayBetImmediate', method: 'POST', debeBloquear: true },
  // PUT/DELETE no se prueban aquí: en no-cors el navegador no los envía. Los cubre tests/dry-run-helpers.test.js.
  { ruta: '/api/WidgetBetOperations/cancelBet', method: 'POST', debeBloquear: true },
  { ruta: '/api/widget/placeWidget',        method: 'GET',  debeBloquear: false },
  { ruta: '/api/widget/GetEventDetails',    method: 'POST', debeBloquear: false },
];

(async () => {
  const bloqueadas = [];
  const origError = console.error;
  console.error = (...a) => {
    const m = String(a[0] || '');
    if (m.includes('BLOQUEADA')) bloqueadas.push(m);
    origError(...a);
  };

  let fallos = 0;
  try {
    const ctx = await iniciarContexto();
    const page = ctx.pages()[0] || await ctx.newPage();
    await page.goto('https://example.com/', { waitUntil: 'domcontentloaded', timeout: 30_000 });

    for (const c of CASOS) {
      const antes = bloqueadas.length;
      await page.evaluate(
        ([url, method]) => fetch(url, { method, body: method === 'GET' ? undefined : '{}', mode: 'no-cors' })
          .then(() => 'ok', () => 'fallo'),
        [HOST + c.ruta, c.method],
      );
      const bloqueo = bloqueadas.length > antes;
      const ok = bloqueo === c.debeBloquear;
      if (!ok) fallos++;
      console.log(`${ok ? 'OK  ' : 'FALLA'} ${c.method.padEnd(4)} ${c.ruta}  bloqueada=${bloqueo}  esperado=${c.debeBloquear}`);
    }
  } finally {
    console.error = origError;
    await cerrarContexto();
  }
  console.log(fallos === 0 ? '\nFRENO OK: bloquea las escrituras de apuesta y deja pasar el resto.'
                          : `\nFRENO CON ${fallos} FALLO(S): no hacer ningún clic.`);
  process.exit(fallos === 0 ? 0 : 1);
})().catch((e) => { console.error('Error en la prueba:', e.message); process.exit(2); });
