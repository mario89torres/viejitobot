const { db } = require('./db');
const { devig } = require('./devig');

// Métricas de calibración sobre picks liquidados (result IN ('win','loss')).
// Las funciones de cálculo son puras (reciben [{conf, y}]) para poder testearlas;
// computeMetrics() las alimenta desde la BD.

// Bins de la reliability table: [0–0.5, 0.5–0.6, 0.6–0.7, 0.7–0.8, 0.8–0.9, 0.9–1.0]
const BIN_EDGES = [0, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0];

const CLIP_MIN = 0.001, CLIP_MAX = 0.999;
const clip = c => Math.min(CLIP_MAX, Math.max(CLIP_MIN, c));

// Brier: media de (conf − y)², con y = 1 si win, 0 si loss
function brierScore(points) {
  if (!points.length) return null;
  return points.reduce((s, p) => s + (p.conf - p.y) ** 2, 0) / points.length;
}

// Log loss con clipping de conf a [0.001, 0.999] para evitar infinitos
function logLoss(points) {
  if (!points.length) return null;
  return points.reduce((s, p) => {
    const c = clip(p.conf);
    return s - (p.y * Math.log(c) + (1 - p.y) * Math.log(1 - c));
  }, 0) / points.length;
}

// Reliability table + ECE = Σ (n_bin/N)·|conf media − tasa real|
function reliability(points) {
  const bins = [];
  for (let i = 0; i < BIN_EDGES.length - 1; i++) {
    bins.push({ lo: BIN_EDGES[i], hi: BIN_EDGES[i + 1], n: 0, sumConf: 0, wins: 0 });
  }
  for (const p of points) {
    const c = Math.min(Math.max(p.conf, 0), 1 - 1e-9); // conf = 1 cae en el último bin
    const b = bins.find(b => c >= b.lo && c < b.hi);
    b.n++;
    b.sumConf += p.conf;
    b.wins += p.y;
  }
  const N = points.length;
  let ece = 0;
  const rows = bins.map(b => {
    if (!b.n) return { lo: b.lo, hi: b.hi, n: 0, avgConf: null, winRate: null, gap: null };
    const avgConf = b.sumConf / b.n;
    const winRate = b.wins / b.n;
    ece += (b.n / N) * Math.abs(avgConf - winRate);
    return { lo: b.lo, hi: b.hi, n: b.n, avgConf, winRate, gap: avgConf - winRate };
  });
  return { bins: rows, ece: N ? ece : null };
}

// ---------- CLV ----------
// Reconstruye el mercado completo en un ts dado y devuelve la prob de-viggeada
// (Shin) de la selección del pick. Los ts de snapshots son por lote, así que
// todas las selecciones del mercado comparten el mismo ts.
const marketAtStmt = db.prepare(`
  SELECT selection, odd_decimal FROM snapshots
  WHERE event_id = ? AND market = ? AND ts = ? AND suspended = 0
`);

function devigProbAt(eventId, market, ts, selection) {
  const rows = marketAtStmt.all(eventId, market, ts);
  if (rows.length < 2) return null;
  const i = rows.findIndex(r => r.selection === selection);
  if (i < 0 || rows.some(r => !(r.odd_decimal > 1))) return null;
  return devig(rows.map(r => r.odd_decimal), 'shin')[i];
}

// CLV = (prob de-viggeada al cierre / prob de-viggeada en la entrada) − 1
function clvForPick(pick) {
  if (!pick.closing_ts || !pick.ts) return null;
  const entry = devigProbAt(pick.event_id, pick.market, pick.ts, pick.selection);
  const close = devigProbAt(pick.event_id, pick.market, pick.closing_ts, pick.selection);
  if (entry === null || close === null || entry <= 0) return null;
  return close / entry - 1;
}

const settledStmt = db.prepare(`
  SELECT * FROM picks WHERE result IN ('win','loss') AND conf IS NOT NULL
`);

function computeMetrics() {
  const settled = settledStmt.all();
  const points = settled.map(p => ({ conf: p.conf, y: p.result === 'win' ? 1 : 0 }));
  const rel = reliability(points);
  const clvs = [];
  for (const p of settled) {
    const v = clvForPick(p);
    if (v !== null) clvs.push(v);
  }
  return {
    n: points.length,
    brier: brierScore(points),
    logLoss: logLoss(points),
    ece: rel.ece,
    bins: rel.bins,
    clvAvg: clvs.length ? clvs.reduce((s, x) => s + x, 0) / clvs.length : null,
    clvN: clvs.length,
  };
}

