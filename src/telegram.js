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

async function sendProfitLockAlert(token, chatId, p) {
  const link = await generateBetLink(p);
  const eventName = esc(p.event || p.event_name);
  const sport = esc(p.sport || 'Fútbol');
  const market = esc(p.market);
  const selection = esc(p.selection);
  const entryOdd = p.entry_odd != null ? p.entry_odd.toFixed(2) : (p.odd_decimal ? p.odd_decimal.toFixed(2) : '—');
  const currentOdd = p.current_odd != null ? p.current_odd.toFixed(2) : '—';
  const profitPct = p.locked_profit_pct || p.mfePeakRoi || '30.0';

  const msg = `⚡ <b>ALERTA CASHOUT / PROFIT LOCK</b>\n` +
    `<i>${new Date().toLocaleString('es-MX', { timeZone: 'America/Mexico_City' })}</i>\n\n` +
    `<b>Pick #${p.id}</b> — ${eventName} <i>(${sport})</i>\n` +
    `Mercado: ${market} · <b>${selection}</b>\n\n` +
    `💰 <b>Ganancia Neta Asegurable: +${profitPct}%</b>\n` +
    `📉 Cuota Entrada: <b>@ ${entryOdd}</b> ➔ Cuota Actual: <b>@ ${currentOdd}</b>\n\n` +
    `👉 <a href="${link}">Ejecutar Cashout en Playdoit</a>`;

  await sendTelegram(token, chatId, msg);
}

async function sendStructuralDrawAlert(token, chatId, p) {
  const link = await generateBetLink(p);
  const eventName = esc(p.event || p.event_name);
  const sport = esc(p.sport || 'Fútbol');
  const score = esc(p.score || '0-0');
  const currentOdd = p.current_odd != null ? p.current_odd.toFixed(2) : (p.odd_decimal ? p.odd_decimal.toFixed(2) : '—');
  const varStr = p.variance != null ? p.variance.toFixed(4) : '0.008';

  const msg = `🎯 <b>ALERTA DE EMPATE ESTRUCTURAL (FLATLINE)</b>\n` +
    `<i>${new Date().toLocaleString('es-MX', { timeZone: 'America/Mexico_City' })} · Scanner Min 75+</i>\n\n` +
    `⚽ <b>${eventName}</b> <i>(${sport})</i>\n` +
    `📊 Marcador en Vivo: <b>${score}</b>\n` +
    `⚖️ Estado de Cuota: <b>Meseta Plana Estabilizada (σ = ${varStr})</b>\n` +
    `📊 Cuota Actual: <b>@ ${currentOdd}</b>\n\n` +
    `💎 <b>Pronóstico Cuantitativo: EMPATE / UNDER TÁCTICO</b>\n` +
    `📈 <i>El mercado ha entrado en equilibrio absoluto. Alta probabilidad implícita de retener el resultado hasta el final.</i>\n\n` +
    `👉 <a href="${link}">Apostar en Playdoit</a>`;

  await sendTelegram(token, chatId, msg);
}

async function sendSniperAlert(token, chatId, p) {
  const link = await generateBetLink(p);
  const eventName = esc(p.event || p.event_name);
  const sport = esc(p.sport || 'Fútbol');
  const market = esc(p.market);
  const selection = esc(p.selection);
  const entryOdd = p.entry_odd != null ? p.entry_odd.toFixed(2) : '—';
  const currentOdd = p.current_odd != null ? p.current_odd.toFixed(2) : '—';

  const msg = `🎯 <b>ALERTA SNIPER VALUE (SOBRE-REACCIÓN)</b>\n` +
    `<i>${new Date().toLocaleString('es-MX', { timeZone: 'America/Mexico_City' })}</i>\n\n` +
    `<b>Pick #${p.id}</b> — ${eventName} <i>(${sport})</i>\n` +
    `Mercado: ${market} · <b>${selection}</b>\n\n` +
    `🚀 Momio Inflado: <b>@ ${currentOdd}</b> (vs Entrada original @ ${entryOdd})\n` +
    `🔥 Sobre-reacción del mercado por evento rival — Gran Oportunidad de Entrada\n\n` +
    `👉 <a href="${link}">Apostar en Playdoit</a>`;

  await sendTelegram(token, chatId, msg);
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

    let alertBadge = '';
    if (p.alert === 'PROFIT_LOCK') alertBadge = ` ⚡ <b>[LOCK +${p.locked_profit_pct || 30}%]</b>`;
    else if (p.alert === 'SNIPER_VALUE') alertBadge = ` 🎯 <b>[SNIPER VALUE]</b>`;
    else if (p.alert === 'STRUCTURAL_DRAW') alertBadge = ` 🎯 <b>[EMPATE FLATLINE]</b>`;

    msg += `<b>${i + 1}.</b> ${esc(p.event)} <i>(${esc(p.sport)})</i>${alertBadge}\n`;
    if (p.score) msg += `   Marcador: ${esc(p.score)}${p.liveTime ? ` — ${esc(p.liveTime)}` : ''}\n`;
    msg += `   ${esc(p.market)}: <b>${esc(p.selection)}</b>\n`;
    msg += `   Momio: <b>${oddDec}</b> ${oddAmer ? `(${oddAmer})` : ''}\n`;
    msg += `   👉 <a href="${link}">Apostar en Playdoit</a>\n\n`;
  }

  return msg;
}

module.exports = {
  sendTelegram,
  formatMessage,
  sendProfitLockAlert,
  sendStructuralDrawAlert,
  sendSniperAlert,
};
