/**
 * Envía una demostración de los badges nuevos, para verlos como los ve el lector.
 *
 * SOLO al chat personal (TELEGRAM_CHAT_ID). NUNCA al canal VIP: ahí hay
 * suscriptores reales y un pick de demostración se leería como una jugada de
 * verdad. El id del canal ni se lee en este script, a propósito.
 *
 * Los textos replican los de bot.js. Si allí cambian, aquí hay que tocarlo — es
 * el precio de no exportar el constructor del mensaje solo para una demo, pero
 * las CIFRAS sí salen de la misma fuente viva (src/badgeStats.js), así que el
 * número nunca puede divergir del que se publica de verdad.
 *
 * Uso: node scripts/send-badge-demo.js
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const Database = require('better-sqlite3');
const { sendTelegram } = require('../src/telegram');
const { frase, estadisticas } = require('../src/badgeStats');

const TOKEN = process.env.TELEGRAM_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
const CHAT = process.env.TELEGRAM_CHAT_ID;
if (!TOKEN || !CHAT) { console.error('Falta TELEGRAM_TOKEN o TELEGRAM_CHAT_ID'); process.exit(1); }

const db = new Database(path.join(__dirname, '..', 'snapshots.db'), { readonly: true });
const esc = s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const pct = v => `${(100 * v).toFixed(0)}%`;

// Picks REALES para que los eventos y las cuotas se vean creíbles.
const reales = db.prepare(`
  SELECT id, event, sport, market, selection, odd_decimal, opening_odd_decimal,
         conf, edge, stake, f_avance
  FROM picks
  WHERE result IN ('win','loss') AND f_avance IS NOT NULL AND opening_odd_decimal IS NOT NULL
  ORDER BY ts DESC LIMIT 40
`).all();

const buscar = (fn, alt) => reales.find(fn) || alt || reales[0];
const conRecta = buscar(p => p.f_avance >= 0.90);
const conMov = buscar(p => p.opening_odd_decimal > 1 &&
  Math.abs(p.opening_odd_decimal - p.odd_decimal) / p.opening_odd_decimal >= 0.50);
const simple = buscar(p => p.f_avance < 0.90 &&
  Math.abs(p.opening_odd_decimal - p.odd_decimal) / p.opening_odd_decimal < 0.50);

/** Réplica del mensaje de bot.js. `badges` fuerza qué marcas mostrar. */
function pick(p, { recta = false, elite = false, mov = false } = {}) {
  let m = `${elite ? '🛡️ ' : ''}${recta ? '⏱️ ' : ''}⚽ <b>#${p.id}</b> · <b>${esc(p.event)}</b>`
        // Sin liga: la tabla `picks` no guarda `champ`, solo lo hace `snapshots`.
        + ` <i>(${esc(p.sport)})</i>\n`;
  m += `Marcador: 1-0 — ${Math.round((p.f_avance || 0.8) * 90)}'\n`;
  m += `${esc(p.market)}: 🎯 <b><u>${esc(p.selection)}</u></b> @ <b>${p.odd_decimal.toFixed(2)}</b>\n`;
  m += `Confianza: <b>${pct(p.conf)}</b> | Edge: <b>+${(100 * p.edge).toFixed(1)}%</b>`;
  m += p.stake != null ? ` | Unidad: <b>${p.stake.toFixed(1)}u</b>\n` : '\n';
  if (mov) {
    const bajo = p.odd_decimal < p.opening_odd_decimal;
    m += `<i>${bajo ? '📉' : '📈'} la cuota ${bajo ? 'bajó' : 'subió'} de `
       + `${p.opening_odd_decimal.toFixed(2)} a ${p.odd_decimal.toFixed(2)} desde que seguimos el partido</i>\n`;
  }
  if (recta) {
    const f = frase('rectaFinal');
    m += `<i>⏱️ recta final — ${(100 * (p.f_avance || 0.92)).toFixed(0)}% del partido jugado.`
       + `${f ? ` ${f}.` : ''} Contexto medido sobre nuestro histórico, no una garantía.</i>\n`;
  }
  if (elite) {
    const f = frase('elite');
    m += `<i>🛡️ tier ELITE del firewall — Under tardío con línea estable.`
       + `${f ? ` ${f}.` : ''} Marca orientativa, no una recomendación de stake.</i>\n`;
  }
  return m;
}

const s = estadisticas();
const mensajes = [
  '🧪 <b>DEMOSTRACIÓN DE LOS BADGES NUEVOS</b>\n\n'
  + '<i>No son jugadas reales y no hay que apostarlas. Solo llegan a este chat: '
  + 'el canal VIP no recibe nada de esto.</i>\n\n'
  + `Cifras calculadas sobre <b>${s.base.toLocaleString('es')}</b> picks liquidados propios, `
  + 'recalculadas cada 12 h.',

  '<b>1 · Pick sin marcas</b>\nEl caso base: ninguna condición se cumple.\n\n' + pick(simple),

  '<b>2 · Con ⏱️ recta final</b>\nEl partido va por el 90%+ .\n\n'
  + pick(conRecta, { recta: true }),

  '<b>3 · Con 🛡️ ELITE</b>\nUnder tardío con línea estable que pasa todo el firewall.\n\n'
  + pick(conRecta, { elite: true }),

  '<b>4 · Las tres a la vez</b>\nAsí se ve un pick que cumple todo.\n\n'
  + pick(conMov, { recta: true, elite: true, mov: true }),

  '🤖 <b>Picks del MODELO aprendido</b> — no apostados, solo registro\n'
  + '<i>2 registrados · 1 que el heurístico NO emitiría</i>\n\n'
  + `🤝 <b>${esc(conRecta.event)}</b> <i>(${esc(conRecta.sport)})</i>\n`
  + `${esc(conRecta.market)}: <b>${esc(conRecta.selection)}</b> @ <b>${conRecta.odd_decimal.toFixed(2)}</b>\n`
  + 'modelo <b>81%</b> · heurístico 74% · <i>ambos coinciden</i>\n\n'
  + `🤖 <b>${esc(simple.event)}</b> <i>(${esc(simple.sport)})</i>\n`
  + `${esc(simple.market)}: <b>${esc(simple.selection)}</b> @ <b>${simple.odd_decimal.toFixed(2)}</b>\n`
  + 'modelo <b>79%</b> · heurístico 66% · <i>solo el modelo</i>\n\n'
  + '<i>Estos SOLO llegan a este chat. El 🤖 marca jugadas de una población sin '
  + 'validar: no apostarlas.</i>',

  '<b>Lo que cambió</b>\n\n'
  + '🔥 <b>retirado</b> — prometía «+30% histórico» sacado de 15 picks, y no se disparaba nunca.\n\n'
  + '⏱️ <b>nuevo</b> — el segmento más fuerte medido.\n\n'
  + '🛡️ <b>actualizado</b> — antes citaba N=28; ahora la cifra se calcula sola.\n\n'
  + '📉 <b>nuevo</b> — hecho puro, sin pronóstico.\n\n'
  + '<i>Ninguna cifra va escrita en el código: todas se recalculan sobre el histórico completo.</i>',
];

(async () => {
  for (const [i, m] of mensajes.entries()) {
    try {
      await sendTelegram(TOKEN, CHAT, m);
      console.log(`  ${i + 1}/${mensajes.length} enviado`);
    } catch (e) {
      console.error(`  ${i + 1}/${mensajes.length} FALLÓ: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 700)); // no atragantar la API
  }
  console.log(`\n${mensajes.length} mensajes al chat ${CHAT}. Canal VIP: NO tocado.`);
})();
