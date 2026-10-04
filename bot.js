require('dotenv').config();
// Antes que nada: si ya hay un bot vivo, abortar. Va aquí arriba a propósito,
// antes de abrir la BD o tocar Telegram, para no dejar efectos a medias.
// Ver src/singleInstance.js para el porqué (dos cuentas de Windows, getUpdates
// en conflicto y picks duplicados sobre la misma BD).
if (!require('./src/singleInstance').acquire()) process.exit(1);
const { fetchAllLive, fetchSportLive, fetchEventDetails, fetchPrematch } = require('./src/fetcher');
const { extraerStats, partidoTerminado, derivarEtiquetas, conteoEstimadoDeMercado } = require('./src/matchStats');
const { fetchLiveCorners, fetchEventFinal } = require('./src/fotmobScraper');
const { matchFotmobEvent, eventosDeHoy } = require('./src/fotmobMatch');
// Mismo calculo que usa el dashboard para "dosFuentes" (ver src/fotmobLive.js):
// compartido para no arriesgar que un fix (p.ej. el bug de signo de
// `sugerida`, 2026-09-10) solo se aplique a una de las dos copias.
const { computeDosFuentes } = require('./src/fotmobLive');
const { escanearLiga: escanearLigaPrematch } = require('./src/prematchValue');
const { xgDeEvento } = require('./src/prematchXg');
const { normalize } = require('./src/normalize');
const { programar: programarSondeos } = require('./src/execProbe');
const { db, saveSnapshot, saveStatSnapshot, saveStatResults, saveFotmobSnapshot, getFotmobCornerLatest,
        saveForecastSnapshot, saveExecProbe, enqueueDryRunJobs, getExecutionMonitor, savePrematchSnapshot, savePrematchValueScan, savePrematchXg,
        getStatEventosPendientes, getStatMuestras, logPicks, logRejected, logModelPicks, getUnsettledPicks, getStats,
        setSharpEntry, setSharpStatus, pruneSnapshots,
        isDuplicatePick, isDuplicateModelPick, countPicksSince, countPicksBelowConfSince, getPendingPicksDetailed,
        hasPickForEvent, findPick, getRescueEligible,
        getPendingModelPicksDetailed,
        addSubscriber, getSubscriber, getActiveSubscribers, getExpiredSubscribers, setSubscriberStatus } = require('./src/db');
const { processSettlements } = require('./src/results');
const { topPicks } = require('./src/analyze');
const { modelPicks } = require('./src/confidence');
const { frase: fraseBadge } = require('./src/badgeStats');
const { sendTelegram, formatMessage, enlaceHtml } = require('./src/telegram');
const { generateBetLink } = require('./src/betlink');
const { safestPicks, rankPicks, auditRejections, goldenPick, parlayCombos, rescuePicks, scoreCandidates, SCORE_VERSION } = require('./src/confidence');
const { isElite } = require('./src/firewall');
const { computeMetrics, compareScores, edgeStats, computeHealth, stakeStats, stakePicksByDate, modelPicksByDate, rescueStats } = require('./src/metrics');
const { getMode, reloadModel } = require('./src/model');
const sharp = require('./src/sharp');
const { execFile, spawn } = require('child_process');
const { promisify } = require('util');
const execFileP = promisify(execFile);
const net = require('net');
const path = require('path');
const fs = require('fs');
const os = require('os');

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = String(process.env.TELEGRAM_CHAT_ID);
const VIP_CHANNEL_ID = process.env.TELEGRAM_VIP_CHANNEL_ID ? String(process.env.TELEGRAM_VIP_CHANNEL_ID) : null;
const VIP_PRICE_STARS = Number(process.env.VIP_PRICE_STARS || 250);
const API = `https://api.telegram.org/bot${TOKEN}`;