// Comparación heurístico vs aprendido sobre picks liquidados que tienen ambos
// scores (modo shadow o learned). Devuelve null si aún no hay ninguno.
const shadowStmt = db.prepare(`
  SELECT conf_heuristic, conf_learned, result FROM picks
  WHERE result IN ('win','loss') AND conf_heuristic IS NOT NULL AND conf_learned IS NOT NULL
`);

function compareScores() {
  const rows = shadowStmt.all();
  if (!rows.length) return null;
  const mk = key => rows.map(r => ({ conf: r[key], y: r.result === 'win' ? 1 : 0 }));
  const summarize = points => ({
    brier: brierScore(points),
    logLoss: logLoss(points),
    ece: reliability(points).ece,
  });
  return {
    n: rows.length,
    heuristic: summarize(mk('conf_heuristic')),
    learned: summarize(mk('conf_learned')),
  };
}

// ---------- Etapa 4: CLV sharp, edge y semáforo de decisión ----------

// CLV_sharp = prob_shin(mercado sharp al cierre) / prob_shin(entrada Altenar) − 1.
// Solo el CLV contra la línea sharp cuenta como evidencia de edge; el CLV
// contra Altenar (línea blanda) se mantiene únicamente como diagnóstico.
function clvSharpForPick(pick) {
  if (!pick.sharp_closing_market || !pick.ts) return null;
  let mkt;
  try { mkt = JSON.parse(pick.sharp_closing_market); } catch { return null; }
  const outcomes = mkt && mkt.outcomes;
  if (!Array.isArray(outcomes) || outcomes.length < 2 || !(mkt.idx >= 0) || mkt.idx >= outcomes.length) return null;
  if (outcomes.some(o => !(o.price > 1))) return null;
  const probClose = devig(outcomes.map(o => o.price), 'shin')[mkt.idx];
  const entry = devigProbAt(pick.event_id, pick.market, pick.ts, pick.selection);
  if (entry === null || entry <= 0) return null;
  return probClose / entry - 1;
}

// Correlación de Spearman con empates promediados; null si n<3 o sin varianza
function spearman(xs, ys) {
  const n = xs.length;
  if (n < 3 || n !== ys.length) return null;
  const rank = (arr) => {
    const idx = arr.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
    const ranks = new Array(n);
    let i = 0;
    while (i < n) {
      let j = i;
      while (j + 1 < n && idx[j + 1][0] === idx[i][0]) j++;
      const avg = (i + j) / 2 + 1;
      for (let k = i; k <= j; k++) ranks[idx[k][1]] = avg;
      i = j + 1;
    }
    return ranks;
  };
  const rx = rank(xs), ry = rank(ys);
  const mean = a => a.reduce((s, v) => s + v, 0) / n;
  const mx = mean(rx), my = mean(ry);
  let num = 0, dx = 0, dy = 0;
  for (let k = 0; k < n; k++) {
    num += (rx[k] - mx) * (ry[k] - my);
    dx += (rx[k] - mx) ** 2;
    dy += (ry[k] - my) ** 2;
  }
  if (dx === 0 || dy === 0) return null;
  return num / Math.sqrt(dx * dy);
}

// Semáforo con las reglas exactas de decisión (N = picks con match sharp liquidados)
function semaphore(clvSharpMean, roi, n) {
  if (clvSharpMean !== null && clvSharpMean > 0 && n >= 300) {
    return 'EDGE PROBABLE: el sistema bate la línea de cierre; el ROI llegará con volumen.';
  }
  if (clvSharpMean !== null && roi !== null && clvSharpMean <= 0 && roi > 0) {
    return 'PRECAUCIÓN: resultado positivo sin batir el cierre = probablemente varianza. No escalar.';
  }
  if (clvSharpMean !== null && roi !== null && clvSharpMean > 0 && roi < 0) {
    return 'VARIANZA NEGATIVA: mantener proceso, revisar en +100 picks.';
  }
  if (n < 300) return `MUESTRA INSUFICIENTE (${n}/300).`;
  return 'SIN EDGE: no bate el cierre ni hay ROI positivo.';
}

const settledAllStmt = db.prepare(`SELECT * FROM picks WHERE result IN ('win','loss')`);
const matchCountsStmt = db.prepare(`
  SELECT sharp_match, COUNT(*) n FROM picks
  WHERE sharp_match IN ('matched','unmatched') GROUP BY sharp_match
`);

