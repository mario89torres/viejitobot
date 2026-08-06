// Módulo de Rigor Cuantitativo y Semáforo de Salud Matemático (Estilo Polymarket Quantitative Engine)
//
// Mide la calidad probabilística del sistema más allá del ROI superficial:
//   1. Brier Score & Log Loss (Precisión estocástica)
//   2. ECE (Expected Calibration Error en 10 bins de probabilidad)
//   3. CLV (Closing Line Value) Beat Rate contra el mercado sharp (Pinnacle/Betfair)
//   4. Sharpe Ratio y Max Drawdown (Riesgo financiero de cartera)
//   5. Semáforo de Salud Matemático (Verde / Amarillo / Rojo) con Circuit Breaker automático.

const { db } = require('./db');
const { excludedSports } = require('./confidence');

const normSport = s => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

function calculateQuantitativeHealth({ windowDays = 30 } = {}) {
  const excl = excludedSports();
  const sinceTs = new Date(Date.now() - windowDays * 24 * 3600e3).toISOString();

  const picks = db.prepare(`
    SELECT id, ts, sport, market, selection, odd_decimal, conf, result, stake, final_score, sharp_closing_odd
    FROM picks
    WHERE stake IS NOT NULL AND result IN ('win', 'loss') AND ts >= ?
    ORDER BY ts ASC
  `).all(sinceTs).filter(p => !excl.includes(normSport(p.sport)));

  if (!picks.length) {
    return {
      status: 'NEUTRO',
      color: '⚪',
      message: 'Sin suficientes picks en el periodo para auditoría.',
      n: 0,
    };
  }

  const n = picks.length;
  let brierSum = 0;
  let logLossSum = 0;
  const wins = picks.filter(p => p.result === 'win').length;
  const wr = (wins / n) * 100;

  let totalStaked = 0;
  let totalProfit = 0;
  const dailyProfits = {};

  // 1. CÁLCULO DE BRIER SCORE, LOG LOSS Y PROFIT/STAKE
  for (const p of picks) {
    const y = p.result === 'win' ? 1 : 0;
    const conf = Math.max(0.001, Math.min(0.999, p.conf || 0.5));

    // Brier Score: (conf - y)^2
    brierSum += Math.pow(conf - y, 2);

    // Log Loss: -[y*ln(conf) + (1-y)*ln(1-conf)]
    logLossSum += -(y * Math.log(conf) + (1 - y) * Math.log(1 - conf));

    const profit = y === 1 ? p.stake * (p.odd_decimal - 1) : -p.stake;
    totalStaked += p.stake;
    totalProfit += profit;

    // Agrupar por día local para Sharpe Ratio y Max Drawdown
    const dateStr = p.ts.slice(0, 10);
    dailyProfits[dateStr] = (dailyProfits[dateStr] || 0) + profit;
  }

  const brierScore = brierSum / n;
  const logLoss = logLossSum / n;
  const roi = totalStaked > 0 ? (totalProfit / totalStaked) * 100 : 0;

  // 2. EXPECTED CALIBRATION ERROR (ECE) EN 10 BINS
  const bins = Array.from({ length: 10 }, () => ({ confSum: 0, winCount: 0, count: 0 }));
  for (const p of picks) {
    const conf = Math.max(0.5, Math.min(0.999, p.conf || 0.5));
    const binIdx = Math.min(9, Math.floor((conf - 0.5) / 0.05));
    bins[binIdx].confSum += conf;
    bins[binIdx].count += 1;
    if (p.result === 'win') bins[binIdx].winCount += 1;
  }

  let ece = 0;
  const binReport = [];
  for (let i = 0; i < 10; i++) {
    const b = bins[i];
    const rangeMin = (0.5 + i * 0.05).toFixed(2);
    const rangeMax = (0.5 + (i + 1) * 0.05).toFixed(2);
    if (b.count > 0) {
      const avgConf = b.confSum / b.count;
      const actualAcc = b.winCount / b.count;
      const gap = Math.abs(actualAcc - avgConf);
      ece += (b.count / n) * gap;
      binReport.push({
        range: `[${rangeMin}-${rangeMax}]`,
        n: b.count,
        avgConf: (avgConf * 100).toFixed(1) + '%',
        actualAcc: (actualAcc * 100).toFixed(1) + '%',
        gap: (gap * 100).toFixed(1) + '%',
      });
    }
  }

  // 3. CLOSING LINE VALUE (CLV) Y SHARP BEAT RATE
  const sharpPicks = picks.filter(p => p.sharp_closing_odd && p.sharp_closing_odd > 1.0);
  let clvBeatCount = 0;
  let totalClvPct = 0;
  for (const p of sharpPicks) {
    const clv = (p.odd_decimal / p.sharp_closing_odd) - 1;
    totalClvPct += clv;
    if (clv > 0) clvBeatCount++;
  }
  const sharpN = sharpPicks.length;
  const clvBeatRate = sharpN > 0 ? (clvBeatCount / sharpN) * 100 : null;
  const avgClvPct = sharpN > 0 ? (totalClvPct / sharpN) * 100 : null;

  // 4. METRICAS FINANCIERAS: SHARPE RATIO & MAX DRAWDOWN
  const days = Object.keys(dailyProfits);
  let sharpeRatio = null;
  let maxDrawdown = 0;
  let peak = 0;
  let cumu = 0;

  if (days.length >= 3) {
    const returns = days.map(d => dailyProfits[d]);
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / returns.length;
    const stdDev = Math.sqrt(variance);
    sharpeRatio = stdDev > 0 ? (mean / stdDev) * Math.sqrt(365) : 0;

    for (const r of returns) {
      cumu += r;
      if (cumu > peak) peak = cumu;
      const dd = peak - cumu;
      if (dd > maxDrawdown) maxDrawdown = dd;
    }
  }

  // 5. EVALUACIÓN DEL SEMÁFORO DE SALUD Y CIRCUIT BREAKER
  let color = '🟢';
  let status = 'ÓPTIMO (SALUDABLE)';
  let message = 'El modelo presenta calibración probabilística sólida y CLV positivo.';

  if (ece > 0.08 || (brierScore > 0.22 && n >= 50)) {
    color = '🔴';
    status = 'DESCALIBRADO (CIRCUIT BREAKER)';
    message = 'ALERTA MATEMÁTICA: El error de calibración (ECE) supera el 8.0%. Recomienda re-entrenar la IA.';
  } else if (ece > 0.05 || (roi < 0 && n >= 30)) {
    color = '🟡';
    status = 'PRECAUCIÓN (DESCALIBRACIÓN LEVE)';
    message = 'ADVERTENCIA: Ligero desajuste entre confianza estimada y precisión real.';
  }

  return {
    n, wins, wr, totalStaked, totalProfit, roi,
    brierScore, logLoss, ece,
    sharpN, clvBeatRate, avgClvPct,
    sharpeRatio, maxDrawdown,
    bins: binReport,
    status, color, message,
  };
}

module.exports = { calculateQuantitativeHealth };