const baseConfig = {
  minOdds: Number(process.env.MIN_ODDS || 1.05),
  maxOdds: Number(process.env.MAX_ODDS || 100),
  excludeSports: (process.env.EXCLUDE_SPORTS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
  topN: Number(process.env.TOP_N || 10),
};

const HELP = `Comandos disponibles:
/botonera — botones táctiles dentro del chat
/top — top 10 momios más bajos (todos los deportes)
/top 5 — top N
/top futbol — solo ese deporte
/top 5 tenis — combinado
/top 1.5-3 — rango de momios (ej. entre 1.5 y 3.0)
/top 5 futbol 1.2-2 — todo combinado
/top futbol +60 — solo juegos con 60+ minutos
/top tenis s2 — solo partidos en el 2º set (o parte) en adelante
/seguras — top 3 jugadas con mayor probabilidad (tiempo restante, marcador y movimiento de línea)
/seguras futbol — solo ese deporte
/golden — UN solo pick: la mejor combinación seguridad/pago (edge máximo con confianza ≥70% y momio ≥1.15)
/golden futbol — solo ese deporte
/parlay — combos sugeridos (+EV verificado en cada pata)
/parlay futbol — solo ese deporte
/stats — tasa de acierto histórica de /seguras por nivel de confianza
/health — calibración de los últimos 200 picks (detección de drift)
/unidades — unidades apostadas vs ganadas (resumen general y últimos 7 días)
/unidades hoy — dos imágenes 9:16 (heurístico y learned) con los picks liquidados hoy (o /unidades ayer / AAAA-MM-DD)
/pick 3300 — ficha de un pick con gráfica de evolución de cuota (el #id sale en cada pick automático)
/dia — gráfica de P/L acumulado del día hasta el momento (o /dia ayer / AAAA-MM-DD)
/validar — contrasta los resultados liquidados contra el marcador oficial (3 días)
/validar 6h — solo las últimas 6 horas (menos picks; el costo es por liga, no por pick)
/train — exporta el dataset y reentrena el modelo (walk-forward + calibración)
/reboot — reinicia el bot (solo admin; vuelve en ~10 s)
/pendientes — picks aún sin liquidar y cómo va cada uno (marcador, minuto y movimiento de cuota)
/fotmob — córners de partidos EN VIVO, playdoit vs conteo real de FotMob (solo admin)
/deportes — deportes en vivo ahora
/help — esta ayuda e interfaz de botones`;

function norm(s) {
  return s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

// El bot atiende a cualquier chat (los suscriptores VIP usan /start y /vip), asi
// que los comandos que ejecutan procesos en la maquina se restringen al due\u00f1o.
function isOwner(chatId) {
  return String(chatId) === CHAT_ID;
}

// Usada por los comandos interactivos (/top, /seguras, /golden, /parlay,
// /deportes) para traer una foto fresca de las cuotas en vivo. YA NO escribe
// esa foto a la BD (saveSnapshot) — el sampler de fondo (sample(), mas abajo)
// ya guarda exactamente lo mismo cada SAMPLE_MINUTES por su cuenta, asi que
// la escritura de aqui era una foto duplicada, sincrona y cara con la BD bajo
// contencion (documentada aparte): el 2026-09-12 se midio en 12-55+ segundos
// justo cuando alguien pedia /parlay o /golden, siendo buena parte de la
// lentitud que se reportaba en esos comandos. Quitarla los deja dependiendo
// del historial que el sampler de fondo llena solo, sin retrasar la
// respuesta con una escritura que en 1 minuto mas iba a existir de todas
// formas.
async function getFreshRows() {
  const sportResults = await fetchAllLive();
  const rows = normalize(sportResults);
  return { rows, sports: sportResults.map(r => r.sport) };
}

async function handleTop(args, chatId) {
  const cfg = { ...baseConfig };
  let sportFilter = null;
  let minMinute = null;
  let minSet = null;

  for (const a of args) {
    const range = a.match(/^(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)$/);
    const plus = a.match(/^\+(\d+)$/);
    const set = a.match(/^s(\d+)$/i);
    if (range) {
      cfg.minOdds = Number(range[1]);
      cfg.maxOdds = Number(range[2]);
    } else if (plus) {
      minMinute = Number(plus[1]);
    } else if (set) {
      minSet = Number(set[1]);
    } else if (/^\d+$/.test(a)) {
      cfg.topN = Math.min(Number(a), 25);
    } else {
      sportFilter = norm(a);
    }
  }

  await reply(chatId, '⏳ Consultando momios en vivo...');
  const { rows } = await getFreshRows();
  let filtered = rows;
  if (sportFilter) filtered = filtered.filter(r => norm(r.sport).includes(sportFilter));
  if (minMinute !== null) filtered = filtered.filter(r => r.minute !== null && r.minute >= minMinute);
  if (minSet !== null) filtered = filtered.filter(r => r.setNum !== null && r.setNum >= minSet);

  if (!filtered.length) return reply(chatId, 'No hay jugadas en vivo con esos filtros ahora mismo.');

  const picks = topPicks(filtered, cfg);
  if (!picks.length) return reply(chatId, 'No hay jugadas dentro del rango de momios indicado.');
  // formatMessage es async: sin await, `text` viajaba como Promise y se
  // serializaba a {} en el JSON, así que Telegram rechazaba el envío y el
  // usuario solo veía el error del catch. Era el único punto de llamada.
  const msg = await formatMessage(picks);
  // Devuelve null cuando la Guardia Pre-Shot cancela TODAS las jugadas (se
  // suspendieron entre el cálculo y el envío). Es un caso normal, no un fallo:
  // sin esto se mandaba text:null y Telegram lo rechazaba igual.
  if (!msg) return reply(chatId, '⚠️ Las jugadas se suspendieron justo antes de enviarlas. Prueba de nuevo en unos segundos.');
  await sendTelegram(TOKEN, chatId, msg);
}

function pct(x) { return `${Math.round(x * 100)}%`; }

// Intenta capturar el momio sharp equivalente de cada pick recién emitido;
// registra también los no-matcheados (picks.sharp_match).
async function captureSharpEntries(ids, picks) {
  for (let i = 0; i < picks.length; i++) {
    const p = picks[i];
    try {
      const r = await sharp.captureForPick(p);
      if (r.status === 'matched') {
        setSharpEntry({ id: ids[i], odd: r.odd, source: r.source, eventId: r.eventId, match: 'matched', marketJson: r.marketJson });
        console.log(`[sharp] match: ${p.event} @ ${r.odd} (${r.source})`);
      } else {
        setSharpStatus(ids[i], r.status);
        if (r.status === 'unmatched') console.log(`[sharp] sin match: ${p.event} (${p.sport})`);
      }
    } catch (e) {
      console.error(`[sharp] captura ${p.event}: ${e.message}`);
    }
  }
}

function getCountryFlag(champ = '', event = '', sport = '') {
  const normStr = s => (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const text = normStr(champ) + ' ' + normStr(event) + ' ' + normStr(sport);

  if (/mexico|liga mx|copa mx|expansion/i.test(text)) return '🇲🇽';
  if (/spain|espana|laliga|copa del rey/i.test(text)) return '🇪🇸';
  if (/usa|united states|eeuu|mlb|nba|mls|nfl|nhl|us open/i.test(text)) return '🇺🇸';
  if (/japan|japon|npb|j1 league|j2 league|j3 league/i.test(text)) return '🇯🇵';
  if (/brazil|brasil|serie a|serie b|copa do brasil/i.test(text)) return '🇧🇷';
  if (/argentina|liga profesional|copa argentina/i.test(text)) return '🇦🇷';
  if (/chile|primera division/i.test(text) && /chile/i.test(text)) return '🇨🇱';
  if (/colombia|primera a/i.test(text) && /colombia/i.test(text)) return '🇨🇴';
  if (/england|inglaterra|premier league|championship|fa cup|efl/i.test(text)) return '🇬🇧';
  if (/germany|alemania|bundesliga|dfb pokal/i.test(text)) return '🇩🇪';
  if (/italy|italia|serie a|coppa italia/i.test(text)) return '🇮🇹';
  if (/france|francia|ligue 1|coupe de france/i.test(text)) return '🇫🇷';
  if (/portugal|primeira liga/i.test(text)) return '🇵🇹';
  if (/netherlands|holanda|eredivisie/i.test(text)) return '🇳🇱';
  if (/uruguay/i.test(text)) return '🇺🇾';
  if (/peru/i.test(text)) return '🇵🇪';
  if (/paraguay/i.test(text)) return '🇵🇾';
  if (/ecuador/i.test(text)) return '🇪🇨';
  if (/venezuela/i.test(text)) return '🇻🇪';
  if (/guatemala/i.test(text)) return '🇬🇹';
  if (/costa rica/i.test(text)) return '🇨🇷';
  if (/honduras/i.test(text)) return '🇭🇳';
  if (/el salvador/i.test(text)) return '🇸🇻';
  if (/bolivia/i.test(text)) return '🇧🇴';
  if (/canada|canadan/i.test(text)) return '🇨🇦';
  if (/australia|a-league/i.test(text)) return '🇦🇺';
  if (/south korea|korea|corea|k-league|kbo/i.test(text)) return '🇰🇷';
  if (/china|super league/i.test(text)) return '🇨🇳';
  if (/russia|rusia/i.test(text)) return '🇷🇺';
  if (/turkey|turquia|super lig/i.test(text)) return '🇹🇷';
  if (/greece|grecia/i.test(text)) return '🇬🇷';
  if (/belgium|belgica|pro league/i.test(text)) return '🇧🇪';
  if (/austria/i.test(text)) return '🇦🇹';
  if (/switzerland|suiza/i.test(text)) return '🇨🇭';
  if (/sweden|suecia|allsvenskan/i.test(text)) return '🇸🇪';
  if (/norway|noruega|eliteserien/i.test(text)) return '🇳🇴';
  if (/denmark|dinamarca|superliga/i.test(text)) return '🇩🇰';
  if (/finland|finlandia|veikkausliiga/i.test(text)) return '🇫🇮';
  if (/poland|polonia|ekstraklasa/i.test(text)) return '🇵🇱';
  if (/czech|checa/i.test(text)) return '🇨🇿';
  if (/croatia|croacia/i.test(text)) return '🇭🇷';
  if (/serbia/i.test(text)) return '🇷🇸';
  if (/scotland|escocia/i.test(text)) return '🏴󠁧󠁢󠁳󠁣󠁴󠁿';
  if (/ireland|irlanda/i.test(text)) return '🇮🇪';
  if (/saudi|arabia/i.test(text)) return '🇸🇦';
  if (/egypt|egipto/i.test(text)) return '🇪🇬';
  if (/morocco|marruecos/i.test(text)) return '🇲🇦';
  if (/international|world|mundial|champions league|europa league|copa libertadores|copa sudamericana|friendly|amistoso/i.test(text)) return '🌐';

  return '🌐';
}

async function handleSeguras(args, chatId) {
  const sportFilter = args.length ? norm(args.join(' ')) : null;
  await reply(chatId, '⏳ Analizando jugadas en vivo...');
  const { rows } = await getFreshRows();
  let filtered = rows;
  if (sportFilter) filtered = filtered.filter(r => norm(r.sport).includes(sportFilter));
  // e-sports/simulados excluidos por defecto (ruidosos), salvo que los pidas explícitamente
  else filtered = filtered.filter(r => !norm(r.sport).startsWith('e-'));
  if (!filtered.length) return reply(chatId, 'No hay jugadas en vivo con ese filtro ahora mismo.');

  const picks = safestPicks(filtered, 3);
  if (!picks.length) return reply(chatId, 'No hay jugadas candidatas en este momento.');
  // Se muestran todas, pero solo se REGISTRAN las nuevas: repetir /seguras no
  // debe duplicar filas en el dataset (los duplicados rompen la independencia
  // que el entrenamiento walk-forward asume).
  const fresh = picks.filter(p => !isDuplicatePick(p.eventId, p.market, p.selection));
  const pickIds = logPicks(fresh.map(p => ({
    ts: p.ts, eventId: p.eventId, event: p.event, sport: p.sport,
    market: p.market, selection: p.selection, oddDecimal: p.oddDecimal, conf: p.conf,
    fProbJusta: p.base, fAvance: p.progress, fAvanceModel: p.fAvance, fSituacion: p.scoreFactor, fLinea: p.lineFactor,
    confHeuristic: p.confHeuristic, confLearned: p.confLearned, modelVersion: p.modelVersion, modelMode: p.modelMode, edge: p.edge, source: 'seguras',
    openingOdd: p.openingOdd, fApertura: p.fApertura, scoreVersion: p.scoreVersion,
    stake: p.stake, stakeMode: p.stakeMode,
  })));
  // captura sharp en segundo plano (no bloquea la respuesta al usuario)
  captureSharpEntries(pickIds, fresh).catch(e => console.error('[sharp]', e.message));

  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const now = new Date().toLocaleString('es-MX', { timeZone: 'America/Mexico_City' });
  let msg = `<b>🛡️ Top ${picks.length} más seguras</b>\n<i>${now}</i>\n\n`;
  for (const [i, p] of picks.entries()) {
    const flag = getCountryFlag(p.champ, p.event, p.sport);
    // Ya emitido: se MARCA, no se oculta. Ocultarlo haria que /seguras mintiera
    // sobre cual es el top 3 real; mostrarlo sin avisar invita a apostarlo dos
    // veces. El #id deja pedir su ficha con /pick <id>.
    const yaEmitido = findPick(p.eventId, p.market, p.selection);
    // JERARQUIA: el pick (que apostar) es lo PRIMARIO, va primero y en
    // negrita; el partido es CONTEXTO, va despues sin negrita (antes ambos
    // competian por el mismo peso visual y el ranking 1/2/3 quedaba pegado al
    // nombre del partido en vez de a la jugada en si).
    msg += `${i + 1}. 🎯 <b>${esc(p.market)}: ${esc(p.selection)} @ ${p.oddDecimal.toFixed(2)}</b> <i>(${p.oddAmerican})</i>\n`;
    msg += `   ${flag} ${esc(p.event)} <i>(${esc(p.sport)}${p.champ ? ` — ${esc(p.champ)}` : ''})</i>\n`;
    if (yaEmitido) {
      const estado = yaEmitido.result ? `ya liquidado (${yaEmitido.result})` : 'sigue abierto';
      msg += `   <i>\u{267B} Ya emitido como #${yaEmitido.id} — ${estado}. No lo repitas.</i>\n`;
    }
    if (p.score) msg += `   Marcador: ${esc(p.score)}${p.liveTime ? ` — ${esc(p.liveTime)}` : ''}\n`;
    msg += `   Confianza ${pct(p.conf)} · prob. implícita ${pct(p.base)} · avance ${pct(p.progress)}\n`;
    if (p.stake != null) msg += `   Unidad sugerida: <b>${p.stake.toFixed(1)}u</b>\n`;
    if (p.lead !== null) msg += `   Ventaja del pick: ${p.lead > 0 ? `+${p.lead}` : p.lead}\n`;
    if (p.lineDelta !== null) {
      const dir = p.lineDelta > 0 ? '📉 línea bajando (a favor)' : '📈 línea subiendo (en contra)';
      msg += `   Línea: ${dir} ${pct(Math.abs(p.lineDelta))}\n`;
    } else {
      msg += `   Línea: sin historial aún\n`;
    }
    msg += '\n';
  }
  await sendTelegram(TOKEN, chatId, msg);
}

async function handleStats(chatId) {
  const { buckets, pending } = getStats();
  if (!buckets.length && !pending) return reply(chatId, 'Aún no hay picks registrados. Usa /seguras para empezar a acumular historial.');

  const m = computeMetrics();

  // La tarjeta principal es la GRAFICA: un diagrama de confiabilidad se lee
  // de un vistazo (¿los puntos siguen la diagonal?) donde la tabla <pre> de
  // antes obligaba a comparar columna por columna. El caption trae solo el
  // headline (Brier/LogLoss/ECE) — el resto (buckets de /seguras, heuristico
  // vs aprendido, edge) va en un mensaje de texto aparte: un caption de foto
  // en Telegram tiene tope de 1024 caracteres, muy corto para todo lo que
  // este comando ya reporta.
  if (m.n) {
    const { sendCalibrationChart } = require('./src/telegram');
    let caption = `<b>📐 Calibración</b> (N=${m.n})\n`;
    if (m.n < 50) caption += `⚠️ <i>muestra insuficiente para conclusiones</i>\n`;
    caption += `Brier: <b>${m.brier.toFixed(4)}</b> · Log loss: <b>${m.logLoss.toFixed(4)}</b> · ECE: <b>${m.ece.toFixed(4)}</b>\n`;
    caption += m.clvN
      ? `CLV medio: <b>${m.clvAvg >= 0 ? '+' : ''}${(100 * m.clvAvg).toFixed(2)}%</b> (n=${m.clvN})`
      : `CLV: aún sin datos de mercado suficientes`;
    try { await sendCalibrationChart(TOKEN, chatId, m.bins, caption); }
    catch (e) { console.error('[stats] fallo la grafica de calibracion:', e.message); }
  }

  // Acierto por bucket de confianza: barras en vez de tres lineas sueltas de
  // texto — un vistazo dice si el acierto sube con la confianza (deberia) o
  // esta plano, que es justo lo que el analisis del 2026-09-12 encontro
  // (Spearman conf<->resultado practicamente cero en todo el historico).
  let tw = 0, tl = 0;
  for (const b of buckets) { tw += b.wins; tl += b.losses; }
  if (buckets.length) {
    const { sendBucketsChart } = require('./src/telegram');
    const captionBuckets = (tw + tl)
      ? `<b>📊 Total: ${tw}/${tw + tl}</b> (${Math.round(100 * tw / (tw + tl))}% acierto) · Pendientes: ${pending}`
      : `Pendientes de resolver: ${pending}`;
    try { await sendBucketsChart(TOKEN, chatId, buckets, captionBuckets); }
    catch (e) { console.error('[stats] fallo la grafica de buckets:', e.message); }
  }

  const cmp = compareScores();
  if (cmp) {
    const { sendHeuristicVsLearnedChart } = require('./src/telegram');
    const captionCmp = `<b>🤖 Heurístico vs aprendido</b> <i>(modo: ${getMode()})</i>`;
    try { await sendHeuristicVsLearnedChart(TOKEN, chatId, cmp, captionCmp); }
    catch (e) { console.error('[stats] fallo la grafica heuristico vs aprendido:', e.message); }
  }

  let msg = '';
  const es = edgeStats();
  if (es) {
    const fmtPct = v => `${v >= 0 ? '+' : ''}${(100 * v).toFixed(2)}%`;
    msg += `<b>🎯 Edge (CLV sharp)</b>\n`;
    if (!sharp.status().enabled) msg += `<i>Fuente sharp desactivada (falta ODDS_API_KEY)</i>\n`;
    if (es.nAttempted) {
      msg += `Match sharp: ${es.nMatched}/${es.nAttempted} (${Math.round(100 * es.matchRate)}%)\n`;
    } else {
      msg += `Match sharp: sin intentos aún\n`;
    }
    if (es.nClv) {
      msg += `CLV_sharp: medio <b>${fmtPct(es.clvMean)}</b> | mediana ${fmtPct(es.clvMedian)} | ${Math.round(100 * es.clvPositive)}% positivo (n=${es.nClv})\n`;
    } else {
      msg += `CLV_sharp: aún sin picks con match liquidados\n`;
    }
    msg += `ROI: ${fmtPct(es.roi)} (n=${es.nSettled})\n`;
    if (es.rhoEdgeResult !== null) msg += `Spearman edge↔resultado: ${es.rhoEdgeResult.toFixed(2)}\n`;
    if (es.rhoEdgeClv !== null) msg += `Spearman edge↔CLV_sharp: ${es.rhoEdgeClv.toFixed(2)}\n`;
    msg += `\n🚦 <b>${es.semaphore}</b>`;
  }
  if (msg) await reply(chatId, msg);
}

// ---------- /golden: un solo pick, la mejor relación seguridad/pago ----------
async function handleGolden(args, chatId) {
  const sportFilter = args.length ? norm(args.join(' ')) : null;
  await reply(chatId, '⏳ Buscando el pick dorado...');
  const { rows } = await getFreshRows();
  let filtered = rows;
  if (sportFilter) filtered = filtered.filter(r => norm(r.sport).includes(sportFilter));
  else filtered = filtered.filter(r => !norm(r.sport).startsWith('e-'));
  if (!filtered.length) return reply(chatId, 'No hay jugadas en vivo con ese filtro ahora mismo.');

  const p = goldenPick(filtered);
  if (!p) {
    return reply(chatId, '🥇 Ahora mismo no hay pick dorado: ninguna jugada cumple confianza ≥' +
      `${Math.round(100 * Number(process.env.GOLDEN_MIN_CONF || 0.70))}% con edge positivo ` +
      `a momio ≥${Number(process.env.GOLDEN_MIN_ODDS || 1.15).toFixed(2)}. Mejor no apostar que apostar caro.`);
  }

  if (!isDuplicatePick(p.eventId, p.market, p.selection)) {
    const [id] = logPicks([{
      ts: p.ts, eventId: p.eventId, event: p.event, sport: p.sport,
      market: p.market, selection: p.selection, oddDecimal: p.oddDecimal, conf: p.conf,
      fProbJusta: p.base, fAvance: p.progress, fAvanceModel: p.fAvance, fSituacion: p.scoreFactor, fLinea: p.lineFactor,
      confHeuristic: p.confHeuristic, confLearned: p.confLearned, modelVersion: p.modelVersion, modelMode: p.modelMode, edge: p.edge, source: 'golden',
      openingOdd: p.openingOdd, fApertura: p.fApertura, scoreVersion: p.scoreVersion,
      stake: p.stake, stakeMode: p.stakeMode,
    }]);
    captureSharpEntries([id], [p]).catch(e => console.error('[sharp]', e.message));
  }

  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const now = new Date().toLocaleString('es-MX', { timeZone: 'America/Mexico_City' });
  const flag = getCountryFlag(p.champ, p.event, p.sport);
  const yaEmitido = findPick(p.eventId, p.market, p.selection);
  let msg = `<b>🥇 Pick dorado</b>\n<i>${now}</i>\n\n`;
  if (yaEmitido) {
    const estado = yaEmitido.result ? `ya liquidado (${yaEmitido.result})` : 'sigue abierto';
    msg += `<i>\u{267B} Ya emitido como <b>#${yaEmitido.id}</b> — ${estado}. No lo repitas.</i>\n\n`;
  }
  // JERARQUIA: el pick es lo PRIMARIO (negrita, primero); partido y marcador
  // son CONTEXTO (sin negrita, despues); confianza/edge son diagnostico.
  msg += `🎯 <b>${esc(p.market)}: ${esc(p.selection)} @ ${p.oddDecimal.toFixed(2)}</b> <i>(${p.oddAmerican})</i>\n`;
  msg += `${flag} ${esc(p.event)} <i>(${esc(p.sport)}${p.champ ? ` — ${esc(p.champ)}` : ''})</i>\n`;
  if (p.score) msg += `Marcador: ${esc(p.score)}${p.liveTime ? ` — ${esc(p.liveTime)}` : ''}\n`;
  msg += '\n';
  msg += `Confianza ${pct(p.conf)} · Edge estimado +${(100 * p.edge).toFixed(1)}%\n`;
  if (p.stake != null) msg += `Unidad sugerida: <b>${p.stake.toFixed(1)}u</b>\n`;
  msg += `Pago: 100 → ${(100 * p.oddDecimal).toFixed(0)}\n`;
  if (p.lead !== null) msg += `Ventaja del pick: ${p.lead > 0 ? `+${p.lead}` : p.lead}\n`;
  if (p.lineDelta !== null) {
    const dir = p.lineDelta > 0 ? '📉 línea bajando (a favor)' : '📈 línea subiendo (en contra)';
    msg += `Línea: ${dir} ${pct(Math.abs(p.lineDelta))}\n`;
  }
  msg += `\n<i>Criterio: edge máximo del universo en vivo con confianza ≥${Math.round(100 * Number(process.env.GOLDEN_MIN_CONF || 0.70))}% y momio ≥${Number(process.env.GOLDEN_MIN_ODDS || 1.15).toFixed(2)}.</i>`;
  await sendTelegram(TOKEN, chatId, msg, MAIN_KEYBOARD);
}

// ---------- /parlay: combos +EV con selección óptima ----------
// Encuentra combinaciones de 2 ó 3 patas donde CADA pata tiene edge > 0 individual
// y el combo resultante maximiza el Edge Compuesto ajustado con factor de penalización por varianza γ = 0.97^(K-1).
async function handleParlay(args, chatId) {
  const sportFilter = args.length ? norm(args.join(' ')) : null;
  await reply(chatId, '⏳ Analizando parlays +EV en vivo...');
  const { rows } = await getFreshRows();
  let filtered = rows;
  if (sportFilter) filtered = filtered.filter(r => norm(r.sport).includes(sportFilter));
  else filtered = filtered.filter(r => !norm(r.sport).startsWith('e-'));
  if (!filtered.length) return reply(chatId, 'No hay jugadas en vivo con ese filtro ahora mismo.');

  const combos = parlayCombos(filtered);
  if (!combos.length) {
    return reply(chatId, '🎰 Ahora mismo no hay combinaciones de parlay con +EV verificado en vivo. ' +
      'Es preferible abstenerse que forzar un combo con esperanza matemática negativa (-EV).');
  }

  const best = combos[0];
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const now = new Date().toLocaleString('es-MX', { timeZone: 'America/Mexico_City' });

  let msg = `<b>🎰 Parlay Robusto (+EV)</b>\n<i>${now}</i>\n\n`;
  msg += `<b>Patas seleccionadas (${best.legCount} patas +EV):</b>\n`;
  // JERARQUIA: cada pata es PRIMARIO por su pick (mercado:seleccion@cuota),
  // no por el nombre del partido; y del combo, el edge compuesto es el
  // resultado que decide si vale la pena — momio y prob. conjunta son el
  // detalle que lo sustenta.
  for (const [i, p] of best.legs.entries()) {
    const legFlag = getCountryFlag(p.champ, p.event, p.sport);
    msg += `${i + 1}. 🎯 <b>${esc(p.market)}: ${esc(p.selection)} @ ${p.oddDecimal.toFixed(2)}</b>\n`;
    msg += `   ${legFlag} ${esc(p.event)} <i>(${esc(p.sport)})</i>\n`;
    if (p.score) msg += `   Marcador: ${esc(p.score)}${p.liveTime ? ` — ${esc(p.liveTime)}` : ''}\n`;
    msg += `   Confianza ${pct(p.conf)} · Edge individual +${(100 * p.edge).toFixed(1)}%\n\n`;
  }

  msg += `<b>🎯 Edge compuesto: +${(100 * best.edge).toFixed(1)}%</b> <i>(+EV verificado)</i>\n`;
  msg += `Momio total: ${best.totalOdd.toFixed(2)} · Prob. conjunta ajustada: ${pct(best.adjProb)}\n\n`;

  if (combos.length > 1) {
    msg += `<i>Combinaciones +EV detectadas en vivo: ${combos.length}</i>\n`;
  }
  msg += `<i>Criterio: exige edge > 0 en cada pata (partidos distintos) y aplica corrección por varianza (γ=0.97). ` +
`Estos combos no se registran en /stats.</i>`;

  await sendTelegram(TOKEN, chatId, msg, MAIN_KEYBOARD);
}

// ---------- /train: reentrenamiento bajo demanda ----------
// Exporta dataset.csv y corre el entrenador Python. Devuelve el reporte como
// texto (sin enviar nada a Telegram) para poder probarlo aislado.
let training = false;
async function runTraining() {
  if (training) return { ok: false, text: 'Ya hay un entrenamiento en curso.' };
  training = true;
  try {
    const opts = { cwd: __dirname, timeout: 10 * 60 * 1000, maxBuffer: 10 * 1024 * 1024, windowsHide: true };
    const exp = await execFileP(process.execPath, ['scripts/export-dataset.js'], opts);
    let report;
    try {
      const tr = await execFileP('python', ['scripts/train_weights.py'], opts);
      report = tr.stdout;
    } catch (e) {
      // exit != 0: dataset insuficiente u otro fallo controlado — el mensaje va en stdout/stderr
      const detail = [e.stdout, e.stderr].filter(Boolean).join('\n').trim();
      return { ok: false, text: `${exp.stdout.trim()}\n\n${detail || e.message}` };
    }
    const adopted = report.includes('Modelo exportado a model.json');
    if (adopted) reloadModel(); // recarga en caliente: sin reiniciar el bot
    return { ok: true, adopted, text: `${exp.stdout.trim()}\n\n${report.trim()}` };
  } finally {
    training = false;
  }
}

/**
 * Reinicia el bot saliendo del proceso y dejando que el supervisor lo relance.
 *
 * NO mata ni respawnea nada por su cuenta, a propósito: scripts/run-bot.cmd ya
 * envuelve a node en un `:loop` que relanza a los 10 s de cualquier salida, así
 * que salir limpio ES el reinicio. Intentar spawnear un reemplazo desde aquí
 * añadiría una carrera con el lock de instancia única para no ganar nada.
 *
 * Por qué exige BOT_SUPERVISED: la tarea programada solo dispara al iniciar
 * sesión (MSFT_TaskLogonTrigger), no vigila el proceso. Si alguien arrancó con
 * `node bot.js` a mano, no hay quien relance — y entonces /reboot no sería un
 * reinicio sino un apagado permanente hasta el próximo logon. En ese caso se
 * niega y lo explica, que es lo contrario de lo que el usuario pidió pero lo
 * que de verdad quiere.
 *
 * El lock se libera solo: singleInstance registra su release en process.on
 * ('exit'), y los 10 s del supervisor dan margen de sobra para que el PID muera
 * antes de que el sucesor compruebe si sigue vivo.
 */
async function handleReboot(chatId) {
  if (!process.env.BOT_SUPERVISED) {
    await reply(chatId,
      '⚠️ <b>No hay supervisor.</b> Este proceso no se arrancó con <code>scripts/run-bot.cmd</code>, '
      + 'así que nadie lo relanzaría: reiniciar aquí sería apagarlo hasta el próximo inicio de sesión.\n\n'
      + 'Arráncalo con <code>scripts\\run-bot.cmd</code> (o la tarea programada) y <code>/reboot</code> funcionará.');
    return;
  }
  // El await importa: process.exit() corta el envío en curso, así que el aviso
  // tiene que estar entregado ANTES de salir o el usuario se queda sin saber
  // si el comando llegó.
  // El panel YA NO cae con el bot: corre desacoplado (detached) y el bot
  // relanzado lo adopta por el lock, asi que la pestaña abierta sigue viva y las
  // alertas automaticas no se cortan. Antes moria con cada reinicio y habia que
  // avisar de mandar /dashboard.
  const avisoPanel = dashboardAlive() ? '\n\nEl panel sigue vivo; no se corta.' : '';
  await reply(chatId, '♻️ <b>Reiniciando…</b> el supervisor relanza el bot en ~10 s.' + avisoPanel);
  console.log(`[reboot] solicitado desde Telegram (chat ${chatId}); saliendo para que el supervisor relance`);
  setTimeout(() => process.exit(0), 250);
}

async function handleTrain(chatId) {
  await reply(chatId, '⏳ Exportando dataset y entrenando (walk-forward + calibración)...');
  const r = await runTraining();
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  // Telegram limita a 4096 chars por mensaje: trocea el reporte
  const text = r.text;
  for (let i = 0; i < text.length; i += 3500) {
    await reply(chatId, `<pre>${esc(text.slice(i, i + 3500))}</pre>`);
  }
  if (r.ok) {
    await reply(chatId, r.adopted
      ? `✅ <b>Modelo adoptado y recargado en caliente.</b> Modo actual: <b>${getMode()}</b>${getMode() !== 'learned' ? ' (sigue mostrando el heurístico; cambia MODEL_MODE=learned cuando el shadow lo confirme)' : ''}`
      : `ℹ️ El modelo NO superó la regla de adopción: se mantiene el heurístico (se escribió model_candidate.json para inspección).`);
  }
}

// ---------- /validar: contrasta las liquidaciones con el marcador oficial ----------
// Acepta ventana: /validar 1h · /validar 6h · /validar 2 (días) · sin arg = 3 días
function parseVentana(args) {
  const a = (args[0] || '').toLowerCase();
  const m = a.match(/^(\d+(?:\.\d+)?)\s*(h|d)?$/);
  if (!m) return 72;
  const n = Number(m[1]);
  return m[2] === 'h' ? n : n * 24;
}

async function handleValidar(args, chatId) {
  const horas = parseVentana(args);
  const etiqueta = horas < 24 ? `${horas} h` : `${(horas / 24).toFixed(0)} día(s)`;
  await reply(chatId, `⏳ Validando liquidaciones de las últimas ${etiqueta} contra marcadores oficiales...`);
  const { validateSettlements } = require('./src/validate');
  let r;
  try { r = await validateSettlements({ hours: horas }); } catch (e) { return reply(chatId, `⚠️ Error: ${e.message}`); }
  if (r.error) return reply(chatId, `⚠️ ${r.error}`);
  if (!r.n) return reply(chatId, `No hay picks liquidados en las últimas ${etiqueta}.\n<i>Un pick tarda ~36 min de mediana en liquidarse; prueba una ventana mayor: /validar 6h</i>`);

  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  let msg = `<b>🔍 Validación de resultados</b>\n\n`;
  msg += `Picks liquidados (${etiqueta}): ${r.n}\n`;
  const pf = r.porFuente || { oddsapi: r.checked, fotmob: 0 };
  msg += `Verificables: <b>${r.checked}</b> (The Odds API: ${pf.oddsapi} en ${r.leagues} liga(s) · FotMob: ${pf.fotmob})\n`;
  if (!r.checked) {
    msg += `\n<i>Ninguno pudo verificarse: sus ligas no tienen fuente oficial disponible ` +
`(FotMob solo cubre fútbol de ligas que sigue). La liquidación por último marcador visto sigue sin contraste.</i>`;
    return reply(chatId, msg);
  }
  const sinCubrir = r.n - r.checked;
  if (sinCubrir > 0) msg += `Sin verificar: ${sinCubrir} <i>(deporte o liga sin fuente)</i>\n`;
  if (r.fotmobError) msg += `<i>⚠️ FotMob no respondió: ${esc(r.fotmobError.slice(0, 60))}</i>\n`;
  const pctOk = (100 * r.ok / r.checked).toFixed(0);
  msg += `Marcador coincide: <b>${r.ok}/${r.checked}</b> (${pctOk}%)\n`;
  msg += `Marcador distinto: ${r.mismatch.length}\n`;
  msg += `<b>Resultado que cambiaría: ${r.resultChanges.length}</b>\n`;

  if (r.resultChanges.length) {
    msg += `\n<b>⚠️ Picks mal liquidados</b>\n`;
    for (const m of r.resultChanges.slice(0, 6)) {
      msg += `• ${esc(m.event.slice(0, 34))}\n`;
      msg += `  ${esc(m.selection.slice(0, 22))} — nuestro ${esc(m.final_score)} vs oficial ${esc(m.oficial)}\n`;
      msg += `  registrado <b>${m.result}</b> → debería ser <b>${m.nuevo}</b>\n`;
    }
  } else if (r.mismatch.length) {
    msg += `\n<i>Hay marcadores distintos, pero ninguno cambia el resultado del pick ` +
`(diferencias posteriores a la decisión).</i>\n`;
    for (const m of r.mismatch.slice(0, 4)) {
      msg += `• ${esc(m.event.slice(0, 30))}: ${esc(m.final_score)} → ${esc(m.oficial)}\n`;
    }
  } else {
    msg += `\n✅ Todas las liquidaciones verificadas son correctas.`;
  }
  msg += `\n<i>Créditos usados: ${r.credits}. No se modificó ningún registro: se reporta, no se corrige.</i>`;
  await reply(chatId, msg);
}

const { calculateQuantitativeHealth } = require('./src/health');

async function handleHealth(chatId) {
  const esc = str => String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const fmtU = v => `${v >= 0 ? '+' : ''}${v.toFixed(2)}u`;

  const h = calculateQuantitativeHealth({ windowDays: 30 });
  if (!h.n) return reply(chatId, 'Aún no hay picks liquidados con score para evaluar calibración.');

  let msg = `<b>🩺 RIGOR CUANTITATIVO Y SALUD DEL MODELO</b>\n`;
  msg += `<i>Estilo Polymarket Quantitative Engine</i>\n\n`;
  msg += `<b>Estado:</b> ${h.color} <b>${esc(h.status)}</b>\n`;
  msg += `<i>${esc(h.message)}</i>\n\n`;

  msg += `<b>1. Calibración &amp; Precisión (OOS):</b>\n`;
  msg += `• Muestras Evaluadas: <b>${h.n} picks</b>\n`;
  msg += `• Win Rate: <b>${h.wr.toFixed(1)}%</b> (${h.wins}/${h.n})\n`;
  msg += `• Brier Score: <b>${h.brierScore.toFixed(4)}</b> (óptimo &lt; 0.2000)\n`;
  msg += `• Log Loss: <b>${h.logLoss.toFixed(4)}</b>\n`;
  msg += `• ECE (Calibration Error): <b>${(h.ece * 100).toFixed(2)}%</b> (óptimo &lt; 5.0%)\n\n`;

  if (h.sharpN > 0) {
    msg += `<b>2. Mercado Sharp &amp; CLV (Pinnacle/Betfair):</b>\n`;
    msg += `• Muestras Sharp: <b>${h.sharpN}</b>\n`;
    msg += `• Sharp Beat Rate (% CLV &gt; 0): <b>${h.clvBeatRate.toFixed(1)}%</b>\n`;
    msg += `• Ventaja Promedio CLV: <b>${h.avgClvPct >= 0 ? '+' : ''}${h.avgClvPct.toFixed(2)}%</b>\n\n`;
  }

  msg += `<b>3. Cartera & Riesgo Financiero:</b>\n`;
  msg += `• Apostado: <b>${h.totalStaked.toFixed(2)}u</b> | Ganancia: <b>${fmtU(h.totalProfit)}</b>\n`;
  msg += `• ROI Global: <b>${h.roi >= 0 ? '+' : ''}${h.roi.toFixed(2)}%</b>\n`;
  if (h.sharpeRatio !== null) msg += `• Ratio de Sharpe: <b>${h.sharpeRatio.toFixed(2)}</b> (institucional &gt; 1.50)\n`;
  if (h.maxDrawdown !== null) msg += `• Max Drawdown: <b>-${h.maxDrawdown.toFixed(2)}u</b>\n`;

  await reply(chatId, msg);
}

// ---------- /unidades: rendimiento por unidades ----------
// Detalle diario ("hoy" / "ayer" / fecha) recortado a los últimos N picks
// liquidados por sección, para que siempre quepa en UN solo mensaje de
// Telegram (límite 4096 chars) sin necesidad de trocear en partes.
async function handleUnidades(args = [], chatId) {
  const esc = str => String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const fmtU = v => `${v >= 0 ? '+' : ''}${v.toFixed(2)}u`;
  const LAST_N = 10;

  // Renderiza hasta LAST_N picks (los más recientes) como bloque de texto.
  // totalCount es el conteo real (antes de recortar), para anotar "de N".
  function renderPickList(picks, totalCount) {
    const shown = picks.slice(-LAST_N);
    let out = '';
    if (totalCount > shown.length) out += `<i>(últimos ${shown.length} de ${totalCount})</i>\n\n`;
    for (const [idx, p] of shown.entries()) {
      const icon = p.result === 'win' ? '✅' : '❌';
      const sign = p.profit >= 0 ? '+' : '';
      const hora = p.ts ? new Date(p.ts).toLocaleTimeString('es-MX', { timeZone: 'America/Mexico_City', hour: '2-digit', minute: '2-digit', hour12: false }) : '';
      const timeTag = hora ? ` <i>[${hora}]</i>` : '';
      const flag = getCountryFlag(p.champ, p.event, p.sport);
      const lossMinTag = (p.result === 'loss' && p.loss_minute !== null && p.loss_minute !== undefined) ? ` <i>(Perdido min ${p.loss_minute}')</i>` : '';
      out += `${icon} <b>${idx + 1}. ${flag} ${esc(p.event)}</b>${timeTag} <i>(${esc(p.sport)})</i>\n`;
      out += `   ${esc(p.market)}: <b>${esc(p.selection)}</b> @ ${p.odd_decimal.toFixed(2)}\n`;
      out += `   Stake: <b>${p.stake ? p.stake.toFixed(1) : '1.0'}u</b> | Marcador: ${esc(p.final_score || '—')} ➔ <b>${sign}${p.profit.toFixed(2)}u</b>${lossMinTag}\n\n`;
    }
    return out;
  }

  function renderSessionSummary(title, s) {
    let out = `<b>${title}</b>\n`;
    out += `• Picks: <b>${s.wins}/${s.n}</b> (${s.wr ? s.wr.toFixed(0) : 0}% acierto)\n`;
    out += `• Apostado: <b>${s.staked.toFixed(2)}u</b> | Ganancia: <b>${fmtU(s.profit)}</b>`;
    if (s.roi !== null) out += ` (ROI ${s.roi >= 0 ? '+' : ''}${s.roi.toFixed(1)}%)`;
    return out + `\n`;
  }

  if (args.length > 0) {
    const sub = norm(args[0]);

    // "Unidades Hoy" bifurca: heuristico (en produccion, apuesta real) vs
    // learned (modelo aprendido, solo sombra — nunca se apuesta). Antes
    // mezclarlos hubiera confundido "lo que se gano" con "lo que el modelo
    // habria ganado si decidiera el" bajo el mismo boton. Pedido explicito
    // del usuario el 2026-09-12: preguntar primero con botones inline, en vez
    // de mandar directo el reporte del heuristico como hacia antes.
    // Fila 2: en vez de un reporte de texto propio, mandan una CAPTURA de la
    // seccion equivalente del dashboard (History > Tabla / History > Modelo
    // ML) — pedido explicito del usuario el 2026-09-13. Distinto de las
    // filas de arriba: ahi se calcula el numero en bot.js, aqui se abre el
    // dashboard de verdad con Playwright y se recorta esa seccion, asi que
    // lo que se ve en Telegram es EXACTAMENTE lo que se veria abriendo el
    // panel — no una reconstruccion aparte que podria desviarse.
    if (sub === 'hoy') return enviarUnidadesHoyImagenes(chatId);

    if (sub === 'ayer' || /^\d{4}-\d{2}-\d{2}$/.test(sub)) {
      const res = stakePicksByDate(sub);
      if (!res.n) return reply(chatId, `No hay picks liquidados para el día <b>${esc(res.date)}</b>.`);

      if (res.isToday) {
        const postPicks = res.postSession.picks;

        let msg = `<b>🌟 SESIÓN NUEVA (POST-AJUSTES DE ROI & CAP DINÁMICO)</b>\n<i>Picks emitidos desde las 6:02 PM CDMX</i>\n\n`;

        if (!postPicks.length) {
          msg += `⏳ <i>Aún no se han liquidado picks emitidos tras los nuevos ajustes de Stake Cap Dinámico y Doble Capa. Esperando los primeros partidos.</i>\n\n`;
        } else {
          msg += renderPickList(postPicks, postPicks.length);
          msg += renderSessionSummary('Resumen Sesión Nueva (Post 6:02 PM)', res.postSession) + `\n`;
        }

        if (res.preSession.n > 0) {
          msg += renderSessionSummary('📜 Sesión Previa de Hoy (Pre-Ajustes - antes 6:02 PM)', res.preSession) + `\n`;
        }

        msg += `<b>Total Acumulado del Día (${esc(res.date)}):</b>\n`;
        msg += `• Picks: <b>${res.wins}/${res.n}</b> | Ganancia Total: <b>${fmtU(res.profit)}</b>`;

        return reply(chatId, msg);
      }

      // Rama: /unidades ayer, /unidades AAAA-MM-DD
      let msg = `<b>📋 Picks liquidados del ${esc(res.date)}</b>\n\n`;
      msg += renderPickList(res.picks, res.picks.length);
      msg += `<b>Resumen del día (${esc(res.date)}):</b>\n`;
      msg += `• Picks: <b>${res.wins}/${res.n}</b> (${res.wr ? res.wr.toFixed(0) : 0}% acierto)\n`;
      msg += `• Apostado: <b>${res.staked.toFixed(2)}u</b>\n`;
      msg += `• Ganancia: <b>${fmtU(res.profit)}</b>\n`;
      if (res.roi !== null) msg += `• ROI: <b>${res.roi >= 0 ? '+' : ''}${res.roi.toFixed(1)}%</b>\n`;

      return reply(chatId, msg);
    }
  }

  // ---------- Rama por defecto: /unidades (resumen general) ----------
  const s = stakeStats();
  if (!s.n && !s.pendingN) {
    return reply(chatId, 'Aún no hay picks con unidad de apuesta asignada. Se asignan desde que se activó el dimensionamiento por unidades (2026-07-30).');
  }
  const modeName = { flat: 'plano (1u fija)', half_kelly: 'medio Kelly', kelly: 'Kelly completo' }[s.mode] || s.mode;

  // Tarjeta principal: la GRAFICA de banca acumulada + P/L diario. La tabla
  // <pre> dia-por-dia de antes daba el numero de cada dia pero no la
  // TENDENCIA (¿la banca sube en general, o el ultimo tramo es una racha
  // dentro de una caida mas larga?) — eso se ve de un vistazo en la curva.
  // El caption trae solo el headline (ROI/ganancia); el resto (picks/modo,
  // por deporte, rescates) va en un mensaje de texto aparte por el mismo
  // motivo que en /stats: 1024 caracteres de tope en un caption de foto.
  if (s.n && s.byDay.length) {
    const { sendUnitsBankChart } = require('./src/telegram');
    const caption = `<b>💰 ROI: ${s.roi >= 0 ? '+' : ''}${s.roi.toFixed(2)}%</b> · <b>${fmtU(s.profit)}</b>\n` +
      `<i>${s.byDay.filter(d => d.profit > 0).length} de ${s.byDay.length} días en positivo</i>`;
    try { await sendUnitsBankChart(TOKEN, chatId, s.byDay, caption); }
    catch (e) { console.error('[unidades] fallo la grafica de banca:', e.message); }
  }

  let msg = `<b>💰 Rendimiento por unidades</b>\n`;
  if (s.since) msg += `<i>desde ${new Date(s.since).toLocaleDateString('es-MX', { timeZone: 'America/Mexico_City' })}</i>\n\n`;
  if (!s.n) {
    msg += `Sin picks liquidados todavía.\n`;
  } else {
    msg += `Picks liquidados: ${s.n} (acierto ${s.wr.toFixed(1)}%) · modo: ${modeName}\n`;
    msg += `Unidades apostadas: ${s.staked.toFixed(2)}u · apuesta media: ${s.avgStake.toFixed(2)}u\n`;
    msg += `💡 <i>Usa /unidades hoy para el detalle del día</i>\n`;

    if (s.bySport.length > 1) {
      msg += `\n<b>Por deporte</b>\n<pre>deporte          apostado  ganado   ROI\n`;
      for (const b of s.bySport) {
        msg += `${b.sport.slice(0, 15).padEnd(16)} ${b.staked.toFixed(1).padStart(7)}u ${fmtU(b.profit).padStart(7)} ${(b.roi >= 0 ? '+' : '') + b.roi.toFixed(1)}%\n`;
      }
      msg += `</pre>`;
    }
  }
  if (s.pendingN) msg += `\nPendientes de liquidar: ${s.pendingN} picks (${s.pendingUnits.toFixed(2)}u en juego)`;

  // Los rescates van APARTE y contra su referencia natural: los picks emitidos
  // de la misma ventana. Contra el historico completo la comparacion mentiria,
  // porque el regimen se mueve.
  const r = rescueStats();
  if (r.n) {
    msg += `\n\n<b>\u{1F6DF} Rescates del modelo</b> <i>(experimento, fuera del total de arriba)</i>\n`;
    msg += `Picks: <b>${r.wins}/${r.n}</b> | apostado ${r.staked.toFixed(2)}u | ${fmtU(r.profit)}`;
    msg += (r.roi != null ? ` (ROI ${r.roi >= 0 ? '+' : ''}${r.roi.toFixed(1)}%)` : '') + `\n`;
    const ref = r.referencia;
    if (ref && ref.n) {
      msg += `<i>Emitidos en la misma ventana: ${ref.wins}/${ref.n}`;
      msg += (ref.roi != null ? ` (ROI ${ref.roi >= 0 ? '+' : ''}${ref.roi.toFixed(1)}%)` : '') + `</i>\n`;
    }
  }
  await reply(chatId, msg);
}

// Las dos ramas de la bifurcacion de "Unidades Hoy" (ver el boton inline en
// handleUnidades). Funciones propias, no reutilizan los helpers internos de
// handleUnidades (closures atadas a esa llamada) — mas simple que exponerlos.
async function enviarUnidadesHoyHeuristico(chatId) {
  const esc = str => String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const fmtU = v => `${v >= 0 ? '+' : ''}${v.toFixed(2)}u`;
  const res = stakePicksByDate('hoy');
  if (!res.n) return reply(chatId, `📊 <b>Heurístico (producción)</b>\n\nAún no hay picks liquidados hoy.`);

  let msg = `📊 <b>Heurístico (producción) — Unidades Hoy</b>\n`;
  msg += `<i>${esc(res.date)}</i>\n\n`;
  msg += `<b>ROI: ${res.roi >= 0 ? '+' : ''}${res.roi.toFixed(2)}%</b> · <b>${fmtU(res.profit)}</b>\n`;
  msg += `Picks: ${res.wins}/${res.n} (${res.wr.toFixed(0)}% acierto) · Apostado: ${res.staked.toFixed(2)}u\n`;
  return reply(chatId, msg);
}

async function enviarUnidadesHoyLearned(chatId) {
  const esc = str => String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const fmtU = v => `${v >= 0 ? '+' : ''}${v.toFixed(2)}u`;
  const res = modelPicksByDate('hoy');
  if (!res.n) return reply(chatId, `🔮 <b>Learned (shadow)</b>\n\nAún no hay picks del modelo aprendido liquidados hoy.`);

  let msg = `🔮 <b>Learned (shadow) — Unidades Hoy</b>\n`;
  msg += `<i>${esc(res.date)} · nunca se apuesta, solo registro</i>\n\n`;
  msg += `<b>ROI: ${res.roi >= 0 ? '+' : ''}${res.roi.toFixed(2)}%</b> · <b>${fmtU(res.profit)}</b> <i>(1u plana por pick)</i>\n`;
  msg += `Picks: ${res.wins}/${res.n} (${res.wr.toFixed(0)}% acierto)\n`;
  return reply(chatId, msg);
}

// Las otras dos ramas de "Unidades Hoy": imagen con los ultimos picks,
// dibujada DESDE CODIGO (Pillow) en vez de capturar el dashboard con
// Playwright. Se probo primero la version con screenshot (src/dashboardShot.js,
// retirado) y se descarto: mas lenta (levanta Chromium completo), fragil
// (depende de que el dashboard este vivo y de que sus selectores no
// cambien), y sin acotar el DOM a mano producia imagenes de decenas de
// miles de pixeles. Aqui los datos salen directo de la BD, se le pasan al
// script de Python ya recortados, y no hace falta ni el dashboard ni un
// navegador.
//
// Sin la tabla de estadisticas por dia (se quito a pedido del usuario el
// 2026-09-13: ya la tiene el dashboard, aqui solo interesa el detalle
// pick-a-pick). TODOS los picks LIQUIDADOS de HOY (dia CDMX) para cada
// modelo, sin pendientes — pedido explicito del usuario el 2026-09-13,
// reemplaza la version anterior de "ultimos 20 sin importar el dia". Sin
// tope de cantidad: si un dia trae mas de lo normal (se ha visto hasta 467
// en un solo dia), la imagen sale mas larga, pero eso es preferible a
// cortar informacion que se pidio completa.
function rangoHoyCDMX() {
  const diaCDMX = new Date(Date.now() - 6 * 3600e3).toISOString().slice(0, 10);
  const inicio = new Date(`${diaCDMX}T06:00:00.000Z`); // 00:00 CDMX = 06:00 UTC
  const fin = new Date(inicio.getTime() + 24 * 3600e3);
  return { inicio: inicio.toISOString(), fin: fin.toISOString() };
}

async function renderPicksTableImagen(titulo, liquidados, enJuego, modo, meta = {}) {
  const fs = require('fs');
  const path = require('path');
  const tmpDir = path.join(__dirname, 'scratch');
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
  const entrada = path.join(tmpDir, `_unidades_hoy_${process.pid}.json`);
  const salida = path.join(tmpDir, `_unidades_hoy_${process.pid}.png`);
  // Sin emoji en el titulo de la IMAGEN: Segoe UI/Arial no traen esos
  // glifos y salen como un cuadro vacio. El emoji si va en el caption de
  // Telegram (texto normal, ese si lo renderiza bien).
  const tituloSinEmoji = titulo.replace(/\p{Extended_Pictographic}/gu, '').trim();
  fs.writeFileSync(entrada, JSON.stringify({
    titulo: tituloSinEmoji, liquidados, enJuego, modo,
    modelo: meta.modelo, pagina: meta.pagina, totalPaginas: meta.totalPaginas, reportId: meta.reportId,
    stats: meta.stats || null,
  }));
  try {
    await execFileP('python', [path.join(__dirname, 'scripts', 'render-picks-table.py'), entrada, salida],
      { timeout: 15000, windowsHide: true });
    return salida;
  } finally {
    fs.unlink(entrada, () => {});
  }
}

function filaAImagenPick(p) {
  // Minuto del partido al momento del pick: model_picks guarda entry_minute
  // crudo, pero picks (heuristico) solo guarda f_avance normalizado (0-1) —
  // ver el comentario en db.js sobre por que no se guarda el minuto crudo
  // ahi. Se aproxima asumiendo partido de 90' (el grueso del volumen es
  // futbol); es una estimacion, no el dato exacto que si tiene el modelo.
  let minuto = null;
  if (p.entry_minute != null) minuto = Math.round(p.entry_minute);
  else if (p.f_avance != null) minuto = Math.round(p.f_avance * 90);

  return {
    id: p.id,
    fecha: new Date(p.ts).toLocaleDateString('es-MX', { timeZone: 'America/Mexico_City', day: '2-digit', month: '2-digit' }),
    hora: new Date(p.ts).toLocaleTimeString('es-MX', { timeZone: 'America/Mexico_City', hour: '2-digit', minute: '2-digit', hour12: false }),
    evento: p.event || '', mercado: p.market || '', seleccion: p.selection || '',
    cuota: p.odd_decimal, resultado: p.result, pl: p.pl,
    // Marcador final del partido — pedido explicito del usuario el
    // 2026-09-13, distinto de "resultado" (WIN/LOSS, ya estaba): esto es el
    // score real, para poder juzgar el pick sin tener que ir a buscarlo
    // aparte.
    marcador: p.final_score || null,
    minuto, edge: p.edge != null ? p.edge : null,
  };
}

async function enviarUnidadesHoyImagenDashboard(chatId, view, titulo) {
  const esc = str => String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const { sendPhotoFile } = require('./src/telegram');
  try {
    const { inicio, fin } = rangoHoyCDMX();
    let liquidadosRows;
    if (view === 'table') {
      liquidadosRows = db.prepare(`
        SELECT id, ts, event, market, selection, odd_decimal, result, final_score, edge, f_avance,
               IFNULL(stake,1) AS stake,
               CASE WHEN result = 'win' THEN IFNULL(stake,1) * (odd_decimal - 1)
                    WHEN result = 'loss' THEN -IFNULL(stake,1) END AS pl
        FROM picks WHERE stake IS NOT NULL AND result IN ('win','loss') AND ts >= ? AND ts < ?
        ORDER BY ts DESC
      `).all(inicio, fin);
    } else {
      liquidadosRows = db.prepare(`
        SELECT id, ts, event, market, selection, odd_decimal, result, final_score,
               edge_learned AS edge, entry_minute,
               CASE WHEN result = 'win' THEN (odd_decimal - 1) WHEN result = 'loss' THEN -1 END AS pl
        FROM model_picks WHERE result IN ('win','loss') AND ts >= ? AND ts < ?
        ORDER BY ts DESC
      `).all(inicio, fin);
    }
    const liquidados = liquidadosRows.map(filaAImagenPick);

    // Estadisticas del encabezado: sobre TODO lo liquidado hoy, no solo la
    // pagina que se este dibujando — pedido explicito del usuario. En el
    // modelo aprendido (shadow) no hay stake real (nunca se apuesta), asi
    // que se asume 1u por pick, igual que ya hace el pl de la query de
    // arriba (odd_decimal - 1 / -1).
    const wins = liquidadosRows.filter(r => r.result === 'win').length;
    const losses = liquidadosRows.filter(r => r.result === 'loss').length;
    const decididos = wins + losses;
    const winrate = decididos ? (wins / decididos) * 100 : 0;
    const plTotal = liquidadosRows.reduce((k, r) => k + (r.pl || 0), 0);
    const apostado = view === 'table'
      ? liquidadosRows.reduce((k, r) => k + (r.stake || 1), 0)
      : decididos;
    const roi = apostado ? (plTotal / apostado) * 100 : 0;

    // Paginado: en un dia activo el modelo aprendido liquida cientos de
    // picks (216 visto el 2026-09-13), y una sola imagen con todos termina
    // tan alta que Telegram la comprime y sale pixelada — ilegible. Se
    // parte en paginas de MAX_POR_PAGINA, cada una su propia imagen, en vez
    // de una imagen gigante. Pedido explicito del usuario, mismo dia.
    const MAX_POR_PAGINA = 30;
    const paginas = [];
    for (let i = 0; i < liquidados.length; i += MAX_POR_PAGINA) paginas.push(liquidados.slice(i, i + MAX_POR_PAGINA));
    if (!paginas.length) paginas.push([]); // sin picks: manda una imagen vacia con el aviso de siempre

    // ID del reporte: fecha CDMX + vista + timestamp corto, comun a todas
    // las paginas de esta misma corrida — permite identificar cual imagen
    // pertenece a cual "tanda" enviada, pedido explicito del usuario
    // (encabezado institucional, 2026-09-13).
    const diaCDMX = new Date(Date.now() - 6 * 3600e3).toISOString().slice(0, 10).replace(/-/g, '');
    const reportId = `UH-${diaCDMX}-${view.toUpperCase()}-${Date.now().toString(36).toUpperCase()}`;
    const modeloNombre = view === 'model' ? 'Modelo aprendido (shadow)' : 'Heurístico (producción)';
    const fechaLegible = new Date(Date.now() - 6 * 3600e3).toLocaleDateString('es-MX', {
      timeZone: 'America/Mexico_City', day: '2-digit', month: '2-digit', year: 'numeric',
    });
    const tituloImagen = view === 'model'
      ? `Reporte de picks liquidados por el Modelo Learned — ${fechaLegible}`
      : `Reporte de picks liquidados por Heurístico — ${fechaLegible}`;

    const fs = require('fs');
    for (const [i, pagina] of paginas.entries()) {
      const paginaTag = paginas.length > 1 ? ` — página ${i + 1}/${paginas.length}` : '';
      const png = await renderPicksTableImagen(tituloImagen, pagina, [], view, {
        modelo: modeloNombre, pagina: i + 1, totalPaginas: paginas.length, reportId,
        stats: { winrate, pl: plTotal, apostado, roi },
      });
      await sendPhotoFile(TOKEN, chatId, png, `${view === 'table' ? '📋' : '🤖'} <b>${esc(tituloImagen)}${paginaTag}</b>`);
      fs.unlink(png, () => {});
    }
  } catch (e) {
    // e.stderr trae el traceback real de Python (e.message solo dice
    // "Command failed: ..."), indispensable para diagnosticar sin adivinar.
    console.error(`[unidades-hoy-img:${view}]`, e.stderr || e.message);
    await reply(chatId, `⚠️ No se pudo generar la imagen de ${esc(titulo)}. Detalle: ${esc(e.message)}`);
  }
}

// "Unidades Hoy" (boton 📋 / "/unidades hoy"): DOS imagenes 9:16, una por modelo
// (heuristico en produccion y learned en sombra), con el detalle pick a pick de lo
// liquidado hoy: hora del pick, partido, pick y cuota, edge, marcador y minuto al
// emitirlo, marcador final, resultado, P/L y el minuto en que murio si lo perdio. Mismo
// renderizador de tablas que la imagen de arranque (scripts/render-estado-sistema.py);
// datos armados por src/reportePicks.js. Pedido del usuario el 2026-09-24: reemplaza
// el menu de cuatro botones que habia antes (esas ramas siguen vivas por sus callbacks).
//
// Cabe un numero acotado de filas legibles en 1080x1920: UNIDADES_HOY_MAX_FILAS (25 por
// defecto) son las filas POR IMAGEN; si hay mas se envian varias paginas. Los picks van
// agrupados por mercado, con ganados y perdidos por separado (2026-09-25), y el encabezado
// cuenta emitidos, ganados y perdidos de todo el dia.
async function enviarUnidadesHoyImagenes(chatId) {
  const esc = str => String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const { sendPhotoFile } = require('./src/telegram');
  const { minutoDeMuerte, armarPaginas, MAX_FILAS_DEFECTO } = require('./src/reportePicks');
  const porPagina = Math.max(5, Number(process.env.UNIDADES_HOY_MAX_FILAS || MAX_FILAS_DEFECTO));
  const tz = 'America/Mexico_City';
  const ahora = new Date();
  const fechaRaw = ahora.toLocaleDateString('es-MX', { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const fecha = fechaRaw.replace(',', '').replace(/^./, c => c.toUpperCase());
  const hora = ahora.toLocaleTimeString('es-MX', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false });
  const { inicio, fin } = rangoHoyCDMX();
  const esFutbol = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim() === 'futbol';
  const horaPick = (ts) => new Date(ts).toLocaleTimeString('es-MX', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false });
  // Serie del marcador desde que se emitio el pick, leida del mercado del propio pick Y del de
  // resultado final (idx_snapshots_ems). El mercado de un "Menos de X" desaparece del feed justo
  // al cruzarse la linea, asi que solo con el suyo nunca se veria el gol decisivo; el 1X2 sigue
  // hasta el pitido y da el minuto exacto.
  const MERCADO_MARCADOR = 'Resultado Final (Tiempo Regular)';
  const muestrasStmt = db.prepare('SELECT score, live_time FROM snapshots WHERE event_id = ? AND ts >= ? AND market IN (?, ?) ORDER BY ts');
  // Marcador al momento del pick: la primera muestra del evento desde que se emitio (el heuristico no lo guarda;
  // el learned si, en entry_score, y solo cae aqui si esa columna viene vacia).
  const marcadorStmt = db.prepare('SELECT score FROM snapshots WHERE event_id = ? AND ts >= ? AND market IN (?, ?) AND score IS NOT NULL ORDER BY ts LIMIT 1');

  const modelos = [
    {
      nombre: 'Heurístico (producción)', emoji: '📊', extra: 'producción', textoFallback: enviarUnidadesHoyHeuristico,
      liquidados: `SELECT id, ts, event_id, event, sport, market, selection, odd_decimal, result, edge, f_avance, final_score,
                          IFNULL(stake,1) AS stake,
                          CASE WHEN result = 'win' THEN IFNULL(stake,1) * (odd_decimal - 1) WHEN result = 'loss' THEN -IFNULL(stake,1) END AS pl
                   FROM picks WHERE stake IS NOT NULL AND result IN ('win','loss') AND ts >= ? AND ts < ? ORDER BY ts DESC`,
      pendientes: `SELECT COUNT(*) n FROM picks WHERE stake IS NOT NULL AND result IS NULL AND ts >= ? AND ts < ?`,
      emitidos: `SELECT COUNT(*) n FROM picks WHERE stake IS NOT NULL AND ts >= ? AND ts < ?`,
      nota: 'P/L con el stake de cada pick · Min del pick estimado (~)',
    },
    {
      nombre: 'Learned (shadow)', emoji: '🔮', extra: 'shadow', textoFallback: enviarUnidadesHoyLearned,
      liquidados: `SELECT id, ts, event_id, event, sport, market, selection, odd_decimal, result, edge_learned AS edge, entry_minute, entry_score, final_score,
                          1 AS stake,
                          CASE WHEN result = 'win' THEN (odd_decimal - 1) WHEN result = 'loss' THEN -1 END AS pl
                   FROM model_picks WHERE result IN ('win','loss') AND ts >= ? AND ts < ? ORDER BY ts DESC`,
      pendientes: `SELECT COUNT(*) n FROM model_picks WHERE result IS NULL AND ts >= ? AND ts < ?`,
      emitidos: `SELECT COUNT(*) n FROM model_picks WHERE ts >= ? AND ts < ?`,
      nota: 'P/L a 1u plana por pick',
    },
  ];

  for (const m of modelos) {
    try {
      const rows = db.prepare(m.liquidados).all(inicio, fin);
      const pendientes = db.prepare(m.pendientes).get(inicio, fin).n;
      const emitidos = db.prepare(m.emitidos).get(inicio, fin).n;
      // Resumen sobre TODO lo liquidado hoy.
      const wins = rows.filter(r => r.result === 'win').length;
      const pl = rows.reduce((s, r) => s + (r.pl || 0), 0);
      const apostado = rows.reduce((s, r) => s + (r.stake || 1), 0);
      const resumen = { n: rows.length, wins, pl, apostado, roi: apostado ? 100 * pl / apostado : null, pendientes, emitidos };

      // Ahora se muestran TODOS (paginados), asi que todos se enriquecen (el minuto de muerte
      // cuesta una consulta por pick perdido).
      const picks = rows.map(r => {
        const futbol = esFutbol(r.sport);
        let minutoPick = null, minutoPickAprox = false;
        if (r.entry_minute != null) minutoPick = Math.round(r.entry_minute);
        else if (futbol && r.f_avance != null) { minutoPick = Math.round(r.f_avance * 90); minutoPickAprox = true; }
        const muerte = r.result === 'loss' ? minutoDeMuerte(r, muestrasStmt.all(r.event_id, r.ts, r.market, MERCADO_MARCADOR)) : null;
        const marcadorPick = r.entry_score || marcadorStmt.get(r.event_id, r.ts, r.market, MERCADO_MARCADOR)?.score || null;
        return { ...r, hora: horaPick(r.ts), marcadorPick, minutoPick, minutoPickAprox, muerte };
      });

      const paginas = armarPaginas({
        subtitulo: `Picks de hoy · ${m.nombre.split(' ')[0]}`, extra: m.extra, fecha, hora, picks, resumen, porPagina, notaPie: m.nota,
      });
      const fmtU = v => `${v >= 0 ? '+' : ''}${v.toFixed(2)}u`;
      const perdidos = rows.length - wins;
      const captionBase = `${m.emoji} <b>${esc(m.nombre)} — Unidades Hoy</b>
` +
        `${emitidos} emitidos` +
        (rows.length
          ? ` · ✅ ${wins} ganados · ❌ ${perdidos} perdidos · <b>${fmtU(pl)}</b>${resumen.roi != null ? ` · ROI ${resumen.roi >= 0 ? '+' : ''}${resumen.roi.toFixed(1)}%` : ''}`
          : ' · aún no hay picks liquidados hoy') +
        `${pendientes ? ` · ${pendientes} en juego` : ''}`;
      for (const [i, datos] of paginas.entries()) {
        const png = await renderPanelEstadoImagen(datos);
        const caption = paginas.length > 1 ? `${captionBase}
<i>Página ${i + 1}/${paginas.length}</i>` : captionBase;
        await sendPhotoFile(TOKEN, chatId, png, caption);
        fs.unlink(png, () => {});
      }
    } catch (e) {
      // Sin Python/Pillow o con un fallo de datos, este modelo cae al resumen de texto de siempre;
      // el otro modelo se intenta igual.
      console.error(`[unidades-hoy-imagenes:${m.nombre}]`, e.stderr || e.message);
      try { await m.textoFallback(chatId); } catch (e2) { console.error('[unidades-hoy-imagenes] fallback de texto:', e2.message); }
    }
  }
}

async function handlePendientes(chatId) {
  const esc = str => String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const rows = getPendingPicksDetailed();
  const sombra = getPendingModelPicksDetailed();

  if (!rows.length && !sombra.length) {
    return reply(chatId, '✅ <b>No hay picks pendientes.</b>\n\nTodo lo emitido está liquidado, y la sombra del modelo también.');
  }

  // El sampler ve cada evento cada SAMPLE_MINUTES. Si hace más de 25 min que no
  // aparece, el partido ya no está en vivo: acabó y espera al liquidador, o el
  // proveedor lo retiró. En ambos casos el marcador de abajo es el último visto,
  // no el actual, y hay que decirlo en vez de fingir que es en vivo.
  const STALE_MIN = 25;
  const now = Date.now();
  const MAX_SHOWN = 20;

  const live = [];
  const stale = [];
  for (const p of rows) {
    const ageMin = p.last_seen_ts ? (now - new Date(p.last_seen_ts).getTime()) / 60000 : Infinity;
    (ageMin > STALE_MIN ? stale : live).push({ ...p, ageMin });
  }

  function renderOne(p, idx) {
    const flag = getCountryFlag(p.champ, p.event, p.sport);
    const hora = p.ts ? new Date(p.ts).toLocaleTimeString('es-MX', { timeZone: 'America/Mexico_City', hour: '2-digit', minute: '2-digit', hour12: false }) : '';

    // Semáforo por movimiento de cuota: es lo único que sirve como termómetro
    // transversal a todos los mercados. Cuota que baja = mercado moviéndose a
    // favor de la selección. Sin cuota actual no se inventa un veredicto.
    let estado = '⚪ sin lectura';
    if (p.current_odd && p.odd_decimal) {
      const delta = (p.current_odd - p.odd_decimal) / p.odd_decimal;
      const pct = (delta * 100).toFixed(0);
      if (delta <= -0.08) estado = `🟢 a favor (${pct}%)`;
      else if (delta >= 0.08) estado = `🔴 en contra (+${pct}%)`;
      else estado = `🟡 estable (${delta >= 0 ? '+' : ''}${pct}%)`;
    }

    // JERARQUIA: el semaforo (¿va a favor o en contra?) es lo PRIMARIO de un
    // pick que ya esta en juego — es la unica pregunta que importa mientras
    // se espera. El pick y el partido son contexto para identificarlo.
    let out = `${idx + 1}. ${estado}\n`;
    out += `   🎯 <b>${esc(p.market)}: ${esc(p.selection)} @ ${p.odd_decimal.toFixed(2)}</b> <i>(ahora ${p.current_odd ? p.current_odd.toFixed(2) : '—'})</i>\n`;
    out += `   ${flag} #${p.id} · ${esc(p.event.trim())} <i>[${hora}]</i>\n`;
    out += `   Stake ${(p.stake || 1).toFixed(1)}u · Marcador ${esc(p.live_score || '—')}`;
    if (p.live_time) out += ` <i>(${esc(String(p.live_time).split('—')[0].trim())})</i>`;
    out += `\n`;
    return out;
  }

  const enJuego = rows.reduce((k, p) => k + (p.stake || 1), 0);
  let msg = `<b>⏳ PICKS PENDIENTES DE LIQUIDAR</b>\n`;
  msg += `<i>${rows.length} picks · ${enJuego.toFixed(2)}u en juego</i>\n`;
  if (!rows.length) msg += `\n<i>Nada emitido sin liquidar.</i>\n`;
  msg += `\n`;

  if (live.length) {
    msg += `<b>🔴 EN VIVO (${live.length})</b>\n\n`;
    for (const [i, p] of live.slice(0, MAX_SHOWN).entries()) msg += renderOne(p, i) + '\n';
    if (live.length > MAX_SHOWN) msg += `<i>… y ${live.length - MAX_SHOWN} más en vivo.</i>\n\n`;
  }

  if (stale.length) {
    const restante = Math.max(0, MAX_SHOWN - live.length);
    msg += `<b>🏁 SIN SEÑAL / ESPERANDO LIQUIDACIÓN (${stale.length})</b>\n`;
    msg += `<i>El partido ya no aparece en el feed. El marcador es el último visto.</i>\n\n`;
    for (const [i, p] of stale.slice(0, restante).entries()) {
      msg += renderOne(p, i);
      msg += `   <i>Sin señal desde hace ${Math.round(p.ageMin)} min</i>\n\n`;
    }
    if (stale.length > restante) msg += `<i>… y ${stale.length - restante} más esperando liquidación.</i>\n\n`;
  }

  // Bloque de sombra. Va al final y visualmente separado a proposito: son picks
  // NO apostados. Mezclarlos con los reales en la misma lista invitaria a
  // leerlos como exposicion, que es exactamente lo que no son.
  if (sombra.length) {
    msg += `\n\n\u{1F916} <b>MODELO APRENDIDO (sombra — no apostados)</b>\n`;
    msg += `<i>${sombra.length} sin liquidar · 0u en juego</i>\n\n`;
    for (const [i, p] of sombra.slice(0, 10).entries()) {
      const flag = getCountryFlag(p.champ, p.event, p.sport);
      const hora = p.ts ? new Date(p.ts).toLocaleTimeString('es-MX', { timeZone: 'America/Mexico_City', hour: '2-digit', minute: '2-digit', hour12: false }) : '';
      let estado = '⚪ sin lectura';
      if (p.current_odd && p.odd_decimal) {
        const delta = (p.current_odd - p.odd_decimal) / p.odd_decimal;
        const pctd = (delta * 100).toFixed(0);
        if (delta <= -0.08) estado = `🟢 a favor (${pctd}%)`;
        else if (delta >= 0.08) estado = `🔴 en contra (+${pctd}%)`;
        else estado = `🟡 estable (${delta >= 0 ? '+' : ''}${pctd}%)`;
      }
      msg += `${p.tambien_heuristico ? '\u{1F91D}' : '\u{1F916}'} <b>${i + 1}. ${flag} ${esc(p.event.trim())}</b> <i>[${hora}]</i>\n`;
      msg += `   ${esc(p.market)}: <b>${esc(p.selection)}</b> @ ${p.odd_decimal.toFixed(2)}\n`;
      msg += `   Marcador: <b>${esc(p.live_score || '—')}</b>`;
      if (p.live_time) msg += ` <i>(${esc(String(p.live_time).split('—')[0].trim())})</i>`;
      msg += `\n   Cuota ahora: <b>${p.current_odd ? p.current_odd.toFixed(2) : '—'}</b> → ${estado}\n`;
    }
    if (sombra.length > 10) msg += `<i>… y ${sombra.length - 10} más en sombra.</i>\n`;
  }

  msg += `\n💡 <i>Usa /pick &lt;id&gt; para la ficha completa de cualquiera.</i>`;
  await reply(chatId, msg);
}

// Cinturon generico contra un await que no resuelve nunca. Con FotMob no hay
// Chromium compartido que colgar (ver src/fotmobScraper.js), pero cada fetch
// ya lleva su propio AbortSignal.timeout — este cinturon es la red de
// seguridad de mas afuera. El bot procesa los mensajes de Telegram EN SERIE
// (poll() hace `await handleMessage`), asi que un solo await sin tope aqui no
// cuelga solo /fotmob: cuelga el bot ENTERO para siempre. Costo real el
// 2026-09-10 (con el piloto anterior, SofaScore): asi paso.
function conTope(promesa, ms) {
  return Promise.race([
    promesa,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout ${ms}ms`)), ms)),
  ]);
}

// Tope por mensaje en el bucle de escucha de Telegram. poll() atiende los
// updates EN SERIE, asi que un solo handler colgado (un fetch sin timeout, una
// captura de Playwright que no vuelve) dejaba al bot sordo a TODO: el
// 2026-09-19 "Deportes" se atasco en un sendPhoto sin timeout y ningun comando
// respondio durante 1.5 h. Pasado el tope el handler se ABANDONA (Promise.race
// no lo cancela: sigue en segundo plano y contestara si termina) y el bucle
// vuelve a escuchar. 180s por defecto: /train y /validar pueden tardar minutos
// de verdad y no deben cortarse por poco.
const TELEGRAM_HANDLER_MAX_MS = Number(process.env.TELEGRAM_HANDLER_MAX_MS || 180000);
async function atender(etiqueta, promesa) {
  try {
    await conTope(promesa, TELEGRAM_HANDLER_MAX_MS);
  } catch (e) {
    if (!/^timeout/.test(e.message)) throw e;
    console.error(`[poll] "${etiqueta}" excedio ${TELEGRAM_HANDLER_MAX_MS}ms; se abandona para no bloquear la escucha (sigue en segundo plano)`);
  }
}

// ---------- /fotmob: partidos EN VIVO con córners en las dos fuentes ----------
// Piloto de solo lectura (src/fotmobMatch.js): NO emite ni apuesta nada. Antes
// mostraba solo lo ya LIQUIDADO (getFotmobComparadas) — pero esa etiqueta
// llegaba a 0 filas siempre (ver el fix de enriquecerConFotmob el 2026-09-10,
// entonces enriquecerConSofa), asi que el comando se quedaba mudo la mayor
// parte del tiempo. Ahora muestra el conteo EN VIVO de cada partido con
// córners muestreados, aun sin liquidar: el inferido de playdoit
// (stat_snapshots) junto al real de FotMob (fotmob_corner_snapshots), si
// logro emparejarse.
async function handleFotmob(chatId) {
  const esc = str => String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // Un evento pendiente puede tener varias familias muestreadas (corner,
  // tarjeta); nos quedamos con la ULTIMA fila de corner por evento — el
  // conteo inferido se repite igual en todas las lineas de un mismo instante
  // (ver derivarEtiquetas en src/matchStats.js), asi que una sola basta.
  const eventos = [];
  for (const eventId of getStatEventosPendientes()) {
    const muestras = getStatMuestras(eventId);
    let ultima = null;
    for (const m of muestras) {
      if (m.familia === 'corner' && m.conteo != null) ultima = m; // muestras vienen ordenadas por ts
    }
    if (!ultima) continue;

    // Segunda estimacion, INDEPENDIENTE del N-esimo: invierte el mercado de
    // totales (Mas/Menos de X.5) del MISMO instante que `ultima`. Validado
    // contra FotMob el 2026-09-17 sobre 22 instantes de 6 partidos: error
    // promedio 0.59 corners contra 2.23 del N-esimo (el N-esimo se congela
    // cuando la casa no cierra los indices bajos a tiempo — ver el hallazgo
    // de esa fecha). Se excluyen filas suspendidas: un mercado cerrado cerca
    // del final da precios basura que invierten a cualquier cosa.
    const filasLinea = muestras
      .filter(m => m.familia === 'corner' && m.ts === ultima.ts && m.lado === 'under'
        && m.fair_prob != null && m.suspended === 0)
      .map(m => ({ fairProbUnder: m.fair_prob, linea: m.linea, minuto: ultima.minute }));
    ultima.estimadoMercado = conteoEstimadoDeMercado(filasLinea);

    eventos.push(ultima);
  }

  if (!eventos.length) {
    return reply(chatId, '🔗 <b>FotMob — sin partidos en vivo con córners todavía.</b>');
  }

  let conMatch = 0, coinciden = 0;
  // Si el primer intento se topa con el timeout, la fuente probablemente
  // esta lenta o degradada — insistir con los eventos que siguen solo suma
  // otro timeout por cada uno y alarga el comando sin ganar nada. Se corta
  // ahi.
  let fotmobLento = false;
  const lineas = [];
  for (const ev of eventos) {
    let sf = 'sin match FotMob';
    let marca = '⚪';
    if (fotmobLento) {
      sf = 'FotMob lento, sin tiempo para emparejar';
    } else try {
      const match = await conTope(matchFotmobEvent({ event: ev.event, ts: ev.ts, minute: ev.minute }), 8000);
      if (match) {
        const latest = getFotmobCornerLatest(match.fotmobEvent.id);
        if (latest) {
          conMatch++;
          const diff = Math.abs(latest.total - ev.conteo);
          marca = diff <= 1 ? '✅' : '⚠️';
          if (diff <= 1) coinciden++;
          sf = `<b>${latest.total}</b> (${latest.home}-${latest.away}) <i>${esc(latest.status || '—')}</i>`;
        } else {
          sf = 'emparejado, sin muestra FotMob aún';
        }
      }
    } catch (e) {
      console.error('[fotmob:live]', e.message);
      if (/^timeout/.test(e.message)) fotmobLento = true;
    }

    lineas.push(`<b>${esc(ev.event)}</b> <i>[${esc(ev.champ || '')}]</i> — min ${ev.minute ?? '—'}\n` +
      `   Playdoit (línea ${ev.linea}): <b>${ev.conteo}</b>\n` +
      `   Mercado (invertido): <b>${ev.estimadoMercado ?? '—'}</b>\n` +
      `   FotMob: ${sf} ${marca}\n`);
  }

  let msg = `<b>🔗 FOTMOB — PARTIDOS EN VIVO (córners)</b>\n`;
  msg += `<i>${eventos.length} partido(s) en vivo · ${conMatch} emparejado(s) con FotMob · ✅ ${coinciden} coinciden (±1)</i>\n\n`;
  msg += lineas.join('\n');
  msg += `\n💡 <i>Conteo en vivo, aún SIN liquidar. Diagnóstico del pilotaje, no emite ni apuesta nada.</i>`;
  msg += `\n🧮 <i>"Mercado" = estimado invirtiendo el mercado de totales, de referencia (más preciso que el N-ésimo en la validación del 2026-09-17, pero todavía no reemplaza nada).</i>`;
  await reply(chatId, msg);
}

// Grafica de pastel via QuickChart (mismo patron que sendDailyPerformanceChart
// en src/telegram.js: config de Chart.js codificado en la URL, sin libreria
// de graficas propia ni Chromium de por medio). Antes era una lista de texto;
// con la variedad de deportes que llegan a estar en vivo a la vez, un pastel
// se lee de un vistazo donde la lista habia que leerla entera.
async function handleDeportes(chatId) {
  await reply(chatId, '⏳ Consultando...');
  const { rows } = await getFreshRows();
  const { excludedSports } = require('./src/confidence');
  const { sendPhotoTelegram } = require('./src/telegram');
  const normSport = s => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
  const vetados = new Set(excludedSports());

  const counts = {};
  for (const r of rows) {
    if (vetados.has(normSport(r.sport))) continue; // deportes vetados fuera del pastel
    counts[r.sport] = (counts[r.sport] || 0) + 1;
  }
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (!entries.length) return reply(chatId, 'No hay jugadas en vivo (fuera de los deportes vetados) ahora mismo.');

  const PALETTE = ['#2ed573', '#1e90ff', '#ffa502', '#ff4757', '#a55eea', '#26de81', '#fd9644', '#45aaf2', '#fc5c65', '#778ca3', '#f7b731', '#20bf6b'];
  const total = entries.reduce((s, [, n]) => s + n, 0);
  const chartConfig = {
    type: 'pie',
    data: {
      labels: entries.map(([name]) => name),
      datasets: [{ data: entries.map(([, n]) => n), backgroundColor: entries.map((_, i) => PALETTE[i % PALETTE.length]) }],
    },
    options: {
      title: { display: true, text: `Deportes en vivo — ${total} jugadas`, fontColor: '#d4d4d4', fontSize: 14 },
      legend: { position: 'right', labels: { fontColor: '#abb2bf' } },
    },
  };
  const chartUrl = `https://quickchart.io/chart?bkg=181a1f&w=700&h=420&c=${encodeURIComponent(JSON.stringify(chartConfig))}`;
  const caption = `<b>⚽ Deportes en vivo</b>\n<i>${total} jugadas · ${entries.length} deportes (vetados excluidos)</i>`;
  await sendPhotoTelegram(TOKEN, chatId, chartUrl, caption);
}

// ---------- /vip: gestión de membresías y canal VIP ----------
async function handleVip(chatId, fromUser) {
  if (!VIP_CHANNEL_ID) {
    return sendTelegram(TOKEN, chatId, '⚠️ La suscripción VIP aún no está configurada en .env (falta TELEGRAM_VIP_CHANNEL_ID).');
  }

  const userId = fromUser ? fromUser.id : chatId;
  const sub = getSubscriber(userId);
  let statusText = '';
  if (sub && sub.status === 'active' && new Date(sub.expires_at) > new Date()) {
    const expDate = new Date(sub.expires_at).toLocaleDateString('es-MX', { timeZone: 'America/Mexico_City' });
    statusText = `✅ <b>Tienes una suscripción VIP ACTIVA</b>\nActiva hasta: <b>${expDate}</b>\n\n`;
    if (sub.invite_link) {
      statusText += `👉 Tu enlace de acceso al Canal VIP: <a href="${sub.invite_link}">Unirme al Canal VIP</a>\n\n`;
    }
  }

  const priceStars = VIP_PRICE_STARS;
  const days = Number(process.env.VIP_DURATION_DAYS || 30);
  const infoText = `${statusText}⭐ <b>Membresía VIP - Playdoit Monitor</b>\n\n` +
    `Obtén acceso directo al <b>Canal Privado VIP</b> con todas las señales en tiempo real:\n` +
    `• Picks automáticos instantáneos (+EV)\n` +
    `• Picks Dorados de máxima certidumbre\n` +
    `• Parlays compuestos optimizados\n\n` +
    `💰 <b>Precio:</b> ${priceStars} Estrellas Telegram / ${days} días\n\n` +
    `Presiona el botón de pago nativo de Telegram a continuación:`;

  try {
    const res = await fetch(`${API}/sendInvoice`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        title: 'Membresía VIP (30 Días)',
        description: `Acceso exclusivo al Canal VIP Privado por ${days} días.`,
        payload: `vip_monthly_${userId}_${Date.now()}`,
        provider_token: '',
        currency: 'XTR',
        prices: [{ label: 'VIP 30 Días', amount: priceStars }],
        start_parameter: 'vip-access'
      })
    });
    const data = await res.json();
    if (!data.ok) {
      await sendTelegram(TOKEN, chatId, infoText);
    }
  } catch (e) {
    await sendTelegram(TOKEN, chatId, infoText);
  }
}

async function handleSuccessfulPayment(msg) {
  const fromUser = msg.from;
  const chatId = msg.chat.id;
  const days = Number(process.env.VIP_DURATION_DAYS || 30);

  let inviteLink = '';
  if (VIP_CHANNEL_ID) {
    try {
      const resLink = await fetch(`${API}/createChatInviteLink`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: VIP_CHANNEL_ID,
          member_limit: 1,
          expire_date: Math.floor(Date.now() / 1000) + 86400
        })
      });
      const linkData = await resLink.json();
      if (linkData.ok) {
        inviteLink = linkData.result.invite_link;
      }
    } catch (e) {
      console.error('[createChatInviteLink error]', e.message);
    }
  }

  addSubscriber(fromUser.id, fromUser.username, fromUser.first_name, days, inviteLink);

  let welcomeMsg = `🎉 <b>¡Pago recibido con éxito! Bienvenido a la Membresía VIP.</b>\n\n` +
    `Tu suscripción estará activa durante <b>${days} días</b>.\n\n`;

  if (inviteLink) {
    welcomeMsg += `Aquí tienes tu enlace exclusivo e intransferible (1 solo uso) para unirte al Canal VIP Privado:\n\n` +
      `👉 <a href="${inviteLink}">UNIRME AL CANAL VIP AHORA</a>\n\n` +
      `<i>Nota: Este enlace caducará tras unirte o en 24 horas. ¡Mucho éxito!</i>`;
  } else {
    welcomeMsg += `Tu cuenta ha sido activada en el sistema VIP.`;
  }

  await sendTelegram(TOKEN, chatId, welcomeMsg);
}

