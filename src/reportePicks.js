// Datos del reporte "Unidades Hoy" en imagen 9:16 (una por modelo). PURO: sin BD ni
// red — bot.js hace las consultas y esto arma el JSON que dibuja
// scripts/render-estado-sistema.py (el mismo renderizador de tablas del arranque).
//
// MINUTO EN QUE MURIO UN PICK. La columna picks.loss_minute la lleno una sola vez
// un script (scripts/populate_loss_minutes.js): 296 de 1,374 perdidos la tienen, y
// los de hoy no. Aqui se calcula al dibujar, con el historial de marcadores del
// evento en `snapshots`. Solo dos mercados se pueden dar por perdidos ANTES del
// final: totales (un "Menos de X" muere al pasar la linea) y "ambos anotan: No"
// (muere cuando anotan los dos) — es decidedResult() de src/markets.js. Para el
// resto (ganador, handicap...) el pick solo muere al pitido final, y se muestra "FT".
const { decidedResult, parsePick } = require('./markets');

const MAX_FILAS_DEFECTO = 25; // filas por imagen; con el texto envuelto cada fila ocupa 1-3 lineas

/** Minuto de un live_time de Altenar: "91' — 2ª parte" -> 91. null si no se puede leer. */
function parseMinuto(liveTime) {
  const m = String(liveTime || '').match(/^\s*(\d{1,3})'/);
  return m ? Number(m[1]) : null;
}

/**
 * ¿En que minuto murio un pick perdido? `muestras`: [{ score, live_time }] en orden
 * de tiempo, desde el momento del pick. Devuelve
 *   { minuto, tipo }  con tipo:
 *     'exacto' — primer marcador visto en que el pick ya era irrecuperable
 *     'aprox'  — mercado decidible por marcador pero el feed dejo de verlo antes del
 *                gol decisivo: se da el ultimo minuto visto (el gol fue despues)
 *     'final'  — mercado que solo se decide al pitido final (FT)
 *   o null si el pick no esta perdido.
 */
function minutoDeMuerte(pick, muestras) {
  if (!pick || pick.result !== 'loss') return null;
  const parsed = parsePick(pick);
  const decidible = !!parsed && (parsed.type === 'total' || parsed.type === 'btts');
  if (!decidible) return { minuto: null, tipo: 'final' };
  let ultimo = null;
  for (const s of muestras || []) {
    const min = parseMinuto(s.live_time);
    if (min != null) ultimo = min;
    if (decidedResult(pick, s.score) === 'loss') {
      return min != null ? { minuto: min, tipo: 'exacto' } : { minuto: ultimo, tipo: 'aprox' };
    }
  }
  return ultimo != null ? { minuto: ultimo, tipo: 'aprox' } : { minuto: null, tipo: 'final' };
}

/** Celda de la columna "Murio": '67\'' / '~85\'' / 'FT' / '—' (gano). */
function celdaMuerte(pick, muerte) {
  if (pick.result !== 'loss') return { t: '—' };
  if (!muerte || muerte.tipo === 'final' || muerte.minuto == null) return { t: 'FT', tone: 'bad' };
  return { t: `${muerte.tipo === 'aprox' ? '~' : ''}${muerte.minuto}'`, tone: 'bad' };
}

/** Recorta un nombre a `max` caracteres con puntos suspensivos. */
function acortar(txt, max) {
  const s = String(txt || '').replace(/\s+/g, ' ').trim();
  return s.length <= max ? s : s.slice(0, Math.max(max - 1, 1)).trimEnd() + '…';
}

/** "Universidad Nacional Sub-21 vs. Club America Sub-21" -> "Universidad N… v Club Ameri…". */
function acortarPartido(evento, maxPorEquipo = 13) {
  const t = String(evento || '').split(/\s+vs\.?\s+|\s+@\s+/i);
  if (t.length < 2) return acortar(evento, maxPorEquipo * 2 + 3);
  return `${acortar(t[0], maxPorEquipo)} v ${acortar(t[1], maxPorEquipo)}`;
}

/** "Menos de 2.5" -> "Menos 2.5"; "Mas de 3.5" -> "Mas 3.5"; otros: la seleccion, recortada a `max`. */
function abreviarSeleccion(seleccion, max = 13) {
  return acortar(String(seleccion || '').replace(/^(m[aá]s|menos)\s+de\s+/i, '$1 '), max);
}

const numero = (x, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : '—');
const signo = (x, d = 2) => `${x >= 0 ? '+' : ''}${x.toFixed(d)}`;

// Alto de una imagen 9:16 medido con scripts/render-estado-sistema.py (2026-09-25, 9 columnas,
// nombres de partido de hasta 4 lineas): con encabezado y 6 KPIs, `filas + 2 por seccion <= 21`
// cabe sin pasar de la letra minima de 16 px. Por encima el renderizador omite filas (hasta 4).
const UNIDADES_PAGINA = 21;
const COSTO_SECCION = 2;

const COLUMNAS = [
  { name: 'Hora', w: 0.085 }, { name: 'Partido', w: 0.21 }, { name: 'Pick', w: 0.185 },
  { name: 'Edge', w: 0.075, align: 'right' }, { name: 'Al pick', w: 0.115, align: 'center' },
  { name: 'Final', w: 0.07, align: 'center' }, { name: 'Result.', w: 0.105, align: 'center' },
  { name: 'P/L', w: 0.075, align: 'right' }, { name: 'Murió', w: 0.08, align: 'center' },
];

/** "1-0 · 48'" : marcador y minuto al momento del pick; lo que falte se omite; '—' si no hay nada. */
function celdaAlPick(p) {
  const marc = p.marcadorPick ? String(p.marcadorPick).trim() : '';
  const min = p.minutoPick != null ? `${p.minutoPickAprox ? '~' : ''}${p.minutoPick}'` : '';
  return [marc, min].filter(Boolean).join(' · ') || '—';
}

function filaPick(p) {
  return [
    p.hora,
    String(p.event || '').replace(/\s+/g, ' ').trim(),
    `${String(p.selection || '').replace(/\s+/g, ' ').trim()} @${numero(p.odd_decimal, 2)}`,
    p.edge != null ? numero(p.edge * 100, 1) : '—',
    celdaAlPick(p),
    p.final_score ? String(p.final_score).trim() : '—',
    { t: p.result === 'win' ? 'WIN' : 'LOSS', tone: p.result === 'win' ? 'ok' : 'bad', pill: true },
    { t: signo(p.pl), tone: p.pl >= 0 ? 'ok' : 'bad' },
    celdaMuerte(p, p.muerte),
  ];
}

/**
 * Bloques del reporte: un bloque por (mercado, ganados|perdidos). Los mercados van
 * de mayor a menor numero de picks (empate: por nombre) y, dentro de cada mercado,
 * primero los ganados y despues los perdidos. Dentro de un bloque, por hora.
 * Se ordena por mercado y no por horario a pedido del usuario (2026-09-25).
 */
function agruparPorMercado(picks) {
  const porMercado = new Map();
  for (const p of picks) {
    const m = String(p.market || '').replace(/\s+/g, ' ').trim() || 'Sin mercado';
    if (!porMercado.has(m)) porMercado.set(m, []);
    porMercado.get(m).push(p);
  }
  const bloques = [];
  const orden = [...porMercado.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0], 'es'));
  for (const [mercado, ps] of orden) {
    const porTs = (a, b) => String(a.ts).localeCompare(String(b.ts));
    for (const resultado of ['win', 'loss']) {
      const g = ps.filter(p => p.result === resultado).sort(porTs);
      if (!g.length) continue;
      bloques.push({ mercado, resultado, picks: g, pl: g.reduce((t, p) => t + (p.pl || 0), 0) });
    }
  }
  return bloques;
}

