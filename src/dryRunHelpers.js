// src/dryRunHelpers.js
// Helpers puros del dry-run de apuesta (sin Playwright, sin BD), separados de
// dryRunBetslip.js para poder probarlos: importar aquel módulo abre la BD real y Chrome.
//
//   - Frenos anti-apuesta: esTextoDeConfirmacion, areaExcesiva (antes del clic) y
//     esPeticionDeApuesta (en la red, con patrones de las rutas reales del SDK de Altenar).
//     Son a propósito INCLUSIVOS: un falso positivo solo rompe el dry-run; un falso
//     negativo puede costar dinero.
//   - decimalToAmerican / americanToDecimal / parsearCuota: el sitio muestra cuotas
//     AMERICANAS (+350, -184).
//   - latenciaDesdeEmision: ms desde que se emitió el pick.
'use strict';

const RE_TEXTO_CONFIRMACION =
  /\b(apostar|apuesta\s+ahora|confirmar|confirma|realizar\s+(la\s+)?apuesta|colocar|place\s*bet|confirm)\b/i;

// Rutas reales del SDK de Altenar (placeWidget, placeToto, PayBetImmediate, cancelBet,
// processPendingBet, widgetCashout, SkinConfig/SetUser*) + patrones genéricos.
// WidgetAuth/SignIn se sacó de aquí (medido 2026-09-27): iniciar sesión no es una acción
// financiera y el usuario lo hace a mano en abrir-perfil.js; bloquearlo impedía loguearse
// del todo (el POST del login nunca llegaba al servidor, la sesión nunca se completaba).
const RE_ENDPOINT_APUESTA =
  /(\/widget\/place(widget|toto)|\/aamsapi\/bet\/paybetimmediate|\/widgetbetoperations\/(cancelbet|processpendingbet|widgetcashout)|widgetcashout|\/skinconfig\/setuser|place[-_/]?(bet|coupon|wager|toto|widget)|submit[-_/]?(bet|coupon|wager)|confirm[-_/]?(bet|coupon)|make[-_/]?bet|wager|checkout|apuesta)/i;

const METODOS_SEGUROS = new Set(['GET', 'HEAD', 'OPTIONS']);

// Un botón de cuota mide ~150x50 px (7.5k px²). Por encima es un contenedor y su centro
// puede caer sobre otro botón.
const AREA_MAXIMA_PX2 = 60_000;

function esTextoDeConfirmacion(texto) {
  return RE_TEXTO_CONFIRMACION.test(String(texto || ''));
}

// Cualquier método que escribe (no GET/HEAD/OPTIONS) hacia un endpoint de apuesta.
function esPeticionDeApuesta({ method, url } = {}) {
  if (METODOS_SEGUROS.has(String(method || 'GET').toUpperCase())) return false;
  return RE_ENDPOINT_APUESTA.test(String(url || ''));
}

function areaExcesiva(bbox, max = AREA_MAXIMA_PX2) {
  if (!bbox || !(bbox.width > 0) || !(bbox.height > 0)) return true;
  return bbox.width * bbox.height > max;
}

// ms desde la emisión del pick; null si la fecha es inválida o futura.
function latenciaDesdeEmision(emitTs, ahoraMs = Date.now()) {
  const t = Date.parse(emitTs);
  if (!Number.isFinite(t)) return null;
  const d = ahoraMs - t;
  return d < 0 ? null : Math.round(d);
}

function decimalToAmerican(dec) {
  if (!dec || dec <= 1) return null;
  if (dec >= 2.0) return '+' + Math.round((dec - 1) * 100);
  return String(Math.round(-100 / (dec - 1)));
}

function americanToDecimal(a) {
  const n = Number(a);
  if (!Number.isFinite(n) || Math.abs(n) < 100) return null;
  return n > 0 ? 1 + n / 100 : 1 + 100 / -n;
}

// Americana con signo (+350, -184) o decimal (1,85 / 1.85). Lo ambiguo devuelve null.
function parsearCuota(texto) {
  // Signo menos unicode (U+2212, guiones tipográficos) y espacios raros -> ASCII.
  const t = String(texto || '').replace(/[−‐-―]/g, '-').trim().replace(/[\s ​]+/g, '');
  if (/^[+-]\d{3,4}$/.test(t)) return americanToDecimal(t);
  const d = t.replace(',', '.');
  if (/^\d+(\.\d+)?$/.test(d)) { const n = Number(d); return n >= 1.01 && n <= 100 ? n : null; }
  return null;
}

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Regex exacto (sin mayúsculas) de la etiqueta de una selección: "Menos de 3.5" no casa "Menos de 13.5".
function regexEtiqueta(seleccion) {
  const t = String(seleccion || '').replace(/\s+/g, ' ').trim();
  return new RegExp(`^\\s*${escapeRegex(t).replace(/ /g, '\\s+')}\\s*$`, 'i');
}

module.exports = {
  RE_ENDPOINT_APUESTA, AREA_MAXIMA_PX2,
  esTextoDeConfirmacion, esPeticionDeApuesta, areaExcesiva, latenciaDesdeEmision,
  decimalToAmerican, americanToDecimal, parsearCuota, regexEtiqueta,
};