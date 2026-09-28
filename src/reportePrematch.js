// Reporte pre-partido de las 08:00 (CDMX): valor, catalogo del dia y parlay.
// PURO: sin BD ni red — bot.js hace las consultas y esto arma los datos.
//
// LO QUE ESTO NO ES. No hay historial pre-partido: los 3,720 picks medidos del
// heuristico son en vivo. Medido ademas: el xG pre-partido ya esta en el precio
// (p=0.60 contra el mercado) y steam no tiene señal. Por eso:
//  - "Valor" solo se afirma donde hay lectura de una casa sharp (Pinnacle), via
//    prematch_value_scan. Sin lectura NO se inventa valor: se dice que falta.
//  - "Seguro" del parlay = probabilidad justa alta (cuota sin margen), NO un
//    record medido. Un parlay multiplica el margen de la casa en cada pata.
// El reporte se etiqueta asi para no vender algo sin validar a los suscriptores.
const { devig } = require('./devig');

const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const limpio = (s) => String(s || '').replace(/\s+/g, ' ').trim();

const M_1X2 = 'Resultado Final (Tiempo Regular)';
const M_DNB = 'Empate No Accion';
const M_DC = 'Doble oportunidad';
const M_BTTS = 'Ambos equipos marcan';
const esTotal = (m) => /^Total \d/.test(m);

// Ligas donde no hay informacion fiable de plantillas/rotaciones: fuera del parlay.
// Segunda linea (2026-09-28, tras el parlay Jamaica-Honduras/San Cristobal y Nieves-Granada/
// Santa Lucia-Bermuda/AD Cariari Pococi-Uruguay de Coronado, EV -23.9%): divisiones inferiores
// identificables por texto. El devig asume mercado eficiente; en ligas de poco volumen esa
// suposicion es la mas debil, y el filtro anterior (sub-XX, reservas, juvenil, femenil, amateur)
// no las tocaba.
// LIMITE CONOCIDO: esto NO excluye clasificatorios de confederaciones o selecciones nacionales
// debiles (el caso real de arriba: Jamaica, San Cristobal y Nieves, Santa Lucia son selecciones
// FIFA de primer nivel, no ligas menores). Detectarlo por texto sin una lista mantenida a mano
// daria falsa confianza; queda para revisar a ojo hasta que haya una fuente de fuerza de liga.
const RE_MENOR = /\bsub[- ]?\d|\bu-?\d{2}\b|reserv|juvenil|femen|\(f\)|\(w\)|amateur|liga iii|landesliga|tdp|segunda divisi[oó]n|tercera divisi[oó]n|liga de ascenso|primera [bc]\b|divisi[oó]n de ascenso|regional/i;
const esCategoriaMenor = (champ, event) => RE_MENOR.test(`${champ || ''} ${event || ''}`);

function equipos(evento) {
  const t = String(evento || '').split(/\s+vs\.?\s+|\s+@\s+/i);
  return t.length >= 2 ? [limpio(t[0]), limpio(t[1])] : [null, null];
}

/** Ultima cuota vista por (evento, mercado, seleccion) -> Map(eventId -> partido). */
function agruparPartidos(filas) {
  const m = new Map();
  for (const f of filas) {
    if (f.suspended || !(f.odd_decimal > 1)) continue;
    if (!m.has(f.event_id)) {
      m.set(f.event_id, { eventId: f.event_id, event: limpio(f.event), champ: f.champ, start: f.start_date, mercados: {} });
    }
    (m.get(f.event_id).mercados[f.market] ||= []).push({ sel: limpio(f.selection), odd: f.odd_decimal });
  }
  return m;
}

const tieneEquipo = (sel, equipo) => equipo && norm(sel).includes(norm(equipo));

/**
 * Patas con probabilidad justa (sin margen) de un partido. Formato:
 *  { eventId, event, champ, start, market, sel, odd, p }
 * 1X2, DNB, Total y Ambos marcan se des-marginan por mercado; Doble oportunidad
 * NO es una particion, asi que su p sale de sumar las p del 1X2 des-marginado.
 */
