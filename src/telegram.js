const { generateBetLink } = require('./betlink');

// Telegram rechaza cualquier mensaje de mas de 4096 caracteres con
// "Bad Request: message is too long". Paso el 2026-08-28 con el boton
// Pendientes, que lista hasta 30 picks de varias lineas cada uno.
//
// Se parte AQUI y no en cada handler a proposito: cualquier comando puede
// crecer (mas picks pendientes, mas dias en /unidades) y arreglarlo caso por
// caso deja el siguiente sin cubrir.
//
// Se corta por SALTO DE LINEA, nunca a mitad: con parse_mode HTML, partir
// dentro de una etiqueta la rompe y Telegram rechaza el mensaje entero.
const TG_MAX = 4000;   // margen sobre los 4096 reales

function trocear(text) {
  if (text.length <= TG_MAX) return [text];
  const partes = [];
  let actual = '';
  for (const linea of String(text).split('\n')) {
    // Una sola linea mas larga que el tope: se corta en duro, no hay
    // alternativa, pero no puede colgar el bucle.
    if (linea.length > TG_MAX) {
      if (actual) { partes.push(actual); actual = ''; }
      for (let i = 0; i < linea.length; i += TG_MAX) partes.push(linea.slice(i, i + TG_MAX));
      continue;
    }
    if (actual.length + linea.length + 1 > TG_MAX) { partes.push(actual); actual = linea; }
    else actual = actual ? actual + '\n' + linea : linea;
  }
  if (actual) partes.push(actual);
  return partes;
}

async function sendTelegram(token, chatId, text, replyMarkup = null) {
  const partes = trocear(text);
  // La botonera solo va en la ULTIMA parte: repetirla en cada trozo la
  // duplicaria en el chat.
  for (let i = 0; i < partes.length; i++) {
    await enviarUno(token, chatId, partes[i], i === partes.length - 1 ? replyMarkup : null);
  }
}

async function enviarUno(token, chatId, text, replyMarkup) {
  const payload = { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true };
  if (replyMarkup) payload.reply_markup = replyMarkup;
  // El timeout NO es opcional: un fetch sin AbortSignal en Node se queda colgado
  // para siempre si la conexión se establece y no responde. sendTelegram se
  // llama DENTRO del ciclo del sampler, que tiene un guard `sampling` de una
  // sola instancia — así que un cuelgue aquí deja el guard en true y el bot
  // deja de muestrear PARA SIEMPRE sin lanzar un error ni morirse. Es lo que
  // pasó el 2026-08-19 a las 17:38: 4h de silencio con el proceso vivo.
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Telegram: ${data.description}`);
}

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// EL ENLACE VA ESCAPADO. Un & crudo dentro de un href es HTML invalido y
// parse_mode=HTML de Telegram lo rechaza: hay que mandar &lt; &gt; &amp;.
//
// No es teorico: el 2026-09-04 el deep link paso de
//   https://www.playdoit.mx/#/sport/66/event/123        (sin ningun &)
// a
//   https://www.playdoit.mx/#page=event&eventId=123&sportId=66   (dos &)
// y los cinco sitios que lo incrustaban lo hacian en crudo. Con el formato
// viejo nunca importo; con el nuevo, Telegram rechaza el mensaje ENTERO y el
// pick no llega — no es que llegue sin enlace.
//
// Existe como funcion, y no como esc(link) repetido en cada sitio, para que
// quien aniada el sexto enlace no tenga que acordarse.
function enlaceHtml(url, texto) {
  return `<a href="${esc(url)}">${esc(texto)}</a>`;
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
  const link = generateBetLink(p);
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
    `👉 ${enlaceHtml(link, 'Ejecutar Cashout en Playdoit')}`;

  await sendTelegram(token, chatId, msg);
}

async function sendStructuralDrawAlert(token, chatId, p) {
  const link = generateBetLink(p);
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
    `👉 ${enlaceHtml(link, 'Apostar en Playdoit')}`;

  await sendTelegram(token, chatId, msg);
}

async function sendSniperAlert(token, chatId, p) {
  const link = generateBetLink(p);
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
    `${enlaceHtml(link, 'Ver el evento')}`;

  await sendTelegram(token, chatId, msg);
}

// Drift genérico de línea: la señal de respaldo cuando NADA de lo prioritario
// (Profit Lock, Posición Deteriorada, Empate Estructural) disparó pero el
// momio ya subió de forma considerable (>=15%, ver dashboardApi.ts) — un
// cambio real de estado del pick, no ruido normal del mercado. Solo dispara
// en esta dirección (momio subiendo, posición deteriorándose): una CAÍDA de
// momio es buena noticia y ya la cubre Profit Lock con su propio umbral. No
// se enviaba nada hasta el 2026-09-12 (`if (!sender) continue` la
// descartaba en silencio); a diferencia de Profit Lock/Posición Deteriorada,
// aquí no hay evidencia histórica de qué tan grave es — el mensaje es
// informativo, sin sugerir acción.
async function sendLineDriftAlert(token, chatId, p) {
  const link = generateBetLink(p);
  const eventName = esc(p.event || p.event_name);
  const sport = esc(p.sport || 'Fútbol');
  const market = esc(p.market);
  const selection = esc(p.selection);
  const entryOdd = p.entry_odd != null ? p.entry_odd.toFixed(2) : '—';
  const currentOdd = p.current_odd != null ? p.current_odd.toFixed(2) : '—';
  const clv = p.live_clv != null ? Math.abs(p.live_clv).toFixed(1) : '—';

  const msg = `📈 <b>Movimiento de línea</b>\n` +
    `<i>${new Date().toLocaleString('es-MX', { timeZone: 'America/Mexico_City' })}</i>\n\n` +
    `<b>Pick #${p.id}</b> — ${eventName} <i>(${sport})</i>\n` +
    `Mercado: ${market} · <b>${selection}</b>\n\n` +
    `Cuota entrada <b>@ ${entryOdd}</b> ➔ actual <b>@ ${currentOdd}</b> ` +
    `(subió ${clv}%)\n\n` +
    `<i>Aviso informativo: el mercado se movió, no es una recomendación.</i>\n` +
    `${enlaceHtml(link, 'Ver el evento')}`;

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
    const link = generateBetLink(p);
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
    msg += `   👉 ${enlaceHtml(link, 'Apostar en Playdoit')}\n\n`;
  }

  return msg;
}

