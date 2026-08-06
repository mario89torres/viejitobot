require('dotenv').config();
const { fetchAllLive, fetchSportLive } = require('./src/fetcher');
const { normalize } = require('./src/normalize');
const { saveSnapshot, logPicks, getUnsettledPicks, getStats,
        setSharpEntry, setSharpStatus, pruneSnapshots,
        isDuplicatePick, countPicksSince,
        addSubscriber, getSubscriber, getActiveSubscribers, getExpiredSubscribers, setSubscriberStatus } = require('./src/db');
const { processSettlements } = require('./src/results');
const { topPicks } = require('./src/analyze');
const { sendTelegram, formatMessage } = require('./src/telegram');
const { safestPicks, rankPicks, goldenPick, parlayCombos } = require('./src/confidence');
const { computeMetrics, compareScores, edgeStats, computeHealth, stakeStats, stakePicksByDate } = require('./src/metrics');
const { getMode, reloadModel } = require('./src/model');
const sharp = require('./src/sharp');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileP = promisify(execFile);

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
/unidades hoy — detalle pick por pick liquidados hoy (o /unidades ayer / AAAA-MM-DD)
/validar — contrasta los resultados liquidados contra el marcador oficial (3 días)
/validar 6h — solo las últimas 6 horas (menos picks; el costo es por liga, no por pick)
/train — exporta el dataset y reentrena el modelo (walk-forward + calibración)
/deportes — deportes en vivo ahora
/help — esta ayuda e interfaz de botones`;

function norm(s) {
  return s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

async function getFreshRows() {
  const sportResults = await fetchAllLive();
  const rows = normalize(sportResults);
  if (rows.length) saveSnapshot(rows);
  return { rows, sports: sportResults.map(r => r.sport) };
}

async function handleTop(args) {
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

  await reply('⏳ Consultando momios en vivo...');
  const { rows } = await getFreshRows();
  let filtered = rows;
  if (sportFilter) filtered = filtered.filter(r => norm(r.sport).includes(sportFilter));
  if (minMinute !== null) filtered = filtered.filter(r => r.minute !== null && r.minute >= minMinute);
  if (minSet !== null) filtered = filtered.filter(r => r.setNum !== null && r.setNum >= minSet);

  if (!filtered.length) return reply('No hay jugadas en vivo con esos filtros ahora mismo.');

  const picks = topPicks(filtered, cfg);
  if (!picks.length) return reply('No hay jugadas dentro del rango de momios indicado.');
  await sendTelegram(TOKEN, CHAT_ID, formatMessage(picks));
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

async function handleSeguras(args) {
  const sportFilter = args.length ? norm(args.join(' ')) : null;
  await reply('⏳ Analizando jugadas en vivo...');
  const { rows } = await getFreshRows();
  let filtered = rows;
  if (sportFilter) filtered = filtered.filter(r => norm(r.sport).includes(sportFilter));
  // e-sports/simulados excluidos por defecto (ruidosos), salvo que los pidas explícitamente
  else filtered = filtered.filter(r => !norm(r.sport).startsWith('e-'));
  if (!filtered.length) return reply('No hay jugadas en vivo con ese filtro ahora mismo.');

  const picks = safestPicks(filtered, 3);
  if (!picks.length) return reply('No hay jugadas candidatas en este momento.');
  // Se muestran todas, pero solo se REGISTRAN las nuevas: repetir /seguras no
  // debe duplicar filas en el dataset (los duplicados rompen la independencia
  // que el entrenamiento walk-forward asume).
  const fresh = picks.filter(p => !isDuplicatePick(p.eventId, p.market, p.selection));
  const pickIds = logPicks(fresh.map(p => ({
    ts: p.ts, eventId: p.eventId, event: p.event, sport: p.sport,
    market: p.market, selection: p.selection, oddDecimal: p.oddDecimal, conf: p.conf,
    fProbJusta: p.base, fAvance: p.progress, fSituacion: p.scoreFactor, fLinea: p.lineFactor,
    confHeuristic: p.confHeuristic, confLearned: p.confLearned, edge: p.edge, source: 'seguras',
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
    msg += `<b>${i + 1}. ${flag}</b> ${esc(p.event)} <i>(${esc(p.sport)}${p.champ ? ` — ${esc(p.champ)}` : ''})</i>\n`;
    if (p.score) msg += `   Marcador: ${esc(p.score)}${p.liveTime ? ` — ${esc(p.liveTime)}` : ''}\n`;
    msg += `   ${esc(p.market)}: <b>${esc(p.selection)}</b> @ ${p.oddDecimal.toFixed(2)} (${p.oddAmerican})\n`;
    msg += `   Confianza: <b>${pct(p.conf)}</b> | prob. implícita ${pct(p.base)} | avance ${pct(p.progress)}\n`;
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
  await sendTelegram(TOKEN, CHAT_ID, msg);
}

async function handleStats() {
  const { buckets, pending } = getStats();
  if (!buckets.length && !pending) return reply('Aún no hay picks registrados. Usa /seguras para empezar a acumular historial.');
  let msg = '<b>📊 Rendimiento de /seguras</b>\n\n';
  let tw = 0, tl = 0;
  for (const b of buckets) {
    const n = b.wins + b.losses;
    msg += `Confianza ${b.bucket}: <b>${b.wins}/${n}</b> (${Math.round(100 * b.wins / n)}% acierto)\n`;
    tw += b.wins; tl += b.losses;
  }
  if (tw + tl) msg += `\nTotal: <b>${tw}/${tw + tl}</b> (${Math.round(100 * tw / (tw + tl))}%)\n`;
  msg += `Pendientes de resolver: ${pending}`;

  const m = computeMetrics();
  if (m.n) {
    msg += `\n\n<b>📐 Calibración</b> (N=${m.n})\n`;
    if (m.n < 50) msg += `⚠️ <i>muestra insuficiente para conclusiones</i>\n`;
    msg += `Brier: <b>${m.brier.toFixed(4)}</b> | Log loss: <b>${m.logLoss.toFixed(4)}</b> | ECE: <b>${m.ece.toFixed(4)}</b>\n`;
    msg += `<pre>bin      n     conf  real  gap\n`;
    for (const b of m.bins) {
      const label = `${b.lo.toFixed(1)}-${b.hi.toFixed(1)}`.padEnd(9);
      if (!b.n) { msg += `${label}0     —     —     —\n`; continue; }
      const gap = `${b.gap >= 0 ? '+' : ''}${(100 * b.gap).toFixed(0)}%`;
      msg += `${label}${String(b.n).padEnd(6)}${pct(b.avgConf).padEnd(6)}${pct(b.winRate).padEnd(6)}${gap}\n`;
    }
    msg += `</pre>`;
    msg += m.clvN
      ? `CLV medio: <b>${m.clvAvg >= 0 ? '+' : ''}${(100 * m.clvAvg).toFixed(2)}%</b> (n=${m.clvN})`
      : `CLV: aún sin datos de mercado suficientes`;
  }

  const cmp = compareScores();
  if (cmp) {
    msg += `\n\n<b>🤖 Heurístico vs aprendido</b> (n=${cmp.n}, modo: ${getMode()})\n`;
    msg += `<pre>          brier   logloss ece\n`;
    msg += `heurist.  ${cmp.heuristic.brier.toFixed(4)}  ${cmp.heuristic.logLoss.toFixed(4)}  ${cmp.heuristic.ece.toFixed(4)}\n`;
    msg += `aprendido ${cmp.learned.brier.toFixed(4)}  ${cmp.learned.logLoss.toFixed(4)}  ${cmp.learned.ece.toFixed(4)}</pre>`;
  }

  const es = edgeStats();
  if (es) {
    const fmtPct = v => `${v >= 0 ? '+' : ''}${(100 * v).toFixed(2)}%`;
    msg += `\n\n<b>🎯 Edge (CLV sharp)</b>\n`;
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
  await reply(msg);
}

// ---------- /golden: un solo pick, la mejor relación seguridad/pago ----------
async function handleGolden(args) {
  const sportFilter = args.length ? norm(args.join(' ')) : null;
  await reply('⏳ Buscando el pick dorado...');
  const { rows } = await getFreshRows();
  let filtered = rows;
  if (sportFilter) filtered = filtered.filter(r => norm(r.sport).includes(sportFilter));
  else filtered = filtered.filter(r => !norm(r.sport).startsWith('e-'));
  if (!filtered.length) return reply('No hay jugadas en vivo con ese filtro ahora mismo.');

  const p = goldenPick(filtered);
  if (!p) {
    return reply('🥇 Ahora mismo no hay pick dorado: ninguna jugada cumple confianza ≥' +
      `${Math.round(100 * Number(process.env.GOLDEN_MIN_CONF || 0.70))}% con edge positivo ` +
      `a momio ≥${Number(process.env.GOLDEN_MIN_ODDS || 1.15).toFixed(2)}. Mejor no apostar que apostar caro.`);
  }

  if (!isDuplicatePick(p.eventId, p.market, p.selection)) {
    const [id] = logPicks([{
      ts: p.ts, eventId: p.eventId, event: p.event, sport: p.sport,
      market: p.market, selection: p.selection, oddDecimal: p.oddDecimal, conf: p.conf,
      fProbJusta: p.base, fAvance: p.progress, fSituacion: p.scoreFactor, fLinea: p.lineFactor,
      confHeuristic: p.confHeuristic, confLearned: p.confLearned, edge: p.edge, source: 'golden',
      openingOdd: p.openingOdd, fApertura: p.fApertura, scoreVersion: p.scoreVersion,
      stake: p.stake, stakeMode: p.stakeMode,
    }]);
    captureSharpEntries([id], [p]).catch(e => console.error('[sharp]', e.message));
  }

  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const now = new Date().toLocaleString('es-MX', { timeZone: 'America/Mexico_City' });
  const flag = getCountryFlag(p.champ, p.event, p.sport);
  let msg = `<b>🥇 Pick dorado</b>\n<i>${now}</i>\n\n`;
  msg += `${flag} <b>${esc(p.event)}</b> <i>(${esc(p.sport)}${p.champ ? ` — ${esc(p.champ)}` : ''})</i>\n`;
  if (p.score) msg += `Marcador: ${esc(p.score)}${p.liveTime ? ` — ${esc(p.liveTime)}` : ''}\n`;
  msg += `${esc(p.market)}: <b>${esc(p.selection)}</b> @ ${p.oddDecimal.toFixed(2)} (${p.oddAmerican})\n\n`;
  msg += `Confianza: <b>${pct(p.conf)}</b> | Edge estimado: <b>+${(100 * p.edge).toFixed(1)}%</b>\n`;
  if (p.stake != null) msg += `Unidad sugerida: <b>${p.stake.toFixed(1)}u</b>\n`;
  msg += `Pago: 100 → ${(100 * p.oddDecimal).toFixed(0)}\n`;
  if (p.lead !== null) msg += `Ventaja del pick: ${p.lead > 0 ? `+${p.lead}` : p.lead}\n`;
  if (p.lineDelta !== null) {
    const dir = p.lineDelta > 0 ? '📉 línea bajando (a favor)' : '📈 línea subiendo (en contra)';
    msg += `Línea: ${dir} ${pct(Math.abs(p.lineDelta))}\n`;
  }
  msg += `\n<i>Criterio: edge máximo del universo en vivo con confianza ≥${Math.round(100 * Number(process.env.GOLDEN_MIN_CONF || 0.70))}% y momio ≥${Number(process.env.GOLDEN_MIN_ODDS || 1.15).toFixed(2)}.</i>`;
  await sendTelegram(TOKEN, currentChatId || CHAT_ID, msg, MAIN_KEYBOARD);
}

// ---------- /parlay: combos +EV con selección óptima ----------
// Encuentra combinaciones de 2 ó 3 patas donde CADA pata tiene edge > 0 individual
// y el combo resultante maximiza el Edge Compuesto ajustado con factor de penalización por varianza γ = 0.97^(K-1).
async function handleParlay(args) {
  const sportFilter = args.length ? norm(args.join(' ')) : null;
  await reply('⏳ Analizando parlays +EV en vivo...');
  const { rows } = await getFreshRows();
  let filtered = rows;
  if (sportFilter) filtered = filtered.filter(r => norm(r.sport).includes(sportFilter));
  else filtered = filtered.filter(r => !norm(r.sport).startsWith('e-'));
  if (!filtered.length) return reply('No hay jugadas en vivo con ese filtro ahora mismo.');

  const combos = parlayCombos(filtered);
  if (!combos.length) {
    return reply('🎰 Ahora mismo no hay combinaciones de parlay con +EV verificado en vivo. ' +
      'Es preferible abstenerse que forzar un combo con esperanza matemática negativa (-EV).');
  }

  const best = combos[0];
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const now = new Date().toLocaleString('es-MX', { timeZone: 'America/Mexico_City' });

  let msg = `<b>🎰 Parlay Robusto (+EV)</b>\n<i>${now}</i>\n\n`;
  msg += `<b>Patas seleccionadas (${best.legCount} patas +EV):</b>\n`;
  for (const [i, p] of best.legs.entries()) {
    const legFlag = getCountryFlag(p.champ, p.event, p.sport);
    msg += `<b>${i + 1}. ${legFlag} ${esc(p.event)}</b> <i>(${esc(p.sport)})</i>\n`;
    if (p.score) msg += `   Marcador: ${esc(p.score)}${p.liveTime ? ` — ${esc(p.liveTime)}` : ''}\n`;
    msg += `   ${esc(p.market)}: 🎯 <b><u>${esc(p.selection)}</u></b> @ ${p.oddDecimal.toFixed(2)}\n`;
    msg += `   Confianza: <b>${pct(p.conf)}</b> | Edge individual: <b>+${(100 * p.edge).toFixed(1)}%</b>\n\n`;
  }

  msg += `<b>Análisis del Combo:</b>\n`;
  msg += `• Momio total: <b>${best.totalOdd.toFixed(2)}</b>\n`;
  msg += `• Prob. conjunta ajustada: <b>${pct(best.adjProb)}</b>\n`;
  msg += `• Edge compuesto: <b>+${(100 * best.edge).toFixed(1)}%</b> 🎯 (+EV verificado)\n\n`;

  if (combos.length > 1) {
    msg += `<i>Combinaciones +EV detectadas en vivo: ${combos.length}</i>\n`;
  }
  msg += `<i>Criterio: exige edge > 0 en cada pata (partidos distintos) y aplica corrección por varianza (γ=0.97). ` +
    `Estos combos no se registran en /stats.</i>`;

  await sendTelegram(TOKEN, currentChatId || CHAT_ID, msg, MAIN_KEYBOARD);
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

async function handleTrain() {
  await reply('⏳ Exportando dataset y entrenando (walk-forward + calibración)...');
  const r = await runTraining();
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  // Telegram limita a 4096 chars por mensaje: trocea el reporte
  const text = r.text;
  for (let i = 0; i < text.length; i += 3500) {
    await reply(`<pre>${esc(text.slice(i, i + 3500))}</pre>`);
  }
  if (r.ok) {
    await reply(r.adopted
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

async function handleValidar(args) {
  const horas = parseVentana(args);
  const etiqueta = horas < 24 ? `${horas} h` : `${(horas / 24).toFixed(0)} día(s)`;
  await reply(`⏳ Validando liquidaciones de las últimas ${etiqueta} contra marcadores oficiales...`);
  const { validateSettlements } = require('./src/validate');
  let r;
  try { r = await validateSettlements({ hours: horas }); } catch (e) { return reply(`⚠️ Error: ${e.message}`); }
  if (r.error) return reply(`⚠️ ${r.error}`);
  if (!r.n) return reply(`No hay picks liquidados en las últimas ${etiqueta}.\n<i>Un pick tarda ~36 min de mediana en liquidarse; prueba una ventana mayor: /validar 6h</i>`);

  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  let msg = `<b>🔍 Validación de resultados</b>\n\n`;
  msg += `Picks liquidados (${etiqueta}): ${r.n}\n`;
  msg += `Verificables (liga cubierta): <b>${r.checked}</b> en ${r.leagues} liga(s)\n`;
  if (!r.checked) {
    msg += `\n<i>Ninguno pudo verificarse: sus ligas no tienen fuente oficial disponible. ` +
           `La liquidación por último marcador visto sigue sin contraste.</i>`;
    return reply(msg);
  }
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
  await reply(msg);
}

const { calculateQuantitativeHealth } = require('./src/health');

async function handleHealth() {
  const esc = str => String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const fmtU = v => `${v >= 0 ? '+' : ''}${v.toFixed(2)}u`;

  const h = calculateQuantitativeHealth({ windowDays: 30 });
  if (!h.n) return reply('Aún no hay picks liquidados con score para evaluar calibración.');

  let msg = `<b>🩺 RIGOR CUANTITATIVO Y SALUD DEL MODELO</b>\n`;
  msg += `<i>Estilo Polymarket Quantitative Engine</i>\n\n`;
  msg += `<b>Estado:</b> ${h.color} <b>${esc(h.status)}</b>\n`;
  msg += `<i>${esc(h.message)}</i>\n\n`;

  msg += `<b>1. Calibración & Precisión (OOS):</b>\n`;
  msg += `• Muestras Evaluadas: <b>${h.n} picks</b>\n`;
  msg += `• Win Rate: <b>${h.wr.toFixed(1)}%</b> (${h.wins}/${h.n})\n`;
  msg += `• Brier Score: <b>${h.brierScore.toFixed(4)}</b> (óptimo < 0.2000)\n`;
  msg += `• Log Loss: <b>${h.logLoss.toFixed(4)}</b>\n`;
  msg += `• ECE (Calibration Error): <b>${(h.ece * 100).toFixed(2)}%</b> (óptimo < 5.0%)\n\n`;

  if (h.sharpN > 0) {
    msg += `<b>2. Mercado Sharp & CLV (Pinnacle/Betfair):</b>\n`;
    msg += `• Muestras Sharp: <b>${h.sharpN}</b>\n`;
    msg += `• Sharp Beat Rate (% CLV > 0): <b>${h.clvBeatRate.toFixed(1)}%</b>\n`;
    msg += `• Ventaja Promedio CLV: <b>${h.avgClvPct >= 0 ? '+' : ''}${h.avgClvPct.toFixed(2)}%</b>\n\n`;
  }

  msg += `<b>3. Cartera & Riesgo Financiero:</b>\n`;
  msg += `• Apostado: <b>${h.totalStaked.toFixed(2)}u</b> | Ganancia: <b>${fmtU(h.totalProfit)}</b>\n`;
  msg += `• ROI Global: <b>${h.roi >= 0 ? '+' : ''}${h.roi.toFixed(2)}%</b>\n`;
  if (h.sharpeRatio !== null) msg += `• Ratio de Sharpe: <b>${h.sharpeRatio.toFixed(2)}</b> (institucional > 1.50)\n`;
  if (h.maxDrawdown !== null) msg += `• Max Drawdown: <b>-${h.maxDrawdown.toFixed(2)}u</b>\n`;

  await reply(msg);
}

async function handleUnidades(args = []) {
  const esc = str => String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const fmtU = v => `${v >= 0 ? '+' : ''}${v.toFixed(2)}u`;

  if (args.length > 0) {
    const sub = norm(args[0]);
    if (sub === 'hoy' || sub === 'ayer' || /^\d{4}-\d{2}-\d{2}$/.test(sub)) {
      const res = stakePicksByDate(sub);
      if (!res.n) {
        return reply(`No hay picks liquidados para el día <b>${esc(res.date)}</b>.`);
      }

      if (res.isToday) {
        const postPicks = res.postSession.picks;
        const CHUNK_SIZE = 10;

        if (!postPicks.length) {
          let msg = `<b>🌟 SESIÓN NUEVA (POST-AJUSTES DE ROI & CAP DINÁMICO)</b>\n<i>Picks emitidos desde las 6:02 PM CDMX</i>\n\n`;
          msg += `⏳ <i>Aún no se han liquidado picks emitidos tras los nuevos ajustes de Stake Cap Dinámico y Doble Capa. Esperando los primeros partidos.</i>\n\n`;
          if (res.preSession.n > 0) {
            msg += `<b>📜 Sesión Previa de Hoy (Pre-Ajustes - antes 6:02 PM):</b>\n`;
            msg += `• Picks: <b>${res.preSession.wins}/${res.preSession.n}</b> (${res.preSession.wr ? res.preSession.wr.toFixed(0) : 0}% acierto)\n`;
            msg += `• Apostado: <b>${res.preSession.staked.toFixed(2)}u</b> | Ganancia: <b>${fmtU(res.preSession.profit)}</b>`;
            if (res.preSession.roi !== null) msg += ` (ROI ${res.preSession.roi >= 0 ? '+' : ''}${res.preSession.roi.toFixed(1)}%)\n`;
            msg += `\n`;
          }
          msg += `<b>Total Acumulado del Día (${esc(res.date)}):</b>\n`;
          msg += `• Picks: <b>${res.wins}/${res.n}</b> | Ganancia Total: <b>${fmtU(res.profit)}</b>`;
          await reply(msg);
          return;
        }

        const totalParts = Math.ceil(postPicks.length / CHUNK_SIZE);
        for (let i = 0; i < postPicks.length; i += CHUNK_SIZE) {
          const chunk = postPicks.slice(i, i + CHUNK_SIZE);
          const partNum = Math.floor(i / CHUNK_SIZE) + 1;

          let msg = `<b>🌟 SESIÓN NUEVA (POST-AJUSTES DE ROI & CAP DINÁMICO)</b>`;
          if (totalParts > 1) msg += ` <i>(Parte ${partNum}/${totalParts})</i>`;
          msg += `\n<i>Picks emitidos desde las 6:02 PM CDMX</i>\n\n`;

          for (const [idx, p] of chunk.entries()) {
            const globalIdx = i + idx + 1;
            const icon = p.result === 'win' ? '✅' : '❌';
            const sign = p.profit >= 0 ? '+' : '';
            const hora = p.ts ? new Date(p.ts).toLocaleTimeString('es-MX', { timeZone: 'America/Mexico_City', hour: '2-digit', minute: '2-digit', hour12: false }) : '';
            const timeTag = hora ? ` <i>[${hora}]</i>` : '';
            const flag = getCountryFlag(p.champ, p.event, p.sport);
            const lossMinTag = (p.result === 'loss' && p.loss_minute !== null && p.loss_minute !== undefined) ? ` <i>(Perdido min ${p.loss_minute}')</i>` : '';
            msg += `${icon} <b>${globalIdx}. ${flag} ${esc(p.event)}</b>${timeTag} <i>(${esc(p.sport)})</i>\n`;
            msg += `   ${esc(p.market)}: <b>${esc(p.selection)}</b> @ ${p.odd_decimal.toFixed(2)}\n`;
            msg += `   Stake: <b>${p.stake ? p.stake.toFixed(1) : '1.0'}u</b> | Marcador: ${esc(p.final_score || '—')} ➔ <b>${sign}${p.profit.toFixed(2)}u</b>${lossMinTag}\n\n`;
          }

          if (i + CHUNK_SIZE >= postPicks.length) {
            msg += `<b>Resumen Sesión Nueva (Post 6:02 PM):</b>\n`;
            msg += `• Picks: <b>${res.postSession.wins}/${res.postSession.n}</b> (${res.postSession.wr ? res.postSession.wr.toFixed(0) : 0}% acierto)\n`;
            msg += `• Apostado: <b>${res.postSession.staked.toFixed(2)}u</b>\n`;
            msg += `• Ganancia: <b>${fmtU(res.postSession.profit)}</b>\n`;
            if (res.postSession.roi !== null) msg += `• ROI: <b>${res.postSession.roi >= 0 ? '+' : ''}${res.postSession.roi.toFixed(1)}%</b>\n\n`;

            if (res.preSession.n > 0) {
              msg += `<b>📜 Sesión Previa de Hoy (Pre-Ajustes - antes 6:02 PM):</b>\n`;
              msg += `• Picks: <b>${res.preSession.wins}/${res.preSession.n}</b> (${res.preSession.wr ? res.preSession.wr.toFixed(0) : 0}% acierto)\n`;
              msg += `• Apostado: <b>${res.preSession.staked.toFixed(2)}u</b> | Ganancia: <b>${fmtU(res.preSession.profit)}</b>`;
              if (res.preSession.roi !== null) msg += ` (ROI ${res.preSession.roi >= 0 ? '+' : ''}${res.preSession.roi.toFixed(1)}%)\n`;
              msg += `\n`;
            }

            msg += `<b>Total Acumulado del Día (${esc(res.date)}):</b>\n`;
            msg += `• Picks: <b>${res.wins}/${res.n}</b> | Ganancia Total: <b>${fmtU(res.profit)}</b>`;
          }

          await reply(msg);
        }
        return;
      }

      const CHUNK_SIZE = 10;
      const totalPicks = res.picks;

      for (let i = 0; i < totalPicks.length; i += CHUNK_SIZE) {
        const chunk = totalPicks.slice(i, i + CHUNK_SIZE);
        const partNum = Math.floor(i / CHUNK_SIZE) + 1;
        const totalParts = Math.ceil(totalPicks.length / CHUNK_SIZE);

        let msg = `<b>📋 Picks liquidados del ${esc(res.date)}</b>`;
        if (totalParts > 1) msg += ` <i>(Parte ${partNum}/${totalParts})</i>`;
        msg += `\n\n`;

        for (const [idx, p] of chunk.entries()) {
          const globalIdx = i + idx + 1;
          const icon = p.result === 'win' ? '✅' : '❌';
          const sign = p.profit >= 0 ? '+' : '';
          const hora = p.ts ? new Date(p.ts).toLocaleTimeString('es-MX', { timeZone: 'America/Mexico_City', hour: '2-digit', minute: '2-digit', hour12: false }) : '';
          const timeTag = hora ? ` <i>[${hora}]</i>` : '';
          const flag = getCountryFlag(p.champ, p.event, p.sport);
          const lossMinTag = (p.result === 'loss' && p.loss_minute !== null && p.loss_minute !== undefined) ? ` <i>(Perdido min ${p.loss_minute}')</i>` : '';
          msg += `${icon} <b>${globalIdx}. ${flag} ${esc(p.event)}</b>${timeTag} <i>(${esc(p.sport)})</i>\n`;
          msg += `   ${esc(p.market)}: <b>${esc(p.selection)}</b> @ ${p.odd_decimal.toFixed(2)}\n`;
          msg += `   Stake: <b>${p.stake ? p.stake.toFixed(1) : '1.0'}u</b> | Marcador: ${esc(p.final_score || '—')} ➔ <b>${sign}${p.profit.toFixed(2)}u</b>${lossMinTag}\n\n`;
        }

        if (i + CHUNK_SIZE >= totalPicks.length) {
          msg += `<b>Resumen del día (${esc(res.date)}):</b>\n`;
          msg += `• Picks: <b>${res.wins}/${res.n}</b> (${res.wr ? res.wr.toFixed(0) : 0}% acierto)\n`;
          msg += `• Apostado: <b>${res.staked.toFixed(2)}u</b>\n`;
          msg += `• Ganancia: <b>${fmtU(res.profit)}</b>\n`;
          if (res.roi !== null) msg += `• ROI: <b>${res.roi >= 0 ? '+' : ''}${res.roi.toFixed(1)}%</b>\n`;
        }

        await reply(msg);
      }
      return;
    }
  }

  const s = stakeStats();
  if (!s.n && !s.pendingN) {
    return reply('Aún no hay picks con unidad de apuesta asignada. Se asignan desde que se activó el dimensionamiento por unidades (2026-07-30).');
  }
  const modeName = { flat: 'plano (1u fija)', half_kelly: 'medio Kelly', kelly: 'Kelly completo' }[s.mode] || s.mode;
  let msg = `<b>💰 Rendimiento por unidades</b>\n`;
  if (s.since) msg += `<i>desde ${new Date(s.since).toLocaleDateString('es-MX', { timeZone: 'America/Mexico_City' })}</i>\n\n`;
  if (!s.n) {
    msg += `Sin picks liquidados todavía.\n`;
  } else {
    msg += `Picks liquidados: <b>${s.n}</b> (acierto ${s.wr.toFixed(1)}%) | modo: ${modeName}\n`;
    msg += `Unidades apostadas: <b>${s.staked.toFixed(2)}u</b> | apuesta media: ${s.avgStake.toFixed(2)}u\n`;
    msg += `Unidades ganadas: <b>${fmtU(s.profit)}</b>\n`;
    msg += `<b>ROI sobre lo apostado: ${s.roi >= 0 ? '+' : ''}${s.roi.toFixed(2)}%</b>\n`;

    const recentDays = s.byDay.slice(-7);
    const dayTag = s.byDay.length > 7 ? ` (últimos 7 días)` : '';
    msg += `\n<b>Día por día</b>${dayTag} (banca = acumulado)\n`;
    msg += `<pre>día    n   acierto  apost   ganado   banca\n`;
    for (const d of recentDays) {
      msg += `${d.dia.slice(5)}  ${String(d.n).padStart(3)}   ${(d.wr.toFixed(0) + '%').padStart(4)}  ${(d.staked.toFixed(1) + 'u').padStart(6)}  ${fmtU(d.profit).padStart(7)}  ${fmtU(d.acumulado).padStart(7)}\n`;
    }
    msg += `</pre>`;
    const pos = s.byDay.filter(d => d.profit > 0).length;
    msg += `<i>${pos} de ${s.byDay.length} días en positivo</i> | 💡 <i>Usa /unidades hoy para el detalle</i>\n`;

    if (s.bySport.length > 1) {
      msg += `\n<b>Por deporte</b>\n<pre>deporte          apostado  ganado   ROI\n`;
      for (const b of s.bySport) {
        msg += `${b.sport.slice(0, 15).padEnd(16)} ${b.staked.toFixed(1).padStart(7)}u ${fmtU(b.profit).padStart(7)} ${(b.roi >= 0 ? '+' : '') + b.roi.toFixed(1)}%\n`;
      }
      msg += `</pre>`;
    }
  }
  if (s.pendingN) msg += `\nPendientes de liquidar: ${s.pendingN} picks (${s.pendingUnits.toFixed(2)}u en juego)`;
  await reply(msg);
}