function patasDePartido(partido) {
  const patas = [];
  const base = { eventId: partido.eventId, event: partido.event, champ: partido.champ, start: partido.start };
  const [local, visita] = equipos(partido.event);
  const dev = (arr) => devig(arr.map(x => x.odd), 'proportional');

  const r1 = partido.mercados[M_1X2];
  let pLocal = null, pEmpate = null, pVisita = null;
  if (r1 && r1.length === 3) {
    const p = dev(r1);
    r1.forEach((x, i) => {
      patas.push({ ...base, market: M_1X2, sel: x.sel, odd: x.odd, p: p[i] });
      if (norm(x.sel) === 'empate') pEmpate = p[i];
      else if (tieneEquipo(x.sel, local) && !tieneEquipo(x.sel, visita)) pLocal = p[i];
      else if (tieneEquipo(x.sel, visita) && !tieneEquipo(x.sel, local)) pVisita = p[i];
    });
  }
  for (const [mkt, lista] of Object.entries(partido.mercados)) {
    if (mkt === M_DNB || mkt === M_BTTS || esTotal(mkt)) {
      if (lista.length !== 2) continue;
      const p = dev(lista);
      lista.forEach((x, i) => patas.push({ ...base, market: mkt, sel: x.sel, odd: x.odd, p: p[i] }));
    }
  }
  if (pLocal != null && pEmpate != null && pVisita != null) {
    for (const x of partido.mercados[M_DC] || []) {
      const s = norm(x.sel), l = tieneEquipo(x.sel, local), v = tieneEquipo(x.sel, visita), e = s.includes('empate');
      let p = null;
      if (l && e) p = pLocal + pEmpate; else if (v && e) p = pVisita + pEmpate; else if (l && v) p = pLocal + pVisita;
      if (p != null) patas.push({ ...base, market: M_DC, sel: x.sel, odd: x.odd, p });
    }
  }
  return patas;
}

/**
 * Parlay de 3-4 patas: las de mayor probabilidad justa, una por partido, sin
 * categorias menores ni cuotas tan cortas que no pagan nada, y con el partido
 * aun por empezar. Devuelve null si no hay al menos `min` patas que cumplan.
 */
function armarParlay(patas, { ahoraMs = Date.now(), min = 3, max = 4, pMin = 0.70, oddMin = 1.2, margenMin = 45 } = {}) {
  const elegibles = patas
    .filter(x => x.p >= pMin && x.odd >= oddMin && !esCategoriaMenor(x.champ, x.event)
      && Date.parse(x.start) >= ahoraMs + margenMin * 60000)
    .sort((a, b) => b.p * b.odd - a.p * a.odd || b.p - a.p); // de las seguras, las de menos margen: el margen se multiplica por pata
  const usados = new Set(), sel = [];
  for (const x of elegibles) {
    if (usados.has(x.eventId)) continue;
    usados.add(x.eventId); sel.push(x);
    if (sel.length === max) break;
  }
  if (sel.length < min) return null;
  const p = sel.reduce((a, x) => a * x.p, 1);
  const cuota = sel.reduce((a, x) => a * x.odd, 1);
  return { patas: sel, pConjunta: p, cuota, ev: p * cuota - 1 };
}

/**
 * Valor confirmado por casa sharp. `filasScan`: filas de prematch_value_scan
 * (la ultima lectura por evento/seleccion). Solo edge_pct > 0.
 */
function valorSharp(filasScan, { top = 10, minEdge = 1 } = {}) {
  const ult = new Map();
  for (const f of filasScan) {
    const k = `${f.event_id}|${f.market}|${f.selection}`;
    if (!ult.has(k) || ult.get(k).ts < f.ts) ult.set(k, f);
  }
  return [...ult.values()].filter(f => f.edge_pct >= minEdge).sort((a, b) => b.edge_pct - a.edge_pct).slice(0, top);
}

