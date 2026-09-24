// PILOTO DE ESTADISTICAS DE PARTIDO — captura de solo lectura.
// (Antes src/corners.js; se generalizo al aniadir tarjetas.)
//
// QUE ES Y QUE NO ES. Esto muestrea mercados de TOTAL de estadisticas (corners,
// tarjetas) y los guarda con su etiqueta cuando el partido acaba. No puntua, no
// emite, no toca el firewall ni el modelo. Vive aparte a proposito: todo lo que
// el sistema sabe se derivo sobre GOLES, y nada de eso transfiere a un mercado
// nuevo. Primero se mide; decidir viene despues.
//
// POR QUE UN CAMINO APARTE. El bot consume GetLiveOverview (una llamada por
// DEPORTE) y ahi no vienen estos mercados. Estan solo en GetEventDetails, que es
// una llamada por PARTIDO.
//
// COBERTURA MEDIDA el 2026-08-29 sobre 30 partidos de futbol en vivo:
//   corners       5/30 (17%)
//   tarjetas      3/30 (10%)   <- subconjunto de los que traen corners
//   tiros a puerta  0/30       <- NO EXISTEN en este feed, ni con 168 mercados
//   faltas, fueras de juego: 0/30
// Las tarjetas salen gratis: mismo partido, misma llamada, mismo ciclo.
const { devig, defaultMethod } = require('./devig');
const nb = require('./negBinomial');
const nbCal = require('./nbCalibrado');

// Sello del formato de captura. Va en cada fila para que un analisis futuro no
// mezcle dos formatos sin avisar — la leccion de model_version, que se aprendio
// tarde y obligo a dejar en NULL todo lo anterior al sello.
// stats-2 (2026-08-30): el contador pasa de max a MIN y se deduplican los
// mercados. Las filas 'stats-1' llevan un `conteo` NO FIABLE — ver conteoInferido.
// stats-3 (2026-08-30): se aniade el scorer de Poisson en sombra (p_poisson).
// stats-4 (2026-09-10): el scorer en sombra pasa de Poisson a binomial
// negativa (probUnderNB) — mismas columnas p_poisson/lambda_poisson por no
// migrar el esquema para un scorer de solo lectura, pero de aqui en adelante
// llevan la probabilidad y la media de la NB, NO de Poisson. Comparar filas
// 'stats-3' contra 'stats-4' en esas columnas mezcla dos modelos distintos.
// stats-5 (2026-09-19): igual que stats-4 pero con el NB CALIBRADO contra los
// finales de FotMob (src/nbCalibrado.js: prior mu/r reajustado y perfil de
// intensidad por minuto). Solo se sella asi el p_poisson de las filas cuando
// STATS_NB_CALIBRADO=on; el resto de columnas no cambia (ver
// featureVersionScorer). Comparar p_poisson de 'stats-4' contra 'stats-5'
// mezcla dos calibraciones distintas del mismo modelo.
const FEATURE_VERSION = 'stats-4';
const FEATURE_VERSION_NB_CALIBRADO = 'stats-5';

// Las familias que se capturan. Solo se guardan los mercados con forma de TOTAL
// (los que tienen lado over/under); el resto del grupo — par/impar, 1x2,
// handicap, exactas, ventanas de tiempo — se ignora: la pregunta es la tendencia
// de over y under, y mezclarlos solo aniade ruido.
const FAMILIAS = [
  {
    nombre: 'corner',
    mercado: /tiros?\s+de\s+esquina/i,
    // CONTADOR. Los corners tienen mercado del N-esimo ("Septimo Tiros de
    // esquina 7"), y ese indice ES el conteo: si cotizan el 7o, han caido 6.
    // Verificado el 2026-08-29 en America-Puebla: al 54' el sexto, al 55' el
    // septimo. Es el unico canal, porque el feed no publica la estadistica y no
    // hay endpoint que la sirva (probados ocho nombres, todos 404).
    conteo: true,
  },
  {
    nombre: 'tarjeta',
    mercado: /tarjeta/i,
    // SIN CONTADOR. No existe mercado de "N-esima tarjeta". Hay "Tarjetas
    // exactas", pero el valor minimo ofrecido no es obviamente el conteo actual
    // (el 2026-08-29 era 4 tanto al minuto 52 como al 79 en partidos distintos),
    // asi que NO se infiere nada. Antes NULL que un numero inventado: es el
    // error que dejo inservibles los 184 picks de global_draw.
    conteo: false,
  },
];

