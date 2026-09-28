// src/dryRunBetslip.js
// ─────────────────────────────────────────────────────────────────────────────
// Dry-Run de apuesta en Playdoit: navegador REAL (headful, Chrome instalado),
// perfil persistente (sesión reutilizable). NUNCA presiona "Apostar".
//
// Flujo por pick:
//   1. Abre evento con deep-link (#page=event&eventId=...&sportId=...)
//   2. Espera a que la SPA de Altenar renderice las cuotas (hasta MAX_WAIT_MS)
//   3. Busca la selección por texto del mercado + selección (fuzzy-light)
//   4. Hace clic → abre betslip   (solo si pasa bloquearClic)
//   5. Lee la cuota del betslip (americana o decimal) y la pasa a decimal
//   6. Introduce el monto de prueba (DRYRUN_IMPORTE_MXN)
//   7. Toma captura de pantalla (screenshots/dry-run-{id}.png)
//   8. Limpia el betslip
//   9. Guarda todo en la tabla `bot_dry_run_log` de snapshots.db
//
// FRENOS anti-apuesta (ver src/dryRunHelpers.js):
//   - red: iniciarContexto instala un route() que ABORTA cualquier escritura a un
//     endpoint de apuesta (placeWidget, placeToto, PayBetImmediate, cashout...).
//   - clic: bloquearClic() rechaza elementos que parezcan confirmar o que sean
//     demasiado grandes.
//
// Métricas registradas:
//   - latencia_dom_ms       : navigate → cuota visible
//   - latencia_click_ms     : clic → betslip abierto
//   - latencia_total_ms     : desde el inicio del script hasta stake introducido
//   - latencia_desde_emit_ms: desde la EMISIÓN del pick hasta stake introducido
//   - odd_emit, odd_betslip : cuota de emisión vs cuota en el betslip (decimal)
//   - odd_drift_pct         : desviación porcentual (negativa = cuota bajó)
//   - status: 'ok' | 'odd_changed' | 'suspended' | 'gone' | 'timeout' | 'error'
//             | 'bloqueado_confirmacion' | 'ambiguo' | 'bloqueado_apuesta'
//   - rechazo_regla: 1 si odd_drift_pct < -ODD_REJECT_PCT
//
// Variables de entorno opcionales:
//   DRYRUN_IMPORTE_MXN  — monto a teclear en el betslip (default: 10)
//   DRYRUN_PROFILE_DIR  — directorio de perfil de Chrome (default: .chrome-profile)
//   DRYRUN_SCREENSHOTS  — ruta para capturas (default: screenshots/dry-run)
//   DRYRUN_MAX_WAIT_MS  — tiempo máximo esperando cuotas (default: 60000)
//   DRYRUN_LOG_WRITES   — 0 para no registrar las peticiones de escritura vistas
//   ODD_REJECT_PCT      — % de caída para rechazar (default: 3)

'use strict';

const path   = require('path');
const fs     = require('fs');
const crypto = require('crypto');
const { chromium } = require('playwright');
const { db }       = require('./db');
const {                                                           // [NUEVO]
  esTextoDeConfirmacion, esPeticionDeApuesta, areaExcesiva, latenciaDesdeEmision,
  parsearCuota, regexEtiqueta,
} = require('./dryRunHelpers');

// ── Configuración ────────────────────────────────────────────────────────────
const CHROME_CHANNEL   = 'chrome';
const PROFILE_DIR      = process.env.DRYRUN_PROFILE_DIR  || path.join(__dirname, '..', '.chrome-profile');
const SCREENSHOTS_DIR  = process.env.DRYRUN_SCREENSHOTS  || path.join(__dirname, '..', 'screenshots', 'dry-run');
const MAX_WAIT_MS      = Number(process.env.DRYRUN_MAX_WAIT_MS) || 60_000;
const STAKE_MXN        = Number(process.env.DRYRUN_IMPORTE_MXN) || 10;
const ODD_REJECT_PCT   = Number(process.env.ODD_REJECT_PCT)     || 3;
const LOG_ESCRITURAS   = process.env.DRYRUN_LOG_WRITES !== '0';   // [NUEVO]

// Clases de styled-components del sportsbook (verificadas 2026-09-26; el hash cambia, el prefijo no).
// El sportsbook vive dentro de un Shadow DOM abierto: los locators de Playwright lo atraviesan,
// document.querySelectorAll no.
const SEL_BOTON_CUOTA = 'button[class*="OddBoxButton"]';
const SEL_ETIQUETA    = '[class*="OddLabel"]';
const SEL_VALOR       = '[class*="OddValue"]';
// 1 = solo leer la cuota de la lista: sin clic ni monto. El worker siempre
// fuerza este modo, aunque una corrida manual conserve el modo de boleto.
const SOLO_LECTURA    = process.env.DRYRUN_SOLO_LECTURA === '1';