async function handleDeportes() {
  await reply('⏳ Consultando...');
  const { rows, sports } = await getFreshRows();
  const counts = {};
  for (const r of rows) counts[r.sport] = (counts[r.sport] || 0) + 1;
  const lines = sports.map(s => `• ${s.name}: ${s.count} eventos, ${counts[s.name] || 0} jugadas`);
  await reply(`<b>Deportes en vivo:</b>\n${lines.join('\n')}`);
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

const MAIN_KEYBOARD = {
  keyboard: [
    [{ text: '🛡️ Seguras' }, { text: '🥇 Pick Dorado' }, { text: '🎰 Parlay +EV' }],
    [{ text: '🎯 Top Momios' }, { text: '💰 Unidades' }, { text: '📋 Unidades Hoy' }],
    [{ text: '⭐ Membresía VIP' }, { text: '📊 Rendimiento' }, { text: '⚽ Deportes' }],
    [{ text: '🩺 Salud Modelo' }, { text: '🔍 Validar' }, { text: '❓ Ayuda' }]
  ],
  resize_keyboard: true,
  is_persistent: true,
};

let currentChatId = CHAT_ID;

async function reply(text, showKeyboard = true, targetChatId = null) {
  const dest = targetChatId || currentChatId || CHAT_ID;
  await sendTelegram(TOKEN, dest, text, showKeyboard ? MAIN_KEYBOARD : null);
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
    `Utiliza la <b>botonera táctil</b> a continuación para explorar el sistema o presiona <b>⭐ Membresía VIP</b> para acceder al Canal Privado.\n\n` +
    `<i>¡Mucho éxito en tus jugadas! 🎯</i>`;

  await sendTelegram(TOKEN, chatId, welcomeMsg, MAIN_KEYBOARD);
}

async function handleMessage(rawText, chatId = CHAT_ID, fromUser = null) {
  currentChatId = chatId || CHAT_ID;
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
    '❓ ayuda': '/help',
    'ayuda': '/help',
    'help': '/help',
  };

  if (labelMap[normRaw]) {
    text = labelMap[normRaw];
  } else if (labelMap[cleanLabel]) {
    text = labelMap[cleanLabel];
  }

  const parts = text.split(/\s+/);
  const cmd = norm(parts[0]).replace(/@.*$/, '');
  const args = parts.slice(1);

  try {
    if (cmd === '/top') await handleTop(args);
    else if (cmd === '/seguras') await handleSeguras(args);
    else if (cmd === '/golden') await handleGolden(args);
    else if (cmd === '/parlay') await handleParlay(args);
    else if (cmd === '/stats') await handleStats();
    else if (cmd === '/health') await handleHealth();
    else if (cmd === '/unidades') await handleUnidades(args);
    else if (cmd === '/validar') await handleValidar(args);
    else if (cmd === '/train') await handleTrain();
    else if (cmd === '/deportes') await handleDeportes();
    else if (cmd === '/vip') await handleVip(chatId, fromUser);
    else if (cmd === '/start') await handleStart(chatId, fromUser);
    else if (cmd === '/help') await sendTelegram(TOKEN, chatId, HELP, MAIN_KEYBOARD);
    else await sendTelegram(TOKEN, chatId, `Comando no reconocido.\n\n${HELP}`, MAIN_KEYBOARD);
  } catch (e) {
    console.error('[error]', e.message);
    try { await sendTelegram(TOKEN, chatId, `⚠️ Error: ${e.message}`); } catch {}
  }
}

