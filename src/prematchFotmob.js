// Empareja un evento pre-partido de Playdoit (prematch_snapshots) contra el
// calendario de FotMob y trae su contexto (estadio, arbitro, forma reciente)
// — para el detalle que se ve al hacer clic en un partido del visor "Hoy"
// del dashboard. Solo lectura, bajo demanda (no corre en ningun ciclo).
const { db } = require('./db');
const { scheduledToday, fetchMatchFacts } = require('./fotmobScraper');
const { teamsMatch } = require('./teamMatch');

const TOLERANCIA_MS = 3 * 3600 * 1000; // +-3h: cubre diferencias de zona horaria en el listado de FotMob

async function datosFotmobDeEvento(eventId) {
  const ev = db.prepare(`
    SELECT event, start_date FROM prematch_snapshots WHERE event_id = ? ORDER BY ts DESC LIMIT 1
  `).get(eventId);
  if (!ev || !ev.start_date) return null;

  const partes = ev.event.split(/\s+vs\.?\s+/i);
  if (partes.length < 2) return null;
  const [home, away] = partes;
  const kickoff = Date.parse(ev.start_date);

  const dia = ev.start_date.slice(0, 10);
  const diaAnterior = new Date(kickoff - 24 * 3600 * 1000).toISOString().slice(0, 10);
  const diaSiguiente = new Date(kickoff + 24 * 3600 * 1000).toISOString().slice(0, 10);
  const dias = [...new Set([diaAnterior, dia, diaSiguiente])];

  const eventos = [];
  for (const d of dias) {
    try { eventos.push(...await scheduledToday(d)); } catch { /* un dia fallido no tumba los demas */ }
  }

  let mejor = null, mejorDist = Infinity;
  for (const e of eventos) {
    if (!e.home || !e.away || !e.commenceTime) continue;
    if (!teamsMatch(home, e.home) || !teamsMatch(away, e.away)) continue;
    const dist = Math.abs(Date.parse(e.commenceTime) - kickoff);
    if (dist < mejorDist) { mejorDist = dist; mejor = e; }
  }
  if (!mejor || mejorDist > TOLERANCIA_MS) return null;

  const facts = await fetchMatchFacts(mejor.id);
  return {
    fotmobEventId: mejor.id, fotmobHome: mejor.home, fotmobAway: mejor.away,
    fotmobCommenceTime: mejor.commenceTime, tournament: mejor.tournament,
    ...facts,
  };
}

module.exports = { datosFotmobDeEvento };