// ── Migración de tabla ───────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS bot_dry_run_log (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    ts               TEXT    NOT NULL,           -- ISO, momento de ejecución
    pick_id          INTEGER,                    -- FK model_picks.id (puede ser NULL en modo ad-hoc)
    event_id         INTEGER,
    sport_id         INTEGER,
    market           TEXT,
    selection        TEXT,
    odd_emit         REAL,                       -- cuota al emitir el pick
    odd_betslip      REAL,                       -- cuota leída en el betslip (NULL si gone/timeout)
    odd_drift_pct    REAL,                       -- (betslip - emit) / emit * 100
    rechazo_regla    INTEGER DEFAULT 0,          -- 1 si drift < -ODD_REJECT_PCT
    latencia_dom_ms  INTEGER,                    -- ms hasta ver la cuota en el DOM
    latencia_click_ms INTEGER,                   -- ms desde clic a betslip abierto
    latencia_total_ms INTEGER,                   -- ms desde inicio hasta stake introducido
    status           TEXT,                       -- ok|odd_changed|suspended|gone|timeout|error|bloqueado_*|ambiguo
    error_msg        TEXT,
    screenshot_path  TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_dry_run_pick ON bot_dry_run_log (pick_id);
  CREATE INDEX IF NOT EXISTS idx_dry_run_ts   ON bot_dry_run_log (ts);
`);

// Columnas añadidas después de crear la tabla (la tabla puede existir ya).
const _cols = db.prepare('PRAGMA table_info(bot_dry_run_log)').all().map(c => c.name);
for (const [col, tipo] of [
  ['latencia_desde_emit_ms', 'INTEGER'], ['bloqueos', 'TEXT'],
  ['started_at', 'TEXT'], ['finished_at', 'TEXT'], ['source', 'TEXT'],
  ['job_id', 'INTEGER'], ['attempt', 'INTEGER'], ['mode', 'TEXT'],
]) {
  if (!_cols.includes(col)) db.exec(`ALTER TABLE bot_dry_run_log ADD COLUMN ${col} ${tipo}`);
}

const insertDryRun = db.prepare(`
  INSERT INTO bot_dry_run_log
    (ts, started_at, finished_at, source, job_id, attempt, mode,
     pick_id, event_id, sport_id, market, selection,
     odd_emit, odd_betslip, odd_drift_pct, rechazo_regla,
     latencia_dom_ms, latencia_click_ms, latencia_total_ms, latencia_desde_emit_ms,
     status, error_msg, screenshot_path, bloqueos)
  VALUES
    (@ts, @started_at, @finished_at, @source, @job_id, @attempt, @mode,
     @pick_id, @event_id, @sport_id, @market, @selection,
     @odd_emit, @odd_betslip, @odd_drift_pct, @rechazo_regla,
     @latencia_dom_ms, @latencia_click_ms, @latencia_total_ms, @latencia_desde_emit_ms,
     @status, @error_msg, @screenshot_path, @bloqueos)