/**
 * Arma los JSON del renderizador 9:16: UNA imagen por pagina de `porPagina` filas
 * (25 por defecto), para que se lea sin achicar la letra.
 *  picks: TODOS los liquidados de hoy, cada uno con
 *    { ts, hora, event, market, selection, odd_decimal, edge, result, pl, final_score?,
 *      marcadorPick?, minutoPick?, muerte? }
 *    (`muerte` = resultado de minutoDeMuerte; `minutoPick` en minutos o null).
 *  resumen: { n, wins, pl, apostado, roi, pendientes, emitidos } sobre lo de hoy;
 *    `emitidos` = TODO lo que emitio el modelo hoy (liquidado, en juego y otros).
 * Un bloque que no cabe en la pagina sigue en la siguiente, con "(cont.)". `porPagina` es
 * el tope de filas; el alto real lo acota ademas UNIDADES_PAGINA (una pagina de una sola
 * seccion admite hasta 19 filas).
 */
function armarPaginas({ subtitulo, extra, fecha, hora, picks, resumen, porPagina = MAX_FILAS_DEFECTO, notaPie = '' }) {
  const perdidos = resumen.n - resumen.wins;
  const wr = resumen.n ? (100 * resumen.wins / resumen.n) : null;
  const kpis = [
    { label: 'Emitidos', value: String(resumen.emitidos ?? resumen.n + (resumen.pendientes || 0)) },
    { label: 'Ganados', value: String(resumen.wins), tone: resumen.wins ? 'ok' : null },
    { label: 'Perdidos', value: String(perdidos), tone: perdidos ? 'bad' : null },
    { label: 'Aciertos', value: wr == null ? '—' : `${wr.toFixed(0)}%`, tone: wr == null ? null : wr >= 60 ? 'ok' : 'warn' },
    { label: 'P/L', value: `${signo(resumen.pl, 1)}u`, tone: resumen.pl > 0 ? 'ok' : resumen.pl < 0 ? 'bad' : null },
    { label: 'ROI', value: resumen.roi == null ? '—' : `${signo(resumen.roi, 1)}%`, tone: resumen.roi == null ? null : resumen.roi > 0 ? 'ok' : resumen.roi < 0 ? 'bad' : null },
  ];
  const enJuego = resumen.pendientes ? ` · ${resumen.pendientes} en juego` : '';

  // Pagina a pagina. Dos topes: `porPagina` filas y el PRESUPUESTO de alto de la imagen
  // (filas + COSTO_SECCION por seccion, ver UNIDADES_PAGINA). Sin el segundo, el renderizador
  // quitaba filas EN SILENCIO cuando no cabian ni a 16 px.
  const paginas = [[]];
  const uso = () => {
    const pag = paginas[paginas.length - 1];
    return { filas: pag.reduce((n, x) => n + x.trozo.length, 0), secciones: pag.length };
  };
  for (const b of agruparPorMercado(picks)) {
    let resto = b.picks;
    let cont = false;
    while (resto.length) {
      let u = uso();
      let libres = Math.min(porPagina - u.filas, UNIDADES_PAGINA - u.filas - COSTO_SECCION * (u.secciones + 1));
      if (libres < 3 && u.secciones) { // no vale la pena abrir una seccion de 1-2 filas: pagina nueva
        paginas.push([]);
        u = uso();
        libres = Math.min(porPagina, UNIDADES_PAGINA - COSTO_SECCION);
      }
      const trozo = resto.slice(0, Math.max(libres, 1));
      resto = resto.slice(trozo.length);
      paginas[paginas.length - 1].push({ b, trozo, cont });
      cont = true;
    }
  }

  return paginas.map((pag, i) => {
    const sections = pag.map(({ b, trozo, cont }) => ({
      wrap: true, // el texto se envuelve en varias lineas: nada se recorta con '...'
      title: `${b.mercado} · ${b.resultado === 'win' ? 'Ganados' : 'Perdidos'} (${b.picks.length}) · ${signo(b.pl, 1)}u${cont ? ' · cont.' : ''}`,
      title_tone: b.resultado === 'win' ? 'ok' : 'bad',
      columns: COLUMNAS,
      rows: trozo.map(filaPick),
    }));
    if (!sections.length) {
      sections.push({ wrap: true, title: `Picks liquidados hoy${enJuego}`, columns: COLUMNAS, rows: [['—', 'Sin picks liquidados hoy', '', '', '', '', '', '', '']] });
    }
    const pagTxt = paginas.length > 1 ? `Pág ${i + 1}/${paginas.length}` : '';
    return {
      tam_max: 22, // 8 columnas: a 26 px (el tope por defecto) no caben partido y pick sin recortarse
      header: { titulo: 'VIEJITOBOT', subtitulo, fecha, hora, zona: 'CDMX', extra: [extra, pagTxt].filter(Boolean).join(' · ') },
      kpis,
      sections,
      footer: [pagTxt, `Ordenado por mercado · ganados y perdidos por separado${enJuego}`, notaPie].filter(Boolean).join(' · '),
    };
  });
}

module.exports = { parseMinuto, minutoDeMuerte, celdaMuerte, acortar, acortarPartido, abreviarSeleccion, armarPaginas, agruparPorMercado, MAX_FILAS_DEFECTO, UNIDADES_PAGINA, COSTO_SECCION };