async function checkExpiredSubscribers() {
  if (!VIP_CHANNEL_ID) return;
  const expired = getExpiredSubscribers();
  for (const sub of expired) {
    try {
      await fetch(`${API}/banChatMember`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: VIP_CHANNEL_ID, user_id: sub.telegram_id })
      });
      await fetch(`${API}/unbanChatMember`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: VIP_CHANNEL_ID, user_id: sub.telegram_id, only_if_banned: true })
      });
      setSubscriberStatus(sub.telegram_id, 'expired');
      console.log(`[vip-expire] Suscriptor ${sub.telegram_id} (${sub.username}) removido del Canal VIP.`);

      const renewMsg = `⚠️ <b>Tu suscripción al Canal VIP ha finalizado.</b>\n\n` +
        `Hemos removido tu acceso al Canal VIP Privado. Si deseas renovar tu acceso por 30 días más, presiona el botón ⭐ Membresía VIP o envía /vip.`;
      await sendTelegram(TOKEN, sub.telegram_id, renewMsg).catch(() => {});
    } catch (e) {
      console.error(`[vip-expire error ${sub.telegram_id}]`, e.message);
    }
  }
}

// Antes: teclado de respuesta PERSISTENTE pegado abajo del chat en cada mensaje. Desde el 2026-09-25 la botonera
// va SOLO cuando se manda /botonera, como botones EN LINEA dentro del mensaje (BOTONERA). MAIN_KEYBOARD se conserva
// con este nombre porque ~8 envios lo pasan como reply_markup: ahora es la orden de QUITAR el teclado fijo viejo
// (los clientes que aun lo tienen lo pierden en el primer mensaje del bot; en los demas no hace nada).
const MAIN_KEYBOARD = { remove_keyboard: true };

