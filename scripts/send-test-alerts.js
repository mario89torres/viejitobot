/**
 * Envía alertas de PRUEBA con la lógica nueva, para revisarlas de un vistazo.
 *
 * SOLO al chat personal (TELEGRAM_CHAT_ID). NUNCA al canal VIP: ahí hay
 * suscriptores reales y una alerta de prueba se leería como una jugada de
 * verdad. Ese id ni se lee en este script, a propósito.
 *
 * Uso: node scripts/send-test-alerts.js
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const Database = require('better-sqlite3');
const { sendTelegram, sendProfitLockAlert, sendStructuralDrawAlert, sendSniperAlert } = require('../src/telegram');
const { computeStructuralDrawSignal, recentScoreChange, readSpike } = require('../src/confidence');
const { decidedResult } = require('../src/markets');

const TOKEN = process.env.TELEGRAM_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
const CHAT = process.env.TELEGRAM_CHAT_ID;
if (!TOKEN || !CHAT) { console.error('Falta TELEGRAM_TOKEN o TELEGRAM_CHAT_ID'); process.exit(1); }

const db = new Database(path.join(__dirname, '..', 'snapshots.db'), { readonly: true });
// Un pick real para que los textos se vean con datos verosímiles.
const real = db.prepare(`
  SELECT id, event, sport, market, selection, odd_decimal
  FROM picks WHERE result IN ('win','loss') AND coalesce(source,'') <> 'global_draw'
  ORDER BY ts DESC LIMIT 1
`).get();

const base = {
  id: real.id, event: real.event, sport: real.sport,
  market: real.market, selection: real.selection,
  entry_odd: real.odd_decimal, event_id: 0,
};

(async () => {
  await sendTelegram(TOKEN, CHAT,
    '🧪 <b>MENSAJES DE PRUEBA</b>\n' +
    '<i>Enviados a mano para revisar la lógica nueva de alertas. ' +
    'No son jugadas reales. Solo a este chat: el canal VIP no recibe nada.</i>');

  // 1. La que estaba invertida.
  const dying = { ...base, current_odd: Number((real.odd_decimal * 1.44).toFixed(2)), spike_ratio: 1.44 };
  await sendSniperAlert(TOKEN, CHAT, dying);
  await sendTelegram(TOKEN, CHAT,
    '☝️ <b>1. Antes se llamaba "SNIPER VALUE"</b> y decía <i>"sobre-reacción del ' +
    'mercado — gran oportunidad de entrada"</i>, con botón para apostar.\n\n' +
    'Medido sobre 700 picks liquidados: cuanto más sube la cuota desde la entrada, ' +
    'PEOR va el pick.\n' +
    '· subida &lt;1.05 → WR <b>81.7%</b>\n' +
    '· subida ≥1.60 → WR <b>2.8%</b>\n' +
    'Sus 94 disparos históricos acertaron el <b>3.2%</b>.\n\n' +
    'La señal servía; el signo estaba mal. Ahora es un aviso y <b>sin enlace de apuesta</b>.');

  // 2. La que ahora casi nunca debe sonar.
  await sendStructuralDrawAlert(TOKEN, CHAT, {
    ...base, selection: 'Empate', score: '1-1',
    current_odd: 3.10, variance: 0.0081,
  });
  await sendTelegram(TOKEN, CHAT,
    '☝️ <b>2. Empate flatline</b> — así se ve cuando es LEGÍTIMA.\n\n' +
    'Antes disparaba mal por tres motivos, todos medidos sobre 145 disparos:\n' +
    '· se aplicaba a cualquier pick: el <b>100%</b> cayó fuera del mercado de empate\n' +
    '· admitía marcador no empatado con solo acumular muestras: el <b>76%</b>\n' +
    '· no miraba si acababa de haber gol (la línea aún no reprecia)\n\n' +
    'Con los tres guardas: <b>35 → 0 disparos</b> en el histórico. Cero es lo ' +
    'correcto — solo hay 4 picks de empate en toda la base.');

  // 3. Sin cambios, como referencia.
  await sendProfitLockAlert(TOKEN, CHAT, {
    ...base, current_odd: Number((real.odd_decimal * 0.62).toFixed(2)), locked_profit_pct: '61.3',
  });
  await sendTelegram(TOKEN, CHAT, '☝️ <b>3. Profit Lock</b> — sin cambios, va de referencia.');

  // 4. Lo que ahora se calla.
  const yaDecidido = decidedResult({ market: 'Total 2.5', selection: 'Menos de 2.5', sport: 'Fútbol', event: 'A vs. B' }, '2-1');
  const golReciente = recentScoreChange(['2-1', '1-1', '1-1'], 10);
  await sendTelegram(TOKEN, CHAT,
    '🔇 <b>4. Lo que ahora NO se envía</b>\n\n' +
    `· Pick ya decidido: "Menos de 2.5" con 2-1 → <b>${yaDecidido}</b> irreversible. ` +
    'Alertar sobre eso es ruido sobre algo terminado.\n' +
    `· Gol en las últimas 10 muestras → <b>${golReciente ? 'se calla' : 'no'}</b>. ` +
    'El mercado sigue repreciando; leer el movimiento ahí es prematuro. Eran ' +
    '<b>19 de los 94</b> disparos de spike.\n\n' +
    `Umbrales del spike: aviso desde ×${readSpike(1, 1.15).ratio}, grave desde ×${readSpike(1, 1.35).ratio}.`);

  console.log(`Enviados 7 mensajes de prueba al chat ${CHAT}. Canal VIP: NO tocado.`);
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
