/**
 * src/betlink.js
 * ─────────────────────────────────────────────────────────────
 * Deep link a un evento de Playdoit:
 *   https://www.playdoit.mx/#page=event&eventId={eventId}&sportId={sportId}
 *
 * Es un fragmento hash, se resuelve del lado del cliente. El betslip no viaja
 * en el URL, asi que el enlace llega a nivel EVENTO, no a nivel seleccion:
 * quien recibe la alerta elige la seleccion a mano. Es deliberado — el ultimo
 * clic lo da una persona.
 *
 * NO HAY RAMA AUTENTICADA. Hubo una que hacia POST a AddBetCode con la cookie
 * de sesion (PLAYDOIT_COOKIE) para generar un shareCode de un clic. Se quito el
 * 2026-09-03 por tres razones:
 *   1. Estaba muerta: PLAYDOIT_COOKIE no estaba definida.
 *   2. Estaba muerta dos veces: leia p.odd_id / p.selection_id, y la tabla
 *      `picks` no persiste ningun id de seleccion — normalize.js guarda NOMBRES
 *      de mercado y seleccion, no ids. No podia dispararse desde un pick.
 *   3. Era un arma cargada: bastaba con rellenar una variable de entorno para
 *      que el bot empezara a hacer peticiones autenticadas con la cookie de la
 *      cuenta, sin ningun otro cambio de codigo.
 * Si algun dia hace falta, que vuelva con un interruptor explicito y con los
 * ids de seleccion realmente persistidos, no adivinados.
 */
const { db } = require('./db');

const BASE = 'https://www.playdoit.mx/';

// EL sportId NO VIVE EN `picks`. La tabla guarda `event_id` y `sport` (el
// nombre), pero no `sport_id`, y el deep link lo necesita. La version anterior
// resolvia esto con `|| 66` — el id de Futbol — asi que todo pick de tenis,
// beisbol o baloncesto salia con un enlace al deporte equivocado. Hay 25
// deportes distintos en el feed.
//
// `snapshots` SI guarda sport_id, y todo pick emitido viene de un snapshot de
// su evento, asi que la busqueda acierta salvo que la retencion ya haya podado
// el evento. Se cachea porque un ciclo de alertas repite eventos.
const cacheSport = new Map();

function sportIdDeEvento(eventId) {
  if (eventId == null) return null;
  if (cacheSport.has(eventId)) return cacheSport.get(eventId);
  let id = null;
  try {
    const row = db.prepare(
      'SELECT sport_id FROM snapshots WHERE event_id = ? AND sport_id IS NOT NULL LIMIT 1'
    ).get(eventId);
    id = row ? row.sport_id : null;
  } catch { /* BD ocupada: se devuelve null y el enlace sale sin sportId */ }
  if (id != null) cacheSport.set(eventId, id);
  return id;
}

/**
 * URL del evento para una alerta.
 *
 * @param {Object} p pick u oportunidad; acepta snake_case y camelCase
 * @returns {string} URL lista para clic
 */
function generateBetLink(p) {
  const eventId = p.event_id ?? p.eventId;
  if (eventId == null) return BASE;

  const sportId = p.sport_id ?? p.sportId ?? sportIdDeEvento(eventId);

  // Sin sportId se emite el enlace igual, solo con eventId. Es preferible a
  // inventarse un deporte: un id equivocado abre otra cosa, y uno ausente deja
  // que el router resuelva lo que pueda.
  return sportId == null
    ? `${BASE}#page=event&eventId=${eventId}`
    : `${BASE}#page=event&eventId=${eventId}&sportId=${sportId}`;
}

module.exports = { generateBetLink };
