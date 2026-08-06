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

async function sendPhotoTelegram(token, chatId, photoUrl, caption) {
  const payload = { chat_id: chatId, photo: photoUrl, caption, parse_mode: 'HTML' };
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.description);
  } catch (e) {
    // Fallback a mensaje HTML simple sin foto si QuickChart falla
    await sendTelegram(token, chatId, caption);
  }
}

async function sendPickInspectorCard(token, chatId, pickId) {
  const { db } = require('./db');
  const pick = db.prepare(`SELECT * FROM picks WHERE id = ?`).get(pickId);

  if (!pick) {
    await sendTelegram(token, chatId, `⚠️ <b>Pick #${pickId} no encontrado</b> en la base de datos.`);
    return;
  }

  // Obtener snapshots de este pick
  const snapshots = db.prepare(`
    SELECT odd_decimal, score, live_time, ts, suspended
    FROM snapshots
    WHERE event_id = ? AND market = ? AND selection = ?
    ORDER BY ts ASC
  `).all(pick.event_id, pick.market, pick.selection);

  const activeSnaps = snapshots.filter(s => !s.suspended && s.odd_decimal > 0);
  const activeOdds = activeSnaps.map(s => s.odd_decimal);
  const minOdd = activeOdds.length > 0 ? Math.min(...activeOdds) : pick.odd_decimal;
  const maxOdd = activeOdds.length > 0 ? Math.max(...activeOdds) : pick.odd_decimal;
  const lastOdd = activeOdds.length > 0 ? activeOdds.at(-1) : pick.odd_decimal;
  const initialOdd = pick.odd_decimal;

  const mfePeakRoi = (initialOdd && minOdd && minOdd < initialOdd)
    ? ((initialOdd - minOdd) / minOdd * 100).toFixed(1)
    : '0.0';

  const link = await generateBetLink(pick);

  let statusEmoji = '🟡 PENDIENTE';
  if (pick.result === 'win') statusEmoji = '🟢 GANADO';
  else if (pick.result === 'loss') statusEmoji = '🔴 PERDIDO';
  else if (pick.result === 'push') statusEmoji = '⚪ NULO';

  // Formato HTML Ficha Inspector
  let caption = `🔍 <b>FICHA DE INSPECCIÓN · PICK #${pick.id}</b>\n` +
    `<i>${new Date().toLocaleString('es-MX', { timeZone: 'America/Mexico_City' })}</i>\n\n` +
    `⚽ <b>${esc(pick.event)}</b> <i>(${esc(pick.sport)})</i>\n` +
    `📌 Mercado: ${esc(pick.market)}\n` +
    `📌 Selección: <b>${esc(pick.selection)}</b>\n\n` +
    `📊 <b>DESGLOSE CUANTITATIVO:</b>\n` +
    `• Cuota Entrada: <b>@ ${initialOdd ? initialOdd.toFixed(3) : '—'}</b>\n` +
    `• Cuota Mínima (MFE): <b>@ ${minOdd ? minOdd.toFixed(3) : '—'}</b> (+${mfePeakRoi}% Max ROI)\n` +
    `• Cuota Máxima Snap: <b>@ ${maxOdd ? maxOdd.toFixed(3) : '—'}</b>\n` +
    `• Última Cuota Snap: <b>@ ${lastOdd ? lastOdd.toFixed(3) : '—'}</b>\n` +
    `• Confianza Total: <b>${(pick.conf * 100).toFixed(1)}%</b>\n` +
    `• Stake Asignado: <b>${pick.stake ? pick.stake.toFixed(1) + 'u' : '1.0u'}</b>\n` +
    `• Estado Actual: <b>${statusEmoji}</b>\n\n`;

  if (parseFloat(mfePeakRoi) >= 15 && pick.result !== 'win') {
    caption += `⚡ <b>CASHOUT / PROFIT LOCK:</b> Pico máximo de ganancia +${mfePeakRoi}% ROI alcanzado en cuota @${minOdd.toFixed(2)}.\n\n`;
  }

  caption += `👉 <a href="${link}">Ver / Apostar en Playdoit</a>\n` +
    `👉 <a href="https://playdoit-monitor-bot.web.app">Abrir Dashboard Web</a>`;

  // Generar URL de gráfica neon QuickChart (si hay snapshots)
  if (activeSnaps.length >= 2) {
    const labels = activeSnaps.slice(-30).map((s, i) => s.live_time ? `${s.live_time}` : `${i+1}`);
    const data = activeSnaps.slice(-30).map(s => s.odd_decimal);

    const chartConfig = {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: 'Cuota Snapshots',
            data,
            borderColor: '#98c379',
            backgroundColor: 'rgba(152, 195, 121, 0.15)',
            fill: true,
            pointRadius: 3,
            borderWidth: 2,
          },
          {
            label: 'Entry Odd Baseline',
            data: Array(labels.length).fill(initialOdd),
            borderColor: '#e5c07b',
            borderDash: [4, 4],
            pointRadius: 0,
            borderWidth: 1.5,
          }
        ]
      },
      options: {
        title: { display: true, text: `PICK #${pick.id} — ${pick.event}`, fontColor: '#d4d4d4', fontSize: 14 },
        legend: { labels: { fontColor: '#abb2bf' } },
        scales: {
          xAxes: [{ ticks: { fontColor: '#5c6370' }, gridLines: { color: '#282c34' } }],
          yAxes: [{ ticks: { fontColor: '#abb2bf' }, gridLines: { color: '#282c34' } }]
        }
      }
    };

    const chartUrl = `https://quickchart.io/chart?bkg=181a1f&w=700&h=400&c=${encodeURIComponent(JSON.stringify(chartConfig))}`;
    await sendPhotoTelegram(token, chatId, chartUrl, caption);
  } else {
    await sendTelegram(token, chatId, caption);
  }
}

let lastUpdateId = 0;
function startTelegramBotListener(token) {
  if (!token) return;
  setInterval(async () => {
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/getUpdates?offset=${lastUpdateId + 1}&timeout=5`);
      if (!res.ok) return;
      const data = await res.json();
      if (!data.ok || !data.result) return;

      for (const update of data.result) {
        lastUpdateId = update.update_id;
        const msg = update.message || update.channel_post;
        if (!msg || !msg.text) continue;

        const text = msg.text.trim();
        const chatId = msg.chat.id;

        // Comandos soportados: /pick 2008, /ticket 2008, #2008, o 2008
        const match = text.match(/^(?:\/pick|\/ticket|#)?\s*(\d+)$/i);
        if (match) {
          const pickId = parseInt(match[1], 10);
          console.log(`[telegram] 🔍 Consulta de ticket #${pickId} recibida de chat ${chatId}`);
          await sendPickInspectorCard(token, chatId, pickId);
        }
      }
    } catch (e) {
      // Ignorar errores temporales de polling
    }
  }, 4000); // Polling cada 4 segundos
}

module.exports = {
  sendTelegram,
  sendPhotoTelegram,
  formatMessage,
  sendProfitLockAlert,
  sendStructuralDrawAlert,
  sendSniperAlert,
  sendPickInspectorCard,
  startTelegramBotListener,
};
