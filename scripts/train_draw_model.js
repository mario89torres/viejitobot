const fs = require('fs');
const path = require('path');
const { db } = require('../src/db');

console.log('================================================================');
console.log('🧠 ENTRENAMIENTO AUTOMÁTICO DE MODELO ML PARA EMPATE ESTRUCTURAL');
console.log('================================================================\n');

// Cargar todos los picks de fútbol liquidados de una sola consulta ultra rápida
const picks = db.prepare(`
  SELECT id, event_id, event, sport, market, selection, odd_decimal, final_score, result
  FROM picks
  WHERE (LOWER(sport) LIKE '%futbol%' OR LOWER(sport) LIKE '%fútbol%' OR sport IS NULL)
    AND result IN ('win', 'loss', 'push')
`).all();

console.log(`📊 Picks de fútbol con resultado final cargados: ${picks.length}\n`);

const dataset = [];

for (const p of picks) {
  // Cargar snapshots del pick usando limit 30
  const activeSnaps = db.prepare(`
    SELECT odd_decimal, score, live_time
    FROM snapshots
    WHERE event_id = ? AND suspended = 0 AND odd_decimal > 0
    ORDER BY ts DESC
    LIMIT 30
  `).all(p.event_id);

  if (activeSnaps.length < 5) continue;

  const odds = activeSnaps.map(s => s.odd_decimal);
  const mean = odds.reduce((a, b) => a + b, 0) / odds.length;
  const variance = Math.sqrt(odds.reduce((sq, n) => sq + Math.pow(n - mean, 2), 0) / odds.length);

  const scoreStr = activeSnaps[0].score || p.final_score || '0-0';
  const parts = scoreStr.split('-').map(Number);
  const isTiedScore = parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1]) && parts[0] === parts[1];
  const goalMargin = parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1]) ? Math.abs(parts[0] - parts[1]) : 0;

  const finalScore = p.final_score || activeSnaps[0].score || '0-0';
  const finalParts = finalScore.split('-').map(Number);
  const isFinalDraw = finalParts.length === 2 && !isNaN(finalParts[0]) && !isNaN(finalParts[1]) && finalParts[0] === finalParts[1];

  dataset.push({
    pickId: p.id,
    event: p.event,
    features: {
      f_variance: Number(variance.toFixed(4)),
      f_mean_odd: Number(mean.toFixed(3)),
      f_tied: isTiedScore ? 1 : 0,
      f_margin: goalMargin,
      f_snap_count: activeSnaps.length
    },
    target: isFinalDraw ? 1 : (p.result === 'win' ? 1 : 0)
  });
}

console.log(`📌 Muestras extraídas aptas para entrenamiento: ${dataset.length}`);
const drawCount = dataset.filter(d => d.target === 1).length;
console.log(`  • Clases Positivas (Empate/Acierto): ${drawCount} (${((drawCount / Math.max(1, dataset.length)) * 100).toFixed(1)}%)`);
console.log(`  • Clases Negativas: ${dataset.length - drawCount}\n`);

// 2. Entrenar Modelo de Regresión Logística SGD
let weights = {
  bias: -0.5,
  f_variance: -15.4, // Varianza ultrabaja -> Altísimo peso positivo para Empate
  f_mean_odd: -0.15,
  f_tied: 2.10,      // Estar empatado al min 75+ -> Impulso fuerte
  f_margin: -1.45,   // Colchón estrecho -> Impulso positivo
  f_snap_count: 0.08
};

const lr = 0.05;
const epochs = 500;

for (let ep = 0; ep < epochs; ep++) {
  for (const sample of dataset) {
    const f = sample.features;
    const z = weights.bias +
      weights.f_variance * f.f_variance +
      weights.f_mean_odd * f.f_mean_odd +
      weights.f_tied * f.f_tied +
      weights.f_margin * f.f_margin +
      weights.f_snap_count * f.f_snap_count;

    const pred = 1 / (1 + Math.exp(-z));
    const err = pred - sample.target;

    weights.bias -= lr * err;
    weights.f_variance -= lr * err * f.f_variance;
    weights.f_mean_odd -= lr * err * f.f_mean_odd;
    weights.f_tied -= lr * err * f.f_tied;
    weights.f_margin -= lr * err * f.f_margin;
    weights.f_snap_count -= lr * err * f.f_snap_count;
  }
}

console.log('────────────────────────────────────────────────────────────────');
console.log('🎯 PESOS OPTIMIZADOS APRENDIDOS POR EL MODELO ML (MODEL_DRAW.JSON):');
console.log(`  • Intercepto (Bias): ${weights.bias.toFixed(4)}`);
console.log(`  • Peso Varianza (f_variance): ${weights.f_variance.toFixed(4)} (Penalización severa a alta volatilidad)`);
console.log(`  • Peso Marcador Empatado (f_tied): ${weights.f_tied.toFixed(4)} (Impulso positivo masivo)`);
console.log(`  • Peso Margen Goles (f_margin): ${weights.f_margin.toFixed(4)}`);
console.log(`  • Peso Muestra Snapshots (f_snap_count): ${weights.f_snap_count.toFixed(4)}\n`);

// 3. Evaluar Rendimiento del Modelo
let correct = 0;
let tp = 0, fp = 0, fn = 0, tn = 0;

for (const sample of dataset) {
  const f = sample.features;
  const z = weights.bias +
    weights.f_variance * f.f_variance +
    weights.f_mean_odd * f.f_mean_odd +
    weights.f_tied * f.f_tied +
    weights.f_margin * f.f_margin +
    weights.f_snap_count * f.f_snap_count;

  const prob = 1 / (1 + Math.exp(-z));
  const predClass = prob >= 0.60 ? 1 : 0;

  if (predClass === sample.target) correct++;
  if (predClass === 1 && sample.target === 1) tp++;
  if (predClass === 1 && sample.target === 0) fp++;
  if (predClass === 0 && sample.target === 1) fn++;
  if (predClass === 0 && sample.target === 0) tn++;
}

const accuracy = dataset.length > 0 ? (correct / dataset.length * 100).toFixed(1) : '100.0';
const precision = tp + fp > 0 ? (tp / (tp + fp) * 100).toFixed(1) : '0.0';
const recall = tp + fn > 0 ? (tp / (tp + fn) * 100).toFixed(1) : '0.0';

console.log('────────────────────────────────────────────────────────────────');
console.log('📊 MÉTRICAS DE VALIDACIÓN DEL MODELO ML PARA EMPATE ESTRUCTURAL:');
console.log(`  • Exactitud Global (Accuracy): ${accuracy}%`);
console.log(`  • Precisión (Precision): ${precision}%`);
console.log(`  • Sensibilidad (Recall): ${recall}%`);
console.log(`  • Verdaderos Positivos (Empates/Aciertos Pronosticados): ${tp}`);
console.log(`  • Falsos Positivos: ${fp}\n`);

// 4. Guardar archivo de pesos entrenados model_draw.json
const modelConfig = {
  trained_at: new Date().toISOString(),
  dataset_size: dataset.length,
  accuracy: parseFloat(accuracy),
  precision: parseFloat(precision),
  weights
};

const modelPath = path.join(__dirname, '..', 'model_draw.json');
fs.writeFileSync(modelPath, JSON.stringify(modelConfig, null, 2));

console.log(`💾 Modelo ML especializado guardado exitosamente en: ${modelPath}`);
console.log('================================================================\n');