function edgeStats() {
  const settled = settledAllStmt.all();
  if (!settled.length) return null;

  // ROI a 1 unidad por pick
  const roi = settled.reduce((s, p) => s + (p.result === 'win' ? p.odd_decimal - 1 : -1), 0) / settled.length;

  // tasa de match sobre TODOS los picks con intento (liquidados o no),
  // contando solo los que tenían cobertura sharp posible
  const counts = Object.fromEntries(matchCountsStmt.all().map(r => [r.sharp_match, r.n]));
  const nMatchedAll = counts.matched || 0;
  const attempted = nMatchedAll + (counts.unmatched || 0);

  const matched = settled.filter(p => p.sharp_match === 'matched');

  const withClv = [];
  for (const p of matched) {
    const clv = clvSharpForPick(p);
    if (clv !== null) withClv.push({ ...p, clv });
  }
  const clvs = withClv.map(p => p.clv).sort((a, b) => a - b);
  const nClv = clvs.length;
  const clvMean = nClv ? clvs.reduce((s, v) => s + v, 0) / nClv : null;
  const clvMedian = nClv
    ? (nClv % 2 ? clvs[(nClv - 1) / 2] : (clvs[nClv / 2 - 1] + clvs[nClv / 2]) / 2)
    : null;
  const clvPositive = nClv ? clvs.filter(v => v > 0).length / nClv : null;

  const withEdge = settled.filter(p => p.edge !== null);
  const rhoEdgeResult = spearman(withEdge.map(p => p.edge), withEdge.map(p => (p.result === 'win' ? 1 : 0)));
  const edgeClv = withClv.filter(p => p.edge !== null);
  const rhoEdgeClv = spearman(edgeClv.map(p => p.edge), edgeClv.map(p => p.clv));

  return {
    nSettled: settled.length, roi,
    matchRate: attempted ? nMatchedAll / attempted : null,
    nMatched: nMatchedAll, nAttempted: attempted,
    clvMean, clvMedian, clvPositive, nClv,
    rhoEdgeResult, rhoEdgeClv,
    semaphore: semaphore(clvMean, roi, nClv),
  };
}

// ---------- Etapa 4: monitoreo de drift (/health) ----------
const HEALTH_WINDOW = 200;
const HEALTH_ECE_MAX = 0.05;
const HEALTH_MIN_N = 50;

// Pura para tests: points = [{conf, y}]
function healthEval(points, { minN = HEALTH_MIN_N, threshold = HEALTH_ECE_MAX } = {}) {
  const ece = reliability(points).ece;
  const alert = points.length >= minN && ece !== null && ece > threshold;
  return { n: points.length, ece, threshold, alert };
}

const lastSettledStmt = db.prepare(`
  SELECT conf, result FROM picks
  WHERE result IN ('win','loss') AND conf IS NOT NULL
  ORDER BY settled_ts DESC LIMIT ?
`);

function computeHealth() {
  const points = lastSettledStmt.all(HEALTH_WINDOW)
    .map(p => ({ conf: p.conf, y: p.result === 'win' ? 1 : 0 }));
  return healthEval(points);
}

// ---------- Etapa 6: unidades de apuesta ----------
// Solo cuenta picks con stake asignado (desde que se activó el dimensionamiento
// por unidades); los anteriores quedan fuera en vez de asumirles una unidad
// que nunca se decidió — mezclarlos ensuciaría staked/profit.
const stakedSettledStmt = db.prepare(`
  SELECT ts, stake, stake_mode, odd_decimal, result, sport, source FROM picks
  WHERE stake IS NOT NULL AND result IN ('win','loss')
`);

// Día local de Ciudad de México (UTC-6) al que pertenece un pick. Agrupar por
// día UTC partiría la jornada a las 18:00 hora local, justo en pleno horario
// de partidos: los resultados de una misma tarde caerían en dos días distintos.
const diaLocal = ts => new Date(Date.parse(ts) - 6 * 3600e3).toISOString().slice(0, 10);
const stakedPendingStmt = db.prepare(`
  SELECT COUNT(*) n, COALESCE(SUM(stake),0) u FROM picks WHERE stake IS NOT NULL AND result IS NULL
`);
const stakeFirstStmt = db.prepare(`SELECT MIN(ts) t FROM picks WHERE stake IS NOT NULL`);

const { isExcluded, excludedSports, isBlockedOver, isBlockedMarket } = require('./confidence');