`);

// ── Estado del contexto (singleton por proceso) ──────────────────────────────
let _context = null;
let _bloqueos = [];   // [NUEVO] peticiones de apuesta abortadas durante el pick en curso

// [NUEVO] Aborta cualquier escritura a un endpoint de apuesta. Ojo: route() intercepta
// TODAS las peticiones y suma unos ms a las latencias medidas.
async function instalarFrenoDeApuestas(ctx) {
  await ctx.route('**/*', (route) => {
    const req  = route.request();
    const info = { method: req.method(), url: req.url() };
    let ruta = info.url;
    try { ruta = new URL(info.url).pathname; } catch { /* url rara */ }
    if (esPeticionDeApuesta(info)) {
      _bloqueos.push(`${info.method} ${ruta}`);
      console.error(`[dryRun] BLOQUEADA petición de apuesta: ${info.method} ${ruta}`);
      return route.abort();
    }
    if (LOG_ESCRITURAS && !['GET', 'HEAD', 'OPTIONS'].includes(info.method)) {
      console.log(`[dryRun] escritura observada: ${info.method} ${ruta}`);
    }
    return route.continue();
  });
}

// ── Sesión ───────────────────────────────────────────────────────────────────
// La cookie de login (JSESSIONID) es de SESIÓN pura, sin fecha de expiración: Chrome la
// descarta al cerrarse del todo, aunque el perfil sea persistente. Forzar "restaurar sesión"
// en Preferences no funcionó (Chrome reescribe ese archivo). En su lugar, las cookies del
// contexto se guardan en un archivo cuando el usuario inicia sesión a mano (guardarSesion,
// llamada solo desde abrir-perfil.js) y se reinyectan al abrir. Se guarda SOLO desde ahí: una
// corrida sin sesión no debe pisar una sesión buena. El archivo es una credencial: vive dentro
// del perfil (ignorado por git) y nunca se imprime su contenido.
const SESSION_FILE = path.join(PROFILE_DIR, 'sesion-cookies.json');

async function cargarSesion(ctx) {
  if (!fs.existsSync(SESSION_FILE)) return 0;
  try {
    const ahora = Date.now() / 1000;
    const cookies = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'))
      .filter((c) => c.expires === -1 || c.expires > ahora);   // las ya vencidas no se reinyectan
    await ctx.addCookies(cookies);
    return cookies.length;
  } catch (e) {
    console.warn('[dryRun] no se pudo restaurar la sesión:', e.message);
    return 0;
  }
}

// Guarda las cookies del contexto abierto. Devuelve cuántas.
async function guardarSesion() {
  if (!_context) throw new Error('no hay contexto abierto');
  const cookies = await _context.cookies();
  fs.writeFileSync(SESSION_FILE, JSON.stringify(cookies), { mode: 0o600 });
  return cookies.length;
}

async function iniciarContexto() {
  if (_context) return _context;
  fs.mkdirSync(PROFILE_DIR,     { recursive: true });
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

  _context = await chromium.launchPersistentContext(PROFILE_DIR, {
    channel:  CHROME_CHANNEL,
    headless: false,
    viewport: { width: 1280, height: 800 },
    args: [
      '--disable-blink-features=AutomationControlled',
      '--disable-infobars',
      '--no-default-browser-check',
    ],
  });
  await instalarFrenoDeApuestas(_context);                        // [NUEVO]
  const restauradas = await cargarSesion(_context);
  console.log('[dryRun] contexto Chrome iniciado, perfil:', PROFILE_DIR,
    restauradas ? `(sesión restaurada: ${restauradas} cookies)` : '(sin sesión guardada)');
  return _context;
}

async function cerrarContexto() {
  if (_context) {
    await _context.close().catch(() => {});
    _context = null;
    console.log('[dryRun] contexto Chrome cerrado');
  }
}

// ── Helper: movimiento de ratón "humano" (3 puntos Bézier) ──────────────────
async function moverHacia(page, x, y) {
  const cx = Math.random() * 1280;
  const cy = Math.random() * 400;
  const steps = 12 + Math.floor(Math.random() * 8);
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const bx = (1 - t) ** 2 * cx + 2 * (1 - t) * t * (cx + (x - cx) * 0.5) + t ** 2 * x;
    const by = (1 - t) ** 2 * cy + 2 * (1 - t) * t * (cy + (y - cy) * 0.3) + t ** 2 * y;
    await page.mouse.move(bx, by);
    await page.waitForTimeout(15 + Math.floor(Math.random() * 20));
  }
}

// ── Helper: normalizar texto para comparación fuzzy-light ───────────────────
function norm(t) {
  return String(t || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // quitar tildes
    .replace(/[^a-z0-9.]+/g, ' ')
    .trim();
}

// El mercado se valida en el ancestro cercano de la cuota. Antes solo se
// comprobaba la selección: "Menos de 2.5" podía pertenecer a un total de
// periodo distinto. Se buscan términos textuales del mercado (no la línea,
// que suele estar ya en la selección) para no confundir Total 1.5 con 2.5.
function contextoCoincideMercado(contexto, market) {
  const terms = norm(market).split(' ').filter(t => t.length >= 4 && !/^\d/.test(t));
  if (!terms.length) return false; // un trabajo automático debe traer mercado verificable
  const text = norm(contexto);
  return terms.some(t => text.includes(t));
}

// ── Helper: cerrar banner de cookies si aparece ──────────────────────────────
async function cerrarBannerCookies(page) {
  try {
    await page.evaluate(() => {
      // Buscar el botón × del banner de cookies o botones con texto "Acepto"
      const close = document.querySelector('[class*="cookie"] button, [class*="cookie"] [class*="close"]');
      if (close) { close.click(); return; }
      for (const btn of document.querySelectorAll('button, a')) {
        const t = (btn.innerText || '').toLowerCase().trim();
        if (t === 'acepto' || t === 'accept' || t === 'aceptar') { btn.click(); return; }
      }
    });
    await page.waitForTimeout(500);
  } catch { /* sin banner */ }
}

// [CAMBIO] decimalToAmerican ahora viene de ./dryRunHelpers (se borró la copia local).

// ── Helper: esperar a que el sportsbook pinte cuotas ────────────────────────
async function esperarCuotas(page) {
  const t0 = Date.now();
  try { await page.locator(SEL_BOTON_CUOTA).first().waitFor({ state: 'visible', timeout: MAX_WAIT_MS }); }
  catch { return null; } // timeout
  return Date.now() - t0;
}

// Botón por selección EXACTA y mercado presente en su contexto local. n>1 =>
// ambiguo; n=0 con la selección presente pero sin mercado es "no verificable".
async function localizarSeleccion(page, market, seleccion) {
  const candidatos = page.locator(SEL_BOTON_CUOTA)
    .filter({ has: page.locator(SEL_ETIQUETA).filter({ hasText: regexEtiqueta(seleccion) }) });
  const total = await candidatos.count().catch(() => 0);
  const indices = [];
  for (let i = 0; i < total; i++) {
    const contexto = await candidatos.nth(i).evaluate((el) => {
      let node = el.parentElement;
      let text = '';
      // Se limita a ancestros cercanos: document.body haría coincidir un
      // mercado que esté en cualquier otra tarjeta de la página.
      for (let level = 0; node && level < 7; level++, node = node.parentElement) {
        const t = (node.innerText || node.textContent || '').trim();
        if (t.length && t.length <= 4000) text += ` ${t}`;
      }
      return text;
    }).catch(() => '');
    if (contextoCoincideMercado(contexto, market)) indices.push(i);
  }
  return {
    n: indices.length,
    boton: indices.length === 1 ? candidatos.nth(indices[0]) : null,
    selectionFound: total,
  };
}

// Cuota (decimal) que muestra el sitio en el botón, antes de tocar nada. El sitio la muestra en
// formato AMERICANO (+150, -180): parsearCuota() la pasa a decimal.
// Devuelve { texto, odd }: el texto crudo se guarda en el error si no se pudo interpretar.
async function leerCuotaLista(boton) {
  const texto = await boton.locator(SEL_VALOR).first().innerText({ timeout: 3000 })
    .catch((e) => `!error: ${String(e.message).split('\n')[0]}`);
  return { texto, odd: parsearCuota(texto) };
}

// ── Helper: leer cuota del betslip una vez abierto ──────────────────────────
// Mejor esfuerzo: los selectores del betslip NO están verificados (solo se usa sin SOLO_LECTURA).
// Con 2+ selecciones en el boleto, este selector genérico también casa el total combinado
// ("MOMIOS") además de la cuota de la pata — por eso devuelve TODAS las distintas que
// encuentra, para que el llamador pueda detectar la ambigüedad en vez de quedarse con
// la primera al azar.
const SEL_BETSLIP_ODD = '[class*="betslip" i] [class*="odd" i], [class*="betslip" i] [class*="price" i], [class*="bet-slip" i] [class*="odd" i], [data-testid*="odd"]';
async function leerCuotasBetslip(page, maxMs = 5000) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    const textos = await page.locator(SEL_BETSLIP_ODD).allInnerTexts().catch(() => []);
    const odds = [...new Set(textos.map(parsearCuota).filter((n) => n !== null))];
    if (odds.length) return odds;
    await page.waitForTimeout(250);
  }
  return [];
}
// Compat: una sola cuota (la primera encontrada), para quien no necesite la lista completa.
async function leerCuotaBetslip(page, maxMs = 5000) {
  const odds = await leerCuotasBetslip(page, maxMs);
  return odds.length ? odds[0] : null;
}
// Nº de cuotas visibles en el boleto ahora mismo (sin esperar): 0 = vacío.
async function contarCuotasBetslip(page) {
  const textos = await page.locator(SEL_BETSLIP_ODD).allInnerTexts().catch(() => []);
  return textos.filter((t) => parsearCuota(t) !== null).length;
}

// ── Helper: detectar si el mercado fue suspendido ───────────────────────────
async function esSuspendido(page) {
  return (await page.locator('[class*="suspend" i], [data-status="suspended"]').count().catch(() => 0)) > 0;
}

// ── Helper: teclear con cadencia humana ─────────────────────────────────────
async function teclearHumano(page, selector, texto) {
  await page.click(selector, { delay: 50 + Math.random() * 80 });
  // Seleccionar y borrar DESPUÉS del clic: el clic deselecciona lo que un Control+A previo
  // hubiera marcado, y el campo puede traer un valor (medido 2026-09-28: "20" + "10" = "2010").
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Delete');
  for (const ch of String(texto)) {
    await page.keyboard.type(ch, { delay: 60 + Math.random() * 100 });
  }
}

// [NUEVO] Última defensa antes del clic: nada que parezca confirmar una apuesta y nada
// tan grande que su centro pueda caer sobre otro botón. Devuelve true si NO hay que clicar.
async function bloquearClic(btnEl, row) {
  const info = await btnEl.evaluate(el => ({
    t: (el.innerText || el.textContent || '').trim().slice(0, 300),
    a: el.getAttribute('aria-label') || '',
    b: (el.closest('button, [role="button"], a')?.innerText || '').trim().slice(0, 300),
  })).catch(() => null);
  const bbox = await btnEl.boundingBox().catch(() => null);
  if (!info || esTextoDeConfirmacion(`${info.t} ${info.a} ${info.b}`)) {
    row.status = 'bloqueado_confirmacion';
    row.error_msg = 'el elemento parece confirmar una apuesta; no se hizo clic';
    return true;
  }
  if (areaExcesiva(bbox)) {
    row.status = 'ambiguo';
    row.error_msg = `elemento demasiado grande (${Math.round(bbox?.width || 0)}x${Math.round(bbox?.height || 0)}); no se hizo clic`;
    return true;
  }
  return false;
}

// [NUEVO] Quita las selecciones del betslip (el perfil es persistente y se acumulaban).
// Selectores verificados 2026-09-27 contra el HTML real del boleto (scratch/_boleto.html):
// cada pata trae un botón "Remove" con `title="Remove"` (más estable que las clases con hash
// styled-components); también existe "Limpiar todo" pero se prefiere quitar pata por pata
// para no depender de un solo botón que además podría abrir un diálogo de confirmación.
// El botón de apostar en sí dice "Inicia sesión para realizar apuestas" sin sesión — aquí no
// hay riesgo de tocarlo porque solo se clican los "Remove", nunca ese botón.
// El boleto se abre COLAPSADO (barra "BOLETO n · MOMIOS +x"): mientras lo está, React ni
// siquiera monta el campo de monto ni los botones "Remove" de cada pata (no es que estén
// ocultos: no existen en el DOM — confirmado 2026-09-28, count=0 colapsado vs count=1
// expandido). La cabecera colapsada (la barra inferior) NO trae atributo `data-open`; solo la
// del panel ya abierto trae `data-open="true"` (medido 2026-09-28: buscar `data-open="false"`
// nunca casaba, y por eso ni el monto se escribía ni la limpieza quitaba nada).
async function expandirBoletoSiColapsado(page) {
  const cabecera = page.locator('[class*="BetSlipHeaderContainer" i][data-clickable="true"]:not([data-open="true"])').first();
  if (await cabecera.isVisible({ timeout: 1500 }).catch(() => false)) {
    await cabecera.click({ timeout: 2000 }).catch(() => {});
    await page.waitForTimeout(500);
    return true;
  }
  return false;
}

async function limpiarBetslip(page) {
  const SEL_REMOVE  = 'button[title="Remove"]';
  await expandirBoletoSiColapsado(page);
  let limpiados = 0;
  for (let i = 0; i < 10; i++) {
    const el = page.locator(SEL_REMOVE).first();
    if (!(await el.isVisible().catch(() => false))) break;
    const txt = await el.evaluate(n =>
      `${n.innerText || ''} ${n.getAttribute('aria-label') || ''} ${n.getAttribute('title') || ''}`
    ).catch(() => 'apostar');           // si no se puede leer, se asume peligroso
    if (esTextoDeConfirmacion(txt)) break;
    // force:true (medido 2026-09-28): el clic normal fallaba en silencio contra una pata SGP,
    // probablemente por la animación de expandir/colapsar tapando el botón momentáneamente;
    // sin force, Playwright reintenta la comprobación de "clicable" y el catch se comía el error.
    await el.click({ timeout: 2000, force: true }).catch(() => {});
    limpiados++;
    await page.waitForTimeout(300);
  }
  const quedan = await page.locator(SEL_REMOVE).count().catch(() => 0);
  if (quedan > 0) console.warn(`[dryRun] el betslip sigue con ${quedan} pata(s) tras limpiarlo`);
  return limpiados;
}

// ── Función principal ────────────────────────────────────────────────────────
/**
 * @param {object} item
 * @param {number} [item.pickId]
 * @param {number}  item.eventId
 * @param {number}  item.sportId
 * @param {string}  item.market
 * @param {string}  item.selection
 * @param {number}  item.oddDecimal
 * @param {string} [item.ts]          ISO timestamp del pick; si se omite usa ahora
 * @param {{source?:string, jobId?:number, attempt?:number, mode?:'list_only'|'betslip'}} [options]
 * @returns {Promise<{status:string, odd_betslip:number|null, odd_drift_pct:number|null,
 *                    latencia_total_ms:number, latencia_desde_emit_ms:number|null}>}
 */
async function ejecutarDryRun(item, options = {}) {
  const { pickId = null, eventId, sportId, market, selection, oddDecimal, ts } = item;
  const source = options.source || item.source || 'manual';
  const jobId = options.jobId ?? item.jobId ?? null;
  const attempt = options.attempt ?? item.attempt ?? null;
  const mode = options.mode || item.mode || 'betslip';
  // Ningun caller de worker puede degradar este freno: list_only nunca abre el
  // betslip ni escribe el importe aunque la variable global esté apagada.
  const soloLectura = mode === 'list_only' || SOLO_LECTURA;
  const emitTs   = ts || new Date().toISOString();
  const t0global = Date.now();
  const startedAt = new Date(t0global).toISOString();
  _bloqueos = [];                                                 // [NUEVO]
  let page = null;

  const row = {
    ts: startedAt,
    started_at:       startedAt,
    finished_at:      null,
    source,
    job_id:           jobId,
    attempt,
    mode:             soloLectura ? 'list_only' : 'betslip',
    pick_id:          pickId,
    event_id:         eventId,
    sport_id:         sportId,
    market,
    selection,
    odd_emit:         oddDecimal,
    odd_betslip:      null,
    odd_drift_pct:    null,
    rechazo_regla:    0,
    latencia_dom_ms:  null,
    latencia_click_ms: null,
    latencia_total_ms: null,
    latencia_desde_emit_ms: null,                                 // [NUEVO]
    status:           'error',
    error_msg:        null,
    screenshot_path:  null,
    bloqueos:         null,                                       // [NUEVO]
  };

  // Aplica una cuota leída (decimal) al registro: drift contra la emitida y estado.
  const aplicarCuota = (odd) => {
    row.odd_betslip   = odd;
    row.odd_drift_pct = ((odd - oddDecimal) / oddDecimal) * 100;
    row.rechazo_regla = row.odd_drift_pct < -ODD_REJECT_PCT ? 1 : 0;
    row.status        = row.rechazo_regla ? 'odd_changed' : 'ok';
  };

  try {
    const ctx  = await iniciarContexto();
    page = ctx.pages()[0] || await ctx.newPage();

    // Navegar al evento
    const url = `https://www.playdoit.mx/#page=event&eventId=${eventId}&sportId=${sportId}`;
    console.log(`[dryRun] pick=${pickId ?? 'ad-hoc'} → ${url}`);
    // 'commit' (llegaron las cabeceras) y un timeout de goto NO fatal: la SPA pinta después, y con poca
    // RAM la carga tarda; lo que manda es el tiempo hasta ver cuotas (esperarCuotas / DRYRUN_MAX_WAIT_MS).
    await page.goto(url, { waitUntil: 'commit', timeout: 60_000 }).catch((e) => {
      if (!/Timeout/i.test(e.message)) throw e;
      console.warn('[dryRun] goto lento (timeout); se sigue esperando las cuotas');
    });

    // Pausa inicial + cerrar cookies + scroll suave para despertar el router/viewport
    await page.waitForTimeout(2000);
    await cerrarBannerCookies(page);
    await page.evaluate(() => window.scrollBy(0, 350));
    await page.waitForTimeout(1000);

    // Esperar a que el sportsbook (Shadow DOM) pinte cuotas
    const latDom = await esperarCuotas(page);
    if (latDom === null) {
      // Antes de declarar timeout, verificar suspensión
      row.status = (await esSuspendido(page)) ? 'suspended' : 'timeout';
      row.latencia_dom_ms = MAX_WAIT_MS;
      console.warn(`[dryRun] ${row.status} para eventId=${eventId}`);
    } else {
      row.latencia_dom_ms = latDom;

      // Limpiar el boleto AQUÍ, no antes: el widget del boleto persistido (Momios, patas
      // previas) tarda en hidratar y no tiene una señal propia que esperar — medido
      // 2026-09-28, la limpieza a los 2s de cargar la página no encontraba nada que quitar
      // (el widget aún no montaba) y el resto sin fecha, así que se recicla la señal de
      // "las cuotas ya cargaron" (esperarCuotas) como proxy: si el odds board ya renderizó,
      // el boleto persistido también tuvo tiempo de hacerlo.
      await limpiarBetslip(page).catch(() => 0);

      // Los mercados llegan después del primer botón: margen breve para que aparezca la selección.
      let loc = await localizarSeleccion(page, market, selection);
      const tBusca = Date.now();
      while (loc.n === 0 && Date.now() - tBusca < 8000) {
        await page.waitForTimeout(500);
        loc = await localizarSeleccion(page, market, selection);
      }

      if (loc.n === 0) {
        row.status = loc.selectionFound ? 'market_unverified' : 'gone';
        row.error_msg = loc.selectionFound
          ? `la selección "${selection}" apareció ${loc.selectionFound} vez/veces, pero sin mercado verificable "${market}"`
          : null;
        console.warn(`[dryRun] ${row.status}: ${row.error_msg || `selección no encontrada: "${selection}"`}`);
      } else if (loc.n > 1) {
        row.status = 'ambiguo';
        row.error_msg = `${loc.n} botones con la etiqueta "${selection}" (¿varios mercados?); no se hizo clic`;
        console.warn(`[dryRun] ${row.error_msg}`);
      } else if (await loc.boton.isDisabled().catch(() => false)) {
        row.status = 'suspended';
      } else {
        // 1) Cuota que muestra el sitio AHORA, sin tocar nada.
        const { texto: textoCuota, odd: oddLista } = await leerCuotaLista(loc.boton);
        if (oddLista === null) {
          row.status = 'error';
          row.error_msg = `no se pudo interpretar la cuota del botón (texto: ${JSON.stringify(textoCuota)})`;
          console.warn(`[dryRun] ${row.error_msg}`);
        } else {
          aplicarCuota(oddLista);
          row.latencia_total_ms = Date.now() - t0global;
          row.latencia_desde_emit_ms = latenciaDesdeEmision(emitTs);

          // 2) Opcional: abrir el betslip (con los frenos). En solo lectura se omite.
          if (!soloLectura) {
            // El perfil es persistente: si limpiarBetslip (selectores sin verificar) no
            // logró vaciarlo, cualquier cuota que se lea después puede ser la de OTRA
            // selección o el total combinado (visto: boleto con 2 patas leído como +148 en
            // vez de la cuota de esta pata). Mejor abortar sin clicar que guardar un drift falso.
            // Un solo reintento aquí (medido 2026-09-28): el widget del boleto persistido
            // hidrata con timing propio, independiente de las cuotas del mercado, y a veces
            // sigue sin estar listo justo cuando esperarCuotas ya resolvió; también parece
            // repoblarse solo con una sugerencia del sitio (tarjetas PLAYBOOSTS), no siempre
            // es un resto de una corrida anterior.
            let cuotasPrevias = await contarCuotasBetslip(page);
            if (cuotasPrevias > 0) {
              await limpiarBetslip(page).catch(() => 0);
              await page.waitForTimeout(1000);
              cuotasPrevias = await contarCuotasBetslip(page);
            }
            if (cuotasPrevias > 0) {
              row.status = 'error';
              row.error_msg = `el boleto trae ${cuotasPrevias} cuota(s) sin limpiar de una corrida previa; no se clicó`;
              console.warn(`[dryRun] ${row.error_msg}`);
            }
            const btnEl = cuotasPrevias > 0 ? null : await loc.boton.elementHandle();
            if (!btnEl || (cuotasPrevias === 0 && await bloquearClic(btnEl, row))) {
              if (cuotasPrevias === 0) console.warn(`[dryRun] ${row.status}: ${row.error_msg}`);
            } else {
              // Asegurar que el elemento esté dentro del viewport
              await btnEl.scrollIntoViewIfNeeded().catch(() => {});
              await page.waitForTimeout(300);

              // Mover ratón y hacer clic
              const bbox = await btnEl.boundingBox();
              if (bbox) await moverHacia(page, bbox.x + bbox.width / 2, bbox.y + bbox.height / 2);
              await page.waitForTimeout(200 + Math.random() * 300);

              const t1click = Date.now();
              await btnEl.click({ delay: 50 + Math.random() * 80 });

              // Esperar betslip
              await page.waitForTimeout(800 + Math.random() * 400);
              row.latencia_click_ms = Date.now() - t1click;

              // Expandir: colapsado, el campo de monto no existe en el DOM (confirmado
              // 2026-09-28 — antes de esto, STAKE_MXN nunca se llegaba a escribir) y solo se ve
              // el total combinado, no la pata individual (ver leerCuotasBetslip).
              await expandirBoletoSiColapsado(page);

              // Cuota del betslip (mejor esfuerzo: su DOM no está verificado). Si aparece más
              // de una cuota distinta, no se puede saber cuál es la de esta pata (podría ser
              // el total combinado de un boleto que no se vació) — se descarta la lectura en
              // vez de arriesgarse a guardar un drift inventado.
              const oddsBetslip = await leerCuotasBetslip(page);
              if (oddsBetslip.length === 1) {
                aplicarCuota(oddsBetslip[0]);
              } else if (oddsBetslip.length > 1) {
                row.status = 'ambiguo';
                row.error_msg = `el boleto muestra ${oddsBetslip.length} cuotas distintas (${oddsBetslip.join(', ')}); no se puede aislar la de esta pata`;
                console.warn(`[dryRun] ${row.error_msg}`);
              } else {
                console.warn('[dryRun] betslip no leído; se conserva la cuota de la lista');
              }

              // Rellenar stake con tipeo humano
              const stakeSelector = [
                '[class*="betslip" i] input[type="number"]',
                '[class*="betslip" i] input[type="text"]',
                '[class*="bet-slip" i] input',
                '[class*="stake" i] input',
                'input[placeholder*="monto" i], input[placeholder*="stake" i], input[placeholder*="apuesta" i]',
              ].join(', ');

              const stakeInput = page.locator(stakeSelector).first();
              if (await stakeInput.isVisible().catch(() => false)) {
                await stakeInput.click({ clickCount: 3 });
                await page.keyboard.press('Control+A');
                await teclearHumano(page, stakeSelector, String(STAKE_MXN));
                // Diagnóstico (temporal): confirma en el log si el monto quedó escrito de
                // verdad, sin depender de la captura (el boleto puede volver a colapsarse
                // antes de la captura final y taparlo visualmente).
                const valorEscrito = await stakeInput.inputValue().catch((e) => `!error: ${e.message}`);
                console.log(`[dryRun] monto en el campo tras teclear: ${JSON.stringify(valorEscrito)}`);
              } else {
                console.warn('[dryRun] campo de monto no visible; no se escribió nada');
              }

              row.latencia_total_ms = Date.now() - t0global;
              row.latencia_desde_emit_ms = latenciaDesdeEmision(emitTs);
            }
          }
          console.log(
            `[dryRun] ${row.status} | pick=${pickId ?? 'ad-hoc'} | ` +
            `odd_emit=${oddDecimal} odd_vista=${row.odd_betslip?.toFixed(4)} ` +
            `drift=${row.odd_drift_pct?.toFixed(2)}% | ` +
            `total=${row.latencia_total_ms}ms | desde_emit=${row.latencia_desde_emit_ms ?? '-'}ms`
          );
        }
      }
    }

  } catch (e) {
    row.status    = 'error';
    row.error_msg = e.message;
    console.error('[dryRun] error:', e.message);
  } finally {
    // La evidencia debe sobrevivir tambien a timeouts y excepciones. Un nombre
    // por intento evita que cuatro reintentos de un mismo pick sobrescriban la
    // captura que explica los tres anteriores.
    if (page) {
      const tag = jobId != null
        ? `job-${jobId}-attempt-${attempt ?? 1}`
        : `manual-${source}-${pickId ?? 'ad-hoc'}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
      const ssPath = path.join(SCREENSHOTS_DIR, `dry-run-${tag}.png`);
      await page.screenshot({ path: ssPath, fullPage: false }).then(() => {
        row.screenshot_path = ssPath;
      }).catch(e => console.warn('[dryRun] screenshot fallida:', e.message));

      // La limpieza siempre se intenta aun si navegar, leer una cuota o abrir
      // el boleto falló. En list_only no se toca el boleto: es un worker de
      // lectura y no debe modificar una sesión que el operador esté usando.
      if (!soloLectura) {
        await limpiarBetslip(page).catch(e => {
          console.warn('[dryRun] limpieza fallida:', e.message);
        });
        const quedan = await contarCuotasBetslip(page);
        if (quedan > 0) {
          row.status = 'cleanup_failed';
          row.error_msg = `el boleto conserva ${quedan} cuota(s) tras la limpieza; se detiene el worker`;
          console.error(`[dryRun] ${row.error_msg}`);
        }
        await page.keyboard.press('Escape').catch(() => {});
        await page.waitForTimeout(300);
      }
    }
    row.latencia_total_ms ??= Date.now() - t0global;
    row.latencia_desde_emit_ms ??= latenciaDesdeEmision(emitTs);
    row.finished_at = new Date().toISOString();
  }

  // [NUEVO] Si la red abortó algo, eso manda sobre cualquier otro estado.
  if (_bloqueos.length) {
    row.status  = 'bloqueado_apuesta';
    row.bloqueos = JSON.stringify(_bloqueos);
  }

  // Guardar en BD
  const saved = insertDryRun.run(row);
  console.log(`[dryRun] guardado en bot_dry_run_log — status=${row.status}`);

  return {
    run_id:          Number(saved.lastInsertRowid),
    status:          row.status,
    odd_betslip:     row.odd_betslip,
    odd_drift_pct:   row.odd_drift_pct,
    latencia_total_ms: row.latencia_total_ms,
    latencia_desde_emit_ms: row.latencia_desde_emit_ms,           // [NUEVO]
    error_msg:       row.error_msg,
  };
}

module.exports = { ejecutarDryRun, iniciarContexto, cerrarContexto, guardarSesion };
