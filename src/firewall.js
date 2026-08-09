/**
 * Firewall de jugadas — filtro duro que corre DESPUÉS del scoring y ANTES de
 * emitir a Telegram / registrar el pick.
 *
 * No sustituye a MIN_CONF/MIN_EDGE ni al veto por mercado que ya vive en
 * confidence.js: se suma a ellos. La diferencia es el origen de las reglas —
 * cada una sale de un bucket con ROI negativo medido sobre los picks
 * liquidados, y validado FUERA DE MUESTRA con corte temporal (entreno
 * 2026-07-17 → 08-06, prueba 08-06 → 08-09, sin mirar el periodo de prueba al
 * derivar los umbrales):
 *
 *   sin firewall  N=683  WR=62.8%  ROI= -3.5%
 *   CON firewall  N=593  WR=65.1%  ROI= -1.0%   (retiene 87% del volumen)
 *   bloqueadas    N= 90  WR=47.8%  ROI=-19.7%
 *
 * Esas cifras EXCLUYEN los picks de `source='global_draw'`: el scanner los
 * inserta directo en la BD sin pasar por rankPicks, así que el firewall nunca
 * los ve y contarlos inflaba el resultado. Ver la nota de R6 más abajo.
 *
 * Honestidad sobre lo que hace: el firewall QUITA DAÑO, no crea edge. Pasa de
 * perdedor a break-even. No existe configuración que dé 100% de aciertos — el
 * techo medido en el subconjunto más selectivo (partido casi terminado) es
 * ~80-84% WR.
 *
 * OJO con f_avance: hay DOS columnas y no significan lo mismo.
 *   - `f_avance`       = `progress` CRUDO. Es sobre esta que se derivaron las
 *                        reglas de aquí, así que el firewall usa `r.progress`.
 *   - `f_avance_model` = el valor transformado que consume el modelo (para un
 *                        Over con la línea sin alcanzar, `1 - progress`). Es el
 *                        que se exporta al dataset desde 2026-08-09.
 * No cambiar este módulo a `fAvance`/`f_avance_model` sin rederivar los
 * umbrales: son escalas distintas y R2 dejaría de significar lo que mide.
 *
 * Todo es configurable por .env y reversible: FIREWALL_ENABLED=false lo apaga
 * entero y el bot vuelve exactamente al comportamiento anterior.
 */

const num = (v, d) => (v === undefined || v === '' ? d : Number(v));
const bool = (v, d) => (v === undefined || v === '' ? d : String(v).toLowerCase() === 'true');

const deaccent = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// "Más de X" (Over). Se apoya en marketType cuando scoreRow ya lo calculó, y
// cae al texto de la selección si el pick viene de otra ruta.
function isOver(r) {
  const sel = deaccent(r.selection);
  if (!/^mas de/.test(sel)) return false;
  return r.marketType === undefined || r.marketType === null || r.marketType === 'total';
}

function config() {
  return {
    enabled: bool(process.env.FIREWALL_ENABLED, true),
    blockOvers: bool(process.env.FIREWALL_BLOCK_OVERS, true),
    minAvance: num(process.env.FIREWALL_MIN_AVANCE, 0.40),
    maxOdds: num(process.env.FIREWALL_MAX_ODDS, 3.0),
    // R4 y R6 nacen DESACTIVADAS (0). No es un descuido: ver sus notas abajo.
    minOdds: num(process.env.FIREWALL_MIN_ODDS, 0),
    maxSituacion: num(process.env.FIREWALL_MAX_SITUACION, 0.99),
    maxLinea: num(process.env.FIREWALL_MAX_LINEA, 0),
    // Tier ELITE: el único subconjunto que quedó POSITIVO fuera de muestra
    // (Under + avance>=0.75 + linea>=0.55 → N=37, WR 75.7%, ROI +11.8%).
    // N chico: es una marca orientativa, no una recomendación de stake.
    eliteMinAvance: num(process.env.FIREWALL_ELITE_MIN_AVANCE, 0.75),
    eliteMinLinea: num(process.env.FIREWALL_ELITE_MIN_LINEA, 0.55),
    eliteUnderOnly: bool(process.env.FIREWALL_ELITE_UNDER_ONLY, true),
  };
}

