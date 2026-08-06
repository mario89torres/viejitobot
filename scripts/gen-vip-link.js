require('dotenv').config();
const { addSubscriber } = require('../src/db');
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const VIP = process.env.TELEGRAM_VIP_CHANNEL_ID;

async function run() {
  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/createChatInviteLink`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: VIP,
      member_limit: 1,
      expire_date: Math.floor(Date.now() / 1000) + 86400,
      name: 'Pase Gratuito VIP (30 Días)'
    })
  });
  const data = await res.json();
  if (data.ok) {
    const link = data.result.invite_link;
    addSubscriber(5307381466, 'altidor8', 'Ghost', 30, link);
    console.log('SUCCESS_LINK:', link);
  } else {
    console.error('ERROR_TELEGRAM:', data);
  }
}
run();