async function sendPhotoTelegram(token, chatId, photoUrl, caption) {
  const payload = { chat_id: chatId, photo: photoUrl, caption, parse_mode: 'HTML' };
  try {
    // El timeout NO es opcional (ver sendTelegram arriba). Sin el, un cuelgue
    // de red aqui congelaba el bucle de escucha del bot ENTERO durante horas:
    // /deportes y otros que mandan un grafico se atascaban en este fetch y el
    // poll atiende los mensajes en serie (2026-09-19: 1.5 h sin responder
    // ningun comando). 30s y no 15: Telegram tiene que ir a bajar el grafico
    // de QuickChart antes de contestar. Si vence, cae al mensaje de texto.
    const res = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30000),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.description);
  } catch (e) {
    // Fallback a mensaje HTML simple sin foto si QuickChart falla
    await sendTelegram(token, chatId, caption);
  }
}

// Envia una foto desde un ARCHIVO LOCAL o un Buffer ya en memoria (no una
// URL) — multipart/form-data, necesario porque sendPhotoTelegram solo acepta
// `photo` como URL publica (QuickChart). Usa el FormData/Blob globales de
// Node (18+), sin libreria nueva. Pensada para imagenes generadas
// localmente: un archivo (ver scripts/render-estado-sistema.py y
// scripts/render-picks-table.py) o un Buffer directo cuando no tiene
// sentido volcarlo a disco solo para volver a leerlo.
async function sendPhotoFile(token, chatId, fileOrBuffer, caption, replyMarkup = null) {
  const buffer = Buffer.isBuffer(fileOrBuffer) ? fileOrBuffer : require('fs').readFileSync(fileOrBuffer);
  const form = new FormData();
  form.append('chat_id', String(chatId));
  if (caption) { form.append('caption', caption); form.append('parse_mode', 'HTML'); }
  if (replyMarkup) form.append('reply_markup', JSON.stringify(replyMarkup));
  form.append('photo', new Blob([buffer], { type: 'image/png' }), 'imagen.png');
  const res = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
    method: 'POST', body: form, signal: AbortSignal.timeout(20000),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Telegram sendPhoto (archivo): ${data.description}`);
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

  const link = generateBetLink(pick);

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

  caption += `👉 ${enlaceHtml(link, 'Ver / Apostar en Playdoit')}\n` +
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

// Curva de banca acumulada + P/L diario para /unidades. Antes esto era una
// tabla <pre> dia-por-dia en texto: sirve para leer un numero puntual pero no
// para ver la TENDENCIA de un vistazo (¿la banca sube en general o el ultimo
// tramo es una racha dentro de una caida?). Mismo patron que
// sendDailyPerformanceChart (QuickChart, sin libreria de graficas propia):
// barras de P/L del dia en un eje, linea de banca acumulada en el otro,
// porque son la misma serie vista dos formas (el detalle diario y el
// acumulado) y superponerlas ahorra un segundo mensaje.
async function sendUnitsBankChart(token, chatId, byDay, caption) {
  const MAX_POINTS = 30;
  const dias = byDay.length > MAX_POINTS ? byDay.slice(-MAX_POINTS) : byDay;
  const labels = dias.map(d => d.dia.slice(5));
  const banca = dias.map(d => Number(d.acumulado.toFixed(2)));
  const diario = dias.map(d => Number(d.profit.toFixed(2)));
  const finalPositivo = banca.length ? banca[banca.length - 1] >= 0 : true;
  const lineColor = finalPositivo ? '#5a9a5e' : '#c15750';

  const chartConfig = {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          type: 'line', label: 'Banca acumulada (u)', data: banca,
          borderColor: lineColor, backgroundColor: 'rgba(0,0,0,0)', fill: false,
          yAxisID: 'banca', borderWidth: 2, pointRadius: labels.length <= 20 ? 3 : 0,
        },
        {
          type: 'bar', label: 'P/L del día (u)', data: diario,
          backgroundColor: diario.map(v => v >= 0 ? 'rgba(90,154,94,0.55)' : 'rgba(193,87,80,0.55)'),
          yAxisID: 'diario',
        },
      ],
    },
    options: {
      title: { display: true, text: `RENDIMIENTO POR UNIDADES — últimos ${labels.length} días`, fontColor: '#d4d4d4', fontSize: 14 },
      legend: { display: true, labels: { fontColor: '#abb2bf' } },
      scales: {
        xAxes: [{ ticks: { fontColor: '#5c6370', autoSkip: true, maxTicksLimit: 12 }, gridLines: { color: '#282c34' } }],
        yAxes: [
          { id: 'banca', position: 'left', ticks: { fontColor: '#abb2bf' }, gridLines: { color: '#282c34' } },
          { id: 'diario', position: 'right', ticks: { fontColor: '#5c6370' }, gridLines: { display: false } },
        ],
      },
    },
  };
  const chartUrl = `https://quickchart.io/chart?bkg=181a1f&w=800&h=420&c=${encodeURIComponent(JSON.stringify(chartConfig))}`;
  await sendPhotoTelegram(token, chatId, chartUrl, caption);
}