async function registerCommands() {
  try {
    await fetch(`${API}/setMyCommands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        commands: [
          { command: 'seguras', description: 'Top 3 jugadas con mayor probabilidad' },
          { command: 'golden', description: 'Pick dorado (máximo edge)' },
          { command: 'parlay', description: 'Combos sugeridos (+EV verificado)' },
          { command: 'vip', description: 'Membresía y acceso al Canal VIP' },
          { command: 'top', description: 'Top 10 momios más bajos' },
          { command: 'unidades', description: 'Rendimiento por unidades y días' },
          { command: 'stats', description: 'Tasa de acierto y métricas' },
          { command: 'deportes', description: 'Deportes en vivo ahora' },
          { command: 'health', description: 'Salud del modelo (drift)' },
          { command: 'validar', description: 'Validar resultados con oficial' },
          { command: 'train', description: 'Reentrenar modelo' },
          { command: 'help', description: 'Ayuda y botonera de comandos' },
        ]
      })
    });
  } catch (e) {
    console.error('[setMyCommands error]', e.message);
  }
}

async function poll() {
  await registerCommands();
  try {
    await reply('🤖 <b>Playdoit Monitor activo.</b> Sistema VIP y Botonera listos.', true);
  } catch (e) {
    console.error('[startup notify error]', e.message);
  }
  let offset = 0;
  console.log('Bot escuchando comandos de Telegram...');
  while (true) {
    try {
      const res = await fetch(`${API}/getUpdates?timeout=50&offset=${offset}`, { signal: AbortSignal.timeout(60000) });
      const data = await res.json();
      if (!data.ok) throw new Error(data.description);
      for (const u of data.result) {
        offset = u.update_id + 1;

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
          await handleMessage(msg.text, msg.chat.id, msg.from);
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
const AUTO_PICK_NOTIFY = String(process.env.AUTO_PICK_NOTIFY || 'true').toLowerCase() === 'true';

// 🔥 marca los picks donde el modelo aprendido —el que penaliza seguir el steam—
// muestra confianza alta. Medido sobre los picks con ambos scores (n=54):
// conf_learned >= 0.80 rindió +27.4% (n=15) frente a -12.7% de aquellos donde
// el modelo es menos optimista que el heurístico. Muestra pequeña: la marca es
// orientativa, no una recomendación de stake.
const MODEL_STRONG_CONF = Number(process.env.MODEL_STRONG_CONF || 0.80);
function isModelStrong(p) {
  return p.confLearned !== null && p.confLearned !== undefined &&
         p.confLearned >= MODEL_STRONG_CONF && p.confLearned > p.confHeuristic;
}

async function autoPicks(rows) {
  if (!AUTO_PICKS) return;
  const hourAgo = new Date(Date.now() - 3600 * 1000).toISOString();
  if (countPicksSince(hourAgo) >= AUTO_PICK_MAX_PER_HOUR) return;

  const candidates = safestPicks(rows.filter(r => !norm(r.sport).startsWith('e-')), 5)
    .filter(p => !isDuplicatePick(p.eventId, p.market, p.selection));
  if (!candidates.length) return;

  const room = AUTO_PICK_MAX_PER_HOUR - countPicksSince(hourAgo);
  const picks = candidates.slice(0, Math.max(0, room));
  if (!picks.length) return;

  const ids = logPicks(picks.map(p => ({
    ts: p.ts, eventId: p.eventId, event: p.event, sport: p.sport,
    market: p.market, selection: p.selection, oddDecimal: p.oddDecimal, conf: p.conf,
    fProbJusta: p.base, fAvance: p.progress, fSituacion: p.scoreFactor, fLinea: p.lineFactor,
    confHeuristic: p.confHeuristic, confLearned: p.confLearned, edge: p.edge, source: 'auto',
    openingOdd: p.openingOdd, fApertura: p.fApertura, scoreVersion: p.scoreVersion,
    stake: p.stake, stakeMode: p.stakeMode,
  })));
  captureSharpEntries(ids, picks).catch(e => console.error('[sharp]', e.message));
  for (const p of picks) {
    console.log(`[auto-pick] ${p.event} | ${p.selection} @ ${p.oddDecimal} | conf ${pct(p.conf)} edge ${(100 * p.edge).toFixed(1)}%`);
  }

  if (!AUTO_PICK_NOTIFY) return;
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  let msg = `<b>🤖 Pick automático</b>\n\n`;
  for (const p of picks) {
    const flag = getCountryFlag(p.champ, p.event, p.sport);
    msg += `${isModelStrong(p) ? '🔥 ' : ''}${flag} <b>${esc(p.event)}</b> <i>(${esc(p.sport)}${p.champ ? ` — ${esc(p.champ)}` : ''})</i>\n`;
    if (p.score) msg += `Marcador: ${esc(p.score)}${p.liveTime ? ` — ${esc(p.liveTime)}` : ''}\n`;
    msg += `${esc(p.market)}: 🎯 <b><u>${esc(p.selection)}</u></b> @ <b>${p.oddDecimal.toFixed(2)}</b> (${p.oddAmerican})\n`;
    msg += `Confianza: <b>${pct(p.conf)}</b> | Edge: <b>+${(100 * p.edge).toFixed(1)}%</b>`;
    msg += p.stake != null ? ` | Unidad: <b>${p.stake.toFixed(1)}u</b>\n` : '\n';
    if (isModelStrong(p)) {
      msg += `<i>🔥 el modelo aprendido le da ${pct(p.confLearned)} — su tercil alto rindió +30% histórico</i>\n`;
    }
    msg += '\n';
  }
  try { await sendTelegram(TOKEN, CHAT_ID, msg); } catch (e) { console.error('[auto-pick notify]', e.message); }
  if (VIP_CHANNEL_ID) {
    try { await sendTelegram(TOKEN, VIP_CHANNEL_ID, msg); } catch (e) { console.error('[auto-pick vip notify]', e.message); }
  }
}

let sampling = false;
async function sample() {
  if (sampling) return;
  sampling = true;
  try {
    const sportResults = await fetchAllLive();
    const rows = normalize(sportResults);
    if (rows.length) saveSnapshot(rows);
    console.log(`[sampler ${new Date().toISOString()}] ${rows.length} jugadas guardadas`);
    // processSettlements captura también el cierre sharp bajo demanda (1 sola
    // consulta por pick, al desaparecer el evento del feed)
    await processSettlements(new Set(rows.map(r => r.eventId)));
    computeFocusSports(sportResults, rows);
    await autoPicks(rows);
    await checkExpiredSubscribers();
  } catch (e) {
    console.error('[sampler]', e.message);
  } finally {
    sampling = false;
  }
}
setInterval(sample, SAMPLE_MINUTES * 60 * 1000);
sample();

// Monitoreo de drift: chequeo diario, alerta por Telegram como máximo una vez
// cada 30 días si el ECE de los últimos 200 picks supera el umbral.
let lastDriftAlert = 0;
async function driftCheck() {
  try {
    const h = computeHealth();
    if (h.alert && Date.now() - lastDriftAlert > 30 * 24 * 3600 * 1000) {
      lastDriftAlert = Date.now();
      console.log(`[drift] ECE ${h.ece.toFixed(4)} > ${h.threshold} — recalibrar: correr train_weights.py`);
      await reply(`⚠️ <b>Drift de calibración</b>: ECE ${h.ece.toFixed(4)} > ${h.threshold} en los últimos ${h.n} picks.\nRecalibrar: manda /train (o corre <code>python scripts/train_weights.py</code>).`);
    }
  } catch (e) {
    console.error('[drift]', e.message);
  }
}
setInterval(driftCheck, 24 * 3600 * 1000);

// Poda diaria de snapshots (~1.1M filas/día): retiene RETENTION_DAYS (default 7)
// y preserva siempre los eventos con picks, que alimentan el CLV histórico.
function prune() {
  try {
    const { deleted } = pruneSnapshots(Number(process.env.RETENTION_DAYS || 7));
    if (deleted) console.log(`[prune] ${deleted} snapshots viejos eliminados`);
  } catch (e) {
    console.error('[prune]', e.message);
  }
}
setInterval(prune, 24 * 3600 * 1000);
prune();

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

poll();
