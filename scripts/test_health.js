require('dotenv').config();
const { calculateQuantitativeHealth } = require('../src/health');

console.log('==========================================================================');
print = console.log;
print('   SUITE DE RIGOR CUANTITATIVO Y SEMÁFORO DE SALUD (ESTILO POLYMARKET)     ');
print('==========================================================================\n');

const res = calculateQuantitativeHealth({ windowDays: 30 });

print(`ESTADO DEL SISTEMA: ${res.color} ${res.status}`);
print(`Mensaje Diagnóstico: ${res.message}\n`);

print('--- MÉTRICAS MATEMÁTICAS & CALIBRACIÓN (OOS) ---');
print(`• Total Muestras Evaluadas (n): ${res.n} picks`);
print(`• Tasa de Acierto (Win Rate): ${res.wr.toFixed(1)}% (${res.wins}/${res.n})`);
print(`• Brier Score: ${res.brierScore.toFixed(4)} (Límite óptimo < 0.2000)`);
print(`• Log Loss: ${res.logLoss.toFixed(4)}`);
print(`• ECE (Expected Calibration Error): ${(res.ece * 100).toFixed(2)}% (Límite óptimo < 5.0%)`);

print('\n--- MÉTRICAS DE CLV (CLOSING LINE VALUE VS PINNACLE/SHARP) ---');
if (res.sharpN > 0) {
  print(`• Muestras Evaluadas contra Cuota Cierre Sharp: ${res.sharpN}`);
  print(`• Sharp Beat Rate (% CLV > 0): ${res.clvBeatRate.toFixed(1)}% (Oro > 55.0%)`);
  print(`• Promedio de Ventaja CLV sobre Cierre: ${res.avgClvPct >= 0 ? '+' : ''}${res.avgClvPct.toFixed(2)}%`);
} else {
  print(`• Muestras Sharp: En recolección continua de datos de cierre.`);
}

print('\n--- MÉTRICAS DE BANCA & RIESGO FINANCIERO (CARTERA) ---');
print(`• Capital Apostado: ${res.totalStaked.toFixed(2)}u`);
print(`• Ganancia Neta: ${res.totalProfit >= 0 ? '+' : ''}${res.totalProfit.toFixed(2)}u`);
print(`• ROI Global: ${res.roi >= 0 ? '+' : ''}${res.roi.toFixed(2)}%`);
if (res.sharpeRatio !== null) print(`• Ratio de Sharpe Anualizado: ${res.sharpeRatio.toFixed(2)} (Institucional > 1.50)`);
if (res.maxDrawdown !== null) print(`• Máxima Racha de Caída (Max Drawdown): -${res.maxDrawdown.toFixed(2)}u`);

print('\n--- REPORTE DE CALIBRACIÓN POR BINS DE PROBABILIDAD (10 BINS) ---');
console.table(res.bins);
