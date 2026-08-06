require('dotenv').config();
const { fetchAllLive } = require('./src/fetcher');
const { normalize } = require('./src/normalize');
const { saveSnapshot } = require('./src/db');
const { topPicks } = require('./src/analyze');
const { sendTelegram, formatMessage } = require('./src/telegram');

const config = {
  intervalMin: Number(process.env.INTERVAL_MINUTES || 3),
  minOdds: Number(process.env.MIN_ODDS || 1.05),
  maxOdds: Number(process.env.MAX_ODDS || 100),
  excludeSports: (process.env.EXCLUDE_SPORTS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
  topN: Number(process.env.TOP_N || 10),
  telegramToken: process.env.TELEGRAM_BOT_TOKEN,
  telegramChatId: process.env.TELEGRAM_CHAT_ID,
};

async function runCycle() {
  const start = Date.now();
  console.log(`\n[${new Date().toISOString()}] Iniciando ciclo...`);

  const sportResults = await fetchAllLive();
  const rows = normalize(sportResults);
  console.log(`  Deportes: ${sportResults.length}, jugadas extraídas: ${rows.length}`);

  if (!rows.length) {
    console.log('  Sin datos en vivo, se omite este ciclo.');
    return;
  }

  saveSnapshot(rows);
  const picks = topPicks(rows, config);

  console.log('  Top picks:');
  picks.forEach((p, i) =>
    console.log(`   ${i + 1}. [${p.oddDecimal.toFixed(2)} / ${p.oddAmerican}] ${p.event} | ${p.market}: ${p.selection}`));

  if (config.telegramToken && config.telegramChatId && picks.length) {
    await sendTelegram(config.telegramToken, config.telegramChatId, formatMessage(picks));
    console.log('  Enviado a Telegram.');
  } else if (!config.telegramToken) {
    console.log('  [aviso] TELEGRAM_BOT_TOKEN no configurado, sin notificación.');
  }

  console.log(`  Ciclo completado en ${((Date.now() - start) / 1000).toFixed(1)}s`);
}

async function main() {
  const once = process.argv.includes('--once');
  console.log(`Playdoit Monitor — intervalo: ${config.intervalMin} min, top ${config.topN}, momios [${config.minOdds}, ${config.maxOdds}]`);

  while (true) {
    try {
      await runCycle();
    } catch (e) {
      console.error(`  [error] ${e.message}`);
    }
    if (once) break;
    await new Promise(r => setTimeout(r, config.intervalMin * 60 * 1000));
  }
}

main();
