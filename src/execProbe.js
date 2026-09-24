// Nivel 0 de "apuesta directa": mide, SIN apostar nada, si un pick seguiria
// siendo ejecutable unos segundos despues de emitirlo. Tras la emision se vuelve
// a leer el overview del deporte a +10/+30/+60 s y se guarda la cuota que tenia
// la misma seleccion y si seguia abierta. Solo lectura del feed publico, sin
// credenciales, y no toca picks ni modelo.
//
// POR QUE EXISTE: el analisis historico del 2026-09-17 sobre snapshots (1/min)
// dio disponibilidad 86.6% a ~20-80 s y ROI ejecutable ~ igual al de emision,
// pero con resolucion demasiado gruesa y sin ver el desfase real. Esto lo mide
// con retraso conocido.
const { fetchSportLive } = require('./fetcher');
const { normalize } = require('./normalize');

const DELAYS_S = [10, 30, 60];
// Un solo fetch por deporte sirve a todos los picks que sondean casi a la vez
// (el modelo emite en tandas del mismo ciclo).
const CACHE_MS = 3000;
const cache = new Map(); // sportId -> { t, promesa }

function overviewDeporte(sportId, sportName) {
  const hit = cache.get(sportId);
  if (hit && Date.now() - hit.t < CACHE_MS) return hit.promesa;
  const promesa = fetchSportLive({ id: sportId, name: sportName }).then(res => normalize([res]));
  cache.set(sportId, { t: Date.now(), promesa });
  // Si falla, no dejar la promesa rota cacheada.
  promesa.catch(() => { if (cache.get(sportId)?.promesa === promesa) cache.delete(sportId); });
  return promesa;
}

// Puro (testeable): estado de un pick dentro de las filas normalizadas.
//  ok   = la seleccion existe y esta activa
//  susp = existe pero suspendida
//  gone = el evento o la seleccion ya no estan en el overview
function buscarEstado(rows, item) {
  const delEvento = rows.filter(r => r.eventId === item.eventId);
  if (!delEvento.length) return { status: 'gone', oddSeen: null, scoreSeen: null };
  const r = delEvento.find(x => x.market === item.market && x.selection === item.selection);
  if (!r) return { status: 'gone', oddSeen: null, scoreSeen: delEvento[0].score || null };
  return {
    status: r.suspended ? 'susp' : 'ok',
    oddSeen: r.oddDecimal,
    scoreSeen: r.score || null,
  };
}

/**
 * @param {'heur'|'model'} source
 * @param {Array<{pickId:number, eventId:number, sportId:number, sport:string,
 *                market:string, selection:string, oddDecimal:number}>} items
 * @param {(row:object)=>void} guardar  persistencia (saveExecProbe)
 */
function programar(source, items, guardar) {
  const emitMs = Date.now();
  const emitTs = new Date(emitMs).toISOString();
  for (const item of items) {
    if (!item.pickId || item.sportId == null) continue;
    for (const delayS of DELAYS_S) {
      const t = setTimeout(async () => {
        const base = {
          source, pickId: item.pickId, delayS, emitTs,
          probeTs: null, realDelayMs: null, oddEmit: item.oddDecimal,
          oddSeen: null, status: 'error', scoreSeen: null,
        };
        try {
          const rows = await overviewDeporte(item.sportId, item.sport);
          const est = buscarEstado(rows, item);
          Object.assign(base, { status: est.status, oddSeen: est.oddSeen, scoreSeen: est.scoreSeen });
        } catch (e) {
          // status 'error' se guarda: distinguir "no pudimos mirar" de "ya no estaba".
        }
        const ahora = Date.now();
        base.probeTs = new Date(ahora).toISOString();
        base.realDelayMs = ahora - emitMs;
        try { guardar(base); } catch (e) { console.error('[execProbe]', e.message); }
      }, delayS * 1000);
      t.unref(); // un sondeo pendiente no debe impedir que el proceso termine
    }
  }
}

module.exports = { programar, buscarEstado, DELAYS_S };