/**
 * Evalúa un pick ya puntuado (salida de scoreRow mezclada con la fila).
 * Devuelve { blocked, rules } — `rules` lista TODAS las que dispararon, para
 * poder auditar por qué se bloqueó sin tener que reproducir el estado.
 *
 * Un umbral desactivado (0 en los mínimos, 0 en los máximos) apaga su regla,
 * igual que MIN_EDGE=0 apaga el filtro de edge.
 */
function firewallVerdict(r) {
  const c = config();
  if (!c.enabled) return { blocked: false, rules: [] };

  const rules = [];
  const over = isOver(r);

  // R1 — Over ("Más de"): N=131, WR 45.8%, ROI -26.4% en el histórico, y pierde
  // en TODOS los tramos de avance. Fuera de muestra: N=86, WR 46.5%, ROI -22.1%.
  if (c.blockOvers && over) rules.push('R1:over');

  // R2 — el tiempo juega en contra: N=91, WR 47.3%, ROI -18.9%.
  // Fuera de muestra: N=86, WR 46.5%, ROI -22.1%. OJO: fuera de muestra bloquea
  // exactamente el mismo conjunto que R1 (son Overs tardíos); las dos reglas
  // están muy solapadas y su aporte no es aditivo.
  if (c.minAvance > 0 && r.progress != null && r.progress < c.minAvance) rules.push('R2:avance');

  // R3 — momio alto. INERTE en la práctica: rankPicks ya acota a maxOdds=3, así
  // que nunca dispara (N=0 sobre picks reales). Se deja como red de seguridad
  // por si algún día se sube ese techo. Sin evidencia propia a favor ni en contra.
  if (c.maxOdds > 0 && r.oddDecimal > c.maxOdds) rules.push('R3:odd_alto');

  // R4 — momio bajo. DESACTIVADA por defecto. La derivé de un ROI -1.4% que
  // resultó ser un artefacto de mezclar los picks del scanner (features
  // hardcodeadas) con los reales. Sobre picks reales la banda <1.30 rinde
  // N=67, WR 91.0%, ROI +8.9% — o sea POSITIVO, lo contrario de lo que creía.
  // Además rankPicks ya impone MIN_ODDS=1.35, así que tampoco alcanzaría.
  if (c.minOdds > 0 && r.oddDecimal < c.minOdds) rules.push('R4:odd_bajo');

  // R5 — situación "perfecta": N=146, WR 55.5%, ROI -12.4%. El evaluador de
  // totales devuelve 1.0 cuando la línea aún no se cruzó, o sea "todavía puede
  // pasar", y el scoring lo lee como "va a pasar". Falso positivo sistemático.
  if (c.maxSituacion > 0 && r.scoreFactor != null && r.scoreFactor >= c.maxSituacion) rules.push('R5:situacion');

  // R6 — DESACTIVADA por defecto. Parecía "steam extremo" (N=388, ROI -3.8%),
  // pero era un ESPEJISMO: globalDrawScanner.ts inserta sus picks con features
  // HARDCODEADAS (f_prob_justa=0.72, f_avance=0.85, f_situacion=0.75,
  // f_linea=0.82, conf=0.76 — una única combinación para las 184 filas). Como
  // 0.82 >= 0.80, R6 capturaba el 100% de esos picks y lo que medía era "el
  // scanner rinde mal", no un fenómeno de mercado. Fuera de muestra bloqueaba
  // 184 picks, TODOS del scanner, y CERO con features reales.
  // Sobre picks reales, f_linea >= 0.80 rinde N=128, WR 72.7%, ROI +2.3%:
  // activarla bloquearía un bucket GANADOR. No reactivar sin rederivar.
  if (c.maxLinea > 0 && r.lineFactor != null && r.lineFactor >= c.maxLinea) rules.push('R6:linea');

  return { blocked: rules.length > 0, rules };
}

const isFirewallBlocked = r => firewallVerdict(r).blocked;

/** true si el pick, además de pasar el firewall, cae en el tier ELITE. */
function isElite(r) {
  const c = config();
  if (!c.enabled) return false;
  if (firewallVerdict(r).blocked) return false;
  if (c.eliteUnderOnly && !(r.marketType === 'total' && /^menos de/.test(deaccent(r.selection)))) return false;
  if (r.progress == null || r.progress < c.eliteMinAvance) return false;
  if (r.lineFactor == null || r.lineFactor < c.eliteMinLinea) return false;
  return true;
}

module.exports = { firewallVerdict, isFirewallBlocked, isElite, isOver, config };