// Diagrama de confiabilidad (reliability diagram) para /stats: confianza
// estimada (eje X) contra acierto real (eje Y), por bin de confianza, con la
// diagonal de referencia (calibracion perfecta). Es EL grafico estandar para
// esta metrica — la tabla <pre> de antes obligaba a leer fila por fila para
// notar que un bin se aleja de la diagonal; aqui se ve de un vistazo.
async function sendCalibrationChart(token, chatId, bins, caption) {
  const validBins = (bins || []).filter(b => b.n > 0);
  const puntos = validBins.map(b => ({ x: Number((100 * b.avgConf).toFixed(1)), y: Number((100 * b.winRate).toFixed(1)) }));

  const chartConfig = {
    type: 'scatter',
    data: {
      datasets: [
        {
          label: 'Calibración real', data: puntos, showLine: true,
          borderColor: '#5a9a5e', backgroundColor: '#5a9a5e', pointRadius: 6, fill: false,
        },
        {
          label: 'Calibración perfecta', data: [{ x: 0, y: 0 }, { x: 100, y: 100 }], showLine: true,
          borderColor: '#5c6370', borderDash: [6, 4], pointRadius: 0, fill: false,
        },
      ],
    },
    options: {
      title: { display: true, text: 'CALIBRACIÓN — confianza estimada vs. acierto real', fontColor: '#d4d4d4', fontSize: 14 },
      legend: { display: true, labels: { fontColor: '#abb2bf' } },
      scales: {
        xAxes: [{
          scaleLabel: { display: true, labelString: 'Confianza estimada (%)', fontColor: '#abb2bf' },
          ticks: { fontColor: '#5c6370', min: 0, max: 100 }, gridLines: { color: '#282c34' },
        }],
        yAxes: [{
          scaleLabel: { display: true, labelString: 'Acierto real (%)', fontColor: '#abb2bf' },
          ticks: { fontColor: '#5c6370', min: 0, max: 100 }, gridLines: { color: '#282c34' },
        }],
      },
    },
  };
  const chartUrl = `https://quickchart.io/chart?bkg=181a1f&w=700&h=500&c=${encodeURIComponent(JSON.stringify(chartConfig))}`;
  await sendPhotoTelegram(token, chatId, chartUrl, caption);
}