function stakeStats() {
  const excl = excludedSports();
  const rows = stakedSettledStmt.all()
    .filter(r => !isExcluded(r.sport, excl))
    .filter(r => !isBlockedOver(r))
    .filter(r => !isBlockedMarket(r));
  const pending = stakedPendingStmt.get();
  const since = stakeFirstStmt.get().t;
  if (!rows.length) return { n: 0, since, pendingN: pending.n, pendingUnits: pending.u };

  let staked = 0, profit = 0;
  const bySport = {}, byDay = {};
  for (const r of rows) {
    const pl = r.result === 'win' ? r.stake * (r.odd_decimal - 1) : -r.stake;
    staked += r.stake;
    profit += pl;
    const b = (bySport[r.sport] = bySport[r.sport] || { n: 0, staked: 0, profit: 0 });
    b.n++; b.staked += r.stake; b.profit += pl;
    const d = (byDay[diaLocal(r.ts)] = byDay[diaLocal(r.ts)] || { n: 0, wins: 0, staked: 0, profit: 0 });
    d.n++; d.staked += r.stake; d.profit += pl;
    if (r.result === 'win') d.wins++;
  }
  const wins = rows.filter(r => r.result === 'win').length;

  // acumulado corrido: permite ver la trayectoria de la banca, no solo el total
  let acum = 0;
  const dias = Object.entries(byDay).sort(([a], [b]) => a.localeCompare(b)).map(([dia, d]) => {
    acum += d.profit;
    return {
      dia, n: d.n, wr: 100 * d.wins / d.n,
      staked: d.staked, profit: d.profit,
      roi: d.staked > 0 ? 100 * d.profit / d.staked : null,
      acumulado: acum,
    };
  });

  return {
    n: rows.length, since,
    staked, profit, roi: staked > 0 ? 100 * profit / staked : null,
    wr: 100 * wins / rows.length,
    mode: rows[0].stake_mode,
    avgStake: staked / rows.length,
    bySport: Object.entries(bySport).map(([sport, b]) => ({
      sport, n: b.n, staked: b.staked, profit: b.profit,
      roi: b.staked > 0 ? 100 * b.profit / b.staked : null,
    })).sort((a, b) => b.profit - a.profit),
    byDay: dias,
    pendingN: pending.n, pendingUnits: pending.u,
  };
}

const allStakedPicksStmt = db.prepare(`
  SELECT id, ts, event_id, event, sport, market, selection, odd_decimal, conf, result, final_score, settled_ts, stake, stake_mode, source, loss_minute
  FROM picks
  WHERE stake IS NOT NULL AND result IN ('win','loss')
  ORDER BY ts ASC
`);

function stakePicksByDate(dateStr) {
  const targetDate = (!dateStr || dateStr === 'hoy')
    ? diaLocal(new Date().toISOString())
    : (dateStr === 'ayer'
        ? diaLocal(new Date(Date.now() - 24 * 3600e3).toISOString())
        : dateStr);

  const excl = excludedSports();
  const rows = allStakedPicksStmt.all()
    .filter(r => !isExcluded(r.sport, excl))
    .filter(r => !isBlockedOver(r))
    .filter(r => !isBlockedMarket(r));
  const dayPicks = rows
    .filter(r => diaLocal(r.ts) === targetDate)
    .map(r => {
      const profit = r.result === 'win' ? r.stake * (r.odd_decimal - 1) : -r.stake;
      return { ...r, profit };
    })
    .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));

  const sessionCutoffTs = '2026-08-06T00:02:00.000Z'; // 18:02 CDMX de hoy (05-Ago)
  const isToday = targetDate === diaLocal(new Date().toISOString());

  const postPicks = isToday ? dayPicks.filter(p => p.ts >= sessionCutoffTs) : dayPicks;
  const prePicks = isToday ? dayPicks.filter(p => p.ts < sessionCutoffTs) : [];

  const calcSub = (arr) => {
    const subN = arr.length;
    const subWins = arr.filter(p => p.result === 'win').length;
    const subStaked = arr.reduce((s, p) => s + p.stake, 0);
    const subProfit = arr.reduce((s, p) => s + p.profit, 0);
    const subRoi = subStaked > 0 ? (100 * subProfit / subStaked) : null;
    const subWr = subN > 0 ? (100 * subWins / subN) : null;
    return { n: subN, wins: subWins, staked: subStaked, profit: subProfit, roi: subRoi, wr: subWr, picks: arr };
  };

  const n = dayPicks.length;
  const wins = dayPicks.filter(p => p.result === 'win').length;
  const staked = dayPicks.reduce((s, p) => s + p.stake, 0);
  const profit = dayPicks.reduce((s, p) => s + p.profit, 0);
  const roi = staked > 0 ? (100 * profit / staked) : null;
  const wr = n > 0 ? (100 * wins / n) : null;

  return {
    date: targetDate,
    picks: dayPicks,
    n,
    wins,
    staked,
    profit,
    roi,
    wr,
    sessionCutoffTs,
    isToday,
    preSession: calcSub(prePicks),
    postSession: calcSub(postPicks),
  };
}

module.exports = {
  brierScore, logLoss, reliability, clvForPick, devigProbAt, computeMetrics, compareScores,
  clvSharpForPick, spearman, semaphore, edgeStats, healthEval, computeHealth, stakeStats,
  stakePicksByDate, diaLocal,
};

