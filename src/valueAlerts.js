// ALERTAS DE VALOR — logica pura (filtro, formato, dedupe).
//
// QUE HACE. Mira los picks que el heuristico YA emitio, se queda con los que
// caen en la banda de valor medida, y manda uno a Telegram. No coloca apuestas:
// el ultimo clic es manual, a proposito.
//
// POR QUE LEE `picks` Y NO EL FEED. El bot ya descarga el feed y ya puntua; que
// este modulo recalculara su propio edge duplicaria confidence.js y las dos
// copias divergirian en silencio a la primera vez que alguien tocara una. Al
// consumir picks emitidos desaparecen ademas el poller del feed, el backoff por
// 429 y el User-Agent propio: aqui no se le pega a Altenar.
//
// POR QUE PROCESO APARTE. El bucle de alertas que ya existe vive dentro del
// callback de server.listen de dashboardApi.ts, asi que solo corre mientras el
// panel este vivo — y el panel es proceso hijo del bot, o sea que cada reinicio
// se lo lleva. Este modulo corre por su cuenta (scripts/alertas-valor.js).
//
// ─────────────────────────────────────────────────────────────────────────────
// DE DONDE SALEN LOS UMBRALES. Medidos sobre 3.554 picks liquidados, 49 dias:
//
//   todo lo emitido             +3.94%  [1.7,  6.2]   72.5/dia
//   Under                       +7.80%  [4.6, 11.0]   32.5/dia
//   Under + Futbol              +7.44%  [4.2, 10.7]   32.0/dia
//   Under + Futbol + edge 3-8%  +9.48%  [4.1, 14.8]   10.8/dia  <- la elegida
//   Under + Futbol + edge >=8%  +4.62%  [-1.5, 10.7]  11.3/dia
//
// EL EDGE ES UNA BANDA, NO UN PISO, y eso es lo contraintuitivo: subir el piso
// EMPEORA (>=3% +3.74%, >=5% +3.22%, >=7% +2.34%, >=10% +1.75%, >=15% +0.53%) y
// la cola alta pierde dinero (>=20%: -3.89%, WR 53.5%, n=318). Un edge enorme
// significa que el modelo discrepa mucho del mercado, y de media el mercado
// tiene razon. Concuerda con lo ya sabido: la magnitud del edge no ordena.
//
// SESGO QUE HAY QUE TENER PRESENTE: ese +9.48% se eligio sobre la MISMA muestra
// que lo produjo, entre unas seis combinaciones. Esta inflado. Por eso las
// alertas se etiquetan y se miden aparte desde el primer dia, en vez de darse
// por buenas.
// ─────────────────────────────────────────────────────────────────────────────
const { generateBetLink } = require('./betlink');

const num = (v, def) => (v === undefined || v === '' ? def : Number(v));

function config(env = process.env) {
  return {
    edgeMin: num(env.ALERTA_EDGE_MIN, 0.03),
    edgeMax: num(env.ALERTA_EDGE_MAX, 0.08),
    soloUnder: /^(1|true|on|si|sí)$/i.test(env.ALERTA_SOLO_UNDER ?? '1'),
    deportes: (env.ALERTA_DEPORTES ?? 'Fútbol').split(',').map(s => s.trim()).filter(Boolean),
    intervaloSeg: num(env.ALERTA_INTERVALO_SEG, 60),
    // Techo de edad del pick. Sin el, el primer arranque encontraria MILES de
    // picks historicos sin alertar y los mandaria todos de golpe.
    maxEdadMin: num(env.ALERTA_MAX_EDAD_MIN, 20),
    maxPorCiclo: num(env.ALERTA_MAX_POR_CICLO, 5),
  };
}

// Normaliza para comparar sin depender de acentos: el feed manda "Más" y "Mas".
const sinAcentos = (s) => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

const esUnder = (pick) => /^menos\s+de\b/.test(sinAcentos(pick.selection));

/**
 * ¿Este pick merece alerta? Devuelve null si pasa, o el motivo del descarte.
 * Se devuelve el MOTIVO y no un booleano para que --dry-run pueda explicar por
 * que se descarto cada pick; depurar un filtro mudo es innecesariamente dificil.
 */
function motivoDescarte(pick, cfg) {
  if (pick.edge == null) return 'sin edge';
  if (pick.edge < cfg.edgeMin) return `edge ${(100 * pick.edge).toFixed(1)}% < ${(100 * cfg.edgeMin).toFixed(0)}%`;
  if (pick.edge >= cfg.edgeMax) return `edge ${(100 * pick.edge).toFixed(1)}% >= ${(100 * cfg.edgeMax).toFixed(0)}% (la cola alta pierde)`;
  if (cfg.soloUnder && !esUnder(pick)) return 'no es Under';
  if (cfg.deportes.length && !cfg.deportes.includes(pick.sport)) return `deporte fuera de la lista (${pick.sport})`;
  return null;
}

const esCandidato = (pick, cfg) => motivoDescarte(pick, cfg) === null;

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Mensaje de alerta, en HTML de Telegram.
 *
 * Pensado para leerse de un vistazo en el movil: evento primero, luego la
 * apuesta, luego las tres cifras que deciden, y el enlace al final. El valor
 * justo se muestra como CUOTA (1/conf) y no como probabilidad, porque es lo
 * comparable de un golpe de vista con el precio de la casa.
 */
function formatearAlerta(pick, { link } = {}) {
  const url = link ?? generateBetLink(pick);
  const cuota = Number(pick.odd_decimal);
  const conf = Number(pick.conf);
  const justa = conf > 0 ? 1 / conf : null;
  const edgePct = 100 * Number(pick.edge);

  const estado = [
    pick.score ? `${esc(pick.score)}` : null,
    pick.minute != null ? `${pick.minute}'` : null,
  ].filter(Boolean).join(' · ');

  return [
    '💡 <b>Valor detectado</b>',
    '',
    `<b>${esc(pick.event)}</b>`,
    `${esc(pick.selection)} — <i>${esc(pick.market)}</i>`,
    '',
    `Casa <b>${cuota.toFixed(2)}</b> · Justo <b>${justa ? justa.toFixed(2) : '—'}</b> · Edge <b>+${edgePct.toFixed(1)}%</b>`,
    estado ? `⏱ ${estado}` : null,
    '',
    `<a href="${esc(url)}">Abrir en Playdoit</a>`,
  ].filter(l => l !== null).join('\n');
}

module.exports = { config, esCandidato, motivoDescarte, formatearAlerta, esUnder };