const BOTONERA_FILAS = [
  ['🛡️ Seguras', '🥇 Pick Dorado', '🎰 Parlay +EV'],
  ['🎯 Top Momios', '💰 Unidades', '📋 Unidades Hoy'],
  ['⭐ Membresía VIP', '📊 Rendimiento', '📈 Gráfica del Día'],
  // /pick <id> no entra aquí: necesita un número como argumento y un botón no puede llevarlo.
  ['⚽ Deportes', '🩺 Salud Modelo', '🔍 Validar'],
  ['⏳ Pendientes', '🔗 FotMob', '❓ Ayuda'],
  ['⏱️ Parlay Próximos', '📆 Unidades Ayer', '🕐 Gráfica de Ayer'],
];
// Solo se muestra al dueño. Los comandos igual se revalidan con isOwner(): esto solo evita ensuciar la botonera
// de los suscriptores con botones que responderian "reservado al administrador". /reboot NO va: un toque
// accidental reiniciaria el bot.
const BOTONERA_FILA_ADMIN = ['📅 Pre-partido', '🤖 Reentrenar', '🖥️ Panel', '🧪 Experimentos'];
// Indices estables: las filas generales primero, luego la de administrador (callback_data = 'bt:<indice>').
const BOTONERA_ETIQUETAS = [...BOTONERA_FILAS.flat(), ...BOTONERA_FILA_ADMIN];
// Comando de cada etiqueta nueva (las anteriores ya estan en labelMap, mas abajo).
const BOTONES_NUEVOS = {
  '⏱️ Parlay Próximos': '/parlayprox', 'Parlay Próximos': '/parlayprox',
  '📆 Unidades Ayer': '/unidades ayer', 'Unidades Ayer': '/unidades ayer',
  '🕐 Gráfica de Ayer': '/dia ayer', 'Gráfica de Ayer': '/dia ayer',
  '📅 Pre-partido': '/prematch', 'Pre-partido': '/prematch',
  '🖥️ Panel': '/panel', 'Panel': '/panel',
  '🧪 Experimentos': '/experimentos', 'Experimentos': '/experimentos',
};
// callback_data = 'bt:<indice>' (limite de 64 bytes; asi no depende del texto ni de los emojis).
function botoneraPara(chatId) {
  const filas = isOwner(chatId) ? [...BOTONERA_FILAS, BOTONERA_FILA_ADMIN] : BOTONERA_FILAS;
  let n = 0;
  return { inline_keyboard: filas.map(fila => fila.map(text => ({ text, callback_data: `bt:${n++}` }))) };
}

// chatId se pasa explícito en cada llamada — antes dependía de una variable
// global mutable (currentChatId) que un mensaje concurrente podía pisar
// mientras un handler estaba en medio de un await, respondiendo al chat
// equivocado. Cada handler ahora recibe su propio chatId por parámetro.
async function reply(chatId, text, showKeyboard = true) {
  await sendTelegram(TOKEN, chatId || CHAT_ID, text, showKeyboard ? MAIN_KEYBOARD : null);
}

async function handleStart(chatId, fromUser) {
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const name = fromUser && fromUser.first_name ? esc(fromUser.first_name) : 'Apostador';

  const welcomeMsg = `👋 <b>¡Bienvenido a Playdoit Monitor AI, ${name}!</b>\n\n` +
    `Soy tu asistente inteligente de apuestas deportivas en vivo. Monitorizo las cuotas y marcadores en tiempo real para encontrar <b>esperanza matemática positiva (+EV)</b> y darte ventaja frente a la casa.\n\n` +
    `<b>🚀 ¿Qué puedes hacer aquí?</b>\n` +
    `• 🛡️ <b>Picks Seguros:</b> Jugadas con mayor certidumbre y probabilidad en vivo.\n` +
    `• 🥇 <b>Pick Dorado:</b> La selección del momento con máximo valor (+EV).\n` +
    `• 🎰 <b>Parlay +EV:</b> Combinadas de 2 o 3 patas analizadas sin cuotas -EV.\n` +
    `• 💰 <b>Gestión de Unidades:</b> Control estricto de banca y métricas históricas.\n` +
    `• ⭐ <b>Canal VIP Privado:</b> Notificaciones automáticas instantáneas en vivo.\n\n` +
    `<b>💡 ¿Cómo comenzar?</b>\n` +
    `Manda <b>/botonera</b> para abrir los botones táctiles y explorar el sistema o presiona <b>⭐ Membresía VIP</b> para acceder al Canal Privado.\n\n` +
    `<i>¡Mucho éxito en tus jugadas! 🎯</i>`;

  await sendTelegram(TOKEN, chatId, welcomeMsg, MAIN_KEYBOARD);
}

// ---------- Panel web (dashboard API, puerto 3001) ----------
// No es solo la UI: ese proceso corre el setInterval que dispara las alertas de
// Telegram, asi que su vida es la de las alertas automaticas.
//
// SOBREVIVE AL REINICIO DEL BOT. Antes se lanzaba como hijo NO desacoplado y,
// ademas, un handler de 'exit' lo mataba a proposito para no dejar el puerto
// ocupado. El efecto colateral era grave y poco visible: cada reinicio del bot
// —y el supervisor de run-bot.cmd reinicia ante cualquier caida— se llevaba por
// delante el panel Y con el las alertas de PROFIT_LOCK, POSITION_DYING y
// STRUCTURAL_DRAW, sin que nada lo dijera. El 2026-09-04 se conto: cinco veces
// en una sesion de trabajo.
//
// Ahora se lanza DESACOPLADO (detached + unref) y el bot nuevo, en vez de
// necesitar el puerto libre, ADOPTA el panel que ya este vivo. El problema que
// resolvia matarlo —un huerfano bloqueando el puerto— se resuelve mejor
// reconociendolo: si el lock apunta a un proceso vivo y el puerto responde, es
// nuestro panel y no hay nada que levantar.
const DASHBOARD_PORT = Number(process.env.DASHBOARD_PORT || 3001);
const DASHBOARD_ENTRY = path.join(__dirname, 'dist', 'server', 'dashboardApi.js');

// DASHBOARD_AUTOSTART=1 hace que el bot se ocupe del panel al arrancar. Con la
// adopcion ya implementada eso equivale a AUTO-REPARARLO: si sigue vivo lo
// adopta y no hace nada; si murio por su cuenta, lo vuelve a levantar. Es la
// forma de que el panel —y con el las alertas automaticas— deje de depender de
// que alguien mande /dashboard despues de cada incidente.
// Por defecto APAGADO: levantar un servidor HTTP sin que nadie lo pida es un
// efecto secundario que debe elegirse, no heredarse.
const DASHBOARD_AUTOSTART = process.env.DASHBOARD_AUTOSTART === '1';
const DASHBOARD_LOG = path.join(__dirname, 'dashboard.log');
// Lock del panel, en el mismo estilo que .bot.lock: "<pid> <iso>". Es lo que
// permite que un bot recien arrancado reconozca al panel que dejo vivo el bot
// anterior, en vez de pelearse con el por el puerto.
const DASHBOARD_LOCK = path.join(__dirname, '.dashboard.lock');
let dashboardProc = null;

const { pidAlive } = require('./src/singleInstance');

