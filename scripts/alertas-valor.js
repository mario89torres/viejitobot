#!/usr/bin/env node
// ALERTAS DE VALOR — proceso propio.
//
//   node scripts/alertas-valor.js              # envia a Telegram
//   node scripts/alertas-valor.js --dry-run    # imprime a stdout, no envia
//   node scripts/alertas-valor.js --una-vez    # un ciclo y sale
//
// NO COLOCA APUESTAS. Alerta; el ultimo clic es de una persona.
//
// PROCESO APARTE Y NO DENTRO DEL BOT NI DEL PANEL, por dos razones. El bucle de
// alertas que ya existe cuelga del server.listen de dashboardApi.ts, asi que
// muere con el panel — y el panel es hijo del bot, o sea que cada reinicio se lo
// lleva. Y el ciclo del sampler es el camino critico que emite: no conviene
// colgarle nada mas.
//
// Ver src/valueAlerts.js para de donde salen los umbrales.
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { getPicksSinAlertar, marcarAlertado, getEstadoEvento } = require('../src/db');
const { config, motivoDescarte, formatearAlerta } = require('../src/valueAlerts');
const { sendTelegram } = require('../src/telegram');

const DRY = process.argv.includes('--dry-run');
const UNA_VEZ = process.argv.includes('--una-vez');
const cfg = config();

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT = process.env.ALERTA_CHAT_ID || process.env.TELEGRAM_CHAT_ID;

if (!DRY && (!TOKEN || !CHAT)) {
  console.error('[alertas] falta TELEGRAM_BOT_TOKEN o TELEGRAM_CHAT_ID. Usa --dry-run para probar sin enviar.');
  process.exit(1);
}

const log = (...a) => console.log(`[alertas ${new Date().toISOString()}]`, ...a);

// Dedupe en memoria SOLO para --dry-run, que no toca la BD (ver el comentario
// del ciclo). En modo real el dedupe vive en la tabla value_alerts y sobrevive
// a los reinicios.
const vistosEnSeco = new Set();

async function ciclo() {
  const desde = new Date(Date.now() - cfg.maxEdadMin * 60000).toISOString();
  const candidatos = getPicksSinAlertar(desde);

  let enviadas = 0;
  const descartes = [];
  for (const p of candidatos) {
    if (DRY && vistosEnSeco.has(p.id)) continue;
    const motivo = motivoDescarte(p, cfg);
    if (motivo) { descartes.push(`#${p.id} ${motivo}`); continue; }
    if (enviadas >= cfg.maxPorCiclo) {
      log(`tope de ${cfg.maxPorCiclo} alertas por ciclo alcanzado; el resto espera al siguiente`);
      break;
    }

    // Estado en vivo desde snapshots: el formateador es puro y no consulta nada,
    // asi que el enriquecido va aqui.
    const est = getEstadoEvento(p.event_id);
    const minuto = est && est.live_time ? Number((String(est.live_time).match(/(\d+)/) || [])[1]) : null;
    const texto = formatearAlerta({ ...p, score: est && est.score, minute: Number.isFinite(minuto) ? minuto : null });
    // EL DRY-RUN NO ESCRIBE EN LA BD. Si marcara, previsualizar quemaria los
    // picks y luego el modo real se quedaria callado sobre justo lo que acabas
    // de ver — el fallo silencioso mas facil de no notar. Para que aun asi no se
    // repita dentro de una misma sesion en bucle, se lleva un set en memoria.
    //
    // En modo real SE MARCA ANTES DE ENVIAR: ante un fallo a mitad es preferible
    // perder una alerta que repetirla en el chat, que es el mismo criterio que
    // ya usa el bucle de dashboardApi.ts.
    if (DRY) vistosEnSeco.add(p.id); else marcarAlertado(p, false);
    if (DRY) {
      console.log('\n' + '─'.repeat(60));
      console.log(texto.replace(/<[^>]+>/g, ''));
    } else {
      await sendTelegram(TOKEN, CHAT, texto);
    }
    enviadas++;
  }

  if (enviadas || descartes.length) {
    log(`${candidatos.length} picks nuevos · ${enviadas} alertas${DRY ? ' (dry-run)' : ''}` +
        (descartes.length ? ` · ${descartes.length} descartados` : ''));
    if (DRY && descartes.length) for (const d of descartes) console.log('   descartado', d);
  }
  return enviadas;
}

async function bucle() {
  try {
    await ciclo();
  } catch (e) {
    // Que un ciclo falle no puede tumbar el proceso: se loguea y se reintenta al
    // siguiente. La causa tipica aqui es la BD bloqueada por el bot escribiendo.
    console.error('[alertas] ciclo fallido:', e.message);
  }
}

(async () => {
  log(`arrancado${DRY ? ' en DRY-RUN' : ''} · edge [${(100 * cfg.edgeMin).toFixed(0)}%, ${(100 * cfg.edgeMax).toFixed(0)}%)` +
      ` · ${cfg.soloUnder ? 'solo Under' : 'cualquier lado'} · deportes: ${cfg.deportes.join(', ') || 'todos'}` +
      ` · cada ${cfg.intervaloSeg}s`);
  await bucle();
  if (UNA_VEZ) process.exit(0);
  setInterval(bucle, cfg.intervaloSeg * 1000);
})();
