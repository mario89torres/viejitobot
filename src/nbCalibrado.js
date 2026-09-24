// CALIBRACION del NB de corners contra los finales REALES de FotMob.
//
// El NB original (matchStats.js) tiene dos supuestos que los datos de FotMob
// desmintieron (medido el 2026-09-19 sobre 214 partidos, ver
// scripts/entrenar-nb-fotmob.js):
//
//  1. NIVEL. El prior mu=12.985 salio de un ajuste con 90% de datos censurados
//     de playdoit; el promedio real de FotMob es ~9.8 corners por partido y la
//     dispersion es MENOR de lo que se creia (r~22, no ~7).
//  2. TIEMPO. Asume que los corners llegan de forma uniforme y que el partido
//     dura exactamente 90'. En la realidad la intensidad sube hacia el final y
//     ~15% de los corners caen despues del '90 nominal (descuento): en los
//     minutos 65-85 caen 1.6x mas corners de los que el modelo esperaba, y a
//     partir del '90 el modelo daba "under ganado con certeza" (restan=0).
//
// Este modulo carga lo que entrena scripts/entrenar-nb-fotmob.js
// (fotmob_nb.json): { mu, r, nudos, F } donde F(t) es la fraccion esperada del
// total de corners ya ocurrida al minuto t (perfil de intensidad, monotono,
// medido en reloj de FotMob). El posterior Gamma-Poisson se conserva, solo que
// el "tiempo" que se consume es F(t) en vez de t/90:
//
//    lo que falta ~ NB( (r+c)(1-F(t)) / (r/mu + F(t)),  r+c )
//
// que con F(t)=t/90 es EXACTAMENTE la formula anterior.
//
// OPT-IN: STATS_NB_CALIBRADO=on y que exista el archivo. Sin eso todo el
// sistema se comporta como antes (y los tests de borde originales siguen
// valiendo).
const fs = require('fs');
const path = require('path');

const FILE = () => process.env.NB_CALIBRADO_FILE || path.join(__dirname, '..', 'fotmob_nb.json');

function numDe(v) {
  if (v == null) return null;
  if (typeof v === 'number') return v;
  const m = String(v).match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : null;
}

// Minuto de reloj desde el estado de FotMob: "46’", "45+2’" (=47), "HT" (=45).
// null para lo que no es minuto de juego (FT, programado, textos de otra fuente).
function minutoDeStatus(status) {
  if (status == null) return null;
  const s = String(status);
  if (/^\s*HT\s*$/i.test(s)) return 45;
  const m = s.match(/(\d+)(?:\s*\+\s*(\d+))?/);
  if (!m) return null;
  return Number(m[1]) + (m[2] ? Number(m[2]) : 0);
}

function valido(p) {
  return p && p.mu > 0 && p.r > 0 && Array.isArray(p.nudos) && Array.isArray(p.F)
    && p.nudos.length === p.F.length && p.nudos.length >= 3
    && p.nudos[0] === 0 && p.F[0] === 0
    && p.F.every((x, i) => x >= 0 && x <= 1 && (i === 0 || x >= p.F[i - 1]));
}

let cache = { file: null, mtime: 0, cal: null };
function cargar() {
  const file = FILE();
  try {
    const st = fs.statSync(file);
    if (cache.file === file && cache.mtime === st.mtimeMs) return cache.cal;
    const p = JSON.parse(fs.readFileSync(file, 'utf8'));
    cache = { file, mtime: st.mtimeMs, cal: valido(p) ? p : null };
    if (!cache.cal) console.error(`[nb-calibrado] ${file} no es valido; se ignora`);
    return cache.cal;
  } catch {
    cache = { file, mtime: 0, cal: null };
    return null;
  }
}

/** Calibracion vigente, o null (modo off, sin archivo, o archivo invalido). */
function vigente() {
  if (String(process.env.STATS_NB_CALIBRADO || 'off').toLowerCase() !== 'on') return null;
  return cargar();
}

/** Fraccion esperada del total ya ocurrida al minuto t: interpolacion lineal, 1 pasado el ultimo nudo. */
function fraccion(cal, t) {
  const { nudos, F } = cal;
  if (t <= 0) return 0;
  const ult = nudos.length - 1;
  if (t >= nudos[ult]) return 1;
  for (let i = 1; i <= ult; i++) {
    if (t <= nudos[i]) {
      const w = (t - nudos[i - 1]) / (nudos[i] - nudos[i - 1]);
      return F[i - 1] + w * (F[i] - F[i - 1]);
    }
  }
  return 1;
}

module.exports = { numDe, minutoDeStatus, vigente, cargar, fraccion, valido };