function leerLockPanel() {
  try {
    const raw = fs.readFileSync(DASHBOARD_LOCK, 'utf8').trim();
    const pid = Number(raw.split(/\s+/)[0]);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch { return null; }
}
function escribirLockPanel(pid) {
  try { fs.writeFileSync(DASHBOARD_LOCK, `${pid} ${new Date().toISOString()}\n`); } catch {}
}
function borrarLockPanel() {
  try { fs.unlinkSync(DASHBOARD_LOCK); } catch {}
}

/** PID del panel vivo — el que lanzamos nosotros o el que adoptamos del lock. */
function dashboardPid() {
  if (dashboardProc !== null && dashboardProc.exitCode === null && !dashboardProc.signalCode) {
    return dashboardProc.pid;
  }
  const pid = leerLockPanel();
  return pid && pidAlive(pid) ? pid : null;
}

function dashboardAlive() {
  return dashboardPid() !== null;
}

// El puerto puede estar tomado por un dashboard que este bot NO lanzó (otra
// cuenta de Windows, o un hijo huérfano de un bot anterior que murió por
// taskkill /F sin ejecutar su limpieza). Comprobarlo evita responder "arrancado"
// cuando en realidad el proceso nuevo murió al instante al no poder enlazar.
//
// Se sondea con listen(port) SIN host, exactamente como enlaza createDashboardServer:
// el dashboard escucha en '::' (dual-stack), y un sondeo a '127.0.0.1' devolvía
// "libre" con el puerto ocupado. Cualquier error cuenta como no disponible, no
// solo EADDRINUSE: si el dueño del socket es otro usuario de Windows, el error
// es EACCES, y da igual la causa — si este sondeo no puede enlazar, el dashboard
// tampoco podrá.
function portUnavailable(port) {
  return new Promise(resolve => {
    const s = net.createServer();
    s.once('error', () => resolve(true));
    s.once('listening', () => s.close(() => resolve(false)));
    s.listen(port);
  });
}

async function startDashboard() {
  const vivoPid = dashboardPid();
  if (vivoPid) {
    return `ℹ️ El panel ya está corriendo (PID ${vivoPid}) en http://localhost:${DASHBOARD_PORT}`;
  }
  if (!fs.existsSync(DASHBOARD_ENTRY)) {
    return `⚠️ No existe <code>dist/server/dashboardApi.js</code>. Compila con <code>npx tsc</code> y reintenta.`;
  }
  if (await portUnavailable(DASHBOARD_PORT)) {
    // El lock no apuntaba a nada vivo pero el puerto SI esta tomado: es un panel
    // que no lanzamos nosotros (otra cuenta de Windows, o uno arrancado a mano).
    // No se mata: se avisa. Matar procesos ajenos por ocupar un puerto es peor
    // que no arrancar.
    return `⚠️ El puerto ${DASHBOARD_PORT} está ocupado por un proceso que este bot no lanzó.\n` +
           `Puede ser un panel de otra sesión o arrancado a mano. Ciérralo antes de reintentar.`;
  }

  const out = fs.openSync(DASHBOARD_LOG, 'a');
  // detached + unref: el panel deja de colgar del ciclo de vida del bot. Sin
  // esto, en Windows el hijo se va con el padre al hacer Stop-Process /F.
  const child = spawn(process.execPath, [DASHBOARD_ENTRY], {
    cwd: __dirname, windowsHide: true, stdio: ['ignore', out, out], detached: true,
  });
  child.unref();
  dashboardProc = child;
  escribirLockPanel(child.pid);
  child.on('exit', (code, signal) => {
    console.log(`[dashboard] terminó (code=${code}, signal=${signal})`);
    if (dashboardProc === child) dashboardProc = null;
    // Solo se limpia el lock si sigue siendo el nuestro: si otro panel lo
    // reclamo mientras tanto, borrarlo lo dejaria invisible para el proximo bot.
    if (leerLockPanel() === child.pid) borrarLockPanel();
  });

  // Dar un margen para que falle rápido (EADDRINUSE, error de require, etc.)
  // en vez de anunciar un arranque que no ocurrió.
  await new Promise(r => setTimeout(r, 1500));
  if (!dashboardAlive()) {
    return `⚠️ El panel murió al arrancar. Revisa <code>dashboard.log</code>.`;
  }
  return `✅ Panel arrancado (PID ${child.pid}) en http://localhost:${DASHBOARD_PORT}\n` +
         `Las alertas automáticas vuelven a estar activas.`;
}

// Mata POR PID, no por el handle del hijo: el panel puede haberlo lanzado un bot
// anterior y este solo haberlo adoptado, en cuyo caso no hay handle que matar.
function stopDashboard() {
  const pid = dashboardPid();
  if (!pid) return 'ℹ️ El panel no está corriendo.';
  try { process.kill(pid); } catch (e) {
    return `⚠️ No se pudo detener el panel (PID ${pid}): ${e.message}`;
  }
  dashboardProc = null;
  borrarLockPanel();
  return `🛑 Panel detenido (PID ${pid}). Las alertas automáticas quedan suspendidas.`;
}

// NO se mata el panel al salir. Es justo lo contrario de lo que hacia antes, y
// es el objetivo del cambio: que un reinicio del bot no se lleve las alertas por
// delante. El panel queda vivo y el siguiente bot lo adopta por el lock.
// Para pararlo de verdad esta /dashboard off.

async function handleDashboard(args, chatId) {
  const sub = (args[0] || '').toLowerCase();
  if (sub === 'off' || sub === 'stop' || sub === 'apagar') {
    return reply(chatId, stopDashboard());
  }
  if (sub === 'status' || sub === 'estado') {
    const pid = dashboardPid();
    if (pid) {
      const propio = dashboardProc && dashboardProc.pid === pid;
      return reply(chatId, `✅ Panel activo (PID ${pid}${propio ? '' : ', adoptado de un arranque anterior'}) ` +
                           `en http://localhost:${DASHBOARD_PORT}`);
    }
    const busy = await portUnavailable(DASHBOARD_PORT);
    return reply(chatId, busy
      ? `⚠️ El puerto ${DASHBOARD_PORT} está ocupado, pero no por este bot.`
      : '🛑 Panel apagado. Manda /dashboard para levantarlo.');
  }
  await reply(chatId, '⏳ Levantando el panel...');
  return reply(chatId, await startDashboard());
}

// ─────────────────────────────────────────────────────────────────────────
// Túnel público (cloudflared) — expone el panel fuera de localhost. Mismo
// patrón que el panel: lock file, adopta lo que ya esté vivo, se lanza
// detached para no caerse con el bot. Sin cuenta de Cloudflare la URL es
// efímera (quick tunnel de trycloudflare.com): cambia cada vez que se
// reinicia el túnel, por eso se guarda en el lock y se manda por Telegram al
// levantarlo — si no, habría que ir a buscarla al log a mano.
const TUNNEL_AUTOSTART = process.env.TUNNEL_AUTOSTART === '1';
const TUNNEL_LOG = path.join(__dirname, 'tunnel.log');
const TUNNEL_LOCK = path.join(__dirname, '.tunnel.lock');
let tunnelProc = null;
let tunnelUrlCache = null;

function findCloudflaredExe() {
  const candidatos = [
    'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe',
    'C:\\Program Files\\cloudflared\\cloudflared.exe',
  ];
  for (const c of candidatos) {
    if (fs.existsSync(c)) return c;
  }
  return 'cloudflared'; // si no está en ninguna ruta conocida, se prueba vía PATH
}
const CLOUDFLARED_EXE = findCloudflaredExe();

function leerLockTunel() {
  try {
    const raw = fs.readFileSync(TUNNEL_LOCK, 'utf8').trim();
    const [pidStr, url] = raw.split(/\s+/);
    const pid = Number(pidStr);
    return Number.isInteger(pid) && pid > 0 ? { pid, url: url || null } : null;
  } catch { return null; }
}
function escribirLockTunel(pid, url) {
  try { fs.writeFileSync(TUNNEL_LOCK, `${pid} ${url} ${new Date().toISOString()}\n`); } catch {}
}
function borrarLockTunel() {
  try { fs.unlinkSync(TUNNEL_LOCK); } catch {}
}

function tunnelInfo() {
  if (tunnelProc !== null && tunnelProc.exitCode === null && !tunnelProc.signalCode) {
    return { pid: tunnelProc.pid, url: tunnelUrlCache };
  }
  const lock = leerLockTunel();
  return lock && pidAlive(lock.pid) ? lock : null;
}

// La URL sale por stdout de cloudflared unos segundos después de arrancar.
// stdio va directo a un fd de archivo (igual que el panel), así que no hay
// stream que leer en vivo desde acá: se sondea el log hasta encontrarla.
//
// tunnel.log es acumulativo (se abre en modo 'a' entre arranques), así que
// buscar la PRIMERA url del archivo entero devuelve la de un arranque viejo
// — se detectó en producción: el lock quedó apuntando a una url ya muerta
// mientras el proceso nuevo servía otra. `fromByte` acota la búsqueda a lo
// que se escribió DESPUÉS de lanzar este proceso.
function esperarUrlTunel(logPath, timeoutMs, fromByte = 0) {
  return new Promise(resolve => {
    const start = Date.now();
    const check = () => {
      try {
        const contenido = fs.readFileSync(logPath, 'utf8').slice(fromByte);
        const m = contenido.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
        if (m) return resolve(m[0]);
      } catch {}
      if (Date.now() - start > timeoutMs) return resolve(null);
      setTimeout(check, 500);
    };
    check();
  });
}

async function startTunnel() {
  const vivo = tunnelInfo();
  if (vivo) {
    return `ℹ️ El túnel ya está corriendo (PID ${vivo.pid})${vivo.url ? `\n${vivo.url}` : ''}`;
  }

  let offset = 0;
  try { offset = fs.statSync(TUNNEL_LOG).size; } catch {}

  const out = fs.openSync(TUNNEL_LOG, 'a');
  const child = spawn(CLOUDFLARED_EXE, ['tunnel', '--url', `http://localhost:${DASHBOARD_PORT}`], {
    cwd: __dirname, windowsHide: true, stdio: ['ignore', out, out], detached: true,
  });
  child.unref();
  tunnelProc = child;
  child.on('exit', (code, signal) => {
    console.log(`[tunnel] terminó (code=${code}, signal=${signal})`);
    if (tunnelProc === child) tunnelProc = null;
    const lock = leerLockTunel();
    if (lock && lock.pid === child.pid) borrarLockTunel();
  });

  const url = await esperarUrlTunel(TUNNEL_LOG, 15000, offset);
  if (!url) {
    return `⚠️ El túnel arrancó (PID ${child.pid}) pero no se pudo leer la URL de <code>tunnel.log</code>. Revisa el archivo a mano.`;
  }
  tunnelUrlCache = url;
  escribirLockTunel(child.pid, url);
  const auth = process.env.DASHBOARD_USER && process.env.DASHBOARD_PASS
    ? '\n\n🔒 Pide usuario y contraseña (DASHBOARD_USER/DASHBOARD_PASS en .env).'
    : '\n\n⚠️ Sin DASHBOARD_USER/DASHBOARD_PASS en .env: el panel queda ABIERTO a cualquiera con la URL.';
  return `✅ Túnel arrancado (PID ${child.pid})\n${url}${auth}`;
}

// Igual que stopDashboard: mata por PID, no por el handle del hijo, porque
// el túnel puede haberlo lanzado un bot anterior y este solo haberlo adoptado.
function stopTunnel() {
  const info = tunnelInfo();
  if (!info) return 'ℹ️ El túnel no está corriendo.';
  try { process.kill(info.pid); } catch (e) {
    return `⚠️ No se pudo detener el túnel (PID ${info.pid}): ${e.message}`;
  }
  tunnelProc = null;
  tunnelUrlCache = null;
  borrarLockTunel();
  return `🛑 Túnel detenido (PID ${info.pid}).`;
}

async function handleTunnel(args, chatId) {
  const sub = (args[0] || '').toLowerCase();
  if (sub === 'off' || sub === 'stop' || sub === 'apagar') {
    return reply(chatId, stopTunnel());
  }
  if (sub === 'status' || sub === 'estado') {
    const info = tunnelInfo();
    return reply(chatId, info
      ? `✅ Túnel activo (PID ${info.pid})${info.url ? `\n${info.url}` : ''}`
      : '🛑 Túnel apagado. Manda /tunnel para levantarlo.');
  }
  await reply(chatId, '⏳ Levantando el túnel (puede tardar unos segundos)...');
  return reply(chatId, await startTunnel());
}

// Enfriamiento de la botonera: el mismo boton, del mismo chat, dos veces en
// menos de 10s se ignora la segunda vez. poll() atiende los mensajes EN
// SERIE (un await tras otro) — un doble-tap impaciente en "Unidades Hoy" (se
// vio en vivo el 2026-09-12, 3 pulsaciones en menos de 2s) no duplica el
// trabajo, lo ENCOLA: cada pulsacion extra espera a que la anterior termine
// antes de siquiera empezar a leer, y con la BD bajo contencion (escrituras
// de decenas de segundos, documentado aparte) eso deja comandos completamente
// distintos —como /pendientes, mandado despues— atorados detras de una fila
// de comandos identicos que no aportan nada nuevo. Solo aplica a botones de
// la botonera (labelMap abajo), no a comandos escritos a mano: quien teclea
// /top dos veces seguidas probablemente quiere argumentos distintos.
const BOTON_COOLDOWN_MS = 10000;
const ultimoComandoBoton = new Map(); // chatId -> { cmd, ts }

async function handleMessage(rawText, chatId = CHAT_ID, fromUser = null) {
  chatId = chatId || CHAT_ID;
  let text = rawText.trim();
  const normRaw = norm(text);
  const cleanLabel = norm(text.replace(/[\p{Extended_Pictographic}\p{Emoji_Presentation}\u{200d}\u{fe0f}\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F600}-\u{1F64F}]/gu, '')).trim();

  const labelMap = {
    '🛡️ seguras': '/seguras',
    'seguras': '/seguras',
    '🥇 pick dorado': '/golden',
    'pick dorado': '/golden',
    'golden': '/golden',
    '🎰 parlay +ev': '/parlay',
    'parlay +ev': '/parlay',
    'parlay': '/parlay',
    '🎯 top momios': '/top',
    'top momios': '/top',
    'top': '/top',
    '💰 unidades': '/unidades',
    'unidades': '/unidades',
    '📋 unidades hoy': '/unidades hoy',
    'unidades hoy': '/unidades hoy',
    '⭐ membresia vip': '/vip',
    'membresia vip': '/vip',
    'suscripcion vip': '/vip',
    'vip': '/vip',
    '📊 rendimiento': '/stats',
    'rendimiento': '/stats',
    'stats': '/stats',
    '📈 grafica del dia': '/dia',
    'grafica del dia': '/dia',
    'dia': '/dia',
    '⚽ deportes': '/deportes',
    'deportes': '/deportes',
    '🩺 salud modelo': '/health',
    'salud modelo': '/health',
    'health': '/health',
    '🔍 validar': '/validar',
    'validar': '/validar',
    '🤖 reentrenar': '/train',
    'reentrenar': '/train',
    'train': '/train',
    '⏳ pendientes': '/pendientes',
    'pendientes': '/pendientes',
    '🔗 fotmob': '/fotmob',
    'fotmob': '/fotmob',
    'sofascore': '/fotmob',
    'sofa': '/fotmob',
    '❓ ayuda': '/help',
    'ayuda': '/help',
    'help': '/help',
  };

  for (const [etq, comando] of Object.entries(BOTONES_NUEVOS)) labelMap[norm(etq)] = comando;
  const vieneDeBotonera = !!(labelMap[normRaw] || labelMap[cleanLabel]);
  if (labelMap[normRaw]) {
    text = labelMap[normRaw];
  } else if (labelMap[cleanLabel]) {
    text = labelMap[cleanLabel];
  }

  const parts = text.split(/\s+/);
  const cmd = norm(parts[0]).replace(/@.*$/, '');
  const args = parts.slice(1);

  if (vieneDeBotonera) {
    const ahora = Date.now();
    const cmdClave = [cmd, ...args].join(' '); // '/unidades' y '/unidades ayer' son botones distintos
    const previo = ultimoComandoBoton.get(chatId);
    if (previo && previo.cmd === cmdClave && (ahora - previo.ts) < BOTON_COOLDOWN_MS) {
      console.log(`[botonera] ${cmd} ignorado (repetido a ${ahora - previo.ts}ms del anterior, chat ${chatId})`);
      return;
    }
    ultimoComandoBoton.set(chatId, { cmd: cmdClave, ts: ahora });
  }

  try {
    const pickMatch = text.trim().match(/^(?:\/pick|\/ticket|#)?\s*(\d+)$/i);
    if (pickMatch && (cmd === '/pick' || cmd === '/ticket' || /^(?:#)?\d+$/.test(text.trim()))) {
      const { sendPickInspectorCard } = require('./src/telegram');
      await sendPickInspectorCard(TOKEN, chatId, parseInt(pickMatch[1], 10));
    } else if (cmd === '/top') await handleTop(args, chatId);
    else if (cmd === '/seguras') await handleSeguras(args, chatId);
    else if (cmd === '/golden') await handleGolden(args, chatId);
    else if (cmd === '/parlay') await handleParlay(args, chatId);
    else if (cmd === '/stats') await handleStats(chatId);
    else if (cmd === '/health') await handleHealth(chatId);
    else if (cmd === '/unidades') await handleUnidades(args, chatId);
    else if (cmd === '/dia') {
      const { sendDailyPerformanceChart } = require('./src/telegram');
      await sendDailyPerformanceChart(TOKEN, chatId, args[0]);
    }
    else if (cmd === '/validar') await handleValidar(args, chatId);
    else if (cmd === '/parlayprox') await handleParlayProximos(args, chatId);
    // Estado de los picks experimentales (corners y rescate): solo lectura, pero solo al dueño porque esos
    // avisos también van solo a él y los resultados de un experimento no son para los suscriptores.
    else if (cmd === '/experimentos') {
      if (!isOwner(chatId)) await reply(chatId, '🔒 Comando reservado al administrador.');
      else await handleExperimentos(chatId);
    }
    // Vista previa del reporte de las 08:00: solo al dueno, sin guardar patas ni tocar el canal VIP.
    else if (cmd === '/prematch') {
      if (!isOwner(chatId)) await reply(chatId, '🔒 Comando reservado al administrador.');
      else {
        await reply(chatId, '⏳ Armando el reporte pre-partido...');
        try {
          const r = await enviarReportePrematch({ chatIds: [chatId], persistir: false });
          if (!r.enviado) await reply(chatId, `ℹ️ ${r.motivo}`);
        } catch (e) { await reply(chatId, `⚠️ No se pudo armar el reporte: ${e.message}`); }
      }
    }
    // /train y /dashboard lanzan procesos en la máquina: solo el dueño.
    else if (cmd === '/train') {
      if (!isOwner(chatId)) await reply(chatId, '🔒 Comando reservado al administrador.');
      else await handleTrain(chatId);
    }
    else if (cmd === '/dashboard' || cmd === '/panel') {
      if (!isOwner(chatId)) await reply(chatId, '🔒 Comando reservado al administrador.');
      else await handleDashboard(args, chatId);
    }
    else if (cmd === '/tunnel' || cmd === '/tunel') {
      if (!isOwner(chatId)) await reply(chatId, '🔒 Comando reservado al administrador.');
      else await handleTunnel(args, chatId);
    }
    // /reboot tumba el proceso: solo el dueño. Sin esta guarda cualquier chat
    // podría reiniciar el bot en bucle, que es un apagado gratis.
    else if (cmd === '/reboot' || cmd === '/reiniciar') {
      if (!isOwner(chatId)) await reply(chatId, '🔒 Comando reservado al administrador.');
      else await handleReboot(chatId);
    }
    else if (cmd === '/pendientes') await handlePendientes(chatId);
    // Diagnostico interno del pilotaje (src/fotmobMatch.js), no un producto
    // para suscriptores. Boton visible en la botonera a peticion, pero el
    // dato mismo queda reservado al dueno — mismo patron que /train y /dashboard.
    else if (cmd === '/fotmob') {
      if (!isOwner(chatId)) await reply(chatId, '🔒 Comando reservado al administrador.');
      else await handleFotmob(chatId);
    }
    else if (cmd === '/deportes') await handleDeportes(chatId);
    else if (cmd === '/vip') await handleVip(chatId, fromUser);
    else if (cmd === '/start') await handleStart(chatId, fromUser);
    else if (cmd === '/botonera') await sendTelegram(TOKEN, chatId, '🎛️ <b>Botonera</b> — toca una opción:', botoneraPara(chatId));
    else if (cmd === '/help') await sendTelegram(TOKEN, chatId, HELP, MAIN_KEYBOARD);
    else await sendTelegram(TOKEN, chatId, `Comando no reconocido.\n\n${HELP}`, MAIN_KEYBOARD);
  } catch (e) {
    console.error('[error]', e.message);
    try { await sendTelegram(TOKEN, chatId, `⚠️ Error: ${e.message}`); } catch {}
  }
}

async function registerCommands() {
  try {
    // Timeout obligatorio: sin AbortSignal, un fetch de Node que SI conecta
    // pero nunca responde se queda colgado para siempre (mismo motivo que en
    // sendTelegram, ver src/telegram.js). Esta llamada corre ANTES del
    // mensaje de arranque y del loop de polling (poll() la espera primero),
    // asi que un cuelgue aqui deja el bot entero mudo desde el primer
    // segundo, sin ningun error en el log — encontrado el 2026-09-11 tras un
    // reinicio donde el bot no volvio a responder en Telegram.
    await fetch(`${API}/setMyCommands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(15000),
      body: JSON.stringify({
        commands: [
          { command: 'seguras', description: 'Top 3 jugadas con mayor probabilidad' },
          { command: 'golden', description: 'Pick dorado (máximo edge)' },
          { command: 'parlay', description: 'Combos sugeridos (+EV verificado)' },
          { command: 'vip', description: 'Membresía y acceso al Canal VIP' },
          { command: 'top', description: 'Top 10 momios más bajos' },
          { command: 'unidades', description: 'Rendimiento por unidades y días' },
          { command: 'stats', description: 'Tasa de acierto y métricas' },
          { command: 'pendientes', description: 'Picks sin liquidar y su estado actual' },
          { command: 'deportes', description: 'Deportes en vivo ahora' },
          { command: 'health', description: 'Salud del modelo (drift)' },
          { command: 'validar', description: 'Validar resultados con oficial' },
          { command: 'train', description: 'Reentrenar modelo' },
          { command: 'botonera', description: 'Botonera de botones en el chat' },
          { command: 'help', description: 'Ayuda y lista de comandos' },
        ]
      })
    });
  } catch (e) {
    console.error('[setMyCommands error]', e.message);
  }
}

// Offset de getUpdates, persistido en disco para sobrevivir a reinicios.
// Un fichero y no la BD: no depende del esquema ni de que SQLite este sano, y
// esto tiene que funcionar incluso si la base esta bloqueada o corrupta.
const OFFSET_FILE = path.join(__dirname, '.telegram-offset');
function leerOffset() {
  try {
    const n = Number(fs.readFileSync(OFFSET_FILE, 'utf8').trim());
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch { return 0; }   // primer arranque o fichero ilegible: desde el principio
}
let ultimoGuardado = 0;
function guardarOffset(n) {
  if (n <= ultimoGuardado) return;
  try { fs.writeFileSync(OFFSET_FILE, String(n)); ultimoGuardado = n; }
  catch (e) { console.error('[offset] no se pudo guardar:', e.message); }
}

/**
 * Panel de estado al arrancar: bot, dashboard, FotMob. Antes el mensaje de
 * arranque era un solo "activo, Botonera lista" que no decia nada sobre si el
 * panel web seguia vivo o si el piloto de FotMob estaba prendido — habia
 * que preguntarlo con /dashboard o revisar el log a mano. Se arma UNA vez,
 * aqui, en vez de en cada reinicio a ciegas.
 *
 * Todo lo que consulta es barato (PID vivo, una fila de la BD): nada de esto
 * puede colgar el arranque del bot.
 */
function construirPanelEstadoTexto() {
  const horaArranque = new Date().toLocaleTimeString('es-MX', { timeZone: 'America/Mexico_City', hour: '2-digit', minute: '2-digit', hour12: false });

  let msg = `🩺 <b>ESTADO DEL SISTEMA</b> <i>(${horaArranque})</i>\n\n`;

  // ── Bot ──
  msg += `🤖 <b>Bot</b>: ✅ activo\n`;
  msg += `   Muestreo cada ${SAMPLE_MINUTES} min · Modelo: <b>${getMode()}</b> · Auto-picks: ${AUTO_PICKS ? 'ON' : 'OFF'}\n\n`;

  // ── Dashboard ──
  const panelVivo = dashboardAlive();
  if (panelVivo) {
    msg += `📊 <b>Dashboard</b>: ✅ activo — http://localhost:${DASHBOARD_PORT} (PID ${dashboardPid()})\n\n`;
  } else {
    msg += `📊 <b>Dashboard</b>: ⚫ apagado${DASHBOARD_AUTOSTART ? ' (se debería autoarrancar solo; si sigue apagado, revisar dashboard.log)' : ' — manda /dashboard para levantarlo'}\n\n`;
  }

  // ── FotMob ──
  if (FOTMOB_PILOT) {
    let ultimaCaptura = null, capturas24h = 0;
    try {
      ultimaCaptura = db.prepare('SELECT MAX(ts) ts FROM fotmob_corner_snapshots').get()?.ts || null;
      capturas24h = db.prepare(
        "SELECT COUNT(DISTINCT fotmob_event_id) n FROM fotmob_corner_snapshots WHERE ts >= datetime('now','-1 day')"
      ).get()?.n || 0;
    } catch (e) {
      console.error('[panel-estado] fotmob query:', e.message);
    }
    const minsDesde = ultimaCaptura ? Math.round((Date.now() - new Date(ultimaCaptura).getTime()) / 60000) : null;
    // Si la ultima captura tiene mas margen que un par de ciclos, algo se
    // colgo — no basta con decir "activo", hay que decirlo en rojo.
    const rancio = minsDesde != null && minsDesde > FOTMOB_MINUTES * 3;
    msg += `🔗 <b>FotMob</b>: ${rancio ? '🟡' : '✅'} activo — cada ${FOTMOB_MINUTES} min`;
    msg += minsDesde != null
      ? `, última captura hace ${minsDesde} min (${capturas24h} partidos/24h)\n`
      : `, aún sin ninguna captura\n`;
  } else {
    msg += `🔗 <b>FotMob</b>: ⚫ apagado (FOTMOB_PILOT=0)\n`;
  }

  return msg;
}

/**
 * Mismos datos que construirPanelEstadoTexto(), como objeto plano en vez de
 * HTML — lo consume render-estado-sistema.py para dibujar el panel como
 * imagen (pedido del usuario el 2026-09-12, con su propio codigo de
 * Pillow). Se mantienen las DOS formas (texto y datos) porque el texto sigue
 * siendo el respaldo si Python/Pillow fallan al arrancar — un arranque no
 * puede quedar mudo solo porque la imagen no se pudo dibujar.
 */
function construirPanelEstadoDatos() {
  const tz = 'America/Mexico_City';
  const ahora = new Date();
  const hora = ahora.toLocaleTimeString('es-MX', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false });
  const fechaRaw = ahora.toLocaleDateString('es-MX', { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const fecha = fechaRaw.replace(',', '').replace(/^./, c => c.toUpperCase());

  // Umbrales de MONITOREO de los pilotos (los mismos del chequeo horario): cuantos
  // eventos hacen falta antes de que el primer analisis tenga peso estadistico.
  const UMBRAL_STEAM = 300, UMBRAL_SHARP = 20, UMBRAL_XG = 30;

  // Cada consulta va protegida: una tabla o una consulta que falle deja "—" en
  // esa celda, no tumba el panel de arranque entero.
  const q = (sql, ...params) => { try { return db.prepare(sql).get(...params) || {}; } catch (e) { console.error('[panel-estado]', e.message); return {}; } };
  const hace = (ts) => {
    if (!ts) return 'sin datos';
    const m = Math.round((Date.now() - Date.parse(ts)) / 60000);
    if (!Number.isFinite(m)) return 'sin datos';
    return m < 90 ? `${Math.max(m, 0)} min` : m < 2880 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} d`;
  };
  const minsDesde = (ts) => (ts ? (Date.now() - Date.parse(ts)) / 60000 : null);
  const iso = (ms) => new Date(ms).toISOString();
  const desde24h = iso(Date.now() - 24 * 3600e3), desde7d = iso(Date.now() - 7 * 24 * 3600e3), desde72h = iso(Date.now() - 72 * 3600e3);
  const pill = (t, tone) => ({ t, tone, pill: true });
  const flat = (r) => (r.result === 'win' ? r.odd_decimal - 1 : r.result === 'loss' ? -1 : 0);
  const signo = (x, d = 1) => `${x >= 0 ? '+' : ''}${x.toFixed(d)}`;

  // ---------- indicadores ----------
  const picks24 = q('SELECT COUNT(*) n FROM picks WHERE ts >= ?', desde24h).n ?? 0;
  const pendientes = q('SELECT COUNT(*) n FROM picks WHERE result IS NULL AND ts >= ?', desde72h).n ?? 0;
  let pl24 = 0;
  try { pl24 = db.prepare("SELECT odd_decimal, result FROM picks WHERE settled_ts >= ? AND result IN ('win','loss')").all(desde24h).reduce((s, r) => s + flat(r), 0); } catch (e) { console.error('[panel-estado]', e.message); }
  const ramLibreGb = os.freemem() / 1e9;
  const kpis = [
    { label: 'Picks 24 h', value: String(picks24) },
    { label: 'Pendientes', value: String(pendientes) },
    { label: 'P/L 24 h', value: `${signo(pl24)}u`, tone: pl24 > 0 ? 'ok' : pl24 < 0 ? 'bad' : null },
    { label: 'RAM libre', value: `${ramLibreGb.toFixed(1)} GB`, tone: ramLibreGb < 1 ? 'bad' : ramLibreGb < 2 ? 'warn' : 'ok' },
  ];

  // ---------- servicios ----------
  const servicios = [];
  servicios.push(['Bot', pill('ACTIVO', 'ok'), `cada ${SAMPLE_MINUTES} min · ${getMode()} · auto ${AUTO_PICKS ? 'ON' : 'OFF'}`]);
  servicios.push(dashboardAlive()
    ? ['Dashboard', pill('ACTIVO', 'ok'), `localhost:${DASHBOARD_PORT} · PID ${dashboardPid()}`]
    : ['Dashboard', pill('APAGADO', 'off'), `auto-arranque ${DASHBOARD_AUTOSTART ? 'ON' : 'OFF'}`]);
  const ultSnap = q('SELECT MAX(ts) ts FROM snapshots').ts;
  const minSnap = minsDesde(ultSnap);
  servicios.push(['Muestreador', pill(minSnap != null && minSnap <= SAMPLE_MINUTES * 4 ? 'ACTIVO' : 'DEMORADO', minSnap != null && minSnap <= SAMPLE_MINUTES * 4 ? 'ok' : 'warn'), `último ciclo hace ${hace(ultSnap)}`]);
  const maxCred = Number(process.env.SHARP_MAX_CREDITS_PER_DAY || 15);
  const usados = q('SELECT credits FROM sharp_budget WHERE day = ?', iso(Date.now()).slice(0, 10)).credits ?? 0;
  servicios.push(['The Odds API',
    !process.env.ODDS_API_KEY ? pill('SIN CLAVE', 'off') : usados > maxCred ? pill('EXCEDIDO', 'bad') : usados === maxCred ? pill('AGOTADO', 'warn') : pill('ACTIVO', 'ok'),
    `créditos hoy ${usados}/${maxCred}`]);
  let dbGb = null;
  try { dbGb = fs.statSync(process.env.DB_PATH || path.join(__dirname, 'snapshots.db')).size / 1e9; } catch { /* sin tamaño */ }
  servicios.push(['Base de datos', pill(dbGb == null ? 'SIN DATOS' : dbGb > 20 ? 'GRANDE' : 'ACTIVO', dbGb == null ? 'off' : dbGb > 20 ? 'warn' : 'ok'),
    dbGb == null ? '—' : `snapshots.db ${dbGb.toFixed(1)} GB`]);

  // ---------- pilotos ----------
  const pilotos = [];
  const fila = (nombre, activo, cadencia, ts, progreso, demoradoSi) => {
    if (!activo) return [nombre, pill('APAGADO', 'off'), '—', '—', progreso || '—'];
    const m = minsDesde(ts);
    const rancio = demoradoSi != null && m != null && m > demoradoSi;
    return [nombre, pill(rancio ? 'DEMORADO' : 'ACTIVO', rancio ? 'warn' : 'ok'), cadencia, ts ? hace(ts) : '—', progreso];
  };
  {
    const r = FOTMOB_PILOT ? q("SELECT MAX(ts) ts, COUNT(DISTINCT CASE WHEN ts >= ? THEN fotmob_event_id END) n FROM fotmob_corner_snapshots", desde24h) : {};
    pilotos.push(fila('FotMob corners', FOTMOB_PILOT, `${FOTMOB_MINUTES} min`, r.ts, `${r.n ?? 0} partidos/24 h`, FOTMOB_MINUTES * 3));
  }
  {
    const r = PREMATCH_PILOT ? q('SELECT MAX(ts) ts FROM prematch_snapshots') : {};
    const c = PREMATCH_PILOT ? q("SELECT COUNT(*) n FROM (SELECT event_id FROM prematch_snapshots WHERE start_date < strftime('%Y-%m-%dT%H:%M:%SZ','now') GROUP BY event_id HAVING COUNT(DISTINCT ts) >= 2)").n ?? 0 : 0;
    pilotos.push(fila('Steam pre-partido', PREMATCH_PILOT, `${PREMATCH_MINUTES} min`, r.ts, `${c} / ${UMBRAL_STEAM} curvas`, PREMATCH_MINUTES * 3));
  }
  {
    const r = PREMATCH_SHARP_SCAN ? q('SELECT MAX(ts) ts, COUNT(DISTINCT event_id) n FROM prematch_value_scan') : {};
    const c = PREMATCH_SHARP_SCAN ? q("SELECT COUNT(DISTINCT event_id) n FROM prematch_value_scan WHERE start_date < strftime('%Y-%m-%dT%H:%M:%SZ','now')").n ?? 0 : 0;
    pilotos.push(fila('Valor sharp', PREMATCH_SHARP_SCAN, `${Math.round(PREMATCH_SHARP_SCAN_MINUTES / 60)} h`, r.ts, `${c} / ${UMBRAL_SHARP} · ${r.n ?? 0} escaneados`, PREMATCH_SHARP_SCAN_MINUTES * 3));
  }
  {
    const r = PREMATCH_XG_PILOT ? q('SELECT MAX(ts) ts, SUM(xg_esperado_total IS NOT NULL) n FROM prematch_xg_scan') : {};
    const c = PREMATCH_XG_PILOT ? q("SELECT COUNT(*) n FROM prematch_xg_scan WHERE xg_esperado_total IS NOT NULL AND start_date < strftime('%Y-%m-%dT%H:%M:%SZ','now')").n ?? 0 : 0;
    pilotos.push(fila('xG pre-partido', PREMATCH_XG_PILOT, `${Math.round(PREMATCH_XG_MINUTES / 60)} h`, r.ts, `${r.n ?? 0} con xG · ${c} / ${UMBRAL_XG}`, PREMATCH_XG_MINUTES * 3));
  }
  {
    const r = EXEC_PROBE ? q('SELECT MAX(probe_ts) ts, SUM(probe_ts >= ?) n FROM pick_exec_probe', desde24h) : {};
    pilotos.push(fila('Sonda ejecución', EXEC_PROBE, '10-60 s', r.ts, `${r.n ?? 0} sondeos/24 h`, null));
  }
  {
    const r = STATS_PILOT ? q('SELECT MAX(ts) ts FROM stat_snapshots') : {};
    pilotos.push(fila('Estadísticas', STATS_PILOT, `${STATS_MINUTES} min`, r.ts, STATS_PILOT ? 'corners y tarjetas' : 'STATS_PILOT=0', STATS_MINUTES * 4));
  }

  // ---------- umbrales vigentes ----------
  const pct = (x) => `${Math.round(Number(x) * 1000) / 10}%`;
  const umbrales = [
    ['MIN_CONF', String(process.env.MIN_CONF ?? '—'), 'Modelo', getMode()],
    ['Edge heurístico', `${pct(process.env.MIN_EDGE ?? 0)} – ${pct(process.env.MAX_EDGE ?? 0.2)}`, 'Stake', String(process.env.STAKE_MODE || 'half_kelly')],
    ['Edge learned', `hasta ${pct(process.env.MAX_EDGE_LEARNED ?? process.env.MAX_EDGE ?? 0.2)}`, 'Firewall', /^(0|false|off|no)$/i.test(process.env.FIREWALL_ENABLED || '') ? 'OFF' : 'ON'],
    ['Cuota', `${process.env.MIN_ODDS ?? '—'} – ${process.env.PICK_MAX_ODDS ?? '—'}`, 'Piso de avance', String(process.env.FIREWALL_MIN_AVANCE ?? '—')],
  ];

  // ---------- rendimiento (stake plano 1u; el de 24 h es ruido, se lee el de 7 d) ----------
  const rendimiento = [];
  for (const [nombre, tabla] of [['Heurístico', 'picks'], ['Learned', 'model_picks']]) {
    let r24 = [], r7 = [];
    try {
      r24 = db.prepare(`SELECT odd_decimal, result FROM ${tabla} WHERE settled_ts >= ? AND result IN ('win','loss')`).all(desde24h);
      r7 = db.prepare(`SELECT odd_decimal, result FROM ${tabla} WHERE settled_ts >= ? AND result IN ('win','loss')`).all(desde7d);
    } catch (e) { console.error('[panel-estado]', e.message); }
    const pl24m = r24.reduce((s, r) => s + flat(r), 0), pl7 = r7.reduce((s, r) => s + flat(r), 0);
    const wr7 = r7.length ? (100 * r7.filter(r => r.result === 'win').length / r7.length) : null;
    const roi7 = r7.length ? 100 * pl7 / r7.length : null;
    rendimiento.push([
      nombre,
      `${r24.length} · ${signo(pl24m)}u`,
      r7.length ? `${r7.length} · WR ${wr7.toFixed(0)}%` : 'sin datos',
      roi7 == null ? '—' : { t: `${signo(roi7)}%`, tone: roi7 > 0 ? 'ok' : roi7 < 0 ? 'bad' : null },
    ]);
  }

  return {
    header: { titulo: 'VIEJITOBOT', subtitulo: 'Estado del sistema', fecha, hora, zona: 'CDMX', extra: 'arranque del bot' },
    kpis,
    sections: [
      { title: 'Servicios', columns: [{ name: 'Servicio', w: 0.25 }, { name: 'Estado', w: 0.19, align: 'center' }, { name: 'Detalle', w: 0.56 }], rows: servicios },
      { title: 'Pilotos', columns: [{ name: 'Piloto', w: 0.25 }, { name: 'Estado', w: 0.15, align: 'center' }, { name: 'Cada', w: 0.11 }, { name: 'Última', w: 0.13 }, { name: 'Progreso', w: 0.36 }], rows: pilotos },
      { title: 'Umbrales vigentes', columns: [{ name: 'Parámetro', w: 0.27 }, { name: 'Valor', w: 0.23 }, { name: 'Parámetro', w: 0.27 }, { name: 'Valor', w: 0.23 }], rows: umbrales },
      { title: 'Rendimiento · stake plano 1u', columns: [{ name: 'Modelo', w: 0.22 }, { name: 'Últimas 24 h', w: 0.27 }, { name: 'Últimos 7 días', w: 0.29 }, { name: 'ROI 7 d', w: 0.22, align: 'right' }], rows: rendimiento },
    ],
    footer: 'Pilotos de solo lectura · el ROI de 24 h es ruido, lee el de 7 días',
  };
}

/**
 * Renderiza el panel de estado como PNG via scripts/render-estado-sistema.py
 * y devuelve la ruta del archivo generado. Lanza si python/Pillow no estan
 * disponibles o el script falla — quien llama decide el respaldo.
 */
async function renderPanelEstadoImagen(datos) {
  const tmpDir = path.join(__dirname, 'scratch');
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
  const entrada = path.join(tmpDir, `_panel_estado_${process.pid}.json`);
  const salida = path.join(tmpDir, `_panel_estado_${process.pid}.png`);
  fs.writeFileSync(entrada, JSON.stringify(datos));
  try {
    await execFileP('python', [path.join(__dirname, 'scripts', 'render-estado-sistema.py'), entrada, salida],
      { timeout: 15000, windowsHide: true });
    return salida;
  } finally {
    fs.unlink(entrada, () => {});
  }
}

async function poll() {
  await registerCommands();
  // Imagen primero (pedido del usuario, 2026-09-12); si Python/Pillow fallan
  // o el proceso no esta disponible en esta maquina, cae al texto de
  // siempre — el arranque no puede quedar mudo por una imagen que no se
  // pudo dibujar.
  try {
    const png = await renderPanelEstadoImagen(construirPanelEstadoDatos());
    const { sendPhotoFile } = require('./src/telegram');
    await sendPhotoFile(TOKEN, CHAT_ID, png, undefined, MAIN_KEYBOARD);
    fs.unlink(png, () => {});
  } catch (e) {
    console.error('[startup notify] fallo la imagen del panel, uso texto:', e.message);
    try {
      await reply(CHAT_ID, construirPanelEstadoTexto(), true);
    } catch (e2) {
      console.error('[startup notify error]', e2.message);
    }
  }
  // OFFSET PERSISTENTE. Antes vivía solo en memoria y arrancaba en 0.
  //
  // Telegram da por entregada una actualizacion cuando pides la SIGUIENTE con
  // un offset mayor. /reboot llama a process.exit() antes de esa llamada, asi
  // que la propia orden de reiniciar nunca se confirmaba: al arrancar, el bot
  // pedia desde 0, volvia a leer /reboot y se reiniciaba otra vez.
  //
  // Bucle infinito, medido el 2026-08-28: el bot se reinicio cada ~7 min
  // durante media hora replicando el mismo /reboot, sin atender nada. Lo mismo
  // pasaria tras cualquier crash o kill.
  //
  // El offset se guarda ANTES de atender el mensaje, no despues: si el proceso
  // muere a mitad se pierde ESA orden, que es mucho mejor que repetirla para
  // siempre. Un /reboot perdido se vuelve a mandar; uno repetido tumba el bot.
  let offset = leerOffset();
  console.log(`Bot escuchando comandos de Telegram... (offset ${offset})`);
  while (true) {
    try {
      const res = await fetch(`${API}/getUpdates?timeout=50&offset=${offset}`, { signal: AbortSignal.timeout(60000) });
      const data = await res.json();
      if (!data.ok) throw new Error(data.description);
      for (const u of data.result) {
        offset = u.update_id + 1;
        guardarOffset(offset);   // ANTES de atender: ver el comentario de arriba

        if (u.callback_query) {
          const cq = u.callback_query;
          // answerCallbackQuery es obligatorio: sin el, el boton se queda con
          // el reloj de "cargando" girando en el cliente de Telegram hasta
          // que expira solo. Va ANTES de procesar para no hacer esperar al
          // usuario por el reporte completo antes de quitarle el spinner.
          fetch(`${API}/answerCallbackQuery`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ callback_query_id: cq.id }),
            signal: AbortSignal.timeout(10000),
          }).catch(e => console.error('[callback_query] answer:', e.message));

          const chatId = cq.message?.chat?.id;
          const btIdx = /^bt:(\d+)$/.exec(cq.data || '');
          if (chatId && btIdx && BOTONERA_ETIQUETAS[Number(btIdx[1])]) {
            // Misma ruta que el texto del boton (labelMap): conserva el enfriamiento de 10 s contra doble toque.
            await atender(cq.data, handleMessage(BOTONERA_ETIQUETAS[Number(btIdx[1])], chatId, cq.from));
          } else if (chatId && cq.data === 'unidades_hoy:heuristico') {
            await atender(cq.data, enviarUnidadesHoyHeuristico(chatId));
          } else if (chatId && cq.data === 'unidades_hoy:learned') {
            await atender(cq.data, enviarUnidadesHoyLearned(chatId));
          } else if (chatId && cq.data === 'unidades_hoy:tabla_img') {
            await atender(cq.data, enviarUnidadesHoyImagenDashboard(chatId, 'table', 'la tabla'));
          } else if (chatId && cq.data === 'unidades_hoy:modelo_img') {
            await atender(cq.data, enviarUnidadesHoyImagenDashboard(chatId, 'model', 'el modelo ML'));
          }
          continue;
        }

        if (u.pre_checkout_query) {
          try {
            await fetch(`${API}/answerPreCheckoutQuery`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ pre_checkout_query_id: u.pre_checkout_query.id, ok: true })
            });
          } catch (err) {
            console.error('[pre_checkout_query error]', err.message);
          }
          continue;
        }

        const msg = u.message;
        if (!msg) continue;

        if (msg.successful_payment) {
          await handleSuccessfulPayment(msg);
          continue;
        }

        if (msg.text) {
          console.log(`[${new Date().toISOString()}] ${msg.text}`);
          await atender(msg.text, handleMessage(msg.text, msg.chat.id, msg.from));
        }
      }
    } catch (e) {
      if (e.name !== 'TimeoutError') {
        console.error('[poll error]', e.message);
        await new Promise(r => setTimeout(r, 5000));
      }
    }
  }
}

// ---------- Recolector de fondo ----------
// Ciclo global: todos los deportes cada SAMPLE_MINUTES; además liquida picks
// y recalcula el conjunto de deportes focalizados.
const SAMPLE_MINUTES = Number(process.env.SAMPLE_MINUTES || 3);
const FOCUS_SAMPLE_SECONDS = Number(process.env.FOCUS_SAMPLE_SECONDS || 20);

let focusSports = []; // deportes con picks activos o con jugadas candidatas (momio 1.05-3.00)

function computeFocusSports(sportResults, rows) {
  const pickEvents = new Set(getUnsettledPicks().map(p => p.event_id));
  const ids = new Set();
  for (const r of rows) {
    if (pickEvents.has(r.eventId)) ids.add(r.sportId);
    else if (!r.suspended && r.oddDecimal >= 1.05 && r.oddDecimal <= 3) ids.add(r.sportId);
  }
  focusSports = sportResults.map(sr => sr.sport).filter(s => ids.has(s.id));
}

// ---------- Picks automáticos ----------
// Corre en cada ciclo del sampler sobre las filas ya descargadas (cero
// peticiones extra a Playdoit). Aplica los mismos filtros que /seguras
// (MIN_CONF, MIN_EDGE) y además DEDUPLICA: no emite si el evento ya tiene un
// pick sin liquidar ni repite una selección ya registrada. Sin la dedup, el
// mismo pick se registraría en cada ciclo mientras siguiera en el top,
// inflando el N y rompiendo la independencia del dataset de entrenamiento.
const AUTO_PICKS = String(process.env.AUTO_PICKS || 'false').toLowerCase() === 'true';
const AUTO_PICK_MAX_PER_HOUR = Number(process.env.AUTO_PICK_MAX_PER_HOUR || 6);
// Tope diario de picks emitidos por debajo de MIN_CONF (piloto MIN_CONF_UNDER_LOW).
const UNDER_LOW_DAILY_CAP = Number(process.env.UNDER_LOW_DAILY_CAP || 15);
const AUTO_PICK_NOTIFY = String(process.env.AUTO_PICK_NOTIFY || 'true').toLowerCase() === 'true';

// BADGES. La regla que los gobierna: un badge DESCRIBE el pick, no promete
// rendimiento. Cada uno lleva su N, su ventana y su incertidumbre en el texto.
//
// El badge 🔥 se retiró el 2026-08-24. Marcaba los picks donde el modelo
// aprendido superaba al heurístico y afirmaba "su tercil alto rindió +30%
// histórico". Tres motivos para quitarlo:
//   1. Ese +30% venía de n=15.
//   2. Sobre 255 picks frescos el modelo resultó EMPATADO con el heurístico
//      (Brier −0.0012, P(mejor)=39.8%), así que la promesa ya no se sostenía.
//   3. Exigía conf_learned >= 0.82 y no se disparó NI UNA VEZ en esos 255: era
//      código muerto que, de haberse activado, habría vendido un +30%
//      inexistente a suscriptores de pago.
//
// Ninguno de los badges que quedan llega al 95% de confianza, y decirlo forma
// parte del badge: el lector merece saber que es contexto medido, no garantía.
const RECTA_FINAL_MIN = Number(process.env.RECTA_FINAL_MIN || 0.90);
const MOV_CUOTA_MIN = Number(process.env.MOV_CUOTA_MIN || 0.50);

// ⏱️ Partido en su recta final. Medido sobre picks liquidados sin DNB, con corte
// temporal en 2026-08-12:  TRAIN N=293 ROI +16.9%  →  TEST N=94 ROI +21.2%.
// Es el segmento más fuerte y el único consistente en ambos periodos. Contra su
// misma ventana: +11.3pp, IC95% [−3.4, +24.1], P(mejor)=93.3% — no llega al 95%.
function esRectaFinal(p) {
  return p.progress != null && p.progress >= RECTA_FINAL_MIN;
}

// Grupo de control para entrenar: guarda una MUESTRA de los candidatos que se
// puntuaron y no se emitieron, para que el modelo pueda ver la frontera de
// decisión. Sin negativos, el clasificador solo ve picks que ya pasaron
// MIN_CONF=0.70 — el 80% de las conf comprimido en 9pp — y no puede aprender
// nada (medido el 2026-08-09).
//
// Nunca debe tumbar el ciclo de picks: es instrumentación, no producción. De ahí
// el try/catch. Y REJECTED_SAMPLE=0 lo apaga entero.
const REJECTED_SAMPLE = Number(process.env.REJECTED_SAMPLE || 5);
function captureRejectedControls(rows, scored = null) {
  if (REJECTED_SAMPLE <= 0) return;
  try {
    const muestras = auditRejections(rows, {
      minOdds: Number(process.env.MIN_ODDS || 1.35),
      minEdge: Number(process.env.MIN_EDGE || 0.03),
      minConf: Number(process.env.MIN_CONF || 0.70),
      limit: REJECTED_SAMPLE,
      scored,
    });
    if (!muestras.length) return;
    const ts = new Date().toISOString();
    const n = logRejected(muestras.map(({ row: r, rule }) => ({
      ts, eventId: r.eventId, event: r.event, sport: r.sport,
      market: r.market, selection: r.selection, oddDecimal: r.oddDecimal,
      conf: r.conf, edge: r.edge, rejectRule: rule,
      // scoreRow (src/confidence.js) devuelve la probabilidad justa como `base`,
      // no `fProbJusta` — con ese nombre nunca hubo match y la columna se
      // guardaba siempre NULL desde que existe esta tabla (2026-08-09).
      fProbJusta: r.base, fAvance: r.progress, fAvanceModel: r.fAvance,
      fSituacion: r.scoreFactor, fLinea: r.lineFactor, fApertura: r.fApertura,
      confHeuristic: r.confHeuristic, confLearned: r.confLearned, modelVersion: r.modelVersion,
      scoreVersion: SCORE_VERSION,
    })));
    if (n) console.log(`[control] ${n} candidatos rechazados guardados (de ${muestras.length} muestreados)`);
  } catch (e) {
    console.error('[control] no se pudo guardar el grupo de control:', e.message);
  }
}

// Picks que emitiria el modelo aprendido si decidiera el. NO se apuestan: se
// registran y se avisan para poder comparar los dos decisores sobre la misma
// realidad, en vez de discutirlo.
//
// SOLO al chat del dueno, nunca al canal VIP. Los picks que unicamente ve el
// modelo salen de una poblacion sobre la que no hay NI UNA observacion, y sobre
// lo que si se puede medir el modelo filtra al reves (-17u sobre 255 picks
// frescos). Mandarselos a suscriptores de pago seria vender algo sin validar.
// ---------- MODEL_RESCUE ----------
// El experimento inverso al veto: en vez de dejar que el modelo QUITE picks,
// deja que RESCATE los que el heuristico tira SOLO por min_conf y que el modelo
// coloca en su top 30%. Ver src/confidence.js:rescuePicks para la medicion que
// lo justifica (+7.18% ROI OOS, IC95% [+2.81, +11.51], bootstrap por evento).
//
// Se apuestan DE VERDAD — esa es la gracia, convertir un hallazgo observacional
// en un experimento — pero con tres cinturones:
//   1. source='rescue', para poder separarlos de todo lo demas. src/metrics.js
//      los EXCLUYE del rendimiento principal: si contaminaran /unidades y los
//      KPIs del panel, seria imposible saber que rinde cada cosa.
//   2. Stake fijo minimo, no el escalonado. El escalonado esta calibrado sobre
//      la poblacion emitida; aplicarlo aqui seria extrapolarlo a una zona sin
//      validar.
//   3. Tope horario propio, que NO consume el de los picks normales.
// Aviso solo al dueno, nunca al canal VIP: poblacion sin validar.
const MODEL_RESCUE = process.env.MODEL_RESCUE === '1';
// p70 de conf_learned bajo el modelo de produccion del 2026-08-25. RECALCULAR
// al adoptar un modelo nuevo: cada reentrenamiento mueve la escala y este
// numero deja de ser el p70 sin que nada avise.
// El umbral del rescate es un CUANTIL (el p70) de la distribucion de
// conf_learned sobre su poblacion elegible. Cada reentrenamiento mueve esa
// escala, asi que un numero fijo en el .env caduca en silencio: deja de ser el
// p70 y el "top 30%" pasa a ser otra cosa sin que nada avise.
//
// Por eso se CALCULA del modelo vigente al arrancar, en vez de leerse.
// MODEL_RESCUE_MIN_CONF en el entorno lo fija a mano si hace falta.
let rescueMinConf = null;
function umbralRescate() {
  if (rescueMinConf !== null) return rescueMinConf;
  const fijado = Number(process.env.MODEL_RESCUE_MIN_CONF);
  if (fijado > 0) {
    rescueMinConf = fijado;
    console.log(`[rescate] umbral fijado por entorno: ${fijado}`);
    return rescueMinConf;
  }
  try {
    const { learnedConf, marketFeatures } = require('./src/model');
    const desde = new Date(Date.now() - 7 * 864e5).toISOString();
    const confs = getRescueEligible(desde).map(r => learnedConf({
      f_prob_justa: r.f_prob_justa, f_avance: r.f_avance_model,
      f_situacion: r.f_situacion, f_linea: r.f_linea, f_apertura: r.f_apertura,
      ...marketFeatures(r),
    }, r.sport)).filter(v => v != null).sort((a, b) => a - b);
    // Con muestra pobre no se inventa un cuantil: se deja el rescate apagado.
    if (confs.length < 500) {
      console.error(`[rescate] solo ${confs.length} candidatos elegibles: insuficiente para fijar el p70, rescate inactivo`);
      rescueMinConf = 0;
      return rescueMinConf;
    }
    rescueMinConf = confs[Math.floor(0.70 * (confs.length - 1))];
    console.log(`[rescate] umbral p70 recalculado sobre ${confs.length} candidatos: ${rescueMinConf.toFixed(4)}`);
  } catch (e) {
    console.error('[rescate] no se pudo calcular el umbral:', e.message);
    rescueMinConf = 0;
  }
  return rescueMinConf;
}
const MODEL_RESCUE_STAKE = Number(process.env.MODEL_RESCUE_STAKE || 0.25);
const MODEL_RESCUE_MAX_PER_HOUR = Number(process.env.MODEL_RESCUE_MAX_PER_HOUR || 2);

async function emitirRescates(rows, scored = null) {
  if (!MODEL_RESCUE) return;
  const esc = str => String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  try {
    const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const yaEstaHora = countPicksSince(hourAgo, 'rescue');
    const quedan = MODEL_RESCUE_MAX_PER_HOUR - yaEstaHora;
    if (quedan <= 0) return;

    const candidatos = rescuePicks(rows, {
      minOdds: Number(process.env.MIN_ODDS || 1.35),
      minEdge: Number(process.env.MIN_EDGE || 0.03),
      minConf: Number(process.env.MIN_CONF || 0.70),
      minLearned: umbralRescate(),
      n: quedan,
      scored,
    }).filter(p => !hasPickForEvent(p.eventId));
    if (!candidatos.length) return;

    const ts = new Date().toISOString();
    const ids = logPicks(candidatos.map(p => ({
      ts, eventId: p.eventId, event: p.event, sport: p.sport,
      market: p.market, selection: p.selection, oddDecimal: p.oddDecimal, conf: p.conf,
      fProbJusta: p.base, fAvance: p.progress, fAvanceModel: p.fAvance,
      fSituacion: p.scoreFactor, fLinea: p.lineFactor,
      confHeuristic: p.confHeuristic, confLearned: p.confLearned,
      modelVersion: p.modelVersion, modelMode: p.modelMode, edge: p.edge, source: 'rescue',
      openingOdd: p.openingOdd, fApertura: p.fApertura, scoreVersion: p.scoreVersion,
      stake: MODEL_RESCUE_STAKE, stakeMode: 'rescue',
    })));
    captureSharpEntries(ids, candidatos).catch(e => console.error('[sharp]', e.message));
    for (const p of candidatos) {
      console.log(`[rescate] ${p.event} | ${p.selection} @ ${p.oddDecimal} | modelo ${pct(p.confLearned)} heur ${pct(p.confHeuristic)}`);
    }

    let msg = '\u{1F6DF} <b>RESCATE DEL MODELO</b> — experimento, stake mínimo\n';
    msg += `<i>El heurístico los descartó por confianza; el modelo los pone en su top 30%.</i>${NL}${NL}`;
    for (let i = 0; i < candidatos.length; i++) {
      const p = candidatos[i];
      const flag = getCountryFlag(p.champ, p.event, p.sport);
      msg += `${flag} <b>#${ids[i]}</b> · <b>${esc(p.event.trim())}</b> <i>(${esc(p.sport)})</i>${NL}`;
      if (p.score) msg += `Marcador: ${esc(p.score)}${p.liveTime ? ` — ${esc(p.liveTime)}` : ''}${NL}`;
      const xgLinea = xgDelAviso(p.eventId);
      if (xgLinea) msg += `${xgLinea}${NL}`;
      msg += `${esc(p.market)}: <b>${esc(p.selection)}</b> @ <b>${p.oddDecimal.toFixed(2)}</b>${NL}`;
      msg += `modelo <b>${pct(p.confLearned)}</b> · heurístico ${pct(p.confHeuristic)} · <b>${MODEL_RESCUE_STAKE}u</b>${NL}${NL}`;
    }
    msg += '<i>Fuera del rendimiento principal: se miden aparte.</i>';
    await sendTelegram(TOKEN, CHAT_ID, msg).catch(e => console.error('[rescate] aviso:', e.message));
  } catch (e) {
    console.error('[rescate] no se pudieron emitir los rescates:', e.message);
  }
}

const MODEL_PICKS = process.env.MODEL_PICKS === '1';

// Línea de xG prepartido para los avisos (src/xgAviso.js): SOLO informa, no puntúa ni filtra. La
// consulta es por el índice único (event_id) y va en try/catch: un fallo aquí NUNCA debe frenar el
// aviso de un pick (camino crítico de emisión). Devuelve '' si no hay dato usable.
let xgAvisoStmt = null;
function xgDelAviso(eventId) {
  try {
    xgAvisoStmt ||= db.prepare(`SELECT xg_esperado_local, xg_esperado_visita, xg_esperado_total, home_played, away_played
      FROM prematch_xg_scan WHERE event_id = ? ORDER BY ts DESC LIMIT 1`);
    return require('./src/xgAviso').lineaXg(xgAvisoStmt.get(eventId));
  } catch { return ''; }
}

// Nivel 0 de apuesta directa (src/execProbe.js): solo mide, no apuesta. Apagable
// con EXEC_PROBE=0. `ids` va paralelo a `picks` (null donde hubo duplicado).
const EXEC_PROBE = !/^(0|false|off|no)$/i.test(process.env.EXEC_PROBE || '1');
// La cola UI es opt-in: sus trabajos son estrictamente list_only, pero abrir
// Chrome sigue requiriendo una sesión interactiva que no se debe lanzar por
// sorpresa al actualizar el bot.
const DRYRUN_QUEUE_ENABLED = /^(1|true|on|si|sí)$/i.test(process.env.DRYRUN_QUEUE_ENABLED || '');
const DRYRUN_JOB_MAX_ATTEMPTS = Math.max(1, Math.min(5, Number(process.env.DRYRUN_JOB_MAX_ATTEMPTS || 2)));
function sondearEjecutabilidad(source, picks, ids) {
  try {
    const items = picks.map((p, i) => ({
      pickId: ids[i], eventId: p.eventId, sportId: p.sportId, sport: p.sport,
      market: p.market, selection: p.selection, oddDecimal: p.oddDecimal, ts: p.ts,
    })).filter(it => it.pickId);
    if (!items.length) return;
    if (EXEC_PROBE) programarSondeos(source, items, saveExecProbe);
    if (DRYRUN_QUEUE_ENABLED) {
      const queued = enqueueDryRunJobs(source, items, { maxAttempts: DRYRUN_JOB_MAX_ATTEMPTS });
      if (queued) console.log(`[dry-run] ${queued} trabajo(s) list_only encolado(s) (${source})`);
    }
  } catch (e) {
    console.error('[ejecutabilidad]', e.message);
  }
}

// Salud del sondeo nivel 0: disponibilidad del mercado, drift promedio y
// retraso EXTRA sobre los +10/+30/+60 s programados. Se avisa solo cuando
// cambia el estado para no convertir una degradacion larga en spam.
const EXEC_PROBE_ALERTS = /^(1|true|on|si|sí)$/i.test(process.env.EXEC_PROBE_ALERTS || '');
const EXEC_PROBE_MONITOR_HOURS = Math.max(1, Math.min(24, Number(process.env.EXEC_PROBE_MONITOR_HOURS || 6)));
const EXEC_PROBE_MIN_SAMPLES = Math.max(5, Number(process.env.EXEC_PROBE_MIN_SAMPLES || 20));
const EXEC_PROBE_MIN_OK_PCT = Math.max(0, Math.min(1, Number(process.env.EXEC_PROBE_MIN_OK_PCT || 0.70)));
const EXEC_PROBE_MAX_AVG_LATENESS_MS = Math.max(1000, Number(process.env.EXEC_PROBE_MAX_AVG_LATENESS_MS || 15000));
const EXEC_PROBE_MAX_NEGATIVE_DRIFT = Math.min(0, Number(process.env.EXEC_PROBE_MAX_NEGATIVE_DRIFT || -0.03));
let execProbeSanoAnterior = null;

async function vigilarSondeosEjecucion() {
  if (!EXEC_PROBE || !EXEC_PROBE_ALERTS) return;
  try {
    const monitor = getExecutionMonitor(EXEC_PROBE_MONITOR_HOURS);
    const total = monitor.probes.reduce((s, r) => s + (r.n || 0), 0);
    if (total < EXEC_PROBE_MIN_SAMPLES) return;
    const ok = monitor.probes.reduce((s, r) => s + (r.ok || 0), 0);
    const promedio = (campo) => monitor.probes.reduce((s, r) => s + (r[campo] || 0) * (r.n || 0), 0) / total;
    const disponibilidad = ok / total;
    const atraso = promedio('avg_lateness_ms');
    const drift = promedio('avg_drift');
    const sano = disponibilidad >= EXEC_PROBE_MIN_OK_PCT &&
      atraso <= EXEC_PROBE_MAX_AVG_LATENESS_MS && drift >= EXEC_PROBE_MAX_NEGATIVE_DRIFT;
    const anterior = execProbeSanoAnterior;
    if (anterior === sano) return;
    execProbeSanoAnterior = sano;
    const detalle = `ventana ${EXEC_PROBE_MONITOR_HOURS}h · n=${total} · disponibles ${(100 * disponibilidad).toFixed(1)}% · ` +
      `retraso extra ${Math.round(atraso / 1000)}s · drift medio ${(100 * drift).toFixed(2)}%`;
    if (!sano) {
      console.error(`[execProbe] degradado: ${detalle}`);
      await sendTelegram(TOKEN, CHAT_ID, `⚠️ <b>Sondeo de ejecutabilidad degradado</b>\n${detalle}`, false).catch(() => {});
    } else if (anterior === false) {
      console.log(`[execProbe] recuperado: ${detalle}`);
      await sendTelegram(TOKEN, CHAT_ID, `🟢 <b>Sondeo de ejecutabilidad recuperado</b>\n${detalle}`, false).catch(() => {});
    }
  } catch (e) {
    console.error('[execProbe] monitor:', e.message);
  }
}

async function emitirPicksModelo(rows, scored = null) {
  if (!MODEL_PICKS) return;
  // `esc` es local a propósito: no es un global de bot.js (vive en
  // src/telegram.js y no se exporta). Sin esta línea, el aviso reventaba con
  // "esc is not defined" en CADA ciclo desde que existe la función — 138 veces
  // hasta el 2026-08-25. Los picks SÍ se registraban (logModelPicks corre
  // antes), así que el fallo era invisible salvo en bot.log.
  const esc = str => String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  try {
    const picks = modelPicks(rows, {
      minOdds: Number(process.env.MIN_ODDS || 1.35),
      minEdge: Number(process.env.MIN_EDGE || 0.03),
      minConf: Number(process.env.MIN_CONF || 0.70),
      n: Number(process.env.MODEL_PICKS_N || 3),
      scored,
    });
    if (!picks.length) return;

    // Un evento con pick de sombra sin liquidar no genera mas. Misma regla que
    // autoPicks aplica al real: sin ella los dos conjuntos no son comparables
    // pick a pick, porque la sombra contaria varias veces el mismo partido.
    // Se filtra aqui y no dentro de modelPicks() para que la funcion siga
    // siendo pura y los scripts de backtest puedan llamarla sin tocar la BD.
    const vistos = new Set();
    const nuevos = picks.filter(p => {
      if (vistos.has(p.eventId) || isDuplicateModelPick(p.eventId)) return false;
      vistos.add(p.eventId);
      return true;
    });
    if (!nuevos.length) return;
    const ts = new Date().toISOString();
    const { n, ids } = logModelPicks(nuevos.map(p => ({
      ts, eventId: p.eventId, event: p.event, sport: p.sport, champ: p.champ,
      market: p.market, selection: p.selection, oddDecimal: p.oddDecimal,
      confLearned: p.confLearned, confHeuristic: p.confHeuristic, edgeLearned: p.edge,
      tambienHeuristico: p.tambienHeuristico,
      fProbJusta: p.base, fAvance: p.progress, fAvanceModel: p.fAvance,
      fSituacion: p.scoreFactor, fLinea: p.lineFactor, fApertura: p.fApertura,
      scoreVersion: SCORE_VERSION, modelVersion: p.modelVersion,
      entryScore: p.score || null, entryMinute: p.minute ?? null,
      entryLiveTime: p.liveTime || null,
    })));
    if (!n) return; // ya estaban registrados; no volver a avisar
    console.log(`[modelo] ${n} picks del modelo registrados`);
    sondearEjecutabilidad('model', nuevos, ids);

    const soloModelo = nuevos.filter(p => !p.tambienHeuristico).length;
    let msg = '\u{1F916} <b>Picks del MODELO aprendido</b> — no apostados, solo registro\n';
    msg += `<i>${n} registrado${n === 1 ? '' : 's'} · ${soloModelo} que el heurístico NO emitiría</i>\n\n`;
    for (const [i, p] of nuevos.entries()) {
      // #id y edge: pedido explicito del usuario el 2026-09-13 — sin el id no
      // hay forma de pedir /pick <id> ni de cruzar este aviso con la fila de
      // model_picks despues, y sin el edge no se puede juzgar la sugerencia
      // igual que ya se puede en el aviso de pick automatico real.
      const idTag = ids[i] != null ? `<b>#${ids[i]}</b> · ` : '';
      msg += `${p.tambienHeuristico ? '\u{1F91D}' : '\u{1F916}'} ${idTag}<b>${esc(p.event)}</b> <i>(${esc(p.sport)})</i>\n`;
      // Marcador y minuto del instante del pick. Sin esto el aviso no se puede
      // juzgar al leerlo: "Menos de 2.5" es una cosa en el minuto 10 con 0-0 y
      // otra muy distinta en el 80 con 1-1.
      // liveTime ya viene con el minuto dentro ("96' — 2ª parte"), asi que
      // `minute` solo entra como respaldo cuando el proveedor no manda texto.
      if (p.score) {
        const cuando = p.liveTime ? esc(p.liveTime)
          : (p.minute != null ? `${Math.floor(p.minute)}'` : null);
        msg += `Marcador: <b>${esc(p.score)}</b>${cuando ? ` — ${cuando}` : ''}\n`;
      }
      const xgLinea = xgDelAviso(p.eventId);
      if (xgLinea) msg += `${xgLinea}\n`;
      msg += `${esc(p.market)}: <b>${esc(p.selection)}</b> @ <b>${p.oddDecimal.toFixed(2)}</b>\n`;
      msg += `modelo <b>${pct(p.confLearned)}</b> · heurístico ${pct(p.confHeuristic)} · Edge <b>${p.edge >= 0 ? '+' : ''}${(100 * p.edge).toFixed(1)}%</b>`;
      msg += p.tambienHeuristico ? ' · <i>ambos coinciden</i>\n\n' : ' · <i>solo el modelo</i>\n\n';
    }
    try { await sendTelegram(TOKEN, CHAT_ID, msg); }
    catch (e) { console.error('[modelo] aviso:', e.message); }
  } catch (e) {
    console.error('[modelo] no se pudieron registrar los picks del modelo:', e.message);
  }
}

async function autoPicks(rows, scored = null) {
  if (!AUTO_PICKS) return;

  const elegibles = rows.filter(r => !norm(r.sport).startsWith('e-'));
  captureRejectedControls(elegibles, scored);

  // hasPickForEvent y no isDuplicatePick: estas filas vienen del feed EN VIVO,
  // asi que el partido esta en juego. Un pick anterior del mismo evento cuenta
  // aunque ya liquidara — la liquidacion temprana cierra mercados a mitad de
  // partido y sin esto el evento quedaba libre para un segundo pick correlado.
  let candidates = safestPicks(elegibles, 5, scored)
    .filter(p => !hasPickForEvent(p.eventId));

  // TOPE DIARIO del piloto MIN_CONF_UNDER_LOW (ver confidence.js:minConfFor).
  // Un candidato con conf < MIN_CONF solo llega hasta aqui por ese piso, asi que
  // se cuenta el dia (UTC, como se midio) con ese mismo criterio. Orden de
  // llegada: `conf` no ordena en el segmento, y el tiempo es el criterio mas
  // neutro y auditable (simulado 2026-09-25: no difiere de elegir al azar).
  // Sin MIN_CONF_UNDER_LOW nunca hay candidatos bajo el piso, y esto no hace nada.
  const minConfBase = Number(process.env.MIN_CONF || 0.70);
  if (candidates.some(p => p.conf < minConfBase)) {
    const diaUtc = new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z';
    let cupo = UNDER_LOW_DAILY_CAP - countPicksBelowConfSince(diaUtc, minConfBase);
    candidates = candidates.filter(p => {
      if (p.conf >= minConfBase) return true;
      if (cupo <= 0) return false;
      cupo--;
      return true;
    });
  }
  if (!candidates.length) return;

  // AUTO_PICK_MAX_PER_HOUR estaba declarado y documentado (ver comentario de
  // arriba) pero nunca se aplicaba: countPicksSince se importaba y no se
  // llamaba. Medido el 2026-08-08: 453 picks/auto en 24h, con un pico de 52 en
  // una sola hora — casi 9x el tope pretendido de 6, con exposición de stake
  // real de por medio, no solo ruido en la BD.
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const alreadyThisHour = countPicksSince(hourAgo);
  const remaining = AUTO_PICK_MAX_PER_HOUR - alreadyThisHour;
  if (remaining <= 0) {
    console.log(`[auto-pick] tope horario alcanzado (${alreadyThisHour}/${AUTO_PICK_MAX_PER_HOUR}), se omite este ciclo`);
    return;
  }

  const picks = candidates.slice(0, remaining);
  if (!picks.length) return;

  const ids = logPicks(picks.map(p => ({
    ts: p.ts, eventId: p.eventId, event: p.event, sport: p.sport,
    market: p.market, selection: p.selection, oddDecimal: p.oddDecimal, conf: p.conf,
    fProbJusta: p.base, fAvance: p.progress, fAvanceModel: p.fAvance, fSituacion: p.scoreFactor, fLinea: p.lineFactor,
    confHeuristic: p.confHeuristic, confLearned: p.confLearned, modelVersion: p.modelVersion, modelMode: p.modelMode, edge: p.edge, source: 'auto',
    openingOdd: p.openingOdd, fApertura: p.fApertura, scoreVersion: p.scoreVersion,
    stake: p.stake, stakeMode: p.stakeMode,
  })));
  captureSharpEntries(ids, picks).catch(e => console.error('[sharp]', e.message));
  sondearEjecutabilidad('heur', picks, ids);
  for (const p of picks) {
    console.log(`[auto-pick] ${p.event} | ${p.selection} @ ${p.oddDecimal} | conf ${pct(p.conf)} edge ${(100 * p.edge).toFixed(1)}%`);
  }

  if (!AUTO_PICK_NOTIFY) return;
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  let msg = `<b>🤖 Pick automático</b>\n\n`;
  // El #id es lo que permite pedir después /pick <id> y recibir la gráfica de
  // evolución de cuota (misma ficha que el inspector del dashboard). Antes
  // `ids` se calculaba para capturar el momio sharp y nunca llegaba al
  // mensaje: no había forma de saber qué número pedir sin abrir el dashboard.
  // JERARQUIA: la accion (que apostar y a que cuota) es lo PRIMARIO — va
  // primero, sola, en su propia linea grande. El partido/torneo/marcador es
  // CONTEXTO que sustenta esa accion — va despues, sin negrita. Confianza/
  // edge/stake son diagnostico de POR QUE — van al final, en texto plano, no
  // compitiendo en negrita con la accion misma (antes las cuatro cosas —
  // partido, pick, confianza, edge— llevaban el mismo peso visual y el ojo no
  // sabia por donde empezar; mismo principio que la jerarquia ya aplicada en
  // el dashboard: el peso visual debe coincidir con la prioridad real).
  for (let i = 0; i < picks.length; i++) {
    const p = picks[i];
    const flag = getCountryFlag(p.champ, p.event, p.sport);
    msg += `🎯 <b>${esc(p.market)}: ${esc(p.selection)} @ ${p.oddDecimal.toFixed(2)}</b> <i>(${p.oddAmerican})</i>\n`;
    msg += `${isElite(p) ? '🛡️ ' : ''}${esRectaFinal(p) ? '⏱️ ' : ''}${flag} #${ids[i]} · ${esc(p.event)} <i>(${esc(p.sport)}${p.champ ? ` — ${esc(p.champ)}` : ''})</i>\n`;
    if (p.score) msg += `Marcador: ${esc(p.score)}${p.liveTime ? ` — ${esc(p.liveTime)}` : ''}\n`;
    const xgLinea = xgDelAviso(p.eventId);
    if (xgLinea) msg += `${xgLinea}\n`;
    msg += `Confianza ${pct(p.conf)} · Edge +${(100 * p.edge).toFixed(1)}%`;
    msg += p.stake != null ? ` · Unidad ${p.stake.toFixed(1)}u\n` : '\n';
    // Movimiento de la cuota: es un HECHO, no un pronóstico. No necesita muestra
    // ni intervalo de confianza porque no afirma nada sobre el futuro — solo dice
    // lo que el mercado YA hizo desde que empezamos a seguir esta jugada.
    //
    // El umbral es 50% y no 5% por una razón medida: este bot apuesta tarde, y
    // la caída MEDIANA de la cuota desde la apertura es del 39% (N=325). Con un
    // 5% la línea saldría en el 94% de los picks, y algo que aparece casi
    // siempre no informa de nada. Al 50% sale en un tercio, que es cuando el
    // movimiento de verdad destaca sobre lo normal.
    // Deliberadamente NO dice si eso es bueno o malo: no lo sabemos.
    if (p.openingOdd > 1 && Math.abs(p.openingOdd - p.oddDecimal) / p.openingOdd >= MOV_CUOTA_MIN) {
      const bajo = p.oddDecimal < p.openingOdd;
      msg += `<i>${bajo ? '📉' : '📈'} la cuota ${bajo ? 'bajó' : 'subió'} de ${p.openingOdd.toFixed(2)} a ${p.oddDecimal.toFixed(2)} desde que seguimos el partido</i>\n`;
    }
    // Las cifras se interpolan VIVAS desde src/badgeStats.js, no van escritas
    // aquí. Un número a mano envejece solo: el badge 🔥 acabó prometiendo un
    // +30% sacado de n=15 que para entonces ya no existía. Si no hay muestra
    // suficiente, frase() devuelve '' y el badge se pinta sin cifra.
    if (esRectaFinal(p)) {
      const f = fraseBadge('rectaFinal');
      msg += `<i>⏱️ recta final — ${(100 * p.progress).toFixed(0)}% del partido jugado.`
           + `${f ? ` ${f}.` : ''} Contexto medido sobre nuestro histórico, no una garantía.</i>\n`;
    }
    if (isElite(p)) {
      const f = fraseBadge('elite');
      msg += `<i>🛡️ tier ELITE del firewall — Under tardío con línea estable.`
           + `${f ? ` ${f}.` : ''} Marca orientativa, no una recomendación de stake.</i>\n`;
    }
    // ENLACE AL EVENTO. Faltaba desde siempre en ESTE mensaje. formatMessage
    // (/seguras, /golden) y las alertas de Profit Lock si lo llevaban, pero el
    // aviso del pick automatico —el que llega en cada emision— se arma aqui a
    // mano y nunca llamo a generateBetLink: habia que buscar el partido por su
    // nombre.
    //
    // `p` viene de normalize(), asi que trae eventId y sportId directos y no
    // hace falta resolver el deporte contra snapshots.
    msg += `👉 ${enlaceHtml(generateBetLink(p), 'Abrir en Playdoit')}\n`;
    msg += '\n';
  }
  try { await sendTelegram(TOKEN, CHAT_ID, msg); } catch (e) { console.error('[auto-pick notify]', e.message); }
  if (VIP_CHANNEL_ID) {
    try { await sendTelegram(TOKEN, VIP_CHANNEL_ID, msg); } catch (e) { console.error('[auto-pick vip notify]', e.message); }
  }
}

// El guard de instancia única necesita watchdog. Si un await de dentro se cuelga
// sin timeout, `sampling` se queda en true y TODOS los ciclos siguientes salen
// por el return de arriba: el bot deja de muestrear para siempre, sin error y
// sin morirse, así que ni el supervisor ni las alertas se enteran. Pasó el
// 2026-08-19 (sendTelegram sin AbortSignal, 4h de silencio con el proceso vivo).
// Los timeouts de fetch son el arreglo de fondo; esto es el cinturón: pasado
// SAMPLE_STUCK_MS damos el ciclo por perdido y arrancamos otro. Solaparse es
// mucho menos malo que enmudecer.
const SAMPLE_STUCK_MS = Number(process.env.SAMPLE_STUCK_MS || 5 * 60000);
let sampling = false;
let samplingSince = 0;
async function sample() {
  if (sampling) {
    const stuckMs = Date.now() - samplingSince;
    if (stuckMs < SAMPLE_STUCK_MS) return;
    console.error(`[sampler] el ciclo anterior lleva ${Math.round(stuckMs / 1000)}s sin terminar; se da por colgado y se arranca otro`);
  }
  sampling = true;
  samplingSince = Date.now();
  try {
    const sportResults = await fetchAllLive();
    const rows = normalize(sportResults);
    if (rows.length) saveSnapshot(rows);
    recordarEventosFutbol(rows);
    console.log(`[sampler ${new Date().toISOString()}] ${rows.length} jugadas guardadas`);
    // processSettlements captura también el cierre sharp bajo demanda (1 sola
    // consulta por pick, al desaparecer el evento del feed)
    await processSettlements(rows);
    computeFocusSports(sportResults, rows);
    // Se puntua UNA sola vez por ciclo y se reparte. Antes cada consumidor
    // (auditRejections, safestPicks, modelPicks) puntuaba el conjunto entero
    // por su cuenta: tres pasadas identicas, ~43 s de CPU bloqueante por ciclo
    // con Node de un solo hilo, que era lo que retrasaba los mensajes.
    const scored = scoreCandidates(rows);
    await autoPicks(rows, scored);
    await emitirRescates(rows, scored);
    await emitirPicksModelo(rows, scored);
    await checkExpiredSubscribers();
  } catch (e) {
    console.error('[sampler]', e.message);
  } finally {
    sampling = false;
  }
}
setInterval(sample, SAMPLE_MINUTES * 60 * 1000);
sample();

// ─────────────────────────────────────────────────────────────────────────────
// PILOTO DE ESTADISTICAS DE PARTIDO — captura de solo lectura, apagable.
//
// Va en SU PROPIO intervalo y no dentro de sample() a proposito. sample() es el
// camino critico: descarga, puntua y EMITE. Colgarle 30 llamadas HTTP mas
// retrasaria la emision de todos los picks para alimentar un experimento que no
// decide nada. Aqui, si el piloto se atasca o se cae, la emision ni se entera.
//
// Ver src/matchStats.js para el porque del piloto y que pretende validar.
// ─────────────────────────────────────────────────────────────────────────────
// STATS_* con respaldo en los CORNERS_* originales: el piloto nacio solo-corners
// y las claves viejas siguen valiendo, para no romper un .env restaurado de un
// backup anterior al cambio.
const env = (nuevo, viejo) => process.env[nuevo] ?? process.env[viejo];
const STATS_PILOT = /^(1|true|on|si|sí)$/i.test(env('STATS_PILOT', 'CORNERS_PILOT') || '');
const STATS_MINUTES = Number(env('STATS_MINUTES', 'CORNERS_MINUTES') || 3);
const STATS_MAX_EVENTS = Number(env('STATS_MAX_EVENTS', 'CORNERS_MAX_EVENTS') || 40);
const STATS_STUCK_MS = Number(env('STATS_STUCK_MS', 'CORNERS_STUCK_MS') || 5 * 60000);
// Ciclos seguidos sin ver un evento en el feed antes de darlo por terminado. Un
// partido puede faltar un ciclo por un hueco del feed; liquidar a la primera
// etiquetaria como final un estado intermedio.
const STATS_AUSENCIAS = Number(process.env.STATS_AUSENCIAS || 2);

// Los eventos de futbol en vivo salen del ciclo normal, que YA los tiene en
// memoria. Preguntarselo a la BD costaria un escaneo por rango de ts sobre 113
// millones de filas cada tres minutos para reconstruir algo que el sampler
// acaba de calcular.
let eventosFutbol = [];
function recordarEventosFutbol(rows) {
  const vistos = new Map();
  for (const r of rows) {
    if (r.sport !== 'Fútbol' || !r.eventId) continue;
    if (!vistos.has(r.eventId)) vistos.set(r.eventId, { eventId: r.eventId, event: r.event, champ: r.champ });
  }
  eventosFutbol = [...vistos.values()];
}

let statsRunning = false;
let statsSince = 0;
// Ausencias por evento, para no dar por terminado un partido por un hueco del
// feed. Mismo criterio que la liquidacion de picks en src/results.js.
const statsAusencias = new Map();

/**
 * Segunda fuente de etiqueta para las lineas de CORNERS: el conteo DIRECTO de
 * FotMob. Muta `filas` en el sitio — se llama justo antes de
 * saveStatResults, con las mismas filas que ya trae derivarEtiquetas.
 *
 * Rellena fotmob_* en TODAS las filas (con null si no aplica), porque
 * insertStatResultStmt tiene parametros nombrados obligatorios — better-
 * sqlite3 revienta si falta alguno, no lo trata como NULL implicito.
 *
 * POR QUE fetchEventFinal Y NO getFotmobCornerFinal. getFotmobCornerFinal
 * (src/db.js) lee el ULTIMO SNAPSHOT ya guardado por fetchLiveCorners(), que
 * solo muestrea partidos EN VIVO — uno que termino desaparece de ahi por
 * definicion, asi que esa ultima muestra SIEMPRE es anterior al final y
 * status_type nunca llega a 'finished'. Misma leccion aprendida con el
 * piloto anterior (SofaScore, confirmado el 2026-09-10: 0 de 5376 snapshots
 * lo tenian). fetchEventFinal(fotmobEventId) pregunta DIRECTO por ese
 * partido puntual (no barre el live feed), asi que sigue viendolo aunque ya
 * haya salido de ahi.
 *
 * SIN BACKFILL, a proposito (ver comentario de la columna en src/db.js): si
 * FotMob TODAVIA no marca el partido como terminado en este instante, estas
 * columnas se quedan NULL para esa fila para siempre — es un timing que se
 * acepta, no un caso a reintentar.
 *
 * SIN INTERRUPTOR APARTE (a diferencia de enriquecerConSofa/SOFA_SUSPENDIDO):
 * esa suspension existia porque la liquidacion compartia el MISMO Chromium
 * costoso en RAM que el piloto periodico, sin importar su flag. FotMob no
 * tiene ese recurso compartido — cada llamada es un fetch HTTP independiente
 * con su propio timeout — asi que no hay nada que "suspender" aparte de
 * FOTMOB_PILOT.
 *
 * COSTO ACOPLADO A muestrearStats: matchFotmobEvent cachea el barrido del
 * dia (ver fotmobMatch.js), asi que esto es gratis casi siempre — la PRIMERA
 * liquidacion de un corner despues de medianoche paga el barrido completo,
 * pero a diferencia del piloto anterior (SofaScore, ~2 min con
 * MAX_TOURNAMENTS=600) FotMob trae todas las ligas del dia en UNA sola
 * llamada, asi que el costo real es mucho menor.
 */
async function enriquecerConFotmob(filas) {
  for (const f of filas) { f.fotmobEventId = null; f.fotmobConteoFinal = null; f.fotmobLadoGanador = null; f.fotmobExtraStats = null; }
  const conCorners = filas.filter(f => f.familia === 'corner');
  if (!conCorners.length) return;

  const cab = conCorners[conCorners.length - 1];
  const pick = { event: cab.event, ts: cab.ultimaTs, minute: cab.ultimoMinuto };
  let match;
  try {
    // conTope: mismo motivo que en handleFotmob (ver comentario de conTope
    // arriba) — sin esto, una respuesta lenta de FotMob dejaria esta
    // liquidacion colgada dentro del ciclo del piloto de stats. Sintoma real
    // en produccion el 2026-09-10 (con el piloto anterior, SofaScore):
    // "[stats] el ciclo anterior se dio por colgado" en bucle, y el bot de
    // Telegram sin responder — no porque poll() estuviera bloqueado (corre
    // aparte), sino porque la acumulacion de ciclos zombis termino ahogando
    // la BD compartida (sincronica, un solo hilo) que tambien necesitan los
    // comandos de Telegram.
    match = await conTope(matchFotmobEvent(pick), 20000);
  } catch (e) {
    console.error('[fotmob:match]', e.message);
    return;
  }
  if (!match) return;

  let final;
  try {
    final = await conTope(fetchEventFinal(match.fotmobEvent.id), 15000);
  } catch (e) {
    console.error('[fotmob:final]', e.message);
    return;
  }
  if (!final || final.statusType !== 'finished' || final.cornersHome == null || final.cornersAway == null) return;

  const total = final.cornersHome + final.cornersAway;
  for (const f of conCorners) {
    f.fotmobEventId = match.fotmobEvent.id;
    f.fotmobConteoFinal = total;
    f.fotmobLadoGanador = total > f.linea ? 'over' : 'under';
    f.fotmobExtraStats = final.extraStats; // Fase 2: captura sin usar, ver src/fotmobScraper.js
  }
}

/**
 * Liquida un partido: convierte sus muestras en etiquetas.
 *
 * Se llama cuando el partido ha TERMINADO, por cualquiera de las dos seniales:
 *  - GetEventDetails devuelve `markets: []` (la limpia, hallada el 2026-08-29);
 *  - el evento lleva STATS_AUSENCIAS ciclos sin aparecer en el feed en vivo.
 */
async function liquidarEvento(eventId) {
  const muestras = getStatMuestras(eventId);
  if (!muestras.length) return 0;
  const filas = derivarEtiquetas(muestras);
  await enriquecerConFotmob(filas);
  saveStatResults(filas);
  statsAusencias.delete(eventId);
  const conEtiqueta = filas.filter(f => f.ladoGanador).length;
  const conFotmob = filas.filter(f => f.fotmobLadoGanador).length;
  console.log(`[stats:liquidacion] ${muestras[0].event} | ${filas.length} lineas, ${conEtiqueta} con etiqueta${conFotmob ? `, ${conFotmob} con etiqueta FotMob` : ''}`);
  return filas.length;
}

async function muestrearStats() {
  if (!STATS_PILOT) return;
  // Mismo cinturon que el sampler: sin esto, un await colgado deja el flag en
  // true y el piloto no vuelve a correr nunca, en silencio (ver SAMPLE_STUCK_MS).
  if (statsRunning) {
    if (Date.now() - statsSince < STATS_STUCK_MS) return;
    console.error('[stats] el ciclo anterior se dio por colgado; se arranca otro');
  }
  statsRunning = true;
  statsSince = Date.now();
  const objetivo = eventosFutbol.slice(0, STATS_MAX_EVENTS);
  const vivos = new Set(objetivo.map(e => e.eventId));
  let filas = 0, conMercado = 0, conConteo = 0, errores = 0, terminados = 0, lineas = 0;
  const familias = new Set();
  try {
    for (const ev of objetivo) {
      try {
        const detalle = await fetchEventDetails(ev.eventId);
        if (partidoTerminado(detalle)) {
          terminados++;
          lineas += await liquidarEvento(ev.eventId);
          continue;
        }
        const rows = extraerStats(detalle, ev);
        if (rows.length) {
          conMercado++;
          if (rows.some(r => r.conteo != null)) conConteo++;
          for (const r of rows) familias.add(r.familia);
          saveStatSnapshot(rows);
          filas += rows.length;
        }
      } catch (e) {
        errores++;
      }
      // Respiro entre partidos. El ratelimit global ya impone el techo por
      // minuto; esto evita ademas competir en rafaga con el sampler.
      await new Promise(r => setTimeout(r, 300));
    }

    // Los que tienen muestras, no estan etiquetados y ya no aparecen en el feed.
    // Cubre el caso en que el evento desaparece antes de devolver `markets: []`.
    for (const id of getStatEventosPendientes()) {
      if (vivos.has(id)) { statsAusencias.delete(id); continue; }
      const n = (statsAusencias.get(id) || 0) + 1;
      statsAusencias.set(id, n);
      if (n >= STATS_AUSENCIAS) { terminados++; lineas += await liquidarEvento(id); }
    }

    const fam = familias.size ? ` [${[...familias].join('+')}]` : '';
    console.log(`[stats ${new Date().toISOString()}] ${objetivo.length} partidos, ${conMercado} con mercado${fam}, ${conConteo} con conteo, ${filas} filas` +
      `${terminados ? `, ${terminados} liquidados (${lineas} lineas)` : ''}${errores ? `, ${errores} errores` : ''}`);
  } catch (e) {
    console.error('[stats]', e.message);
  } finally {
    statsRunning = false;
  }
}

if (STATS_PILOT) {
  console.log(`[stats] piloto ACTIVO: cada ${STATS_MINUTES} min, hasta ${STATS_MAX_EVENTS} partidos por ciclo (corners + tarjetas)`);
  setInterval(muestrearStats, STATS_MINUTES * 60 * 1000);
}

// PILOTO FotMob: segundo piloto de corners, fuente distinta (ver
// src/fotmobScraper.js). Reemplazo de SofaScore (suspendido el 2026-09-14
// por bloquear fetch plano — SofaScore exigia Chromium headless, un proceso
// pesado adicional). FotMob responde a fetch normal, asi que ya no hace
// falta el interruptor de suspension aparte (SOFA_SUSPENDIDO) que existia
// solo para cortar el gasto de RAM de ese Chromium compartido.
const FOTMOB_PILOT = /^(1|true|on|si|sí)$/i.test(env('FOTMOB_PILOT') || '');
const FOTMOB_MINUTES = Number(env('FOTMOB_MINUTES') || 3);
const FOTMOB_STUCK_MS = Number(env('FOTMOB_STUCK_MS') || 3 * 60000);

// Picks de CORNERS en registro (src/cornerPicks.js): EXPERIMENTO. Solo al chat del dueño, sin stake, aparte
// de picks/model_picks. El modelo de corners no ha mostrado ventaja sobre el mercado (memoria
// nb-corners-sin-ventaja-vs-mercado), así que esto existe para medirlo, no para apostar con él.
// Opt-in: CORNER_PICKS=1. Requiere STATS_PILOT=1 (líneas de Playdoit) y FOTMOB_PILOT=1 (conteo real).
const CORNER_PICKS = /^(1|true|on|si|sí)$/i.test(env('CORNER_PICKS') || '');

async function emitirCornerPicks(dosFuentes) {
  const { configCorner, candidatosCorners, mensajeCorners } = require('./src/cornerPicks');
  const dbm = require('./src/db');
  const cfg = configCorner();
  const cands = candidatosCorners(dosFuentes, cfg);
  if (!cands.length) return;
  let cupo = Math.max(0, cfg.maxPorHora - dbm.countCornerPicksSince(new Date(Date.now() - 3600e3).toISOString()));
  const nuevos = [], ids = [];
  for (const p of cands) {
    if (cupo <= 0) break;
    const id = dbm.logCornerPick(p);          // null: ese partido ya tenía pick (no volver a avisar)
    if (id == null) continue;
    nuevos.push(p); ids.push(id); cupo--;
  }
  if (!nuevos.length) return;
  for (const [i, p] of nuevos.entries()) console.log(`[corners] #C${ids[i]} ${p.event} | ${p.lado} ${p.linea} @ ${p.odd} | modelo ${(100 * p.pModelo).toFixed(0)}% edge ${(100 * p.edge).toFixed(0)}pp`);
  try { await sendTelegram(TOKEN, CHAT_ID, mensajeCorners(nuevos, ids)); }
  catch (e) { console.error('[corners] aviso:', e.message); }
}

// Liquida contra el conteo final que el piloto de stats ya etiquetó en stat_results. Sin etiqueta: sigue pendiente.
function liquidarCornerPicks() {
  const { resultadoCorner } = require('./src/cornerPicks');
  const dbm = require('./src/db');
  let n = 0;
  for (const p of dbm.getUnsettledCornerPicks()) {
    const fin = dbm.getCornerFinalCount(p.event_id, p.linea);
    if (fin === undefined) continue;
    const res = resultadoCorner(p.lado, p.linea, fin);
    if (!res) continue;
    dbm.settleCornerPick(p.id, res, fin);
    n++;
  }
  if (n) console.log(`[corners] ${n} picks de corners liquidados`);
}

let fotmobRunning = false;
let fotmobSince = 0;

async function muestrearFotmob() {
  if (!FOTMOB_PILOT) return;
  if (fotmobRunning) {
    if (Date.now() - fotmobSince < FOTMOB_STUCK_MS) return;
    console.error(`[fotmob] el ciclo anterior lleva ${Math.round((Date.now() - fotmobSince) / 1000)}s sin terminar; se da por colgado y se arranca otro`);
  }
  fotmobRunning = true;
  fotmobSince = Date.now();
  try {
    const filas = await fetchLiveCorners();
    if (filas.length) saveFotmobSnapshot(filas);
    console.log(`[fotmob ${new Date().toISOString()}] ${filas.length} partidos con corners capturados`);

    // Historial de pronosticos: un snapshot por partido con dos fuentes que
    // ya tiene una linea sugerida (edge positivo). No se guarda TODA la
    // escalera — solo la sugerida, que es lo que el indicador de direccion
    // del dashboard necesita mostrar como historial (ver /api/fotmob-pilot/historial).
    try {
      const dosFuentes = computeDosFuentes(db);
      const ts = new Date().toISOString();
      for (const d of dosFuentes) {
        const sug = d.poisson?.sugerida;
        if (!sug) continue;
        saveForecastSnapshot({
          ts,
          eventId: d.playdoit.eventId,
          fotmobEventId: d.fotmob.fotmobEventId,
          event: d.playdoit.event,
          minuto: d.playdoit.minuto,
          linea: sug.linea,
          lado: sug.lado,
          odd: sug.odd,
          pModelo: sug.pModelo,
          pMercado: sug.pMercado,
          edge: sug.edge,
          conteoReal: (d.fotmob.cornersHome != null && d.fotmob.cornersAway != null) ? d.fotmob.cornersHome + d.fotmob.cornersAway : null,
          esperados: d.poisson.esperados,
          nbVersion: d.poisson.calibrado ? 'nb-cal-1' : 'nb-orig',
        });
      }
      if (CORNER_PICKS) await emitirCornerPicks(dosFuentes);
    } catch (e) {
      console.error('[fotmob:historial]', e.message);
    }
    if (CORNER_PICKS) { try { liquidarCornerPicks(); } catch (e) { console.error('[corners] liquidar:', e.message); } }
  } catch (e) {
    console.error('[fotmob]', e.message);
  } finally {
    fotmobRunning = false;
  }
}

if (FOTMOB_PILOT) {
  console.log(`[fotmob] piloto ACTIVO: cada ${FOTMOB_MINUTES} min, via fetch plano (FotMob, corners directos)`);
  setInterval(muestrearFotmob, FOTMOB_MINUTES * 60 * 1000);

  // CALENTAR EL CACHE DEL BARRIDO AL ARRANCAR, en vez de esperar a que la
  // primera liquidacion lo necesite. Misma leccion aprendida con el piloto
  // anterior (SofaScore, 2026-09-10): el cache de fotmobMatch.js vive en
  // MEMORIA del proceso, asi que cada reinicio del bot lo borra, y
  // enriquecerConFotmob llama a matchFotmobEvent con un tope de 20s — un
  // barrido en frio deberia entrar de sobra en eso (FotMob trae todas las
  // ligas del dia en una sola llamada), pero calentarlo aqui evita depender
  // de que la primera liquidacion tenga la suerte de caber en ese margen.
  //
  // Fire-and-forget: si falla, el barrido se reintenta solo la proxima vez
  // que algo llame a matchFotmobEvent. No se espera aqui porque el arranque
  // del bot no debe depender de que FotMob responda.
  eventosDeHoy().then(
    (evs) => console.log(`[fotmob] cache del barrido calentado al arrancar: ${evs.length} partidos de hoy`),
    (e) => console.error('[fotmob] fallo calentando el cache del barrido al arrancar:', e.message),
  );

  // Y otra vez pasada la medianoche UTC, para el bot que SI se queda vivo
  // muchas horas: sin esto, el primer corner que se liquide despues de las
  // 00:00 UTC vuelve a pagar el barrido en frio dentro de su propio tope.
  setInterval(() => {
    eventosDeHoy().catch(e => console.error('[fotmob] fallo calentando el cache del barrido (refresco diario):', e.message));
  }, 24 * 3600 * 1000);
}

// -----------------------------------------------------------------------------
// PILOTO PRE-PARTIDO (src/fetcher.js: fetchPrematch) — de solo lectura.
// -----------------------------------------------------------------------------
// QUE HACE: guarda el historial de cuotas de los partidos de futbol AUN NO
// INICIADOS (GetEvents, hasta 31 dias hacia adelante segun se midio el
// 2026-09-22), para poder medir "steam" — si el movimiento de la linea entre
// la apertura y el cierre (kickoff) predice el resultado, señal documentada
// en la literatura de apuestas deportivas (dinero informado mueve la linea
// antes que el publico). No puntua, no emite, no apuesta, no toca el
// firewall ni el modelo — mismo criterio que STATS_PILOT/FOTMOB_PILOT.
//
// POR QUE UNA SOLA LLAMADA BASTA: a diferencia del piloto de corners
// (una llamada por partido via GetEventDetails), GetEvents trae TODOS los
// partidos programados de un deporte, con mercados y cuotas incluidos, en una
// sola respuesta — normalize() la procesa sin cambios (misma forma que
// GetLiveOverview). Solo hay que sumar `startDate` a mano, que normalize()
// no conserva.
//
// SIN RESULTADOS TODAVIA: liquidar estos picks (saber si el favorito gano,
// etc.) requiere el mismo pipeline de liquidacion que ya usan los picks
// reales — se deja para cuando haya suficiente historial de apertura/cierre
// acumulado como para que valga la pena construirlo.
const PREMATCH_PILOT = /^(1|true|on|si|sí)$/i.test(env('PREMATCH_PILOT') || '');
const PREMATCH_MINUTES = Number(env('PREMATCH_MINUTES') || 60);
const PREMATCH_STUCK_MS = Number(env('PREMATCH_STUCK_MS') || 5 * 60000);
const PREMATCH_SPORT_ID = Number(env('PREMATCH_SPORT_ID') || 66); // Futbol

let prematchRunning = false;
let prematchSince = 0;
let prematchReintentos = 0;

async function muestrearPrematch() {
  if (!PREMATCH_PILOT) return;
  if (prematchRunning) {
    if (Date.now() - prematchSince < PREMATCH_STUCK_MS) return;
    console.error(`[prematch] el ciclo anterior lleva ${Math.round((Date.now() - prematchSince) / 1000)}s sin terminar; se da por colgado y se arranca otro`);
  }
  prematchRunning = true;
  prematchSince = Date.now();
  try {
    const data = await fetchPrematch(PREMATCH_SPORT_ID);
    const rows = normalize([{ sport: { name: 'Fútbol', id: PREMATCH_SPORT_ID }, data }]);
    // normalize() no conserva startDate; se une a mano desde los eventos crudos.
    const startById = new Map((data.events || []).map(e => [e.id, e.startDate || null]));
    const ts = new Date().toISOString();
    const filas = rows.map(r => ({
      ts, sport: r.sport, sportId: r.sportId, champ: r.champ,
      eventId: r.eventId, event: r.event, startDate: startById.get(r.eventId) || null,
      market: r.market, selection: r.selection, oddDecimal: r.oddDecimal, oddAmerican: r.oddAmerican,
      suspended: r.suspended,
    }));
    if (filas.length) savePrematchSnapshot(filas);
    const eventos = new Set(filas.map(f => f.eventId)).size;
    console.log(`[prematch ${ts}] ${eventos} partidos pre-partido, ${filas.length} filas`);
    prematchReintentos = 0;
  } catch (e) {
    console.error('[prematch]', e.message);
    // Al arrancar el bot el ciclo suele expirar (el hilo esta ocupado con el arranque) y sin reintento las
    // cuotas quedaban 1 h viejas — y el reporte de las 08:00 y /parlayprox leen de esta tabla.
    if (prematchReintentos < 3) { prematchReintentos++; setTimeout(muestrearPrematch, 3 * 60000); }
  } finally {
    prematchRunning = false;
  }
}

if (PREMATCH_PILOT) {
  console.log(`[prematch] piloto ACTIVO: cada ${PREMATCH_MINUTES} min, sportId=${PREMATCH_SPORT_ID}`);
  setInterval(muestrearPrematch, PREMATCH_MINUTES * 60 * 1000);
  muestrearPrematch();
}

// -----------------------------------------------------------------------------
// ESCANEO DE VALOR PRE-PARTIDO vs. casa sharp (src/prematchValue.js) — solo lectura.
// -----------------------------------------------------------------------------
// A diferencia del piloto de arriba (que guarda apertura/cierre PROPIO para
// medir "steam" mas adelante, semanas de espera), esto compara la cuota de
// Playdoit contra Pinnacle/Betfair (misma fuente que ya se usaba solo para
// picks en vivo, src/sharp.js) EN EL MISMO INSTANTE — no espera nada.
// Validado a mano el 2026-09-22: 100% de emparejamiento en EPL+LaLiga, con al
// menos un caso real de diferencia grande (~16%).
//
// PRESUPUESTO COMPARTIDO: cada liga escaneada cuesta 1 credito de
// SHARP_MAX_CREDITS_PER_DAY, EL MISMO presupuesto que ya gastan los picks en
// vivo (src/sharp.js ya lo controla — si se agota, fetchLeagueOdds devuelve
// null/cache sin gastar de mas). Por eso se escanea solo un puñado de ligas
// por ciclo, rotando, y con un intervalo largo (horas, no minutos) — las
// cuotas pre-partido no cambian tan rapido como para necesitar mas.
//
// SIGUE SIN DECIDIR NADA: guarda las comparaciones en prematch_value_scan
// para medir despues (con resultados reales) si estas discrepancias
// predicen algo o son solo ruido de margen. No emite, no apuesta.
const PREMATCH_SHARP_SCAN = /^(1|true|on|si|sí)$/i.test(env('PREMATCH_SHARP_SCAN') || '');
const PREMATCH_SHARP_SCAN_MINUTES = Number(env('PREMATCH_SHARP_SCAN_MINUTES') || 240);
const PREMATCH_SHARP_SCAN_LIGAS_POR_CICLO = Number(env('PREMATCH_SHARP_SCAN_LIGAS_POR_CICLO') || 3);
const PREMATCH_SHARP_SCAN_STUCK_MS = Number(env('PREMATCH_SHARP_SCAN_STUCK_MS') || 5 * 60000);
// Diferencia minima para que el resumen de log la cuente como "destacada" —
// solo afecta el log, no filtra lo que se guarda (se guarda todo, filtrar
// despues con datos es mas seguro que decidir un umbral hoy sin backtest).
const PREMATCH_SHARP_SCAN_DESTACADO_PCT = Number(env('PREMATCH_SHARP_SCAN_DESTACADO_PCT') || 5);

let prematchScanRunning = false;
let prematchScanSince = 0;
let prematchScanCursor = 0;

async function escanearValorPrematch() {
  if (!PREMATCH_SHARP_SCAN) return;
  if (prematchScanRunning) {
    if (Date.now() - prematchScanSince < PREMATCH_SHARP_SCAN_STUCK_MS) return;
    console.error(`[prematch-scan] el ciclo anterior lleva ${Math.round((Date.now() - prematchScanSince) / 1000)}s sin terminar; se da por colgado y se arranca otro`);
  }
  prematchScanRunning = true;
  prematchScanSince = Date.now();
  try {
    const ligasFutbol = (process.env.SHARP_SPORT_KEYS || '').split(',').map(s => s.trim()).filter(s => s.startsWith('soccer_'));
    if (!ligasFutbol.length) {
      console.log('[prematch-scan] sin ligas de futbol en SHARP_SPORT_KEYS; nada que escanear');
      return;
    }
    const tanda = [];
    for (let i = 0; i < PREMATCH_SHARP_SCAN_LIGAS_POR_CICLO; i++) {
      tanda.push(ligasFutbol[prematchScanCursor % ligasFutbol.length]);
      prematchScanCursor++;
    }
    let total = 0, destacadas = 0;
    for (const liga of tanda) {
      try {
        const filas = await escanearLigaPrematch(liga);
        if (filas.length) savePrematchValueScan(filas);
        total += filas.length;
        destacadas += filas.filter(f => Math.abs(f.edgePct) >= PREMATCH_SHARP_SCAN_DESTACADO_PCT).length;
      } catch (e) {
        console.error(`[prematch-scan] ${liga}:`, e.message);
      }
      await new Promise(r => setTimeout(r, 500));
    }
    console.log(`[prematch-scan ${new Date().toISOString()}] ${tanda.join(',')} | ${total} comparaciones, ${destacadas} con diferencia >=${PREMATCH_SHARP_SCAN_DESTACADO_PCT}%`);
  } catch (e) {
    console.error('[prematch-scan]', e.message);
  } finally {
    prematchScanRunning = false;
  }
}

if (PREMATCH_SHARP_SCAN) {
  console.log(`[prematch-scan] piloto ACTIVO: cada ${PREMATCH_SHARP_SCAN_MINUTES} min, ${PREMATCH_SHARP_SCAN_LIGAS_POR_CICLO} ligas/ciclo, comparte presupuesto con src/sharp.js`);
  setInterval(escanearValorPrematch, PREMATCH_SHARP_SCAN_MINUTES * 60 * 1000);
  escanearValorPrematch();
}

// Piloto de xG pre-partido (src/prematchXg.js), pedido explicito del usuario
// el 2026-09-23 tras confirmar que FotMob expone xG de temporada por equipo
// (/data/teams?id=X). A diferencia del escaneo sharp (compara contra otra
// casa) y de steam (compara Playdoit contra si mismo), esta señal viene del
// RENDIMIENTO medido del equipo: disponible desde que se conoce el fixture,
// sin esperar a que nadie mueva una cuota. Solo lectura, no decide ni emite.
//
// FUENTE DE EVENTOS: reutiliza lo que ya captura PREMATCH_PILOT en
// prematch_snapshots — un evento SOLO se procesa si aun no tiene fila en
// prematch_xg_scan (idx_prematch_xg_uniq por event_id), asi que cada partido
// se resuelve una vez, no en cada ciclo.
//
// COSTO: hasta ~7 llamadas HTTP por evento (dias de calendario + matchDetails
// + 2 equipos), sin credito de por medio (FotMob no lo cobra) pero si con
// tope de eventos por ciclo para no saturar el rate-limit del propio FotMob.
const PREMATCH_XG_PILOT = /^(1|true|on|si|sí)$/i.test(env('PREMATCH_XG_PILOT') || '');
const PREMATCH_XG_MINUTES = Number(env('PREMATCH_XG_MINUTES') || 120);
const PREMATCH_XG_EVENTOS_POR_CICLO = Number(env('PREMATCH_XG_EVENTOS_POR_CICLO') || 10);
const PREMATCH_XG_STUCK_MS = Number(env('PREMATCH_XG_STUCK_MS') || 5 * 60000);

let prematchXgRunning = false;
let prematchXgSince = 0;

async function escanearXgPrematch() {
  if (!PREMATCH_XG_PILOT) return;
  if (prematchXgRunning) {
    if (Date.now() - prematchXgSince < PREMATCH_XG_STUCK_MS) return;
    console.error(`[prematch-xg] el ciclo anterior lleva ${Math.round((Date.now() - prematchXgSince) / 1000)}s sin terminar; se da por colgado y se arranca otro`);
  }
  prematchXgRunning = true;
  prematchXgSince = Date.now();
  try {
    const pendientes = db.prepare(`
      SELECT DISTINCT p.event_id, p.event
      FROM prematch_snapshots p
      LEFT JOIN prematch_xg_scan x ON x.event_id = p.event_id
      WHERE p.start_date > strftime('%Y-%m-%dT%H:%M:%SZ','now')
        AND (x.event_id IS NULL OR (x.xg_esperado_total IS NOT NULL AND x.league_id IS NULL))
      LIMIT ?
    `).all(PREMATCH_XG_EVENTOS_POR_CICLO * 3); // margen: no todos van a tener xG en FotMob

    let procesados = 0, conXg = 0;
    for (const ev of pendientes) {
      if (procesados >= PREMATCH_XG_EVENTOS_POR_CICLO) break;
      procesados++;
      try {
        const xg = await xgDeEvento(ev.event_id);
        if (xg) {
          savePrematchXg({
            ts: new Date().toISOString(), eventId: ev.event_id, event: xg.event, startDate: xg.startDate,
            fotmobMatchId: xg.fotmobMatchId,
            homeTeamId: xg.home.teamId, homePlayed: xg.home.played, homeXgFor: xg.home.xgFor, homeXgAgainst: xg.home.xgAgainst,
            awayTeamId: xg.away.teamId, awayPlayed: xg.away.played, awayXgFor: xg.away.xgFor, awayXgAgainst: xg.away.xgAgainst,
            xgEsperadoLocal: xg.xgEsperadoLocal, xgEsperadoVisita: xg.xgEsperadoVisita, xgEsperadoTotal: xg.xgEsperadoTotal,
            leagueId: xg.leagueId, seasonId: xg.seasonId, leagueXgAvg: xg.leagueXgAvg,
            xgNormLocal: xg.xgNormLocal, xgNormVisita: xg.xgNormVisita, xgNormTotal: xg.xgNormTotal,
          });
          conXg++;
        } else {
          // sin xG disponible (friendly, liga menor, sin match en FotMob): se
          // guarda igual con nulos para no reintentar este evento cada ciclo.
          savePrematchXg({
            ts: new Date().toISOString(), eventId: ev.event_id, event: ev.event, startDate: null,
            fotmobMatchId: null, homeTeamId: null, homePlayed: null, homeXgFor: null, homeXgAgainst: null,
            awayTeamId: null, awayPlayed: null, awayXgFor: null, awayXgAgainst: null,
            xgEsperadoLocal: null, xgEsperadoVisita: null, xgEsperadoTotal: null,
            leagueId: null, seasonId: null, leagueXgAvg: null, xgNormLocal: null, xgNormVisita: null, xgNormTotal: null,
          });
        }
      } catch (e) {
        console.error(`[prematch-xg] event_id ${ev.event_id}:`, e.message);
      }
      await new Promise(r => setTimeout(r, 300));
    }
    console.log(`[prematch-xg ${new Date().toISOString()}] ${procesados} eventos procesados, ${conXg} con xG disponible`);
  } catch (e) {
    console.error('[prematch-xg]', e.message);
  } finally {
    prematchXgRunning = false;
  }
}

if (PREMATCH_XG_PILOT) {
  console.log(`[prematch-xg] piloto ACTIVO: cada ${PREMATCH_XG_MINUTES} min, ${PREMATCH_XG_EVENTOS_POR_CICLO} eventos/ciclo`);
  setInterval(escanearXgPrematch, PREMATCH_XG_MINUTES * 60 * 1000);
  escanearXgPrematch();
}

/**
 * WATCHDOG: revisa cada 3 min si el sampler, el piloto de stats, el piloto de
 * FotMob y el dashboard SIGUEN produciendo datos frescos — no solo si el
 * proceso vive, que es lo unico que ya vigilaban los guards *_STUCK_MS (y
 * esos se auto-reparan en silencio, sin avisarle a nadie). Antes la unica
 * forma de notar un congelamiento era mirar la columna "ultima lectura" del
 * dashboard a mano — si nadie estaba viendo, podia llevar horas sin que
 * nadie se enterara (el propio incidente del 2026-08-19: 4h de silencio con
 * el proceso vivo).
 *
 * Avisa por Telegram SOLO en la TRANSICION (se congelo / se recupero), no en
 * cada ciclo mientras sigue mal — mismo criterio que driftCheck. Sin esto,
 * un congelamiento real generaria una alerta cada 3 min para siempre.
 *
 * "Congelado" = sin fila nueva en 3 ciclos de su propio intervalo (mismo
 * margen que ya usaba el panel de arranque para FotMob). Cada pieza solo
 * se vigila si esta prendida — un piloto apagado a proposito no es una falla.
 */
const SALUD_INTERVALO_MS = 3 * 60 * 1000;
const saludPrevia = { sampler: true, stats: true, fotmob: true, dashboard: true };
const SALUD_NOMBRES = {
  sampler: 'Sampler de odds (playdoit)',
  stats: 'Piloto de estadísticas',
  fotmob: 'Piloto de FotMob',
  dashboard: 'Dashboard',
};

// Ventana activa: 8am-11pm hora CDMX, todos los dias. Fuera de ahi (madrugada)
// el sampler de por si tiene menos mercados en vivo y un congelamiento corto
// importa menos — no vale la pena el ruido de un mensaje largo. Se calcula la
// hora LOCAL de Mexico explicitamente (no la del servidor, que puede correr en
// otro huso) via Intl, sin depender de que el proceso tenga TZ configurada.
function horaActivaMx(ahora = new Date()) {
  const hora = Number(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Mexico_City', hour: 'numeric', hour12: false,
  }).format(ahora));
  return hora >= 8 && hora < 23;
}

async function verificarSalud() {
  try {
    const ahora = Date.now();
    // null (no true/false) cuando AUN no hay ninguna fila — un piloto recien
    // prendido no tiene datos todavia y eso no es un congelamiento. El bucle
    // de abajo solo actua sobre true/false; null se salta sin marcar nada,
    // asi que el primer dato real decide, no un arranque en frio.
    const fresco = (tsIso, minutos) => tsIso == null ? null : (ahora - new Date(tsIso).getTime()) <= minutos * 3 * 60000;
    const estados = {};

    estados.sampler = fresco(db.prepare('SELECT MAX(ts) ts FROM snapshots').get()?.ts, SAMPLE_MINUTES);
    if (STATS_PILOT) estados.stats = fresco(db.prepare('SELECT MAX(ts) ts FROM stat_snapshots').get()?.ts, STATS_MINUTES);
    if (FOTMOB_PILOT) estados.fotmob = fresco(db.prepare('SELECT MAX(ts) ts FROM fotmob_corner_snapshots').get()?.ts, FOTMOB_MINUTES);
    if (DASHBOARD_AUTOSTART) estados.dashboard = dashboardAlive();

    for (const [clave, sano] of Object.entries(estados)) {
      const antes = saludPrevia[clave];
      // El sampler es el UNICO que reduce el aviso a solo el emoji: es el que
      // decide "el universo de mercados seleccionables" (fetchAllLive), asi
      // que es tambien el unico donde recuperarse significa algo mas que
      // "ya hay datos" — significa "hay que re-consultar ESE universo ya, no
      // esperar al proximo ciclo natural". Los demas pilotos (stats/fotmob/
      // dashboard) conservan el aviso largo tal cual.
      if (clave === 'sampler' && horaActivaMx()) {
        if (antes !== false && sano === false) {
          console.error(`[salud] ${clave} parece congelado (sin conexion, 8am-11pm)`);
          await reply(CHAT_ID, '🔴', false).catch(() => {});
        } else if (antes === false && sano === true) {
          console.log(`[salud] ${clave} se recupero — re-consultando el universo de mercados`);
          await reply(CHAT_ID, '🟢', false).catch(() => {});
          // Fire-and-forget: no bloquear verificarSalud() a la espera de un
          // ciclo completo. sample() ya trae su propio guard `sampling`, asi
          // que si un ciclo natural ya arranco entretanto esto no hace nada.
          sample().catch(e => console.error('[salud] fallo el resampleo forzado tras recuperar:', e.message));
        }
        saludPrevia[clave] = sano;
        continue;
      }
      if (antes !== false && sano === false) {
        console.error(`[salud] ${clave} parece congelado`);
        await reply(CHAT_ID, `🔴 <b>${SALUD_NOMBRES[clave]}</b> parece congelado — sin datos nuevos en más de lo esperado. Revisa <code>bot.log</code>.`, false).catch(() => {});
      } else if (antes === false && sano === true) {
        console.log(`[salud] ${clave} se recupero`);
        await reply(CHAT_ID, `🟢 <b>${SALUD_NOMBRES[clave]}</b> se recuperó, ya vuelve a producir datos.`, false).catch(() => {});
      }
      saludPrevia[clave] = sano;
    }
  } catch (e) {
    console.error('[salud]', e.message);
  }
}
// -----------------------------------------------------------------------------
// REPORTE PRE-PARTIDO DE LAS 08:00 (CDMX) — src/reportePrematch.js.
// Imagen 9:16 (valor vs Pinnacle, parlay de 3-4 patas, mas probables del dia) +
// CSV con TODAS las jugadas del dia, al canal VIP (suscriptores) y al dueno.
// Pedido del usuario el 2026-09-25. NO decide ni puntua nada: solo lee
// prematch_snapshots / prematch_value_scan, no gasta cuota de API, no toca el
// firewall ni el modelo. Guarda las patas mostradas en prematch_report_picks y
// las liquida despues: es el unico camino para tener record pre-partido.
// PREMATCH_REPORT=0 lo apaga; PREMATCH_REPORT_HORA='08:00' (CDMX) lo mueve.
// -----------------------------------------------------------------------------
const PREMATCH_REPORT = /^(0|false|off|no)$/i.test(env('PREMATCH_REPORT') || '') ? false : PREMATCH_PILOT;
const PREMATCH_REPORT_HORA = /^\d{1,2}:\d{2}$/.test(env('PREMATCH_REPORT_HORA') || '') ? env('PREMATCH_REPORT_HORA') : '08:00';
let reporteEnCurso = false;

async function enviarReportePrematch({ chatIds, persistir }) {
  const R = require('./src/reportePrematch');
  const { sendPhotoFile, sendDocumentBuffer } = require('./src/telegram');
  const ahora = Date.now();
  const ini = new Date(ahora).toISOString();
  const fin = new Date(ahora + 24 * 3600e3).toISOString();
  const filas = db.prepare(`
    SELECT s.event_id, s.event, s.champ, s.start_date, s.market, s.selection, s.odd_decimal, s.suspended
    FROM prematch_snapshots s
    JOIN (SELECT event_id, market, selection, MAX(ts) mts FROM prematch_snapshots
          WHERE start_date >= ? AND start_date < ? GROUP BY event_id, market, selection) u
      ON s.event_id = u.event_id AND s.market = u.market AND s.selection = u.selection AND s.ts = u.mts`).all(ini, fin);
  const partidos = R.agruparPartidos(filas);
  if (!partidos.size) return { enviado: false, motivo: 'sin partidos con cuota' };
  const patas = [...partidos.values()].flatMap(R.patasDePartido);
  const valor = R.valorSharp(db.prepare('SELECT * FROM prematch_value_scan WHERE start_date >= ? AND start_date < ?').all(ini, fin));
  const parlay = R.armarParlay(patas, { ahoraMs: ahora });
  const top = R.topProbables(patas, { ahoraMs: ahora });

  const tz = 'America/Mexico_City';
  const d = new Date(ahora);
  const fecha = d.toLocaleDateString('es-MX', { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
    .replace(',', '').replace(/^./, c => c.toUpperCase());
  const hora = d.toLocaleTimeString('es-MX', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false });
  const dia = new Date(ahora - 6 * 3600e3).toISOString().slice(0, 10);
  const png = await renderPanelEstadoImagen(R.armarDatosImagen({ fecha, hora, valor, parlay, top, totalPartidos: partidos.size }));
  const csv = Buffer.from(R.csvTodas(partidos), 'utf8');
  const leyenda = R.leyenda({ valor, parlay });
  const buf = fs.readFileSync(png);
  fs.unlink(png, () => {});
  // Imagen extra: estado de las patas de reportes anteriores (ayer y hoy) — WIN/LOSS/PUSH/pendiente.
  // Antes se liquida lo que ya termino (la tarea de cada 30 min podria llevar hasta media hora de retraso).
  let bufEstado = null;
  try {
    await liquidarReportePrematch();
    const diaAyer = new Date(Date.parse(dia + 'T12:00:00Z') - 86400000).toISOString().slice(0, 10);
    const estadoFilas = require('./src/db').reporteEstado(diaAyer);
    if (estadoFilas.length) {
      const pngE = await renderPanelEstadoImagen(R.armarEstadoImagen({ fecha, hora, filas: estadoFilas }));
      bufEstado = fs.readFileSync(pngE);
      fs.unlink(pngE, () => {});
    }
  } catch (e) { console.error('[reporte-prematch] imagen de estado:', e.message); }
  for (const id of chatIds) {
    try {
      await sendPhotoFile(TOKEN, id, buf, leyenda);
      if (bufEstado) await sendPhotoFile(TOKEN, id, bufEstado, '📋 <b>Estado de los picks pre-partido</b> (ayer y hoy)')
        .catch(e => console.error('[reporte-prematch] envio del estado:', e.message));
      await sendDocumentBuffer(TOKEN, id, csv, `jugadas-prematch-${dia}.csv`, `📄 Todas las jugadas con cuota de hoy (${partidos.size} partidos): cuota y probabilidad justa sin margen.`);
    } catch (e) { console.error(`[reporte-prematch] envio a ${id}:`, e.message); }
  }
  if (persistir) {
    const ts = new Date().toISOString();
    // xG esperado (simple, del piloto) mas reciente de cada partido mostrado; null si el piloto no lo cubre.
    const xgStmt = db.prepare('SELECT xg_esperado_local l, xg_esperado_visita v, xg_esperado_total t FROM prematch_xg_scan WHERE event_id = ? ORDER BY ts DESC LIMIT 1');
    const xgDe = (id) => xgStmt.get(id) || {};
    const fila = (kind, x) => { const g = xgDe(x.eventId); return { ts, dia, kind, event_id: x.eventId, event: x.event, champ: x.champ, start_date: x.start,
      market: x.market, selection: x.sel, odd_decimal: x.odd, p_justa: x.p, xg_local: g.l ?? null, xg_visita: g.v ?? null, xg_total: g.t ?? null }; };
    const v = valor.map(f => ({ ts, dia, kind: 'valor', event_id: f.event_id, event: f.event, champ: f.champ, start_date: f.start_date,
      market: f.market, selection: f.selection, odd_decimal: f.playdoit_odd, p_justa: null, ...(() => { const g = xgDe(f.event_id); return { xg_local: g.l ?? null, xg_visita: g.v ?? null, xg_total: g.t ?? null }; })() }));
    require('./src/db').saveReportPicks([...(parlay ? parlay.patas.map(x => fila('parlay', x)) : []), ...top.map(x => fila('top', x)), ...v]);
  }
  return { enviado: true, partidos: partidos.size, valor: valor.length, parlay: parlay ? parlay.patas.length : 0 };
}

// /experimentos: estado de los picks que se avisan como experimento (corners en registro y rescate del modelo).
async function handleExperimentos(chatId) {
  const { textoExperimentos } = require('./src/experimentos');
  const corners = db.prepare('SELECT id, event, linea, lado, odd, minuto, result, final_count FROM corner_picks ORDER BY id DESC').all();
  const rescate = db.prepare("SELECT id, event, market, selection, odd_decimal, result, final_score FROM picks WHERE source = 'rescue' ORDER BY id DESC").all();
  return reply(chatId, textoExperimentos({ corners, rescate }));
}

// /parlayprox [horas]: parlay de 3-4 patas de los partidos que estan por empezar (por defecto en las proximas 3 h,
// maximo 12). Solo lee prematch_snapshots (sin API, sin escribir) => abierto a cualquier chat, como los demas
// comandos de lectura. Mismos filtros que el parlay del reporte de las 08:00.
async function handleParlayProximos(args, chatId) {
  const R = require('./src/reportePrematch');
  const horas = Math.min(12, Math.max(1, Number(args[0]) || 3));
  const ahora = Date.now();
  const filas = db.prepare(`
    SELECT s.event_id, s.event, s.champ, s.start_date, s.market, s.selection, s.odd_decimal, s.suspended
    FROM prematch_snapshots s
    JOIN (SELECT event_id, market, selection, MAX(ts) mts FROM prematch_snapshots
          WHERE start_date >= ? AND start_date < ? GROUP BY event_id, market, selection) u
      ON s.event_id = u.event_id AND s.market = u.market AND s.selection = u.selection AND s.ts = u.mts`)
    .all(new Date(ahora).toISOString(), new Date(ahora + horas * 3600e3).toISOString());
  const partidos = R.agruparPartidos(filas);
  const ult = db.prepare('SELECT MAX(ts) ts FROM prematch_snapshots').get();
  const frescura = ult && ult.ts ? Math.round((ahora - Date.parse(ult.ts)) / 60000) : null;
  const patas = [...partidos.values()].flatMap(R.patasDePartido);
  const parlay = R.armarParlayProximos(patas, { ahoraMs: ahora, horas });
  let nota = '';
  // AUDITORÍA: solo el dueño registra (escribe en disco; el botón está abierto a cualquier chat, que
  // sigue siendo de solo lectura). kind='parlay_prox': no cuenta como reporte del día ni entra en el
  // estado de las 08:00 (ver db.js). Mismo parlay el mismo día = una sola fila (guardarParlayProx).
  if (parlay && isOwner(chatId)) {
    try {
      const ts = new Date().toISOString();
      const dia = new Date(ahora - 6 * 3600e3).toISOString().slice(0, 10);
      const xgStmt = db.prepare('SELECT xg_esperado_local l, xg_esperado_visita v, xg_esperado_total t FROM prematch_xg_scan WHERE event_id = ? ORDER BY ts DESC LIMIT 1');
      const filas = parlay.patas.map(x => { const g = xgStmt.get(x.eventId) || {}; return { ts, dia, kind: 'parlay_prox', event_id: x.eventId, event: x.event, champ: x.champ,
        start_date: x.start, market: x.market, selection: x.sel, odd_decimal: x.odd, p_justa: x.p, xg_local: g.l ?? null, xg_visita: g.v ?? null, xg_total: g.t ?? null }; });
      const nuevo = require('./src/db').guardarParlayProx(filas, dia);
      nota = `\n<i>📝 ${nuevo ? 'Registrado para auditoría' : 'Ya estaba registrado (mismo parlay)'}.</i>`;
    } catch (e) { console.error('[parlayprox] registro:', e.message); }
  }
  return reply(chatId, R.textoParlayProximos(parlay, { horas, partidos: partidos.size, frescuraMin: frescura }) + nota);
}

// Una vez al dia, al pasar la hora del reporte (con hasta 10 min de margen por si el bot
// arranca tarde) y solo si no se envio ya ese dia (se persiste con las patas mostradas).
async function chequearReportePrematch() {
  if (!PREMATCH_REPORT || reporteEnCurso) return;
  const cdmx = new Date(Date.now() - 6 * 3600e3);
  const dia = cdmx.toISOString().slice(0, 10);
  const [h, m] = PREMATCH_REPORT_HORA.split(':').map(Number);
  const minutos = cdmx.getUTCHours() * 60 + cdmx.getUTCMinutes();
  if (minutos < h * 60 + m || minutos > h * 60 + m + 10) return;
  if (require('./src/db').reporteYaEnviado(dia)) return;
  reporteEnCurso = true;
  try {
    const destinos = [...new Set([VIP_CHANNEL_ID, process.env.TELEGRAM_GOLDEN_CHANNEL_ID, CHAT_ID].filter(Boolean).map(String))];
    const r = await enviarReportePrematch({ chatIds: destinos, persistir: true });
    console.log('[reporte-prematch]', JSON.stringify(r));
  } catch (e) { console.error('[reporte-prematch]', e.message); }
  finally { reporteEnCurso = false; }
}

// Liquida las patas de dias anteriores: marcador FotMob (si el xG piloto ya guardo el partido) o,
// si no, el marcador final "creible" del feed en vivo (src/marcadorFeed.js). Sin marcador: queda pendiente.
async function liquidarReportePrematch() {
  if (!PREMATCH_REPORT) return;
  const R = require('./src/reportePrematch');
  const { reportePendientes, liquidarReportePick } = require('./src/db');
  const { fetchMarcadorFinal } = require('./src/fotmobScraper');
  const { marcadorFinalCreible, ultimaMuestraConMarcador } = require('./src/marcadorFeed');
  const pend = reportePendientes(new Date(Date.now() - 3 * 3600e3).toISOString());
  let liquidadas = 0;
  for (const p of pend) {
    try {
      let gl = null, gv = null, fuente = null;
      const fm = db.prepare('SELECT fotmob_match_id id FROM prematch_xg_scan WHERE event_id = ? AND fotmob_match_id IS NOT NULL LIMIT 1').get(p.event_id);
      if (fm) {
        const f = await fetchMarcadorFinal(fm.id);
        if (f.finished) { gl = f.home; gv = f.away; fuente = 'fotmob'; }
      }
      if (gl == null) {
        const c = marcadorFinalCreible(ultimaMuestraConMarcador(db, p.event_id), Date.parse(p.start_date));
        if (c) { gl = c.gl; gv = c.gv; fuente = 'feed'; }
      }
      if (gl == null) continue;
      const res = R.resolverPata(p, gl, gv);
      if (res) { liquidarReportePick(p.id, res, `${gl}-${gv}`, fuente); liquidadas++; }
    } catch (e) { console.error('[reporte-prematch:liquidar]', p.event_id, e.message); }
  }
  if (liquidadas) console.log(`[reporte-prematch] ${liquidadas} patas liquidadas`);
}

if (PREMATCH_REPORT) {
  console.log(`[reporte-prematch] ACTIVO: diario ${PREMATCH_REPORT_HORA} CDMX -> canal VIP + dueno`);
  setInterval(chequearReportePrematch, 60 * 1000);
  setInterval(() => liquidarReportePrematch().catch(e => console.error('[reporte-prematch:liquidar]', e.message)), 30 * 60 * 1000);
}

setInterval(verificarSalud, SALUD_INTERVALO_MS);
if (EXEC_PROBE_ALERTS) {
  setInterval(vigilarSondeosEjecucion, 5 * 60 * 1000);
  setTimeout(vigilarSondeosEjecucion, 60 * 1000);
}

// Monitoreo de drift: chequeo diario, alerta por Telegram como máximo una vez
// cada 30 días si el ECE de los últimos 200 picks supera el umbral.
let lastDriftAlert = 0;
async function driftCheck() {
  try {
    const h = computeHealth();
    if (h.alert && Date.now() - lastDriftAlert > 30 * 24 * 3600 * 1000) {
      lastDriftAlert = Date.now();
      console.log(`[drift] ECE ${h.ece.toFixed(4)} > ${h.threshold} — recalibrar: correr train_weights.py`);
      await reply(CHAT_ID, `⚠️ <b>Drift de calibración</b>: ECE ${h.ece.toFixed(4)} > ${h.threshold} en los últimos ${h.n} picks.\nRecalibrar: manda /train (o corre <code>python scripts/train_weights.py</code>).`);
    }
  } catch (e) {
    console.error('[drift]', e.message);
  }
}
setInterval(driftCheck, 24 * 3600 * 1000);

// Poda de snapshots (~1.7M filas/día a SAMPLE_MINUTES=1): retiene
// RETENTION_DAYS (default 7) y preserva siempre los eventos con picks, que
// alimentan el CLV histórico. pruneSnapshots es síncrono (better-sqlite3),
// así que mientras corre NADA más se ejecuta en este proceso — de ahí el
// tope PRUNE_MAX_MS por corrida en vez de vaciar el backlog de una sentada.
//
// ANTES corria UNA VEZ AL DIA y solo volvia a intentar antes si la pasada
// anterior SI habia borrado algo. Con una tabla de 99M filas y una ventana de
// 50k filas examinadas por corrida, el cursor tarda ~2000 dias en dar una
// sola vuelta completa — asi que casi cualquier corrida caía en una region
// donde nada calificaba todavia, `deleted` salía 0, y el codigo se quedaba
// otras 24h sin insistir. Resultado medido el 2026-09-13: 77.7M de 99.67M
// filas (78%) ya tenian mas de RETENTION_DAYS y seguian sin borrarse. La
// tasa de poda (50k filas/corrida) nunca podia alcanzar la tasa de entrada
// (~1.7M filas/dia) corriendo una vez al dia.
//
// Arreglo: correr cada PRUNE_INTERVAL_MS (2 min por defecto) SIN condicionar
// al resultado de la corrida anterior — es el avance constante del cursor,
// no el numero de filas borradas en una ventana puntual, lo que garantiza
// que la tabla completa se revise. A este ritmo (50k filas cada 2 min ≈ 36M
// filas/dia de cobertura) se supera con margen la tasa de entrada actual.
const PRUNE_MAX_MS = Number(process.env.PRUNE_MAX_MS || 2000);
const PRUNE_INTERVAL_MS = Number(process.env.PRUNE_INTERVAL_MS || 120000);
function prune() {
  try {
    const { deleted, pending, ms, examined } = pruneSnapshots(
      Number(process.env.RETENTION_DAYS || 7),
      { maxMs: PRUNE_MAX_MS, pickedDays: Number(process.env.PICKED_RETENTION_DAYS || 60) });
    if (deleted) console.log(`[prune] ${deleted} snapshots viejos eliminados en ${ms}ms${pending ? ' (queda backlog)' : ''}`);
    else console.log(`[prune] nada que borrar en esta ventana: ${examined} filas examinadas en ${ms}ms`);
  } catch (e) {
    console.error('[prune]', e.message);
  }
}
setInterval(prune, PRUNE_INTERVAL_MS);
setTimeout(prune, 60000);

// Ciclo focalizado: solo los deportes de interés, cada FOCUS_SAMPLE_SECONDS
// con jitter ±20%. El tope global de peticiones lo aplica src/ratelimit.js.
let focusing = false;
async function focusedSample() {
  if (focusing || sampling || !focusSports.length) return;
  focusing = true;
  try {
    for (const sport of focusSports) {
      try {
        const res = await fetchSportLive(sport);
        const rows = normalize([res]);
        if (rows.length) saveSnapshot(rows);
      } catch (e) {
        console.error(`[focus] ${sport.name}: ${e.message}`);
      }
      await new Promise(r => setTimeout(r, 250));
    }
  } finally {
    focusing = false;
  }
}
function scheduleFocused() {
  const jitter = 0.8 + Math.random() * 0.4; // ±20%
  setTimeout(async () => {
    try { await focusedSample(); } catch (e) { console.error('[focus]', e.message); }
    scheduleFocused();
  }, FOCUS_SAMPLE_SECONDS * 1000 * jitter);
}
scheduleFocused();

// El túnel solo tiene sentido si el panel está (o queda) vivo, así que su
// autostart cuelga del resultado del panel en vez de dispararse en paralelo:
// si DASHBOARD_AUTOSTART está apagado pero el panel ya lo dejó vivo una
// sesión anterior (adoptado por lock), igual arranca.
function autostartTunnelSiToca() {
  if (!TUNNEL_AUTOSTART) return;
  startTunnel()
    .then(msg => {
      console.log('[tunnel:autostart]', msg.replace(/<[^>]+>/g, ''));
      // Autostart no lo pide nadie por chat, así que sin este aviso la URL
      // nueva (cambia cada arranque) solo se sabría mirando tunnel.log a mano.
      reply(CHAT_ID, `🌐 <b>Túnel público (autostart)</b>\n${msg}`).catch(() => {});
    })
    .catch(e => console.error('[tunnel:autostart]', e.message));
}

if (DASHBOARD_AUTOSTART) {
  startDashboard()
    .then(msg => {
      console.log('[dashboard:autostart]', msg.replace(/<[^>]+>/g, ''));
      autostartTunnelSiToca();
    })
    .catch(e => console.error('[dashboard:autostart]', e.message));
} else {
  autostartTunnelSiToca();
}

poll();