// Acierto por bucket de confianza de /seguras. Antes era tres lineas de
// texto sueltas (alta/media/baja) — un vistazo a las barras dice de una vez
// si el acierto sube con la confianza (deberia) o si esta plano/invertido
// (la señal de que la confianza no esta ordenando, ya documentada aparte en
// este proyecto).
async function sendBucketsChart(token, chatId, buckets, caption) {
  const labels = buckets.map(b => b.bucket);
  const wr = buckets.map(b => {
    const n = b.wins + b.losses;
    return n ? Number((100 * b.wins / n).toFixed(1)) : 0;
  });

  const chartConfig = {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: '% acierto', data: wr,
        backgroundColor: wr.map(v => v >= 70 ? 'rgba(90,154,94,0.7)' : v >= 55 ? 'rgba(230,180,80,0.7)' : 'rgba(193,87,80,0.7)'),
      }],
    },
    options: {
      title: { display: true, text: 'ACIERTO POR CONFIANZA — /seguras', fontColor: '#d4d4d4', fontSize: 14 },
      legend: { display: false },
      scales: {
        xAxes: [{ ticks: { fontColor: '#abb2bf' }, gridLines: { color: '#282c34' } }],
        yAxes: [{ ticks: { fontColor: '#5c6370', min: 0, max: 100 }, gridLines: { color: '#282c34' } }],
      },
    },
  };
  const chartUrl = `https://quickchart.io/chart?bkg=181a1f&w=700&h=420&c=${encodeURIComponent(JSON.stringify(chartConfig))}`;
  await sendPhotoTelegram(token, chatId, chartUrl, caption);
}

// Heuristico vs aprendido: mismas tres metricas (brier/logloss/ece) que la
// tabla <pre> de antes, en barras agrupadas — comparar dos numeros cercanos
// columna por columna en texto monoespaciado es mas lento que verlos uno al
// lado del otro.
async function sendHeuristicVsLearnedChart(token, chatId, cmp, caption) {
  const chartConfig = {
    type: 'bar',
    data: {
      labels: ['Brier', 'Log loss', 'ECE'],
      datasets: [
        {
          label: 'Heurístico (producción)',
          data: [cmp.heuristic.brier, cmp.heuristic.logLoss, cmp.heuristic.ece].map(v => Number(v.toFixed(4))),
          backgroundColor: 'rgba(69,170,242,0.7)',
        },
        {
          label: 'Aprendido (shadow)',
          data: [cmp.learned.brier, cmp.learned.logLoss, cmp.learned.ece].map(v => Number(v.toFixed(4))),
          backgroundColor: 'rgba(253,150,68,0.7)',
        },
      ],
    },
    options: {
      title: { display: true, text: `HEURÍSTICO VS APRENDIDO (n=${cmp.n})`, fontColor: '#d4d4d4', fontSize: 14 },
      legend: { display: true, labels: { fontColor: '#abb2bf' } },
      scales: {
        xAxes: [{ ticks: { fontColor: '#abb2bf' }, gridLines: { color: '#282c34' } }],
        yAxes: [{ ticks: { fontColor: '#5c6370' }, gridLines: { color: '#282c34' } }],
      },
    },
  };
  const chartUrl = `https://quickchart.io/chart?bkg=181a1f&w=700&h=420&c=${encodeURIComponent(JSON.stringify(chartConfig))}`;
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
  sendPhotoFile,
  formatMessage,
  sendProfitLockAlert,
  sendStructuralDrawAlert,
  sendSniperAlert,
  sendLineDriftAlert,
  sendPickInspectorCard,
  sendDailyPerformanceChart,
  sendUnitsBankChart,
  sendCalibrationChart,
  sendBucketsChart,
  sendHeuristicVsLearnedChart,
  startTelegramBotListener, trocear, TG_MAX, enlaceHtml, esc};
