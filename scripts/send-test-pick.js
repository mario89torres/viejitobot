require('dotenv').config();
const { sendTelegram } = require('../src/telegram');

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const VIP_ID = process.env.TELEGRAM_VIP_CHANNEL_ID;

async function run() {
  const msg = `<b>🤖 Pick automático (Simulación de Prueba)</b>\n\n` +
    `🔥 <b>Real Madrid vs. FC Barcelona</b> <i>(Fútbol)</i>\n` +
    `Marcador: 1-1 — 74' (2ª parte)\n` +
    `Total de goles: 🎯 <b><u>Menos de 3.5</u></b> @ <b>1.85</b> (-118)\n` +
    `Confianza: <b>78%</b> | Edge: <b>+8.4%</b> | Unidad: <b>1.2u</b>\n` +
    `Línea: 📉 línea bajando (a favor) 4%\n` +
    `<i>🔥 el modelo aprendido le da 82% — su tercil alto rindió +30% histórico</i>`;

  console.log('Enviando pick simulado a Chat Personal:', CHAT_ID);
  await sendTelegram(TOKEN, CHAT_ID, msg);

  if (VIP_ID) {
    console.log('Enviando pick simulado a Canal VIP:', VIP_ID);
    await sendTelegram(TOKEN, VIP_ID, msg);
  }
  console.log('Pick simulado enviado exitosamente.');
}

run().catch(e => console.error('Error enviando prueba:', e.message));