// "Mas de 9.5" / "Menos de 9.5" -> { lado, linea }. El acento no es fiable en
// este feed (llegan "Más" y "Mas"), asi que se normaliza antes de comparar.
function parseSeleccion(nombre) {
  const n = (nombre || '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
  let m = n.match(/^mas\s+de\s+([\d.]+)$/i);
  if (m) return { lado: 'over', linea: Number(m[1]) };
  m = n.match(/^menos\s+de\s+([\d.]+)$/i);
  if (m) return { lado: 'under', linea: Number(m[1]) };
  return null;
}

/**
 * Conteo inferido del mercado del N-esimo, para las familias que lo tienen.
 *
 * Se distingue del resto por la forma del `sv`: el N-esimo lo trae como ENTERO
 * pelado ("7"), mientras que los totales lo traen con decimal ("8.5", "+1.5") y
 * las ventanas de tiempo con barras ("61:59|55:00"). Se excluyen los mercados de
 * mitad ("1a mitad - ...") porque cuentan sobre otro periodo y mezclarlos daria
 * un total del partido que no existe.
 *
 * Devuelve null si la casa no ofrece ese mercado, que es un estado normal y
 * frecuente — medir CUANTO se queda en null es parte de lo que valida el piloto.
 */
function conteoInferido(markets, familia) {
  if (!familia.conteo) return null;
  const idx = indicesNesimo(markets, familia);
  // EL MINIMO, NO EL MAXIMO. La casa mantiene abiertos VARIOS mercados de
  // N-esimo a la vez: Spartak Varna, en el minuto 4, ofrecia los indices
  // [1,2,3,4,5,7,9,11]. Los que ya cayeron se liquidan y desaparecen, asi que el
  // indice MAS BAJO todavia abierto es el proximo corner por caer, y N-1 los que
  // van. Tomar el maximo daba "10 corners en el minuto 2".
  //
  // Se comprobo antes con partidos de parrilla pobre, donde solo hay un indice
  // abierto y min == max, y de ahi salio la conclusion equivocada de que daba
  // igual cual usar. En parrilla rica no da igual: da un numero inventado.
  return idx.length ? idx[0] - 1 : null;
}

/**
 * Indices del mercado del N-esimo abiertos ahora, ordenados y sin repetidos.
 *
 * Se guardan CRUDOS junto al conteo derivado. La primera version solo guardaba
 * el escalar, y cuando se descubrio que la regla estaba mal no hubo forma de
 * recalcular el historico: habia que volver a muestrear partidos ya terminados.
 * Guardar la lista deja la puerta abierta a arreglar la regla en retroactivo,
 * que es justo lo que salvo a las etiquetas la vez anterior.
 */
function indicesNesimo(markets, familia) {
  if (!familia.conteo) return [];
  const vistos = new Set();
  for (const m of markets || []) {
    const nombre = m.name || '';
    if (!familia.mercado.test(nombre)) continue;
    if (/mitad|half/i.test(nombre)) continue;
    const sv = String(m.sv ?? '').trim();
    if (!/^\d+$/.test(sv)) continue;
    vistos.add(Number(sv));
  }
  return [...vistos].sort((a, b) => a - b);
}

// El mercado GLOBAL del partido, frente a los de equipo ("America Total de
// Tiros de Esquina") y los de mitad. La distincion no es cosmetica: el contador
// cuenta corners del PARTIDO, asi que aplicarselo a una linea por equipo o de
// media parte compara dos cosas distintas y da una probabilidad sin sentido.
const MERCADO_GLOBAL = /^total\s+(tiros?\s+de\s+esquina|de\s+tarjetas)/i;
const esMercadoGlobal = (nombre) => MERCADO_GLOBAL.test((nombre || '').trim());

// Duracion nominal del partido. El descuento se ignora a proposito: no lo
// publica el feed, y suponerlo aniadiria un parametro inventado a un modelo que
// existe precisamente por no tener ninguno.
const MINUTOS_PARTIDO = 90;

// Ritmo de llegada de corners, en corners por minuto. PROVISIONAL: 0.12 sale de
// ~11 corners por partido, que es el orden de magnitud de las primeras medidas
// propias (0.11 a 0.33 corners/min en ventanas cortas, n=7). Hay que re-medirlo
// con datos stats-2 en cuanto haya una semana, y es casi seguro que varia por
// liga. Se deja configurable para poder barrerlo sin tocar codigo.
const LAMBDA_CORNER = Number(process.env.STATS_LAMBDA_CORNER || 0.12);

/**
 * Probabilidad de que el UNDER gane, segun el proceso de llegada.
 *
 * POR QUE ESTO Y NO UN HEURISTICO AJUSTADO. Los corners son un proceso de
 * CONTEO; los goles no. El heuristico de goles tiene que inferir la "situacion"
 * del marcador con reglas hechas a mano, pero aqui, sabiendo el conteo y el
 * minuto, la linea base se DERIVA en vez de ajustarse: los que faltan se
 * reparten como un Poisson y el under gana si no pasan del colchon.
 *
 * Eso lo hace utilizable HOY, sin una sola etiqueta, que es justo el bloqueo del
 * piloto. Las etiquetas hacen falta para VALIDARLO, no para construirlo.
 *
 * El colchon usa floor(linea) y no la linea: con linea 9.5 y 7 corners, el under
 * aguanta hasta 9 en total, o sea 2 mas. Las lineas son siempre X.5, asi que no
 * hay empate posible.
 *
 * Devuelve null cuando falta cualquier ingrediente. Un null aqui es informacion
 * ("no se pudo puntuar"), y rellenarlo con 0.5 seria un dato fabricado.
 */
function probUnderPoisson(conteo, linea, minuto, lambda = LAMBDA_CORNER) {
  if (conteo == null || linea == null || minuto == null) return null;
  if (!(lambda > 0)) return null;
  const colchon = Math.floor(linea) - conteo;
  if (colchon < 0) return 0;                       // ya se paso: el under perdio
  const restan = Math.max(0, MINUTOS_PARTIDO - minuto);
  const media = lambda * restan;
  if (media === 0) return 1;                       // no queda tiempo: el under gano
  // P(X <= colchon) con X ~ Poisson(media), sumando termino a termino.
  let termino = Math.exp(-media);
  let acum = termino;
  for (let k = 1; k <= colchon; k++) {
    termino *= media / k;
    acum += termino;
  }
  return Math.min(1, Math.max(0, acum));
}

// Prior de la binomial negativa sobre el TOTAL de corners del partido,
// ajustado por MLE con verosimilitud CENSURADA sobre datos reales
// (scripts/entrenar-nb-corners.js, 2026-09-10): mu=12.985, r=7.335, n=179
// (90.5% censurados — pocos partidos con conteo exacto verificado). Likelihood
// ratio vs Poisson = 9.55 > 6.64 critico al 99%: se rechaza Poisson con
// margen real, no solo por el indice de dispersion crudo.
// PROVISIONAL, igual que LAMBDA_CORNER: re-medir en cuanto la fuente de
// FotMob (sin censura de mercado, ver enriquecerConFotmob en bot.js)
// acumule mas partidos liquidados sin depender de que la casa mantenga
// abierto el mercado hasta el final.
const STATS_NB_MU = Number(process.env.STATS_NB_MU || 12.985);
const STATS_NB_R = Number(process.env.STATS_NB_R || 7.335);

/**
 * Reemplaza a probUnderPoisson como scorer en sombra. Misma firma, misma
 * semantica (P(under) segun lo que falta del partido), pero con dos mejoras
 * sobre un Poisson de lambda fija:
 *
 *  1. SOBREDISPERSION. Los corners no son equidispersos (ver arriba, LR
 *     test). Un Poisson de lambda fija subestima la probabilidad de las
 *     colas: partidos muy abiertos o muy cerrados son mas frecuentes de lo
 *     que Poisson predice.
 *
 *  2. ACTUALIZACION BAYESIANA POR PARTIDO. Poisson con lambda fija trata
 *     TODO partido igual, ignorando lo que ya se esta viendo EN ESTE. Aqui
 *     el ritmo del partido (rho, corners/min) tiene un prior Gamma derivado
 *     del ajuste NB del total — rho ~ Gamma(r, r*MINUTOS_PARTIDO/mu), que
 *     por construccion hace que rho*MINUTOS_PARTIDO ~ NB(mu, r), el mismo
 *     ajuste de arriba. Al observar `conteo` corners en `minuto` minutos, el
 *     posterior de rho se actualiza por conjugacion Gamma-Poisson estandar
 *     (Gamma(alpha+conteo, beta+minuto)), y lo que falta del partido sale de
 *     esa posterior integrada — que es, por construccion, otra binomial
 *     negativa. Un partido con muchos corners tempranos EMPUJA hacia arriba
 *     la expectativa del resto del partido; Poisson con lambda fija no
 *     puede hacer eso — cada minuto es independiente del resto por diseño.
 *
 * Devuelve null en los mismos casos que probUnderPoisson (falta algun dato).
 */
/**
 * Posterior Gamma-Poisson de lo que falta del partido: dado `conteo` corners
 * en `minuto` minutos, devuelve { alphaPost, betaPost, muRestante, restan } —
 * lo que falta ~ NB(muRestante, alphaPost). Compartido entre probUnderNB y
 * cualquier consumidor que quiera solo la media (p.ej. un "esperados" para
 * mostrar sin tener que barrer todas las lineas).
 */
function posteriorNB(conteo, minuto, mu, r) {
  // Sin mu/r explicitos y con STATS_NB_CALIBRADO=on, usa la calibracion contra
  // FotMob (perfil de intensidad F(t) en vez de t/90; ver src/nbCalibrado.js).
  // Con mu/r explicitos (barridos, tests) siempre el modelo original.
  const cal = (mu === undefined && r === undefined) ? nbCal.vigente() : null;
  if (cal) {
    if (conteo == null || minuto == null) return null;
    const f = nbCal.fraccion(cal, minuto);
    const alphaPost = cal.r + conteo;
    const betaPost = cal.r / cal.mu + f;
    const restanFrac = 1 - f;
    const muRestante = restanFrac <= 0 ? 0 : alphaPost * restanFrac / betaPost;
    // `restan` en minutos EQUIVALENTES de juego (0 solo cuando F llego a 1),
    // para que "sin tiempo" siga significando restan === 0.
    return { alphaPost, betaPost, muRestante, restan: restanFrac <= 0 ? 0 : restanFrac * MINUTOS_PARTIDO };
  }
  if (mu === undefined) mu = STATS_NB_MU;
  if (r === undefined) r = STATS_NB_R;
  if (conteo == null || minuto == null || !(mu > 0) || !(r > 0)) return null;
  const restan = Math.max(0, MINUTOS_PARTIDO - minuto);
  const alpha = r;
  const beta = r * MINUTOS_PARTIDO / mu;
  const alphaPost = alpha + conteo;
  const betaPost = beta + minuto;
  const muRestante = restan === 0 ? 0 : alphaPost * restan / betaPost;
  return { alphaPost, betaPost, muRestante, restan };
}

/** mu/r efectivamente en uso por defecto (calibrados si STATS_NB_CALIBRADO=on). */
function nbParamsVigentes() {
  const cal = nbCal.vigente();
  return cal ? { mu: cal.mu, r: cal.r, calibrado: true } : { mu: STATS_NB_MU, r: STATS_NB_R, calibrado: false };
}

/** Sello de version para las filas con p_poisson (ver FEATURE_VERSION_NB_CALIBRADO). */
function featureVersionScorer() {
  return nbCal.vigente() ? FEATURE_VERSION_NB_CALIBRADO : FEATURE_VERSION;
}

function probUnderNB(conteo, linea, minuto, mu, r) {
  if (conteo == null || linea == null || minuto == null) return null;
  const colchon = Math.floor(linea) - conteo;
  if (colchon < 0) return 0;                       // ya se paso: el under perdio
  const post = posteriorNB(conteo, minuto, mu, r);
  if (!post) return null;
  if (post.restan === 0) return 1;                 // no queda tiempo: el under gano
  // P(lo que falta <= colchon), con "lo que falta" ~ NB(muRestante, alphaPost).
  return nb.cdf(colchon, post.muRestante, post.alphaPost);
}

/**
 * INVERSO de probUnderNB: dado lo que el mercado cree (fairProbUnder, ya sin
 * vig) para una linea a un minuto dado, ¿que conteo actual hace que el modelo
 * prediga esa misma probabilidad? probUnderNB es monotona DECRECIENTE en
 * conteo (mas corners ya caidos = menos probable quedarse abajo de la linea),
 * asi que hay un unico entero que mejor la explica — se busca por fuerza
 * bruta entre 0 y floor(linea) porque el rango es chico (<=20 tipico).
 *
 * PROPOSITO: cross-validar/complementar el conteo inferido del N-esimo (ver
 * conteoInferido arriba), que se demostro fragil el 2026-09-17 — la casa a
 * veces deja indices bajos abiertos mucho despues de que el corner ya cayo
 * (ver el hallazgo en memoria/backtest de esa fecha). El mercado de totales
 * SI se sigue moviendo en esos casos, asi que puede servir de segunda fuente.
 *
 * TODAVIA NO SE USA EN PRODUCCION. Antes de conectarlo a nada (conteo,
 * derivarEtiquetas, o el propio /fotmob) hay que validarlo contra el conteo
 * real de FotMob sobre partidos en vivo — y con datos LIMPIOS, es decir,
 * capturados despues del fix del 2026-09-17 que dejo de mezclar mercados por
 * equipo/mitad en esta misma tabla. Los snapshots de antes de esa fecha no
 * sirven para esta validacion.
 */
function conteoImplicito(fairProbUnder, linea, minuto, mu, r) {
  if (fairProbUnder == null || linea == null || minuto == null) return null;
  const techo = Math.floor(linea);
  let mejor = null, mejorDist = Infinity;
  for (let c = 0; c <= techo; c++) {
    const p = probUnderNB(c, linea, minuto, mu, r);
    if (p == null) continue;
    const d = Math.abs(p - fairProbUnder);
    if (d < mejorDist) { mejorDist = d; mejor = c; }
  }
  return mejor;
}

/**
 * Combina el conteo implicito de VARIAS lineas del mismo instante (cada una
 * da su propia estimacion, con su propio ruido de cuota) en una sola cifra
 * robusta — la mediana, para no dejar que una linea con precio raro arrastre
 * el resultado como pasaria con un promedio.
 */
function conteoEstimadoDeMercado(filasLinea) {
  const estimados = (filasLinea || [])
    .map(f => conteoImplicito(f.fairProbUnder, f.linea, f.minuto))
    .filter(x => x != null)
    .sort((a, b) => a - b);
  if (!estimados.length) return null;
  const mid = Math.floor(estimados.length / 2);
  return estimados.length % 2
    ? estimados[mid]
    : Math.round((estimados[mid - 1] + estimados[mid]) / 2);
}

/**
 * Aplana los mercados de TOTAL de todas las familias a filas.
 *
 * OJO CON EL NOMBRE DEL CAMPO. GetLiveOverview enlaza mercado->momios con
 * `oddIds`, pero GetEventDetails usa `desktopOddIds` / `mobileOddIds`. Leer
 * `oddIds` aqui devuelve undefined y el resultado es CERO filas, que se lee como
 * "el feed no trae estos mercados" cuando si los trae.
 *
 * NO SE FILTRA POR PRECIO. La version anterior descartaba `price <= 1` copiando
 * el criterio de normalize.js, y aqui eso destruia justo la evidencia que hace
 * falta: un precio de 1.0 es el mercado RESUELTO (visto: "Menos de 12.5@1"), y
 * un 0 con oddStatus != 0 es el mercado SUSPENDIDO — en el descanso llegan todos
 * a 0, asi que de ese partido no se guardaba ni una fila. Se guarda todo y se
 * distingue con `suspended` y `oddStatus`; `fairProb` queda NULL cuando no se
 * puede calcular, que es informacion, no un hueco.
 */
function extraerStats(detalle, meta = {}) {
  if (!detalle) return [];
  const ts = new Date().toISOString();
  const oddsById = new Map((detalle.odds || []).map(o => [o.id, o]));

  const liveTime = detalle.liveTime || '';
  const mm = liveTime.match(/(\d+)/);
  const minuto = mm ? Number(mm[1]) : null;

  // EL FEED REPITE MERCADOS. GetEventDetails devuelve el mismo mercado mas de
  // una vez (Spartak Varna: 14 repetidos de 51). Sin deduplicar, cada repeticion
  // genera otra fila identica y el dataset acaba con observaciones que pesan el
  // doble sin que nada lo indique.
  const mercadosUnicos = [];
  const idsVistos = new Set();
  for (const m of detalle.markets || []) {
    const k = m.id != null ? `id:${m.id}` : `n:${m.name}|${m.sv ?? ''}`;
    if (idsVistos.has(k)) continue;
    idsVistos.add(k);
    mercadosUnicos.push(m);
  }

  const filas = [];
  for (const familia of FAMILIAS) {
    const conteo = conteoInferido(mercadosUnicos, familia);
    const indices = indicesNesimo(mercadosUnicos, familia);

    for (const market of mercadosUnicos) {
      const nombre = market.name || '';
      if (!familia.mercado.test(nombre)) continue;
      // Solo el mercado GLOBAL del partido. Antes se guardaba tambien el de
      // cada equipo por separado y el de 1a mitad (mismo regex de familia los
      // deja pasar) — ademas de ensuciar el dato con lineas que no describen
      // el partido completo, colisionaban en derivarEtiquetas: porLinea se
      // indexa por `familia|linea`, y una linea 3.5 de "Real Betis" pisaba la
      // misma linea 3.5 del mercado global sin que nada lo notara. Hallado el
      // 2026-09-17 comparando contra FotMob (ver conteoInferido).
      if (!esMercadoGlobal(nombre)) continue;

      const ids = market.desktopOddIds || market.mobileOddIds || market.oddIds || [];
      const planos = [].concat(...ids.map(x => (Array.isArray(x) ? x : [x])));

      const candidatas = [];
      for (const id of planos) {
        const odd = oddsById.get(id);
        if (!odd) continue;
        const sel = parseSeleccion(odd.name);
        if (!sel) continue; // no es un total: fuera del piloto
        candidatas.push({ odd, sel });
      }
      if (!candidatas.length) continue;

      // Devig por PAREJA (over/under de la MISMA linea). El mercado de totales
      // trae una escalera entera (8.5 .. 12.5) en un solo mercado: devigar las
      // diez selecciones juntas mezclaria cinco apuestas distintas y daria una
      // probabilidad sin significado. Cada linea es un binario independiente.
      const porLinea = new Map();
      for (const c of candidatas) {
        if (!porLinea.has(c.sel.linea)) porLinea.set(c.sel.linea, []);
        porLinea.get(c.sel.linea).push(c);
      }

      const nombreMercado = market.sv ? `${nombre} ${market.sv}` : nombre;
      for (const [linea, grupo] of porLinea) {
        // Solo entran al devig las activas Y con precio real. Una suspendida o
        // una a 1.0 romperia el reparto de probabilidad del par.
        const utiles = grupo.filter(c => c.odd.oddStatus === 0 && c.odd.price > 1);
        let justaPorId = null;
        if (utiles.length === 2) {
          const probs = devig(utiles.map(c => c.odd.price), defaultMethod());
          justaPorId = new Map(utiles.map((c, i) => [c.odd.id, probs[i]]));
        }
        for (const { odd, sel } of grupo) {
          // Scorer en SOMBRA. Se calcula y se guarda; no decide nada. Solo para
          // el mercado global: en los de equipo y los de mitad el contador mide
          // otra cosa (ver MERCADO_GLOBAL).
          const pUnder = (familia.conteo && esMercadoGlobal(nombre))
            ? probUnderNB(conteo, linea, minuto)
            : null;
          const pPoisson = pUnder == null ? null : (sel.lado === 'under' ? pUnder : 1 - pUnder);
          filas.push({
            ts,
            familia: familia.nombre,
            eventId: detalle.id ?? meta.eventId ?? null,
            event: detalle.name || meta.event || '',
            champ: (detalle.champ && detalle.champ.name) || meta.champ || '',
            liveTime: [detalle.liveTime, detalle.ls].filter(Boolean).join(' — '),
            minute: minuto,
            market: nombreMercado,
            selection: odd.name,
            linea,
            lado: sel.lado,
            oddDecimal: typeof odd.price === 'number' ? odd.price : null,
            // NULL y no 1/precio: sin pareja activa no hay margen que quitar, y
            // el inverso crudo lleva el margen dentro. Un NULL explicito evita
            // que un analisis lo tome por una probabilidad justa de verdad.
            fairProb: justaPorId && justaPorId.has(odd.id) ? justaPorId.get(odd.id) : null,
            oddStatus: typeof odd.oddStatus === 'number' ? odd.oddStatus : null,
            suspended: odd.oddStatus === 0 ? 0 : 1,
            conteo,
            // Evidencia cruda del contador, para poder rehacer la regla despues.
            conteoIndices: indices.length ? JSON.stringify(indices) : null,
            // Sombra del modelo, en la MISMA orientacion que fairProb (la de
            // esta fila), para poder restarlas sin pensar. Desde stats-4 es
            // binomial negativa, no Poisson (ver FEATURE_VERSION arriba);
            // lambdaPoisson guarda el mu PRIOR (total del partido) usado en
            // esta fila, no una tasa por minuto — sigue viajando con la fila
            // por el mismo motivo de siempre: va a cambiar en cuanto se
            // re-mida, y sin el sello un analisis mezclaria ajustes distintos
            // sin enterarse.
            pPoisson,
            lambdaPoisson: pPoisson == null ? null : nbParamsVigentes().mu,
            featureVersion: featureVersionScorer(),
          });
        }
      }
    }
  }
  return filas;
}

/**
 * Un GetEventDetails sin mercados = partido TERMINADO.
 *
 * Hallazgo del 2026-08-29: los partidos ya acabados (Houston, Minnesota,
 * Nashville) devuelven `markets: []` mientras el evento sigue un rato en el
 * feed en vivo. Es una senial de fin mucho mas limpia que esperar a que
 * desaparezca del overview, y es la que dispara la liquidacion del piloto.
 */
function partidoTerminado(detalle) {
  return !!detalle && Array.isArray(detalle.markets) && detalle.markets.length === 0;
}

// Una cuota asi de corta significa mercado RESUELTO: la casa ya no cotiza un
// riesgo, esta pagando. Es la evidencia mas directa del desenlace.
const UMBRAL_COLAPSO = 1.05;
// Por debajo de este minuto no se etiqueta por conteo aunque el canal siga vivo:
// el partido no habia terminado y el conteo seguiria subiendo.
const MINUTO_FINAL = 85;
// Observaciones minimas del contador para fiarse de el. Con una sola no hay con
// que corroborarla, y una lectura corrupta bastaria para etiquetar mal: paso el
// 2026-08-29 con New Mexico United, que llego con 8 corners en el MINUTO 1.
const MIN_OBS_CONTEO = 2;

/**
 * Convierte las muestras de UN partido en etiquetas, una por (familia, linea).
 *
 * DERIVA POCO Y GUARDA MUCHO. `lado_ganador` sale NULL siempre que la evidencia
 * no alcance, y eso es un resultado legitimo del piloto: cuantas lineas quedan
 * sin etiquetar es justamente la cifra que dice si esto puede entrenar algo. La
 * alternativa —rellenar con la mejor conjetura— es como se fabricaron las
 * features de global_draw, y dejo 184 picks inservibles para siempre.
 *
 * Los ultimos precios crudos viajan a la fila para poder rehacer la derivacion
 * mas adelante, con una regla mejor, sin volver a muestrear el partido. Esa
 * previsión ya se cobro sola: la regla de monotonia de abajo se aplico en
 * retroactivo a 32 partidos ya liquidados sin volver a pedir un solo byte.
 *
 * LAS TRES REGLAS, en orden, y su certeza:
 *
 *  1. MONOTONIA (cierta). Los corners solo suben. Si el conteo supero la linea
 *     en algun momento, el over YA gano y no hay vuelta atras — da igual que la
 *     casa retire el mercado despues. No es una heuristica: es una propiedad del
 *     contador. Es la regla que desbloquea el etiquetado, porque la anterior
 *     exigia que el contador siguiera vivo en la ULTIMA observacion y eso no
 *     pasa nunca: medido el 2026-08-30, la casa retira el mercado del N-esimo
 *     una media de 2.6 minutos antes del final, asi que todo partido seguido
 *     hasta el pitido salia censurado y la regla no se disparaba jamas (0 de 286).
 *
 *  2. PRECIO COLAPSADO (cierta). Una cuota <= 1.05 es un mercado ya resuelto.
 *
 *  3. CONTEO AL FINAL (PROBABLE, no cierta). El contador seguia vivo pasado el
 *     minuto 85 y quedo por debajo de la linea. El under es lo probable, pero un
 *     corner en el descuento lo voltea. Se etiqueta y se marca `certeza`
 *     PROBABLE para que un entrenamiento pueda excluirlo; mezclarlo con las
 *     ciertas sin distintivo seria justo el tipo de dato fabricado que arruino
 *     los 184 picks de global_draw.
 *
 * LA MONOTONIA SOLO VALE SI EL CONTADOR ES FIABLE, y se comprueba: la serie
 * tiene que ser no decreciente (un conteo que baja es prueba de lectura
 * corrupta) y tener al menos MIN_OBS_CONTEO observaciones.
 *
 * @param muestras filas de stat_snapshots de un solo evento, ordenadas por ts
 */
function derivarEtiquetas(muestras) {
  if (!muestras || !muestras.length) return [];
  const settledTs = new Date().toISOString();
  const cab = muestras[muestras.length - 1];

  // Serie del contador por familia: ultimo valor, maximo, EN QUE MINUTO se vio
  // por ultima vez, si seguia vivo al final, y si la serie es CREIBLE.
  const porFamilia = new Map();
  for (const m of muestras) {
    if (!porFamilia.has(m.familia)) {
      porFamilia.set(m.familia, {
        ultimoConteo: null, conteoMax: null, huboCanal: false, minutoUltimoConteo: null,
        conteoAlFinal: null, ultimaTs: null, obs: [], bajo: false,
      });
    }
    const f = porFamilia.get(m.familia);
    if (m.conteo != null) {
      f.ultimoConteo = m.conteo;
      f.huboCanal = true;
      if (m.minute != null) f.minutoUltimoConteo = m.minute;
      if (f.conteoMax == null || m.conteo > f.conteoMax) f.conteoMax = m.conteo;
      // Un mismo instante repite el conteo en cada linea; solo cuenta una vez.
      const ult = f.obs.length ? f.obs[f.obs.length - 1] : null;
      if (!ult || ult.ts !== m.ts) {
        if (ult && m.conteo < ult.conteo) f.bajo = true; // los corners no bajan
        f.obs.push({ ts: m.ts, conteo: m.conteo });
      }
    }
    if (f.ultimaTs !== m.ts) { f.ultimaTs = m.ts; f.conteoAlFinal = m.conteo; }
    else if (m.conteo != null) f.conteoAlFinal = m.conteo;
  }
  for (const f of porFamilia.values()) {
    f.serieFiable = f.obs.length >= MIN_OBS_CONTEO && !f.bajo;
  }

  // Ultima observacion de cada (familia, linea).
  const porLinea = new Map();
  for (const m of muestras) {
    const k = `${m.familia}|${m.linea}`;
    if (!porLinea.has(k)) {
      porLinea.set(k, {
        familia: m.familia, linea: m.linea, nMuestras: 0,
        ultimaTs: null, ultimoMinuto: null, over: null, under: null,
      });
    }
    const l = porLinea.get(k);
    l.nMuestras++;
    if (l.ultimaTs == null || m.ts > l.ultimaTs) { l.ultimaTs = m.ts; l.over = null; l.under = null; }
    if (m.ts === l.ultimaTs) {
      if (m.minute != null) l.ultimoMinuto = m.minute;
      if (m.lado === 'over') l.over = m;
      if (m.lado === 'under') l.under = m;
    }
  }

  const filas = [];
  for (const l of porLinea.values()) {
    const f = porFamilia.get(l.familia) || {};
    // BUG encontrado el 2026-09-10 analizando dispersion para negativa
    // binomial: `conteoAlFinal == null` solo detecta el mercado SUSPENDIDO
    // (sigue llegando la fila, pero con conteo null). No detecta el mercado
    // RETIRADO (deja de llegar cualquier fila de esta familia) — en ese caso
    // la ULTIMA fila que si existio tiene un conteo valido de cualquier
    // minuto en que se vio por ultima vez, y `conteoAlFinal` queda no-nulo
    // aunque el canal muriera en el minuto 20. Medido sobre 74 eventos
    // marcados censurado=0: la mediana del minuto de esa "ultima" lectura
    // era el minuto 73, y 18/72 ni llegaban al 45 — la bandera decia
    // "termino bien" en partidos que en realidad se cortaron a la mitad.
    // Mismo criterio que ya usaba la regla de escalera (linea 455): el
    // canal solo cuenta como vivo al final si su ULTIMA LECTURA fue en o
    // despues de MINUTO_FINAL, no solo si esa lectura no era null.
    const censurado = !f.huboCanal ? null
      : (f.conteoAlFinal == null || f.minutoUltimoConteo == null || f.minutoUltimoConteo < MINUTO_FINAL) ? 1 : 0;
    const conteoFinal = f.ultimoConteo;

    let ladoGanador = null, metodo = null, certeza = null;
    const oOver = l.over && l.over.odd_decimal;
    const oUnder = l.under && l.under.odd_decimal;

    // 1. Monotonia: el over ya no puede perderse.
    if (f.serieFiable && f.conteoMax != null && f.conteoMax > l.linea) {
      ladoGanador = 'over'; metodo = 'monotonia'; certeza = 'cierta';
    // 2. Precio colapsado: el mercado ya pago.
    } else if (oOver != null && oOver > 0 && oOver <= UMBRAL_COLAPSO) {
      ladoGanador = 'over'; metodo = 'precio_colapsado'; certeza = 'cierta';
    } else if (oUnder != null && oUnder > 0 && oUnder <= UMBRAL_COLAPSO) {
      ladoGanador = 'under'; metodo = 'precio_colapsado'; certeza = 'cierta';
    // 3. ESCALERA COMPLETA. Si el contador llego vivo al minuto 85 o mas, su
    //    ultimo valor es el conteo final a efectos practicos, y sirve para
    //    etiquetar TODAS las lineas del partido — no solo la que alguna regla
    //    pueda demostrar.
    //
    //    Es lo que quita el SESGO DE SELECCION. Etiquetando solo lo demostrable,
    //    la monotonia produce unicamente 'over' (por construccion) y el precio
    //    colapsado tira a 'under' (es el lado que se resuelve pronto): el
    //    reparto 19/37 que salio no describia el mercado, describia mis reglas.
    //    Ajustar cualquier cosa sobre eso habria aprendido a predecir el
    //    etiquetador.
    //
    //    Se marca PROBABLE, no cierta: un corner en el descuento voltea las
    //    lineas justo en el borde. El lado over ya lo cubre la monotonia con
    //    certeza, asi que aqui solo cae el under.
    //
    //    Se mira el minuto de la ULTIMA LECTURA DEL CONTADOR, no el de la ultima
    //    muestra: la casa retira el mercado del N-esimo ~2.6 min antes del final,
    //    asi que exigir censurado===0 no se cumplia casi nunca.
    } else if (f.serieFiable && conteoFinal != null
               && f.minutoUltimoConteo != null && f.minutoUltimoConteo >= MINUTO_FINAL) {
      ladoGanador = conteoFinal > l.linea ? 'over' : 'under';
      metodo = 'escalera'; certeza = 'probable';
    }

    filas.push({
      eventId: cab.event_id, event: cab.event, champ: cab.champ,
      familia: l.familia, linea: l.linea,
      ladoGanador, metodo, certeza,
      conteoFinal: conteoFinal ?? null,
      minutoUltimoConteo: f.minutoUltimoConteo ?? null,
      conteoMax: f.conteoMax ?? null,
      serieFiable: f.huboCanal ? (f.serieFiable ? 1 : 0) : null,
      conteoCensurado: censurado,
      ultimoMinuto: l.ultimoMinuto, ultimaTs: l.ultimaTs, nMuestras: l.nMuestras,
      ultimoOddOver: l.over ? l.over.odd_decimal : null,
      ultimoOddUnder: l.under ? l.under.odd_decimal : null,
      ultimaJustaOver: l.over ? l.over.fair_prob : null,
      ultimaJustaUnder: l.under ? l.under.fair_prob : null,
      featureVersion: FEATURE_VERSION,
      settledTs,
    });
  }
  return filas;
}

module.exports = {
  extraerStats, conteoInferido, indicesNesimo, parseSeleccion, partidoTerminado,
  derivarEtiquetas, probUnderPoisson, probUnderNB, posteriorNB, esMercadoGlobal,
  conteoImplicito, conteoEstimadoDeMercado, nbParamsVigentes, featureVersionScorer,
  FAMILIAS, FEATURE_VERSION, UMBRAL_COLAPSO, MINUTO_FINAL, MIN_OBS_CONTEO,
  LAMBDA_CORNER, MINUTOS_PARTIDO, STATS_NB_MU, STATS_NB_R,
};