/** Las patas mas probables del dia (una por partido, sin categorias menores, aun por empezar). */
function topProbables(patas, { ahoraMs = Date.now(), n = 12, oddMin = 1.2, margenMin = 45 } = {}) {
  const vistos = new Set();
  return patas
    .filter(x => x.odd >= oddMin && !esCategoriaMenor(x.champ, x.event) && Date.parse(x.start) >= ahoraMs + margenMin * 60000)
    .sort((a, b) => b.p - a.p)
    .filter(x => (vistos.has(x.eventId) ? false : (vistos.add(x.eventId), true)))
    .slice(0, n);
}

const fmtHora = (iso, tz = 'America/Mexico_City') => new Date(iso).toLocaleTimeString('es-MX', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false });
const pct = (x, d = 0) => `${(100 * x).toFixed(d)}%`;
const abrev = (s, n) => (s.length <= n ? s : s.slice(0, n - 1).trimEnd() + '…');
const partidoCorto = (ev) => { const [l, v] = equipos(ev); return l ? `${abrev(l, 11)} v ${abrev(v, 11)}` : abrev(ev, 25); };
const selCorta = (sel, mkt) => (mkt === M_1X2 ? abrev(sel, 14) : abrev(`${sel.replace(/^(m[aá]s|menos) de /i, '$1 ')}`, 16));

/** JSON para scripts/render-estado-sistema.py (una sola imagen 9:16). */
function armarDatosImagen({ fecha, hora, valor, parlay, totalPartidos, top = [] }) {
  const secciones = [];
  secciones.push({
    title: 'Valor vs Pinnacle (mayor edge)',
    columns: [{ name: 'Hora', w: 0.09 }, { name: 'Partido', w: 0.37 }, { name: 'Pick', w: 0.24 },
      { name: 'Playdoit', w: 0.10, align: 'right' }, { name: 'Pinn.', w: 0.09, align: 'right' }, { name: 'Edge', w: 0.11, align: 'right' }],
    rows: valor.length
      ? valor.map(f => [fmtHora(f.start_date), partidoCorto(f.event), abrev(f.selection, 16),
        f.playdoit_odd.toFixed(2), f.sharp_odd.toFixed(2), { t: `+${f.edge_pct.toFixed(1)}%`, tone: 'ok' }])
      : [['—', 'Sin valor sharp hoy', '', '', '', '']],
  });
  secciones.push({
    title: parlay ? `Parlay de ${parlay.patas.length} patas (probabilidad justa alta)` : 'Parlay',
    columns: [{ name: 'Hora', w: 0.09 }, { name: 'Partido', w: 0.37 }, { name: 'Pick', w: 0.26 },
      { name: 'Cuota', w: 0.12, align: 'right' }, { name: 'P justa', w: 0.16, align: 'right' }],
    rows: parlay
      ? parlay.patas.map(x => [fmtHora(x.start), partidoCorto(x.event), selCorta(x.sel, x.market), x.odd.toFixed(2), pct(x.p)])
      : [['—', 'Hoy no hay 3 patas que cumplan los filtros', '', '', '']],
  });
  secciones.push({
    title: 'Más probables del día (prob. justa)',
    columns: [{ name: 'Hora', w: 0.09 }, { name: 'Partido', w: 0.37 }, { name: 'Pick', w: 0.26 },
      { name: 'Cuota', w: 0.12, align: 'right' }, { name: 'P justa', w: 0.16, align: 'right' }],
    rows: top.length ? top.map(x => [fmtHora(x.start), partidoCorto(x.event), selCorta(x.sel, x.market), x.odd.toFixed(2), pct(x.p)])
      : [['—', 'Sin partidos elegibles', '', '', '']],
  });
  return {
    tam_max: 24,
    header: { titulo: 'VIEJITOBOT', subtitulo: 'Pre-partido de hoy', fecha, hora, zona: 'CDMX', extra: `${totalPartidos} partidos con cuota` },
    kpis: parlay ? [
      { label: 'Cuota parlay', value: parlay.cuota.toFixed(2) },
      { label: 'P conjunta', value: pct(parlay.pConjunta), tone: parlay.pConjunta >= 0.5 ? 'ok' : 'warn' },
      { label: 'Valor esp.', value: `${parlay.ev >= 0 ? '+' : ''}${(100 * parlay.ev).toFixed(1)}%`, tone: parlay.ev >= 0 ? 'ok' : 'bad' },
      { label: 'Con valor sharp', value: String(valor.length) },
    ] : [{ label: 'Con valor sharp', value: String(valor.length) }],
    sections: secciones,
    footer: 'Sin historial pre-partido · "seguro" = prob. justa, no récord medido',
  };
}

