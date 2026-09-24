// Reconstruye el bloque `calibration` del model.json de PRODUCCION a partir de
// los conf_learned ya persistidos.
//
// POR QUE HIZO FALTA. El 2026-09-04, tests/model.test.js sobrescribio el
// model.json de produccion con su modelo de juguete de 171 bytes: withModel()
// escribe un FAKE_MODEL y restaura en un finally, pero el restore fallo por
// contencion de fichero con el bot vivo. La unica copia buena quedo en la
// memoria del proceso en marcha.
//
// POR QUE ES RECUPERABLE. model_candidate.json (el candidato que se entreno un
// minuto antes) resulto tener EXACTAMENTE los mismos intercept, coef, sport_coef,
// features y n_samples que produccion. Lo unico que cambia es la tabla
// `calibration` — y esa se puede despejar, porque la BD guarda miles de pares
// (features -> conf_learned) producidos por el modelo bueno.
//
// COMO. La calibracion es Platt (calibration_method: 'sigmoid'), asi que
//     logit(conf_learned) = a * logit(raw) + b
// es LINEAL. Con dos parametros y miles de puntos se despeja por minimos
// cuadrados, se comprueba el ajuste, y se reemite la tabla de 200 puntos en el
// mismo formato que espera interp().
//
//   node scripts/recuperar-calibracion-model.js           # solo diagnostica
//   node scripts/recuperar-calibracion-model.js --write   # escribe model.json
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const fs = require('fs');
const { db } = require('../src/db');
const { learnedRaw, marketFeatures, reloadModel } = require('../src/model');

const VERSION_BUENA = process.env.RECUP_VERSION || '20260828T170521Z-085ff8b';
const escribir = process.argv.includes('--write');
const MODEL_PATH = path.join(__dirname, '..', 'model.json');

reloadModel();

// Filas producidas por el modelo bueno, de las tres tablas que guardan
// conf_learned. rejected_picks es la importante: cubre TODO el rango de
// confianza, mientras que picks y model_picks solo traen lo que paso la puerta
// (>= 0.70) y dejarian la mitad baja de la curva sin observar.
// OJO CON EL AVANCE. El modelo NO consume la columna `f_avance`: confidence.js
// le pasa avanceForModel(), y eso se persiste en `f_avance_model`. `f_avance`
// guarda el avance crudo que usa el heuristico. Usar la columna equivocada
// desalinea la reconstruccion (R2 0.84 en vez de 1) y parece un fallo de la
// calibracion cuando en realidad es la feature cambiada.
const sql = (t) => `SELECT sport, market, selection, f_prob_justa, f_avance_model, f_situacion, conf_learned
  FROM ${t} WHERE model_version = ? AND conf_learned IS NOT NULL
    AND f_prob_justa IS NOT NULL AND f_avance_model IS NOT NULL AND f_situacion IS NOT NULL`;
const filas = [
  ...db.prepare(sql('model_picks')).all(VERSION_BUENA),
  ...db.prepare(sql('rejected_picks')).all(VERSION_BUENA),
  ...db.prepare(sql('picks')).all(VERSION_BUENA),
];
console.log(`filas del modelo ${VERSION_BUENA}: ${filas.length}`);
if (!filas.length) { console.error('sin datos: no se puede reconstruir'); process.exit(1); }

const logit = (p) => Math.log(p / (1 - p));
const sigmoid = (z) => 1 / (1 + Math.exp(-z));

const pares = [];
for (const r of filas) {
  const f = {
    f_prob_justa: r.f_prob_justa, f_avance: r.f_avance_model, f_situacion: r.f_situacion,
    ...marketFeatures({ market: r.market, selection: r.selection || '' }),
  };
  const raw = learnedRaw(f, r.sport);
  if (raw == null || raw <= 0 || raw >= 1) continue;
  const cal = r.conf_learned;
  if (cal <= 0 || cal >= 1) continue;
  pares.push({ x: logit(raw), y: logit(cal), raw, cal });
}
console.log(`pares utilizables: ${pares.length}`);
const rawMin = Math.min(...pares.map(p => p.raw)), rawMax = Math.max(...pares.map(p => p.raw));
const calMin = Math.min(...pares.map(p => p.cal)), calMax = Math.max(...pares.map(p => p.cal));
console.log(`  raw observado ${rawMin.toFixed(4)} .. ${rawMax.toFixed(4)}`);
console.log(`  cal observado ${calMin.toFixed(4)} .. ${calMax.toFixed(4)}`);

