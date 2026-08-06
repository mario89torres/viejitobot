/**
 * src/betlink.js
 * ─────────────────────────────────────────────────────────────
 * Generador de enlaces para Playdoit:
 *   1. Deep Link por evento (Default / Sin login):
 *      https://www.playdoit.mx/#/sport/${sportId}/event/${eventId}
 *   2. ShareCode 1-Click Bet (Si existe PLAYDOIT_COOKIE en .env):
 *      POST a Altenar API -> https://www.playdoit.mx?shareCode=${code}
 * ─────────────────────────────────────────────────────────────
 */

const BASE = 'https://sb2frontend-altenar2.biahosted.com/api/widget';
const COMMON = 'culture=es-ES&timezoneOffset=360&integration=playdoit2&deviceType=1&numFormat=en-GB&countryCode=MX';

/**
 * Genera la URL para apostar en Playdoit.
 * @param {Object} p - Pick u oportunidad (event_id, sport_id, odd_id)
 * @returns {Promise<string>} URL lista para clic
 */
async function generateBetLink(p) {
  const cookie = process.env.PLAYDOIT_COOKIE;
  const oddId = p.odd_id || p.oddId || p.selection_id;

  // Opción 2 (Opcional): Si hay cookie de sesión, generar shareCode 1-Click Bet
  if (cookie && oddId) {
    try {
      const res = await fetch(`${BASE}/AddBetCode?${COMMON}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Cookie': cookie,
          'Referer': 'https://www.playdoit.mx/',
          'Origin': 'https://www.playdoit.mx',
          'integration': 'playdoit2',
        },
        body: JSON.stringify({ odds: [oddId] })
      });
      if (res.ok) {
        const data = await res.json();
        const code = data.code || data.shareCode || data.betCode;
        if (code) {
          return `https://www.playdoit.mx?shareCode=${code}`;
        }
      }
    } catch (e) {
      console.warn(`[betlink] Falló generación de shareCode con cookie: ${e.message}`);
    }
  }

  // Opción 1 (Default): Deep Link directo al evento en vivo de Playdoit
  const eventId = p.event_id || p.eventId;
  const sportId = p.sport_id || p.sportId || 66;

  if (eventId) {
    return `https://www.playdoit.mx/#/sport/${sportId}/event/${eventId}`;
  }

  return 'https://www.playdoit.mx/';
}

module.exports = { generateBetLink };