const csvCelda = (v) => { const s = v == null ? '' : String(v); return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

/** CSV con todas las jugadas del dia: una fila por pata con cuota y probabilidad justa. */
function csvTodas(partidos) {
  const filas = [['hora_cdmx', 'liga', 'partido', 'mercado', 'seleccion', 'cuota', 'p_justa_pct', 'valor_esperado_pct']];
  const todos = [...partidos.values()].sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  for (const p of todos) {
    for (const x of patasDePartido(p).sort((a, b) => a.market.localeCompare(b.market) || b.p - a.p)) {
      filas.push([fmtHora(p.start), p.champ, p.event, x.market, x.sel, x.odd.toFixed(3), (100 * x.p).toFixed(1), (100 * (x.p * x.odd - 1)).toFixed(1)]);
    }
  }
  return '﻿' + filas.map(r => r.map(csvCelda).join(';')).join('\r\n') + '\r\n';
}

/** Texto (HTML de Telegram) que acompaña a la imagen. */
function leyenda({ valor, parlay }) {
  const l = ['📅 <b>Pre-partido de hoy</b>'];
  l.push(valor.length
    ? `💎 ${valor.length} con valor frente a Pinnacle (edge más alto +${valor[0].edge_pct.toFixed(1)}%).`
    : '💎 Ninguna lectura de Pinnacle con valor para hoy — no se inventa valor sin lectura sharp.');
  if (parlay) {
    l.push(`🎯 Parlay de ${parlay.patas.length} patas @${parlay.cuota.toFixed(2)} · probabilidad justa conjunta ${pct(parlay.pConjunta)}.`);
    l.push(`⚠️ Valor esperado ${(100 * parlay.ev).toFixed(1)}%: la casa cobra margen en cada pata.`);
  } else l.push('🎯 Hoy no hay 3 patas que cumplan los filtros de parlay.');
  l.push('<i>Contexto medido con cuotas, no garantía: aún no existe historial pre-partido propio.</i>');
  return l.join('\n');
}

/**
 * Resultado de una pata con el marcador final (gl = local, gv = visita), o null
 * si no se sabe leer. 'push' = DNB con empate (se devuelve la apuesta).
 */
function resolverPata({ market, selection, event }, gl, gv) {
  if (!Number.isInteger(gl) || !Number.isInteger(gv)) return null;
  const [local, visita] = equipos(event);
  const sel = norm(selection);
  const gana = (b) => (b ? 'win' : 'loss');
  if (market === M_1X2) {
    if (sel === 'empate') return gana(gl === gv);
    if (tieneEquipo(selection, local) && !tieneEquipo(selection, visita)) return gana(gl > gv);
    if (tieneEquipo(selection, visita) && !tieneEquipo(selection, local)) return gana(gv > gl);
    return null;
  }
  if (market === M_DNB) {
    if (gl === gv) return 'push';
    if (tieneEquipo(selection, local) && !tieneEquipo(selection, visita)) return gana(gl > gv);
    if (tieneEquipo(selection, visita) && !tieneEquipo(selection, local)) return gana(gv > gl);
    return null;
  }
  if (market === M_DC) {
    const l = tieneEquipo(selection, local), v = tieneEquipo(selection, visita), e = sel.includes('empate');
    if (l && e) return gana(gl >= gv);
    if (v && e) return gana(gv >= gl);
    if (l && v) return gana(gl !== gv);
    return null;
  }
  if (market === M_BTTS) {
    const ambos = gl > 0 && gv > 0;
    if (sel === 'si') return gana(ambos);
    if (sel === 'no') return gana(!ambos);
    return null;
  }
  const m = /^Total (\d+(?:\.\d+)?)$/.exec(market);
  if (m) {
    const linea = Number(m[1]), tot = gl + gv;
    if (/^mas/.test(sel)) return gana(tot > linea);
    if (/^menos/.test(sel)) return gana(tot < linea);
  }
  return null;
}

/**
 * Parlay de los partidos que estan por empezar: patas cuyo inicio cae entre `minMin` minutos
 * y `horas` horas a partir de ahora. Mismos filtros de seguridad que el parlay del reporte.
 */
function armarParlayProximos(patas, { ahoraMs = Date.now(), horas = 3, minMin = 10, ...opts } = {}) {
  const tope = ahoraMs + horas * 3600e3;
  const ventana = patas.filter(x => Date.parse(x.start) <= tope);
  return armarParlay(ventana, { ahoraMs, margenMin: minMin, ...opts });
}

const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Texto HTML de Telegram del parlay de proximos. `frescuraMin`: antiguedad de la ultima lectura de cuotas. */
function textoParlayProximos(parlay, { horas, partidos, frescuraMin }) {
  const NL = String.fromCharCode(10);
  const cab = `🎯 <b>Parlay de los próximos partidos</b> (inicio en las próximas ${horas} h · ${partidos} con cuota)`;
  const pie = [`<i>Cuotas leídas hace ${frescuraMin == null ? '?' : frescuraMin} min; pueden haber cambiado — confirma en Playdoit.</i>`,
    '<i>"Seguro" = probabilidad justa alta (cuota sin margen), no récord medido; aún no hay historial pre-partido propio.</i>'];
  if (!parlay) return [cab, 'No hay 3 patas que cumplan los filtros (prob. justa ≥ 70%, cuota ≥ 1.20, sin categorías menores) en esa ventana.', ...pie].join(NL);
  const l = [...parlay.patas].sort((a, b) => Date.parse(a.start) - Date.parse(b.start)).map((x, i) => `${i + 1}. ${fmtHora(x.start)} · ${esc(x.event)}${NL}   ${esc(x.sel)} <b>@${x.odd.toFixed(2)}</b> · p justa ${pct(x.p)}`);
  return [cab, '', ...l, '',
    `Cuota combinada <b>@${parlay.cuota.toFixed(2)}</b> · probabilidad justa conjunta ${pct(parlay.pConjunta)}`,
    `⚠️ Valor esperado ${(100 * parlay.ev).toFixed(1)}%: la casa cobra su margen en cada pata.`, '', ...pie].join(NL);
}

const TIPO_TXT = { parlay: 'Parlay', top: 'Top', valor: 'Valor' };

/**
 * Estado de las patas mostradas en reportes anteriores (tabla prematch_report_picks).
 * `filas` ya viene ordenado (dia desc). Devuelve KPIs y el resultado de cada parlay por dia:
 * LOSS si alguna pata perdio, pendiente si falta alguna, WIN si todas ganaron (los push salen del parlay).
 */
function resumenEstado(filas) {
  const liq = filas.filter(f => f.result);
  const dec = liq.filter(f => f.result === 'win' || f.result === 'loss');
  const wins = dec.filter(f => f.result === 'win').length;
  const parlays = [];
  const porDia = new Map();
  for (const f of filas.filter(x => x.kind === 'parlay')) { if (!porDia.has(f.dia)) porDia.set(f.dia, []); porDia.get(f.dia).push(f); }
  for (const [dia, patas] of porDia) {
    const vivas = patas.filter(x => x.result !== 'push');
    const estado = patas.some(x => x.result === 'loss') ? 'loss' : patas.some(x => !x.result) ? 'pendiente'
      : vivas.length ? 'win' : 'push';
    parlays.push({ dia, estado, cuota: vivas.reduce((a, x) => a * x.odd_decimal, 1), patas: patas.length });
  }
  return { total: filas.length, liquidadas: liq.length, pendientes: filas.length - liq.length, wins, decididas: dec.length, parlays };
}

const RES_CELDA = {
  win: { t: 'WIN', tone: 'ok', pill: true }, loss: { t: 'LOSS', tone: 'bad', pill: true },
  push: { t: 'PUSH', tone: 'warn', pill: true },
};

/**
 * Hora del encuentro en CDMX ("20:30"). Si el partido cae en otro dia que el del reporte
 * (patas de manana, o de madrugada) se antepone la fecha ("26/09 01:00") para no confundirlo.
 */
function horaEncuentro(f, tz = 'America/Mexico_City') {
  const t = Date.parse(f.start_date);
  if (!Number.isFinite(t)) return '—';
  const hora = fmtHora(f.start_date, tz);
  const diaPartido = new Date(t).toLocaleDateString('en-CA', { timeZone: tz });
  return f.dia && diaPartido !== f.dia ? `${diaPartido.slice(8, 10)}/${diaPartido.slice(5, 7)} ${hora}` : hora;
}

/** JSON 9:16 del estado de las patas de reportes anteriores (una tabla con el texto envuelto). */
function armarEstadoImagen({ fecha, hora, filas, maxFilas = 24 }) {
  const r = resumenEstado(filas);
  const vis = filas.slice(0, maxFilas);
  const p = r.parlays[0]; // el mas reciente
  const tonoParlay = !p ? null : p.estado === 'win' ? 'ok' : p.estado === 'loss' ? 'bad' : 'warn';
  const dd = (dia) => `${dia.slice(8, 10)}/${dia.slice(5, 7)}`;
  return {
    tam_max: 22,
    header: { titulo: 'VIEJITOBOT', subtitulo: 'Estado picks pre-partido', fecha, hora, zona: 'CDMX', extra: `${r.total} patas` },
    kpis: [
      { label: 'Liquidadas', value: `${r.liquidadas}/${r.total}` },
      { label: 'Aciertos', value: r.decididas ? pct(r.wins / r.decididas) : '—', tone: r.decididas ? (r.wins / r.decididas >= 0.6 ? 'ok' : 'warn') : null },
      { label: 'Pendientes', value: String(r.pendientes) },
      { label: p ? `Parlay ${dd(p.dia)}` : 'Parlay', value: p ? (p.estado === 'win' ? 'GANADO' : p.estado === 'loss' ? 'PERDIDO' : p.estado === 'push' ? 'PUSH' : 'EN JUEGO') : '—', tone: tonoParlay },
    ],
    sections: [{
      wrap: true,
      title: 'Picks pre-partido: resultado',
      columns: [{ name: 'Día', w: 0.08 }, { name: 'Hora', w: 0.08, align: 'center' }, { name: 'Partido', w: 0.24 }, { name: 'Pick', w: 0.23 },
        { name: 'Tipo', w: 0.08, align: 'center' }, { name: 'Cuota', w: 0.08, align: 'right' }, { name: 'Result.', w: 0.12, align: 'center' },
        { name: 'Marc.', w: 0.09, align: 'center' }],
      rows: vis.length ? vis.map(f => [dd(f.dia), horaEncuentro(f), limpio(f.event), limpio(f.selection), TIPO_TXT[f.kind] || f.kind, f.odd_decimal.toFixed(2),
        RES_CELDA[f.result] || { t: 'Pend.', tone: 'off' }, f.final_score || '—'])
        : [['—', '—', 'Aún no hay picks pre-partido guardados', '', '', '', '', '']],
    }],
    footer: filas.length > maxFilas ? `Se muestran ${maxFilas} de ${filas.length} · el resumen incluye todas` : 'WIN/LOSS con el marcador de tiempo regular',
  };
}

module.exports = { horaEncuentro, resumenEstado, armarEstadoImagen, armarParlayProximos, textoParlayProximos, resolverPata, topProbables, norm, equipos, agruparPartidos, patasDePartido, armarParlay, valorSharp, armarDatosImagen, csvTodas, leyenda, esCategoriaMenor, fmtHora };