// Minimos cuadrados: y = a*x + b
const n = pares.length;
const mx = pares.reduce((s, p) => s + p.x, 0) / n;
const my = pares.reduce((s, p) => s + p.y, 0) / n;
let sxy = 0, sxx = 0;
for (const p of pares) { sxy += (p.x - mx) * (p.y - my); sxx += (p.x - mx) ** 2; }
const a = sxy / sxx, b = my - a * mx;
let ssRes = 0, ssTot = 0;
for (const p of pares) { const pred = a * p.x + b; ssRes += (p.y - pred) ** 2; ssTot += (p.y - my) ** 2; }
const r2 = 1 - ssRes / ssTot;
console.log(`\najuste Platt: logit(cal) = ${a.toFixed(10)} * logit(raw) + ${b.toFixed(10)}`);
console.log(`  R2 = ${r2.toFixed(10)}`);

// Error de reconstruccion en la escala de probabilidad, que es la que importa.
let maxErr = 0;
for (const p of pares) maxErr = Math.max(maxErr, Math.abs(sigmoid(a * p.x + b) - p.cal));
console.log(`  error maximo reconstruyendo conf_learned: ${maxErr.toExponential(3)}`);

// SUELO DE PRECISION: 5e-6, no cero. La tabla de calibracion se exporta
// redondeada a 6 decimales, asi que el conf_learned guardado ya venia con ese
// redondeo dentro. Exigir 1e-9 era pedir mas precision de la que el dato tiene:
// un ajuste perfecto da ~1e-6 y no menos. Por encima de 5e-6 si hay desajuste
// real y no se escribe nada.
const SUELO = 5e-6;
if (maxErr > SUELO) {
  console.log(`\n  El ajuste NO cuadra (error ${maxErr.toExponential(2)} > ${SUELO}). La calibracion de`);
  console.log('  produccion no era un Platt puro, o los coeficientes no eran identicos.');
  console.log('  NO se escribe nada.');
  process.exit(1);
}
console.log(`  dentro del suelo de precision (${SUELO}): la reconstruccion es exacta`);
console.log(`  hasta donde el redondeo a 6 decimales de la tabla lo permite.`);

// Tabla de 200 puntos en el mismo formato que el candidato, para que interp()
// la consuma igual. Se redondea a 6 decimales como el exportador de Python.
const N = 200;
const x = [], y = [];
for (let i = 0; i < N; i++) {
  const xi = i / (N - 1);
  x.push(Number(xi.toFixed(6)));
  const yi = xi <= 0 ? 0 : xi >= 1 ? 1 : sigmoid(a * logit(xi) + b);
  y.push(Number(yi.toFixed(6)));
}

const modelo = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'model_candidate.json'), 'utf8'));
modelo.calibration = { x, y };
modelo.trained_at = '2026-08-28T17:05:21.192797+00:00';   // el de produccion
modelo.recovered_at = new Date().toISOString();
modelo.recovered_note = 'calibration reconstruida por scripts/recuperar-calibracion-model.js tras el incidente del 2026-09-04; coef/sport_coef vienen de model_candidate.json y son identicos a los de produccion';

if (escribir) {
  fs.writeFileSync(MODEL_PATH, JSON.stringify(modelo, null, 1));
  console.log(`\nESCRITO ${MODEL_PATH} (${fs.statSync(MODEL_PATH).size} bytes)`);
} else {
  console.log('\nSIMULACION. Vuelve a correrlo con --write para escribir model.json.');
}
