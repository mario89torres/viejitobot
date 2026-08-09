import * as path from 'path';

const dbPath = path.join(__dirname, '..', 'src', 'db');
const confPath = path.join(__dirname, '..', 'src', 'confidence');
const tgPath = path.join(__dirname, '..', 'src', 'telegram');
const fwPath = path.join(__dirname, '..', 'src', 'firewall');
const devigPath = path.join(__dirname, '..', 'src', 'devig');

const { db, logPicks } = require(dbPath);
const { computeStructuralDrawSignal, scoreRow } = require(confPath);
const { firewallVerdict } = require(fwPath);
const { devig, defaultMethod } = require(devigPath);
const { sendStructuralDrawAlert } = require(tgPath);

/**
 * 🎯 GLOBAL STRUCTURAL DRAW SCANNER (Minuto 75+)
 * Muestra y audita TODO el universo de partidos de fútbol en vivo del mundo
 * que se encuentren en el minuto 75 o posterior.
 *
 * Agrupa los snapshots por (market, selection) para calcular la varianza estricta
 * de cada línea sin mezclar cuotas entre mercados distintos.
 */
function parseMinute(liveTimeStr: any): number | null {
  if (!liveTimeStr) return null;
  const str = String(liveTimeStr).toLowerCase();
  // Descanso / HT / Half-time = minuto ~45, no supera el umbral de 75
  if (str.includes('descanso') || str.includes('half') || str.includes('ht') || str === 'break') return 45;
  const match = str.match(/(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}

/** Devuelve true solo si el marcador es un empate real (ej: "0-0", "1-1", "2-2") */
function isScoreTie(score: any): boolean {
  if (!score) return false;
  const parts = String(score).split('-');
  if (parts.length !== 2) return false;
  const left = Number(parts[0].trim());
  const right = Number(parts[1].trim());
  return !isNaN(left) && !isNaN(right) && left === right;
}

export function scanGlobalDraws75() {
  const since = new Date(Date.now() - 90 * 60 * 1000).toISOString();
  const threeHoursAgo = new Date(Date.now() - 180 * 60 * 1000).toISOString();

  const recentEvents = db.prepare(`
    SELECT DISTINCT event_id, event, sport_id, sport, score, live_time
    FROM snapshots
    WHERE (sport_id = 66 OR LOWER(sport) LIKE '%futbol%' OR LOWER(sport) LIKE '%fútbol%' OR sport IS NULL)
      AND LOWER(sport) NOT LIKE 'e-%'
      AND LOWER(sport) NOT LIKE '%e-soccer%'
      AND LOWER(sport) NOT LIKE '%e-futbol%'
      AND LOWER(sport) NOT LIKE '%esoccer%'
      AND ts >= ?
    ORDER BY ts DESC
  `).all(since) as any[];

  const candidates: any[] = [];
  const addedEventIds = new Set<number>();

  for (const ev of recentEvents) {
    const min = parseMinute(ev.live_time);
    // 🎯 CONDICIÓN 1: Minuto 75 o superior (descartar si es desconocido o menor a 75)
    if (min === null || min < 75) continue;

    // Obtener combinaciones de (market, selection) para este evento
    const markets = db.prepare(`
      SELECT DISTINCT market, selection
      FROM snapshots
      WHERE event_id = ? AND ts >= ? AND suspended = 0 AND odd_decimal > 0
    `).all(ev.event_id, since) as any[];

    for (const m of markets) {
      // 🎯 Solo mercado de Empate directo (1x2 / Resultado Final)
      const sel = (m.selection || '').trim().toLowerCase();
      const mkt = (m.market || '').trim().toLowerCase();
      const isDrawSelection = sel === 'empate';
      const isDrawMarket = mkt.includes('resultado') || mkt === '1x2' || mkt.includes('result');
      if (!isDrawSelection || !isDrawMarket) continue;

      const snaps = db.prepare(`
        SELECT odd_decimal, suspended, score, ts
        FROM snapshots
        WHERE event_id = ? AND market = ? AND selection = ? AND ts >= ?
        ORDER BY ts DESC
        LIMIT 30
      `).all(ev.event_id, m.market, m.selection, since) as any[];

      const activeOdds = snaps.filter((s: any) => !s.suspended && s.odd_decimal > 0).map((s: any) => s.odd_decimal);
      if (activeOdds.length < 5) continue;

      // 🎯 CONDICIÓN 2 (Marcador Empatado) + CONDICIÓN 3 (Varianza Estable / Flatline)
      const drawSig = computeStructuralDrawSignal(activeOdds, ev.score);
      const eventScore = ev.score || (snaps.length ? snaps[0].score : null);

      if (drawSig.isStructuralDraw && isScoreTie(eventScore)) {
        candidates.push({
          event_id: ev.event_id,
          event: ev.event,
          sport: ev.sport || 'Fútbol',
          sport_id: ev.sport_id || 66,
          score: eventScore || '0-0',
          live_time: ev.live_time || (min ? `${min}'` : "75'+"),
          elapsed_min: min || 75,
          variance: drawSig.variance,
          mean_odd: drawSig.mean,
          sample_count: drawSig.sampleCount,
          market: m.market,
          selection: m.selection,
          entry_odd: drawSig.mean,
          current_odd: activeOdds[0],
        });
        addedEventIds.add(ev.event_id);
        break; // Máximo 1 señal por evento
      }
    }
  }

  // 🎯 Incluir también picks de empates globales registrados en BD que sigan pendientes
  const dbGlobalPicks = db.prepare(`
    SELECT event_id, event, sport, market, selection, odd_decimal, ts
    FROM picks
    WHERE source = 'global_draw'
      AND (result IS NULL OR result = 'unknown')
      AND ts >= ?
    ORDER BY ts DESC
  `).all(threeHoursAgo) as any[];

  for (const p of dbGlobalPicks) {
    if (addedEventIds.has(p.event_id)) continue;

    const snaps = db.prepare(`
      SELECT odd_decimal, suspended, score, live_time, ts
      FROM snapshots
      WHERE event_id = ? AND market = ? AND selection = ?
      ORDER BY ts DESC
      LIMIT 30
    `).all(p.event_id, p.market, p.selection) as any[];

    const activeOdds = snaps.filter((s: any) => !s.suspended && s.odd_decimal > 0).map((s: any) => s.odd_decimal);
    const lastSnap = snaps.length ? snaps[0] : null;
    const drawSig = activeOdds.length >= 3 ? computeStructuralDrawSignal(activeOdds, lastSnap?.score) : { variance: 0.0100, mean: p.odd_decimal || 3.0, sampleCount: snaps.length || 1 };

    const elapsedMs = Date.now() - new Date(p.ts).getTime();
    const elapsedMin = Math.floor(elapsedMs / 60000);

    candidates.push({
      event_id: p.event_id,
      event: p.event,
      sport: p.sport || 'Fútbol',
      score: lastSnap?.score || 'Empate',
      live_time: lastSnap?.live_time || 'En juego',
      elapsed_min: elapsedMin,
      variance: drawSig.variance,
      mean_odd: drawSig.mean,
      sample_count: drawSig.sampleCount,
      market: p.market,
      selection: p.selection,
      entry_odd: p.odd_decimal,
      current_odd: activeOdds.length ? activeOdds[0] : p.odd_decimal,
    });
    addedEventIds.add(p.event_id);
  }

  return candidates;
}

// ── SCORING REAL DEL CANDIDATO ─────────────────────────────────────────────
/**
 * Probabilidad justa de la selección, quitando el margen de la casa con devig()
 * sobre TODO el mercado — igual que hace normalize.js con el feed en vivo.
 *
 * El scanner no ve el feed, solo `snapshots`, así que reconstruye el mercado
 * tomando el último momio activo de CADA selección del mismo (event_id, market).
 * Si el mercado no tiene al menos 2 patas activas, no hay margen que quitar y
 * cae a la implícita cruda (1/momio), mismo fallback que normalize.js.
 */
function fairProbFromSnapshots(eventId: number, market: string, selection: string, oddDecimal: number): number {
  try {
    const legs = db.prepare(`
      SELECT selection, odd_decimal FROM snapshots s
      WHERE event_id = ? AND market = ? AND suspended = 0 AND odd_decimal > 0
        AND ts = (
          SELECT MAX(ts) FROM snapshots
          WHERE event_id = s.event_id AND market = s.market AND selection = s.selection
            AND suspended = 0 AND odd_decimal > 0
        )
      GROUP BY selection
    `).all(eventId, market) as any[];

    if (legs.length > 1) {
      const probs = devig(legs.map((l: any) => l.odd_decimal), defaultMethod());
      const i = legs.findIndex((l: any) => l.selection === selection);
      if (i >= 0 && Number.isFinite(probs[i]) && probs[i] > 0) return probs[i];
    }
  } catch {
    // Sin devig no se descarta el pick: se degrada a la implícita cruda.
  }
  return 1 / oddDecimal;
}

/**
 * Puntúa el candidato con el MISMO scoreRow() que el resto del bot.
 *
 * Hasta 2026-08-09 esto no existía: el scanner insertaba features constantes
 * (f_prob_justa=0.72, f_avance=0.85, f_situacion=0.75, f_linea=0.82, conf=0.76)
 * idénticas en las 224 filas que llegó a emitir. Eso tuvo tres costos medidos:
 *   1. contaminó el dataset de entrenamiento con ~9% de filas de features
 *      constantes y etiqueta `y` real;
 *   2. fabricó una regla de firewall falsa (R6, f_linea>=0.80) que en realidad
 *      solo detectaba la huella 0.82 del scanner — ver la nota de R6;
 *   3. `conf=0.76` era una invención: con features reales estos picks puntúan
 *      bastante más bajo (~0.59 en un empate típico al 82'), así que el número
 *      que se publicaba en Telegram no medía nada.
 *
 * Devuelve null si no se puede construir una fila puntuable.
 */
export function scoreCandidate(c: any): any {
  const row = {
    ts: new Date().toISOString(),
    eventId: c.event_id,
    event: c.event,
    sport: c.sport || 'Fútbol',
    sportId: c.sport_id || 66,
    market: c.market,
    selection: c.selection,
    score: c.score,
    minute: parseMinute(c.live_time) ?? c.elapsed_min ?? null,
    setNum: null,
    oddDecimal: c.current_odd || c.entry_odd,
    suspended: 0,
  } as any;

  if (!row.oddDecimal || !(row.oddDecimal > 1)) return null;
  row.fairProb = fairProbFromSnapshots(row.eventId, row.market, row.selection, row.oddDecimal);

  try {
    const s = scoreRow(row);
    // Una feature NaN envenena conf y se persistiría como basura silenciosa.
    // Mejor no emitir que emitir un número que no significa nada.
    const finite = [s.conf, s.base, s.progress, s.fAvance, s.scoreFactor, s.lineFactor];
    if (finite.some((v: any) => !Number.isFinite(v))) return null;
    return { ...row, ...s };
  } catch {
    return null;
  }
}

// ── CACHE PERSISTENTE EN BD (sobrevive reinicios) ──────────────────────────
function isAlreadyAlerted(key: string): boolean {
  const row = db.prepare('SELECT key FROM alerted_events WHERE key = ?').get(key);
  return !!row;
}

function markAsAlerted(key: string): void {
  db.prepare('INSERT OR IGNORE INTO alerted_events (key, ts) VALUES (?, ?)').run(key, new Date().toISOString());
}

export async function checkAndBroadcastGlobalDraws(token: string, chatId: string) {
  if (!token || !chatId) return;

  const personalChatId = process.env.TELEGRAM_CHAT_ID;

  try {
    const candidates = scanGlobalDraws75();
    for (const c of candidates) {
      const key = `${c.event_id}:global_draw_75`;
      if (isAlreadyAlerted(key)) continue;

      // 🎯 Filtro de momio: solo picks con cuota empate > 1.30
      const momio = c.current_odd || c.entry_odd || 0;
      if (momio <= 1.30) {
        console.log(`[scanner] ⏭️ Descartado (momio @${momio.toFixed(2)} ≤ 1.30): ${c.event}`);
        continue;
      }

      // Features REALES vía scoreRow, no constantes. Si no se puede puntuar la
      // jugada no se emite: sin features no hay forma de auditarla después.
      const scored = scoreCandidate(c);
      if (!scored) {
        console.log(`[scanner] ⏭️ Descartado (no puntuable con scoreRow): ${c.event}`);
        continue;
      }

      // 🚧 FIREWALL — antes solo lo pasaban los picks de rankPicks; el scanner
      // insertaba directo en la BD y se lo saltaba entero. Medido sobre los 184
      // picks liquidados del scanner (2026-08-06 → 08-09):
      //
      //   todos           N=184  WR=65.8%  ROI= -7.2%
      //   momio <= 3.0    N=158  WR=75.9%  ROI= +5.6%
      //   momio  > 3.0    N= 26  WR= 3.8%  ROI=-84.6%
      //
      // Todo el resultado negativo es la cola de momio alto, y R3 la corta en
      // seco (FIREWALL_MAX_ODDS=3.0). Un "empate estructural" al 75'+ con
      // marcador empatado cotizado a 9, 51 o 71 no es una señal: es un mercado
      // mal casado o un evento muerto que dejó de actualizar. R3 era hasta
      // ahora una regla inerte precisamente porque nunca veía estos picks.
      //
      // CAVEAT honesto: los 184 picks son TODOS posteriores al 2026-08-06, así
      // que no hay corte temporal posible — esto es in-sample. Lo que sostiene
      // el cambio no es el ROI sino que R3 replica el techo `maxOdds=3` que
      // rankPicks ya impone a cualquier otro pick del sistema; el scanner era
      // la excepción, y no por diseño.
      //
      // NO se aplican MIN_CONF ni MIN_EDGE a propósito: la señal es
      // estructural (varianza plana), no de confianza, y con features reales un
      // empate típico al 82' puntúa ~0.59 — MIN_CONF=0.70 silenciaría el
      // scanner entero, incluida la banda de momio<=3 que sí gana.
      // GLOBAL_DRAW_FIREWALL=false lo devuelve al comportamiento anterior.
      const applyFirewall = String(process.env.GLOBAL_DRAW_FIREWALL || 'true').toLowerCase() !== 'false';
      const verdict = firewallVerdict(scored);
      if (applyFirewall && verdict.blocked) {
        console.log(`[scanner] 🚧 Bloqueado por firewall [${verdict.rules.join(', ')}] @${momio.toFixed(2)}: ${c.event}`);
        continue;
      }

      // Marcar en BD ANTES de enviar para evitar duplicados en caso de crash
      markAsAlerted(key);

      // 📝 REGISTRAR COMO PICK OFICIAL EN LA BASE DE DATOS
      const existing = db.prepare(`
        SELECT id FROM picks WHERE event_id = ? AND market = ? AND selection = ?
      `).get(c.event_id, c.market, c.selection);

      let pickId = existing?.id;

      if (!pickId) {
        // Vía logPicks (src/db.js), la MISMA que usan /seguras y /golden: así el
        // scanner no puede volver a divergir en qué columnas rellena. Persiste
        // f_avance CRUDO (`progress`, que es lo que consume el firewall) y
        // f_avance_model (el valor realmente servido al modelo) por separado.
        //
        // El stake sale de scoreRow. Antes se llamaba
        // `computeStake({ conf, oddDecimal })` con un objeto, pero la firma es
        // posicional — `computeStake(conf, oddDecimal, mode, isHighConviction)`
        // — así que el objeto entraba como `conf`, salía NaN y se persistía
        // NULL: ninguno de los 224 picks históricos del scanner tiene stake.
        [pickId] = logPicks([{
          ts: scored.ts, eventId: scored.eventId, event: scored.event, sport: scored.sport,
          market: scored.market, selection: scored.selection, oddDecimal: scored.oddDecimal, conf: scored.conf,
          fProbJusta: scored.base, fAvance: scored.progress, fAvanceModel: scored.fAvance,
          fSituacion: scored.scoreFactor, fLinea: scored.lineFactor,
          confHeuristic: scored.confHeuristic, confLearned: scored.confLearned,
          edge: scored.edge, source: 'global_draw',
          openingOdd: scored.openingOdd, fApertura: scored.fApertura, scoreVersion: scored.scoreVersion,
          stake: scored.stake, stakeMode: scored.stakeMode,
        }]);
        console.log(`[scanner] 📝 Pick Oficial Registrado en BD: ID #${pickId} (${c.event}) conf=${scored.conf.toFixed(3)} edge=${scored.edge.toFixed(3)} stake=${scored.stake}u`);
      }

      console.log(`[scanner] 🎯 Alerta Global Empate (Min ${c.elapsed_min}') emitida a Telegram para ${c.event}`);
      
      const alertPayload = {
        id: pickId,
        event: c.event,
        sport: c.sport,
        score: `${c.score} (${c.live_time})`,
        market: c.market,
        selection: c.selection,
        current_odd: c.current_odd,
        variance: c.variance,
      };

      // Enviar a Canal VIP
      try {
        await sendStructuralDrawAlert(token, chatId, alertPayload);
      } catch (e: any) {
        console.error(`[scanner] Error enviando a Canal VIP: ${e.message}`);
      }

      // Enviar también a Chat Personal si es distinto
      if (personalChatId && personalChatId !== chatId) {
        try {
          await sendStructuralDrawAlert(token, personalChatId, alertPayload);
        } catch (e: any) {
          console.error(`[scanner] Error enviando a Chat Personal: ${e.message}`);
        }
      }
    }
  } catch (e: any) {
    console.error('[scanner] Error en scanner global de empates 75+:', e.message);
  }
}
