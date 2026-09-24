// Emparejamiento playdoit <-> FotMob, sobre el mismo matcher que ya usa
// src/sharp.js contra The Odds API (ver src/teamMatch.js). No hay tabla de
// "indices de equipo" persistente a proposito: sharp.js demostro que
// fuzzy-match en vivo contra la lista del dia, cacheada en memoria, alcanza
// sin tener que mantener sincronizado un catalogo de nombres aparte.
//
// Reemplaza a src/sofaMatch.js (SofaScore, suspendido el 2026-09-14). El
// techo de match medido para esa fuente (~30-45%, ver historial abajo) se
// hereda como referencia inicial — no se ha vuelto a medir contra FotMob.
//
//  - Sub-19/Sub-20/Sub-21 (playdoit) vs U19/U20/U21 (fuente externa): ERA un
//    bug de notacion, arreglado en normalizeTeam (ver teamMatch.js).
//  - Reservas/filiales ("B", "Reserve"): MIXTO, decidido NO normalizar como
//    equivalentes (ver teamMatch.js para el detalle).
//  - Ligas regionales chicas: cobertura real, no bug — no todas las fuentes
//    las tienen.
const { matchEvent } = require('./teamMatch');
const { scheduledToday } = require('./fotmobScraper');

// Cache POR FECHA (no un solo dia): el barrido completo es una llamada a
// FotMob por dia (mucho mas barato que el de SofaScore, que costaba decenas
// de llamadas — ver fotmobScraper.js), pero sigue sin ser algo para repetir
// en cada ciclo del piloto. Antes era un solo slot atado a "hoy"
// (Date.now()), lo que rompia el emparejamiento para liquidaciones que
// corren ya entrada la madrugada UTC sobre un partido de "ayer": el barrido
// se pedia para la fecha EQUIVOCADA y el candidato correcto jamas podia
// aparecer, sin importar que tan bueno fuera el matcher de equipos/horario.
// Un Map con tope chico evita crecer sin limite en un proceso que vive dias.
const cache = new Map(); // fecha (YYYY-MM-DD) -> eventos

async function eventosDeHoy(fecha = new Date().toISOString().slice(0, 10)) {
  const cacheados = cache.get(fecha);
  if (cacheados && cacheados.length) return cacheados;
  const eventos = await scheduledToday(fecha);
  cache.set(fecha, eventos);
  if (cache.size > 5) cache.delete(cache.keys().next().value);
  return eventos;
}

/**
 * Empareja un evento de playdoit (formato { event: "EqA vs. EqB", ts, minute })
 * contra el barrido de FotMob del dia. Devuelve el evento de FotMob (con su
 * `id`) o null si no matchea nada.
 *
 * matchEvent espera candidatos con {home_team, away_team, commence_time}; el
 * barrido de FotMob usa otros nombres de campo, de ahi el adaptador.
 */
async function matchFotmobEvent(pick) {
  // Barrido de la fecha del PICK, no de "hoy": una liquidacion que corre ya
  // entrada la madrugada UTC sobre un partido que empezo el dia anterior
  // necesita el barrido de ESE dia, no el de hoy (ver comentario del cache
  // arriba). Sin pick.ts (p.ej. el comando /fotmob interactivo, que siempre
  // pregunta por partidos EN VIVO ahora mismo) se mantiene el default de hoy.
  const fecha = pick.ts ? new Date(pick.ts).toISOString().slice(0, 10) : undefined;
  const eventos = await eventosDeHoy(fecha);
  const candidatos = eventos.map(e => ({
    home_team: e.home, away_team: e.away, commence_time: e.commenceTime,
    _fotmob: e,
  }));
  // "now" explicito = pick.ts (ultima lectura real de playdoit), NO
  // Date.now(). El pase 2 de matchEvent exige que el partido siga "en vivo"
  // (< 8h desde el kickoff) contra ESE "now" — con el default (momento en
  // que se llama matchFotmobEvent) una liquidacion demorada horas despues
  // del final del partido saca al candidato de la ventana y lo deja sin
  // match, en silencio (sin error, sin log).
  const m = matchEvent(pick, candidatos, pick.ts ? Date.parse(pick.ts) : undefined);
  return m ? { fotmobEvent: m.ev._fotmob, swapped: m.swapped } : null;
}

module.exports = { matchFotmobEvent, eventosDeHoy, _internal: { cache: () => cache } };
