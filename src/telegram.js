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

async function verifyPreShotExpress(pick) {
  const BASE = 'https://sb2frontend-altenar2.biahosted.com/api/widget';
  const COMMON = 'culture=es-ES&timezoneOffset=360&integration=playdoit2&deviceType=1&numFormat=en-GB&countryCode=MX';
  const sportId = pick.sport_id || pick.sportId || 66;
  const eventId = pick.event_id || pick.eventId;
  if (!eventId) return true;

  try {
    const res = await fetch(`${BASE}/GetLiveOverview?${COMMON}&sportId=${sportId}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'Referer': 'https://www.playdoit.mx/',
        'Accept': 'application/json'
      },
      signal: AbortSignal.timeout(1500)
    });
    if (!res.ok) return true;
    const data = await res.json();
    const ev = (data.events || []).find((e) => e.id === eventId);
    if (!ev) return false; // Evento ya no existe o finalizó
    if (ev.isBooked === false || ev.status !== 1) return false; // Evento suspendido
    return true;
  } catch (e) {
    return true; // En caso de timeout de red, permitir envío
  }
}

async function formatMessage(picks) {
  const now = new Date().toLocaleString('es-MX', { timeZone: 'America/Mexico_City' });

  // Guardia 3 Express: Re-check síncrono pre-disparo
  const verifiedPicks = [];
  for (const p of picks) {
    const isStillActive = await verifyPreShotExpress(p);
    if (isStillActive) verifiedPicks.push(p);
    else console.warn(`[telegram] 🛡️ Guardia 3 Pre-Shot: Pick #${p.id || p.eventId} cancelado en vuelo por suspensión express`);
  }

  if (!verifiedPicks.length) return null;

  let msg = `<b>🎯 Top ${verifiedPicks.length} — Playdoit en vivo</b>\n<i>${now}</i>\n\n`;

  for (let i = 0; i < verifiedPicks.length; i++) {
    const p = verifiedPicks[i];
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
