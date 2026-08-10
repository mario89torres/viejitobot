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

  // OJO con el texto: esta alerta decía "Sobre-reacción del mercado — Gran
  // Oportunidad de Entrada" e incluía enlace para apostar. Medido el 2026-08-09
  // sobre 700 picks liquidados, era justo al revés: cuanto más sube la cuota
  // desde la entrada, PEOR va el pick (spike <1.05 -> WR 81.7%; >=1.60 -> 2.8%),
  // y sus 94 disparos históricos acertaron el 3.2%. El mercado no sobre-reacciona
  // al subir la cuota: reprecia porque la posición va perdiendo.
  // Así que ahora es un AVISO y NO lleva enlace de apuesta — invitar a entrar
  // en algo que gana el 4% de las veces era el peor efecto del bug.
  const pctPeor = p.spike_ratio ? ` (+${Math.round((p.spike_ratio - 1) * 100)}%)` : '';
  const msg = `⚠️ <b>POSICIÓN DETERIORADA</b>\n` +
    `<i>${new Date().toLocaleString('es-MX', { timeZone: 'America/Mexico_City' })}</i>\n\n` +
    `<b>Pick #${p.id}</b> — ${eventName} <i>(${sport})</i>\n` +
    `Mercado: ${market} · <b>${selection}</b>\n\n` +
    `📉 El momio subió a <b>@ ${currentOdd}</b> desde @ ${entryOdd}${pctPeor}\n` +
    `El mercado está repreciando EN CONTRA de esta posición. Históricamente, ` +
    `los picks en esta situación ganan menos del 5%.\n\n` +
    `<i>Aviso informativo: no es una sugerencia de entrada.</i>\n` +
    `<a href="${link}">Ver el evento</a>`;

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
    else if (p.alert === 'POSITION_DYING') alertBadge = ` ⚠️ <b>[POSICIÓN DETERIORADA]</b>`;
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

/**
 * Envía la gráfica de rendimiento del día (o cualquier fecha) hasta el
 * momento: P/L acumulado por pick, más un resumen textual. Reutiliza
 * stakePicksByDate (src/metrics.js), la misma agregación que ya usa
 * /unidades, en vez de recalcular nada: dos caminos calculando lo mismo por
 * separado es como se filtran los desacuerdos silenciosos entre comandos.
 *
 * Igual que sendPickInspectorCard: gráfica vía QuickChart (sin dependencias
 * nuevas, mismo servicio que ya se usa para la ficha de pick) con fallback a
 * texto plano si el servicio no responde.
 */
async function sendDailyPerformanceChart(token, chatId, dateStr) {
  const { stakePicksByDate } = require('./metrics');
  const s = stakePicksByDate(dateStr);
  const label = !dateStr || dateStr === 'hoy' ? 'HOY' : dateStr === 'ayer' ? 'AYER' : dateStr;

  if (!s.n) {
    await sendTelegram(token, chatId, `📊 <b>Rendimiento — ${esc(label)}</b>\n\nSin picks liquidados en esa fecha todavía.`);
    return;
  }

  // Acumulado corrido pick a pick (no por hora): con volumen bajo un día
  // agrupar por hora aplana la curva a un escalón; pick a pick se ve el
  // vaivén real de la sesión, que es lo que se quiere revisar "hasta el momento".
  //
  // El acumulado se calcula sobre TODOS los picks del día (el nivel final debe
  // ser exacto), pero solo se grafican los últimos MAX_POINTS. En un día activo
  // hay cientos de picks (se han visto 372 en una sola hora) y meterlos todos en
  // la URL de QuickChart la dispara a varios miles de caracteres — con 400
  // picks, solo las etiquetas ya pesan 7.6KB. Recortar es el mismo patrón que
  // sendPickInspectorCard usa para su historial de cuotas (.slice(-30)).
  const MAX_POINTS = 80;
  let acum = 0;
  const allLabels = [];
  const allSerie = [];
  for (const p of s.picks) {
    acum += p.profit;
    const hora = new Date(p.ts).toLocaleTimeString('es-MX', { timeZone: 'America/Mexico_City', hour: '2-digit', minute: '2-digit', hour12: false });
    allLabels.push(`#${p.id} ${hora}`);
    allSerie.push(Number(acum.toFixed(2)));
  }
  const truncated = allLabels.length > MAX_POINTS;
  const labels = truncated ? allLabels.slice(-MAX_POINTS) : allLabels;
  const serie = truncated ? allSerie.slice(-MAX_POINTS) : allSerie;

  const positivo = acum >= 0;
  const lineColor = positivo ? '#5a9a5e' : '#c15750';
  const fillColor = positivo ? 'rgba(90,154,94,0.15)' : 'rgba(193,87,80,0.15)';

  const chartConfig = {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: 'P/L acumulado (u)',
        data: serie,
        borderColor: lineColor,
        backgroundColor: fillColor,
        fill: true,
        pointRadius: labels.length <= 20 ? 3 : 0,
        borderWidth: 2,
      }],
    },
    options: {
      title: { display: true, text: `RENDIMIENTO — ${label} (${s.n} picks)`, fontColor: '#d4d4d4', fontSize: 14 },
      legend: { display: false },
      scales: {
        xAxes: [{ ticks: { fontColor: '#5c6370', autoSkip: true, maxTicksLimit: 12 }, gridLines: { color: '#282c34' } }],
        yAxes: [{ ticks: { fontColor: '#abb2bf' }, gridLines: { color: '#282c34' } }],
      },
    },
  };
  const chartUrl = `https://quickchart.io/chart?bkg=181a1f&w=800&h=420&c=${encodeURIComponent(JSON.stringify(chartConfig))}`;

  // stakePicksByDate solo cubre LIQUIDADOS (win/loss): no hay pendientes que
  // reportar aquí, a diferencia de stakeStats. Si se quiere ver qué sigue en
  // juego, ese es justo el trabajo de /unidades.
  const roiTxt = s.roi != null ? `${s.roi >= 0 ? '+' : ''}${s.roi.toFixed(1)}%` : '—';
  const caption = `📊 <b>RENDIMIENTO — ${esc(label)}</b>\n\n` +
    `• Picks liquidados: <b>${s.n}</b> (${s.wins}✅ / ${s.n - s.wins}❌ — ${s.wr.toFixed(0)}% acierto)\n` +
    `• Apostado: <b>${s.staked.toFixed(2)}u</b>\n` +
    `• P/L: <b>${acum >= 0 ? '+' : ''}${acum.toFixed(2)}u</b> (ROI ${roiTxt})\n\n` +
    (truncated ? `<i>Gráfica: últimos ${MAX_POINTS} de ${allLabels.length} picks (el P/L total ya incluye todos).</i>\n` : '') +
    `<i>Pide /pick #id de cualquier punto de la curva para ver su ficha completa.</i>`;

  await sendPhotoTelegram(token, chatId, chartUrl, caption);
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
  sendDailyPerformanceChart,
  startTelegramBotListener,
};
