const path = require('path');
const { db } = require('../src/db');
const { computeStructuralDrawSignal } = require('../src/confidence');

console.log('================================================================');
console.log('🧪 BACKTEST QUANT: ALGORITMOS DE MFE, PROFIT LOCK & EMPATE FLATLINE');
console.log('================================================================\n');

// 1. Obtener todos los picks liquidados (WIN / LOSS / PUSH) con stake asignado
const picks = db.prepare(`
  SELECT id, ts, event_id, event, sport, market, selection, odd_decimal, conf, result, stake, loss_minute
  FROM picks
  WHERE stake IS NOT NULL AND result IN ('win', 'loss', 'push')
  ORDER BY id ASC
`).all();

console.log(`📊 Total de picks liquidados analizados: ${picks.length}\n`);

let baselineWins = 0;
let baselineLosses = 0;
let baselinePushes = 0;
let baselineProfit = 0;
let baselineStakeTotal = 0;

let profitLockTriggers = 0;
let profitLockWins = 0;
let profitLockRescuedLosses = 0; // Picks que habrían sido LOSS al final pero dieron Cashout de +30%+
let profitLockExtraUnits = 0;

let flatlineTriggers = 0;
let flatlineDrawsOrWins = 0; // Picks con Flatline que terminaron en Empate o Win
let flatlineLosses = 0;

const details = [];

for (const p of picks) {
  const stake = p.stake || 1;
  baselineStakeTotal += stake;
  
  if (p.result === 'win') {
    baselineWins++;
    baselineProfit += stake * (p.odd_decimal - 1);
  } else if (p.result === 'loss') {
    baselineLosses++;
    baselineProfit -= stake;
  } else {
    baselinePushes++;
  }

  // Obtener snapshots históricos del pick
  const snapshots = db.prepare(`
    SELECT odd_decimal, suspended, score, ts
    FROM snapshots
    WHERE event_id = ? AND market = ? AND selection = ?
    ORDER BY ts ASC
  `).all(p.event_id, p.market, p.selection);

  const activeOdds = snapshots.filter(s => !s.suspended && s.odd_decimal > 0).map(s => s.odd_decimal);
  
  if (!activeOdds.length) continue;

  const minOdd = Math.min(...activeOdds);
  const initialOdd = p.odd_decimal;

  // MFE Peak ROI (% Ganancia máxima alcanzada durante la vida del pick)
  const mfePeakRoi = (initialOdd && minOdd && minOdd < initialOdd)
    ? (initialOdd - minOdd) / minOdd * 100
    : 0;

  // 1. Detección de Profit Lock (MFE Peak >= 30% de ROI en vivo)
  const hadProfitLock = mfePeakRoi >= 30;
  if (hadProfitLock) {
    profitLockTriggers++;
    if (p.result === 'win') {
      profitLockWins++;
    } else if (p.result === 'loss') {
      profitLockRescuedLosses++;
      // Rescatamos la pérdida sumando la ganancia neta del cashout (ej +30% a +54%)
      const lockROI = mfePeakRoi / 100;
      const rescuedProfit = stake * lockROI; // Ganancia capturada
      const netGainOverLoss = stake + rescuedProfit; // Evita -stake y suma +rescuedProfit
      profitLockExtraUnits += netGainOverLoss;
    }
  }

  // 2. Detección de Señal de Empate Estructural (Flatline Varianza <= 0.025)
  const drawSig = computeStructuralDrawSignal(activeOdds, p.final_score || (snapshots.length ? snapshots.at(-1).score : ''));
  if (drawSig.isStructuralDraw) {
    flatlineTriggers++;
    if (p.result === 'win' || p.result === 'push') {
      flatlineDrawsOrWins++;
    } else {
      flatlineLosses++;
    }
  }

  if (hadProfitLock || drawSig.isStructuralDraw) {
    details.push({
      id: p.id,
      event: p.event,
      market: p.market,
      selection: p.selection,
      entryOdd: initialOdd,
      minOdd: minOdd,
      mfePeakRoi: mfePeakRoi.toFixed(1) + '%',
      hadProfitLock,
      hadFlatline: drawSig.isStructuralDraw,
      finalResult: p.result
    });
  }
}

const baselineROI = baselineStakeTotal > 0 ? (baselineProfit / baselineStakeTotal * 100).toFixed(2) : '0.00';
const optimizedProfit = baselineProfit + profitLockExtraUnits;
const optimizedROI = baselineStakeTotal > 0 ? (optimizedProfit / baselineStakeTotal * 100).toFixed(2) : '0.00';

console.log('────────────────────────────────────────────────────────────────');
console.log('📈 RESULTADOS DE LA ESTRATEGIA BASELINE (SIN CASHOUT / HOLD A 90 MIN):');
console.log(`  • Win Rate: ${((baselineWins / picks.length) * 100).toFixed(1)}% (${baselineWins} W / ${baselineLosses} L / ${baselinePushes} P)`);
console.log(`  • Stake Total Invertido: ${baselineStakeTotal.toFixed(2)} unidades`);
console.log(`  • Beneficio Neto Baseline: ${baselineProfit > 0 ? '+' : ''}${baselineProfit.toFixed(2)} unidades`);
console.log(`  • ROI Baseline: ${baselineROI}%\n`);

console.log('────────────────────────────────────────────────────────────────');
console.log('⚡ IMPACTO DEL MOTOR PROFIT LOCK / MFE CASHOUT:');
console.log(`  • Total de Oportunidades de Profit Lock Detectadas: ${profitLockTriggers} picks (${((profitLockTriggers/picks.length)*100).toFixed(1)}% del universo)`);
console.log(`  • Picks que terminaron en Win de todos modos: ${profitLockWins}`);
console.log(`  • 🚨 PICKS PERDIDOS A LOS 90 MIN RESCATADOS CON CASHOUT: ${profitLockRescuedLosses} picks`);
console.log(`  • Capital Extra Rescatado / Generado: +${profitLockExtraUnits.toFixed(2)} unidades`);
console.log(`  • Beneficio Neto Optimizado: +${optimizedProfit.toFixed(2)} unidades`);
console.log(`  • ROI Optimizado con Profit Lock: ${optimizedROI}% (¡Incremento de +${(parseFloat(optimizedROI) - parseFloat(baselineROI)).toFixed(2)}% de ROI!)\n`);

console.log('────────────────────────────────────────────────────────────────');
console.log('🎯 IMPACTO DE LA SEÑAL DE EMPATE ESTRUCTURAL (FLATLINE):');
console.log(`  • Eventos con Señal de Meseta Flatline Detectados: ${flatlineTriggers}`);
console.log(`  • Tasa de Acierto / Estabilidad en Meseta: ${flatlineTriggers > 0 ? ((flatlineDrawsOrWins / flatlineTriggers) * 100).toFixed(1) : 0}% (${flatlineDrawsOrWins} Aciertos / ${flatlineLosses} Caídas)\n`);

console.log('────────────────────────────────────────────────────────────────');
console.log('📋 EJEMPLOS DE CASOS DE ÉXITO RESCATADOS EN EL HISTÓRICO:');
console.table(details.slice(0, 10));
console.log('================================================================\n');
