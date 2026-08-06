const { generateBetLink } = require('./betlink');

async function sendTelegram(token, chatId, text, replyMarkup = null) {
  const payload = { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true };
  if (replyMarkup) payload.reply_markup = replyMarkup;
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Telegram: ${data.description}`);
}

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function formatMessage(picks) {
  const now = new Date().toLocaleString('es-MX', { timeZone: 'America/Mexico_City' });
  let msg = `<b>🎯 Top ${picks.length} — Playdoit en vivo</b>\n<i>${now}</i>\n\n`;

  for (let i = 0; i < picks.length; i++) {
    const p = picks[i];
    const link = await generateBetLink(p);
    const oddDec = p.oddDecimal != null ? p.oddDecimal.toFixed(2) : (p.odd_decimal ? p.odd_decimal.toFixed(2) : '—');
    const oddAmer = p.oddAmerican || '';

    msg += `<b>${i + 1}.</b> ${esc(p.event)} <i>(${esc(p.sport)})</i>\n`;
    if (p.score) msg += `   Marcador: ${esc(p.score)}${p.liveTime ? ` — ${esc(p.liveTime)}` : ''}\n`;
    msg += `   ${esc(p.market)}: <b>${esc(p.selection)}</b>\n`;
    msg += `   Momio: <b>${oddDec}</b> ${oddAmer ? `(${oddAmer})` : ''}\n`;
    msg += `   👉 <a href="${link}">Apostar en Playdoit</a>\n\n`;
  }

  return msg;
}

module.exports = { sendTelegram, formatMessage };
