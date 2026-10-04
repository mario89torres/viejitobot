const Database = require('better-sqlite3');
const path = require('path');

// DB_PATH existe para los TESTS, no para produccion.
//
// Varias guardas consultan la BD para decidir (isRejectedBy5Guards exige 4+
// snapshots activos del mercado). Con la ruta fija, cualquier test que pasara
// filas sinteticas por rankPicks las veia rechazadas en bloque: sus eventos no
// existen en snapshots.db. El sintoma era una lista vacia y una asercion que
// fallaba lejos de su causa.
//
// Apuntando DB_PATH a un fichero temporal, el test siembra los snapshots que la
// guarda pide y ejerce el pipeline COMPLETO, que es lo que se quiere probar.
//
// Ojo: definir DB_PATH en .env mueve la base de datos de produccion. No esta
// pensado para eso; el default es la ruta de siempre.
const DB_FILE = process.env.DB_PATH || path.join(__dirname, '..', 'snapshots.db');
const db = new Database(DB_FILE, { timeout: 30000 });
db.pragma('journal_mode = WAL');

// MIGRACION DE NOMBRES (2026-09-15): el piloto de corners cambio de fuente,
// SofaScore -> FotMob (ver src/fotmobScraper.js) — SofaScore bloqueaba fetch
// plano (403, fingerprint tipo Cloudflare) y quedo suspendido
// (SOFA_SUSPENDIDO=1). Se renombra la tabla/columnas EN VEZ DE crear unas
// nuevas para conservar el historico ya capturado; debe correr ANTES de los
// CREATE TABLE IF NOT EXISTS de mas abajo (que ya usan los nombres nuevos),
// para que en una BD vieja esos CREATE sean no-op sobre la tabla renombrada
// en vez de crear una tabla nueva vacia y dejar la vieja huerfana.
function tableExists(name) {
  return !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(name);
}
function renameTableIfNeeded(oldName, newName) {
  if (tableExists(oldName) && !tableExists(newName)) {
    db.exec(`ALTER TABLE ${oldName} RENAME TO ${newName}`);
  }
}
function renameColumnIfNeeded(table, oldCol, newCol) {
  if (!tableExists(table)) return;
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (cols.includes(oldCol) && !cols.includes(newCol)) {
    db.exec(`ALTER TABLE ${table} RENAME COLUMN ${oldCol} TO ${newCol}`);
  }
}
renameTableIfNeeded('sofa_corner_snapshots', 'fotmob_corner_snapshots');
renameTableIfNeeded('sofa_forecast_snapshots', 'fotmob_forecast_snapshots');
// Columna, no solo tabla: RENAME TO no toca los nombres de columna por
// dentro, y el CREATE INDEX de mas abajo (dentro del mismo exec) ya
// referencia fotmob_event_id — en una BD vieja recien renombrada esa
// columna todavia se llama sofa_event_id en este punto, asi que esto tiene
// que correr AQUI, antes del exec, no despues (a diferencia de stat_results,
// cuyas columnas sofa_* se agregaron via addColumn y no existen todavia en
// esta etapa — esas se renombran mas abajo, junto a los addColumn).
renameColumnIfNeeded('fotmob_corner_snapshots', 'sofa_event_id', 'fotmob_event_id');
renameColumnIfNeeded('fotmob_forecast_snapshots', 'sofa_event_id', 'fotmob_event_id');

db.exec(`
  CREATE TABLE IF NOT EXISTS snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    sport TEXT, sport_id INTEGER,
    champ TEXT,
    event_id INTEGER, event TEXT,
    score TEXT, live_time TEXT,
    market TEXT, selection TEXT,
    odd_decimal REAL, odd_american TEXT,
    suspended INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_snapshots_ts ON snapshots(ts);
  CREATE INDEX IF NOT EXISTS idx_snapshots_event ON snapshots(event_id, ts);

  -- PILOTO PRE-PARTIDO (src/fetcher.js: fetchPrematch) — solo lectura, no
  -- emite ni decide nada. Misma forma que snapshots mas start_date (el
  -- kickoff programado, necesario para medir "horas hasta el inicio" — sin
  -- eso no se puede distinguir apertura de cierre). Tabla APARTE y no una
  -- columna nueva en snapshots: mezclar picks en vivo con pre-partido en las
  -- mismas consultas de analisis arriesgaria contaminar cifras ya medidas
  -- (mismo criterio que se aplico con rejected_picks vs picks).
  CREATE TABLE IF NOT EXISTS prematch_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    sport TEXT, sport_id INTEGER,
    champ TEXT,
    event_id INTEGER, event TEXT,
    start_date TEXT,
    market TEXT, selection TEXT,
    odd_decimal REAL, odd_american TEXT,
    suspended INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_prematch_ts ON prematch_snapshots(ts);
  CREATE INDEX IF NOT EXISTS idx_prematch_event ON prematch_snapshots(event_id, ts);
  -- El visor "Hoy" filtra por start_date; sin este indice cada peticion recorria la tabla y en disco frio tardaba 34 s
  -- (2026-09-25), bloqueando el dashboard (better-sqlite3 es sincrono). Cubre el subselect de /api/prematch-hoy.
  CREATE INDEX IF NOT EXISTS idx_prematch_start ON prematch_snapshots(start_date, event_id, market, selection, ts);

  -- Escaneo de valor PRE-PARTIDO contra una casa sharp (src/sharp.js, misma
  -- fuente que ya se usaba solo para picks en vivo). NO espera a que se mueva
  -- la linea propia (steam, semanas de historial) — compara la cuota de
  -- Playdoit contra Pinnacle/Betfair AHORA MISMO; si Playdoit paga mas que la
  -- referencia sharp, esa discrepancia YA es la señal. Validado el
  -- 2026-09-22 con EPL + La Liga: 100% de emparejamiento por nombre de
  -- equipo, y un caso real (Man City vs Ipswich: Playdoit @12 vs Pinnacle
  -- @10.38 en Ipswich, ~16% mejor). edge_pct = (odd_playdoit/odd_sharp - 1)*100;
  -- positivo = Playdoit paga mas que la referencia. Solo lectura: no emite,
  -- no apuesta, no decide — mismo criterio que el resto de los pilotos.
  CREATE TABLE IF NOT EXISTS prematch_value_scan (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    event_id INTEGER, event TEXT, champ TEXT,
    sport_key TEXT, market TEXT NOT NULL,
    bookmaker TEXT, selection TEXT,
    sharp_odd REAL, playdoit_odd REAL, edge_pct REAL,
    start_date TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_prematch_scan_ts ON prematch_value_scan(ts);
  CREATE INDEX IF NOT EXISTS idx_prematch_scan_event ON prematch_value_scan(event_id, ts);

  -- Patas que el reporte de las 08:00 mostro (src/reportePrematch.js), guardadas para
  -- construir el RECORD pre-partido que hoy no existe: sin esto no se puede decir
  -- que una pata es "segura" con datos. kind: 'parlay' | 'top' | 'valor'.
  CREATE TABLE IF NOT EXISTS prematch_report_picks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL, dia TEXT NOT NULL, kind TEXT NOT NULL,
    event_id INTEGER, event TEXT, champ TEXT, start_date TEXT,
    market TEXT, selection TEXT, odd_decimal REAL, p_justa REAL,
    result TEXT, final_score TEXT, score_source TEXT, settled_ts TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_report_picks_dia ON prematch_report_picks(dia);
  CREATE INDEX IF NOT EXISTS idx_report_picks_pend ON prematch_report_picks(result, start_date);

  -- xG de temporada de ambos equipos (src/prematchXg.js), pedido explicito del
  -- usuario el 2026-09-23 tras confirmar que FotMob expone xG a favor/en
  -- contra por equipo via /data/teams?id=X. A diferencia del escaneo sharp
  -- (que compara contra el precio de otra casa) y de steam (que compara
  -- Playdoit contra si mismo en el tiempo), esta señal viene del RENDIMIENTO
  -- medido del equipo, no del mercado — no hay que esperar a que nadie mueva
  -- una cuota. xg_esperado_* combina ataque de un lado con defensa del otro,
  -- normalizado por partidos jugados. Solo lectura, no decide ni emite nada.
  CREATE TABLE IF NOT EXISTS prematch_xg_scan (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    event_id INTEGER, event TEXT, start_date TEXT,
    fotmob_match_id INTEGER,
    home_team_id INTEGER, home_played INTEGER, home_xg_for REAL, home_xg_against REAL,
    away_team_id INTEGER, away_played INTEGER, away_xg_for REAL, away_xg_against REAL,
    xg_esperado_local REAL, xg_esperado_visita REAL, xg_esperado_total REAL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_prematch_xg_uniq ON prematch_xg_scan(event_id);
  CREATE INDEX IF NOT EXISTS idx_prematch_xg_ts ON prematch_xg_scan(ts);

  CREATE TABLE IF NOT EXISTS picks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    event_id INTEGER, event TEXT, sport TEXT,
    market TEXT, selection TEXT,
    odd_decimal REAL, conf REAL,
    result TEXT, final_score TEXT, settled_ts TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_picks_result ON picks(result);

  -- Grupo de control: candidatos que el sistema RECHAZÓ, con su resultado real.
  --
  -- Por qué existe: hasta ahora solo se guardaban los picks emitidos, todos
  -- pasados por MIN_CONF=0.70 y MIN_EDGE. Eso comprime el 80% de las conf en
  -- 9pp (restricción de rango) y deja al clasificador SIN NEGATIVOS: no puede
  -- aprender una frontera que nunca ve. Medido el 2026-08-09, es una de las
  -- razones de que ningún modelo supere al heurístico.
  --
  -- TABLA APARTE, no un source='rejected' dentro de picks, y es deliberado:
  -- todo el dashboard, las stats y el ROI leen de picks, así que mezclarlos
  -- contaminaría cada cifra del sistema. Es exactamente el error que ya se
  -- pagó con source='global_draw'.
  --
  -- El índice ÚNICO es el control de tamaño: el universo son ~74k combinaciones
  -- únicas cada 10 min, así que sin dedupe esto sepultaría la BD (que ya crece
  -- de más). Con él, cada candidato se guarda UNA vez, no una por ciclo.
  CREATE TABLE IF NOT EXISTS rejected_picks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    event_id INTEGER, event TEXT, sport TEXT,
    market TEXT, selection TEXT,
    odd_decimal REAL, conf REAL, edge REAL,
    reject_rule TEXT NOT NULL,
    f_prob_justa REAL, f_avance REAL, f_avance_model REAL,
    f_situacion REAL, f_linea REAL, f_apertura REAL,
    conf_heuristic REAL, score_version INTEGER,
    result TEXT, final_score TEXT, settled_ts TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_rejected_uniq
    ON rejected_picks(event_id, market, selection);
  CREATE INDEX IF NOT EXISTS idx_rejected_result ON rejected_picks(result);
  -- Picks que emitiria el MODELO aprendido si decidiera el (MODEL_MODE=learned).
  -- Tabla APARTE, no una fila mas en picks, y no por gusto: picks alimenta
  -- todos los analisis de rendimiento, backtests y el propio entrenamiento.
  -- Meter aqui jugadas que nadie apuesta las colaria en cada medicion futura —
  -- es literalmente lo que paso con globalDrawScanner, que insertaba directo en
  -- picks y contamino los backtests del firewall hasta que hubo que marcar
  -- 224 filas con score_version=0 para poder excluirlas.
  CREATE TABLE IF NOT EXISTS model_picks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    event_id INTEGER, event TEXT, sport TEXT, champ TEXT,
    market TEXT, selection TEXT,
    odd_decimal REAL,
    conf_learned REAL, conf_heuristic REAL, edge_learned REAL,
    -- 1 si el heuristico tambien lo habria emitido: separa las jugadas donde
    -- ambos coinciden de las que SOLO ve el modelo, que son la poblacion sin
    -- validar y el motivo de todo este ejercicio.
    tambien_heuristico INTEGER NOT NULL DEFAULT 0,
    f_prob_justa REAL, f_avance REAL, f_avance_model REAL,
    f_situacion REAL, f_linea REAL, f_apertura REAL,
    score_version INTEGER,
    result TEXT, final_score TEXT, settled_ts TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_model_uniq
    ON model_picks(event_id, market, selection);
  CREATE INDEX IF NOT EXISTS idx_model_result ON model_picks(result);

  CREATE TABLE IF NOT EXISTS subscribers (
    telegram_id INTEGER PRIMARY KEY,
    username TEXT,
    first_name TEXT,
    plan TEXT DEFAULT 'vip_monthly',
    status TEXT DEFAULT 'active',
    subscribed_at TEXT,
    expires_at TEXT,
    invite_link TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_subscribers_status ON subscribers(status, expires_at);

  -- Deduplicacion persistente de alertas ya enviadas a Telegram (sobrevive
  -- reinicios). La usan globalDrawScanner y dashboardApi; existia solo en la BD
  -- viva, creada a mano, asi que cualquier BD nueva reventaba al consultarla.
  CREATE TABLE IF NOT EXISTS alerted_events (
    key TEXT PRIMARY KEY,
    ts TEXT NOT NULL
  );

`);

// ─────────────────────────────────────────────────────────────────────────────
// PILOTO DE ESTADISTICAS DE PARTIDO (src/matchStats.js)
//
// Tablas APARTE de snapshots y no columnas mas, por tres razones: el pipeline de
// scoring lee snapshots entera y meter ahi un mercado que nadie sabe puntuar lo
// contaminaria; el piloto necesita columnas que snapshots no tiene (linea, lado,
// conteo); y separadas se pueden purgar o tirar sin tocar los 113 M de filas que
// sostienen todo lo demas.
//
// OJO CON LA RETENCION: pruneSnapshots solo borra de `snapshots`. Estas tablas
// no las poda nadie todavia.
// ─────────────────────────────────────────────────────────────────────────────

// Migracion del piloto solo-corners al generalizado. Nacio como
// `corner_snapshots` y crecio a tarjetas el mismo dia; se renombra en vez de
// crear una tabla por familia, que habria obligado a un JOIN por cada analisis.
function migrarPilotoStats() {
  const tabla = (n) => db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(n);
  if (tabla('corner_snapshots') && !tabla('stat_snapshots')) {
    db.exec('ALTER TABLE corner_snapshots RENAME TO stat_snapshots');
  }
}
migrarPilotoStats();

db.exec(`
  CREATE TABLE IF NOT EXISTS stat_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    event_id INTEGER, event TEXT, champ TEXT,
    live_time TEXT, minute REAL,
    market TEXT, selection TEXT,
    linea REAL, lado TEXT,
    odd_decimal REAL, fair_prob REAL,
    suspended INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_stat_ts ON stat_snapshots(ts);
  CREATE INDEX IF NOT EXISTS idx_stat_event ON stat_snapshots(event_id, ts);

  -- ETIQUETAS del piloto: una fila por (evento, familia, linea).
  --
  -- Sin esto el log no sirve para entrenar: hay features y no hay 'y'. Se
  -- escribe cuando GetEventDetails devuelve 'markets: []', que es la senial
  -- limpia de partido terminado.
  --
  -- SE GUARDA LA EVIDENCIA, NO SOLO LA CONCLUSION. 'lado_ganador' se DERIVA, y
  -- la derivacion puede estar mal; los ultimos precios crudos quedan en la fila
  -- para poder rehacerla sin volver a muestrear. Es lo contrario de lo que paso
  -- con global_draw, donde se guardaron constantes fabricadas y 184 picks
  -- quedaron inservibles para cualquier analisis posterior.
  CREATE TABLE IF NOT EXISTS stat_results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER, event TEXT, champ TEXT,
    familia TEXT, linea REAL,
    -- 'over' | 'under' | NULL cuando no se pudo derivar con confianza. El NULL
    -- es un resultado legitimo del piloto: medir cuantos quedan sin etiqueta es
    -- parte de lo que decide si esto es viable.
    lado_ganador TEXT,
    metodo TEXT,              -- 'conteo' | 'precio_colapsado' | NULL
    conteo_final INTEGER,     -- ultimo conteo visto; NULL si nunca hubo canal
    conteo_censurado INTEGER, -- 1 si el canal murio antes del final del partido
    ultimo_minuto REAL, ultima_ts TEXT, n_muestras INTEGER,
    -- evidencia cruda de la ultima observacion de esta linea
    ultimo_odd_over REAL, ultimo_odd_under REAL,
    ultima_justa_over REAL, ultima_justa_under REAL,
    feature_version TEXT,
    settled_ts TEXT
  );
  -- ALERTAS DE VALOR (src/valueAlerts.js). UNA fila por pick alertado.
  --
  -- La clave es el pick_id y no (evento, mercado, seleccion): al consumir picks
  -- ya emitidos, el pick ES la unidad, y la emision ya deduplica por evento
  -- aguas arriba. Los ids de mercado/seleccion del feed ni siquiera se
  -- persisten — normalize.js guarda nombres.
  --
  -- NO HAY RE-ALERTA, y por eso no hay contador de veces ni ventana horaria.
  -- Medido sobre 400 picks: la vida de un pick es p50 36 min, p95 1.3 h, asi
  -- que una ventana en HORAS no podria dispararse nunca. Y el movimiento de
  -- precio durante esa vida es p50 25%, p75 51%: cualquier umbral util seria
  -- tan alto que el pick ya estaria decidido. Ese caso ya lo cubren
  -- PROFIT_LOCK y POSITION_DYING, con condiciones mejor afinadas.
  --
  -- 'odd_alertada' se guarda aunque no haya re-alerta: permite medir despues el
  -- CLV entre el precio del aviso y el de cierre, que es gratis y no se puede
  -- reconstruir a posteriori.
  -- PILOTO FotMob: captura de solo lectura del conteo de corners DIRECTO
  -- (estadistica real, no inferida del indice de un mercado). Vive aparte de
  -- stat_snapshots a proposito: es OTRA fuente (FotMob, no playdoit), con
  -- su propio event_id (el matchId de FotMob). Emparejado con eventos de
  -- playdoit por equipos+hora (src/fotmobMatch.js) — techo de match heredado
  -- del piloto anterior (SofaScore, ~30-45%), ver comentario ahi.
  --
  -- FUENTE ANTERIOR (2026-09-08 a 2026-09-15): SofaScore, via Chromium
  -- headless porque bloqueaba fetch plano (403, fingerprint tipo
  -- Cloudflare). Reemplazada por FotMob (src/fotmobScraper.js) el
  -- 2026-09-15: misma cobertura de corners/posesion/xG pero via fetch plano
  -- (sin JS-challenge, verificado en produccion), asi que ya no hace falta
  -- Chromium ni el intervalo aparte que su latencia variable exigia.
  --
  -- status_type: 'notstarted' | 'inprogress' | 'finished' | 'cancelled'. Es
  -- lo que decide si corners_home/away de la ULTIMA fila de un evento sirve
  -- como conteo FINAL para etiquetar stat_results, o si el partido seguia en
  -- curso y tomarlo seria inventar un numero — la misma regla que ya rige
  -- conteo_final en stat_results.
  CREATE TABLE IF NOT EXISTS fotmob_corner_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    fotmob_event_id INTEGER NOT NULL,
    home TEXT, away TEXT, tournament TEXT,
    corners_home INTEGER, corners_away INTEGER,
    status TEXT, status_type TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_fotmob_ts ON fotmob_corner_snapshots(ts);
  CREATE INDEX IF NOT EXISTS idx_fotmob_event ON fotmob_corner_snapshots(fotmob_event_id, ts);

  -- Historial de pronosticos EN VIVO (src/fotmobLive.js: computeDosFuentes,
  -- campo 'sugerida'): un snapshot por ciclo del piloto de FotMob, con la
  -- cuota que tenia la linea EN ESE MOMENTO. Antes el pronostico solo
  -- existia "al vuelo" (recalculado en cada request del dashboard sobre
  -- datos actuales) — no habia forma de ver que decia el modelo hace 20
  -- minutos, ni con que cuota, una vez que la cuota ya se movio o la linea
  -- se liquido. Se guarda solo cuando hay 'sugerida' (edge positivo en algun
  -- lado): sin eso no hay nada que mostrar en el historial.
  CREATE TABLE IF NOT EXISTS fotmob_forecast_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    event_id TEXT NOT NULL,
    fotmob_event_id INTEGER,
    event TEXT,
    minuto INTEGER,
    linea REAL,
    lado TEXT,
    odd REAL,
    p_modelo REAL,
    p_mercado REAL,
    edge REAL,
    conteo_real INTEGER,
    esperados REAL
  );
  CREATE INDEX IF NOT EXISTS idx_forecast_event ON fotmob_forecast_snapshots(event_id, ts);

  -- SONDEOS DE EJECUTABILIDAD (nivel 0 de apuesta directa; src/execProbe.js).
  -- Tras emitir un pick se vuelve a leer su mercado a +10/+30/+60 s y se guarda
  -- que cuota tenia y si seguia abierto. No apuesta nada: mide si el edge
  -- sobreviviria a ejecutar con retraso. (source, pick_id) NO es unico solo:
  -- los ids de picks y model_picks colisionan, por eso va source en la clave.
  CREATE TABLE IF NOT EXISTS pick_exec_probe (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,        -- 'heur' | 'model'
    pick_id INTEGER NOT NULL,
    delay_s INTEGER NOT NULL,    -- retraso PROGRAMADO (10/30/60)
    emit_ts TEXT NOT NULL,
    probe_ts TEXT NOT NULL,
    real_delay_ms INTEGER,       -- retraso REAL medido (el ratelimit puede demorarlo)
    odd_emit REAL,
    odd_seen REAL,
    status TEXT NOT NULL,        -- 'ok' | 'susp' | 'gone' | 'error'
    score_seen TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_exec_probe_uniq ON pick_exec_probe(source, pick_id, delay_s);

  -- Cola del piloto UI. Es independiente de pick_exec_probe: este ultimo
  -- observa el feed publico a +10/+30/+60 s; la cola solo agenda una
  -- comprobacion visual segura (list_only) y nunca confirma una apuesta.
  CREATE TABLE IF NOT EXISTS dry_run_jobs (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    source           TEXT NOT NULL,              -- 'heur' | 'model'
    pick_id          INTEGER NOT NULL,
    event_id         INTEGER NOT NULL,
    sport_id         INTEGER,
    sport            TEXT,
    market           TEXT NOT NULL,
    selection        TEXT NOT NULL,
    odd_emit         REAL NOT NULL,
    pick_ts          TEXT NOT NULL,
    mode             TEXT NOT NULL DEFAULT 'list_only',
    status           TEXT NOT NULL DEFAULT 'pending',
    attempts         INTEGER NOT NULL DEFAULT 0,
    max_attempts     INTEGER NOT NULL DEFAULT 2,
    available_at     TEXT NOT NULL,
    claimed_by       TEXT,
    lease_until      TEXT,
    started_at       TEXT,
    finished_at      TEXT,
    last_error       TEXT,
    last_run_id      INTEGER,
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL,
    UNIQUE(source, pick_id)
  );
  CREATE INDEX IF NOT EXISTS idx_dry_run_jobs_claim
    ON dry_run_jobs(status, available_at, lease_until);

  -- Estado del circuit breaker del worker. Si el perfil queda sucio o la
  -- defensa de red bloquea una escritura, se deja de consumir la cola hasta
  -- que el operador lo inspeccione y lo restablezca explicitamente.
  CREATE TABLE IF NOT EXISTS dry_run_worker_state (
    id             INTEGER PRIMARY KEY CHECK (id = 1),
    circuit_open   INTEGER NOT NULL DEFAULT 0,
    reason         TEXT,
    opened_at      TEXT,
    updated_at     TEXT NOT NULL
  );

  -- Bitacora por INTENTO, no solo por pick. source evita colisiones entre
  -- picks y model_picks; job_id enlaza cada evidencia con su unidad de cola.
  CREATE TABLE IF NOT EXISTS bot_dry_run_log (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    ts                    TEXT NOT NULL,
    started_at            TEXT,
    finished_at           TEXT,
    source                TEXT,
    job_id                INTEGER,
    attempt               INTEGER,
    mode                  TEXT,
    pick_id               INTEGER,
    event_id              INTEGER,
    sport_id              INTEGER,
    market                TEXT,
    selection             TEXT,
    odd_emit              REAL,
    odd_betslip           REAL,
    odd_drift_pct         REAL,
    rechazo_regla         INTEGER DEFAULT 0,
    latencia_dom_ms       INTEGER,
    latencia_click_ms     INTEGER,
    latencia_total_ms     INTEGER,
    latencia_desde_emit_ms INTEGER,
    status                TEXT,
    error_msg             TEXT,
    screenshot_path       TEXT,
    bloqueos              TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_dry_run_ts   ON bot_dry_run_log (ts);
  -- idx_dry_run_pick (source, pick_id) e idx_dry_run_job (job_id, attempt) se crean MAS ABAJO,
  -- despues de los addColumn(): si bot_dry_run_log ya existia con el esquema viejo (creado por
  -- src/dryRunBetslip.js antes de que este archivo cargara), CREATE TABLE IF NOT EXISTS no le
  -- agrega columnas, y un CREATE INDEX sobre source/job_id aqui truena con "no such column"
  -- ANTES de que addColumn tenga oportunidad de agregarlas. Bot en crash-loop 2026-09-28 por esto.

  CREATE TABLE IF NOT EXISTS value_alerts (
    pick_id       INTEGER PRIMARY KEY,
    ts            TEXT NOT NULL,
    odd_alertada  REAL,
    edge_alertado REAL,
    conf_alertada REAL,
    dry_run       INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_value_alerts_ts ON value_alerts(ts);

  CREATE INDEX IF NOT EXISTS idx_stat_res_event ON stat_results(event_id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_stat_res_unico
    ON stat_results(event_id, familia, linea);
`);

// Columnas de Etapa 0 (idempotente: en BDs ya migradas no hace nada)
function addColumn(table, col, def) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
}
addColumn('snapshots', 'suspended', 'INTEGER NOT NULL DEFAULT 0');
addColumn('bot_dry_run_log', 'started_at', 'TEXT');
addColumn('bot_dry_run_log', 'finished_at', 'TEXT');
addColumn('bot_dry_run_log', 'source', 'TEXT');
addColumn('bot_dry_run_log', 'job_id', 'INTEGER');
addColumn('bot_dry_run_log', 'attempt', 'INTEGER');
addColumn('bot_dry_run_log', 'mode', 'TEXT');
addColumn('bot_dry_run_log', 'latencia_desde_emit_ms', 'INTEGER');
addColumn('bot_dry_run_log', 'bloqueos', 'TEXT');
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_dry_run_source_pick ON bot_dry_run_log(source, pick_id);
  CREATE INDEX IF NOT EXISTS idx_dry_run_job ON bot_dry_run_log(job_id, attempt);
`);

// Picks de CORNERS en registro (src/cornerPicks.js): experimento, sin stake, aparte de picks/model_picks
// para que no toquen ninguna métrica de rendimiento. Un pick por partido (índice único): INSERT OR IGNORE.
// Se liquida contra stat_results (conteo final de FotMob, ya etiquetado por el piloto).
db.exec(`
  CREATE TABLE IF NOT EXISTS corner_picks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    event_id INTEGER NOT NULL, fotmob_event_id INTEGER, event TEXT, champ TEXT,
    minuto REAL, conteo_real INTEGER,
    linea REAL NOT NULL, lado TEXT NOT NULL, odd REAL,
    p_modelo REAL, p_mercado REAL, edge REAL, esperados REAL, nb_version TEXT,
    result TEXT, final_count INTEGER, settled_ts TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_corner_picks_evento ON corner_picks(event_id);
  CREATE INDEX IF NOT EXISTS idx_corner_picks_pend ON corner_picks(result, ts);
`);
const insCornerPick = db.prepare(`
  INSERT OR IGNORE INTO corner_picks
    (ts, event_id, fotmob_event_id, event, champ, minuto, conteo_real, linea, lado, odd, p_modelo, p_mercado, edge, esperados, nb_version)
  VALUES (@ts, @eventId, @fotmobEventId, @event, @champ, @minuto, @conteoReal, @linea, @lado, @odd, @pModelo, @pMercado, @edge, @esperados, @nbVersion)`);
// Devuelve el id nuevo, o null si ese partido ya tenía pick (no volver a avisar).
function logCornerPick(p) {
  const r = insCornerPick.run({ ts: new Date().toISOString(), fotmobEventId: null, champ: null, esperados: null, ...p });
  return r.changes ? Number(r.lastInsertRowid) : null;
}
const countCornerSinceStmt = db.prepare('SELECT COUNT(*) n FROM corner_picks WHERE ts >= ?');
const cornerPendStmt = db.prepare('SELECT * FROM corner_picks WHERE result IS NULL ORDER BY id');
// LAZY a propósito: fotmob_conteo_final lo crea un addColumn más abajo en este archivo; preparar la
// consulta aquí reventaba en una BD nueva con "no such column" (mismo orden que tumbó el bot el 2026-09-28).
let cornerEtiquetaStmt = null;
const cornerEtiqueta = (eventId, linea) => (cornerEtiquetaStmt ||= db.prepare(`SELECT fotmob_conteo_final c FROM stat_results
  WHERE event_id = ? AND familia = 'corner' AND linea = ? AND fotmob_conteo_final IS NOT NULL LIMIT 1`)).get(eventId, linea);
const cornerSettleStmt = db.prepare('UPDATE corner_picks SET result = ?, final_count = ?, settled_ts = ? WHERE id = ?');

// xG pre-partido normalizado por liga (src/prematchXg.js). Se CONSERVAN las
// columnas xg_esperado_* originales (promedio simple ataque+defensa) y se
// añaden las normalizadas, para poder medir despues cual de las dos predice
// mejor los goles reales en vez de sustituir una por la otra a ciegas.
addColumn('prematch_xg_scan', 'league_id', 'INTEGER');
addColumn('prematch_xg_scan', 'season_id', 'TEXT');
addColumn('prematch_xg_scan', 'league_xg_avg', 'REAL');
// xG esperado (simple) del partido al momento de mostrar la pata: para cruzarlo con el resultado
// cuando haya record pre-partido propio (pedido 2026-09-25). NULL si el piloto de xG no cubria el partido.
addColumn('prematch_report_picks', 'xg_local', 'REAL');
addColumn('prematch_report_picks', 'xg_visita', 'REAL');
addColumn('prematch_report_picks', 'xg_total', 'REAL');
addColumn('prematch_xg_scan', 'xg_norm_local', 'REAL');
addColumn('prematch_xg_scan', 'xg_norm_visita', 'REAL');
addColumn('prematch_xg_scan', 'xg_norm_total', 'REAL');

// Promedio de xG por liga y temporada, desde la tabla completa de FotMob
// (data.fotmob.com/stats/{liga}/season/{temporada}/expected_goals_team.json).
// xg_por_equipo_partido = xG total / partidos-equipo; el total esperado de un
// partido promedio es el doble. Cache con TTL: 1 request por liga, no por evento.
db.exec(`
  CREATE TABLE IF NOT EXISTS league_xg_avg (
    league_id INTEGER NOT NULL,
    season_id TEXT NOT NULL,
    league_name TEXT,
    n_equipos INTEGER,
    xg_total REAL,
    partidos_equipo INTEGER,
    xg_por_equipo_partido REAL,
    updated_ts TEXT NOT NULL,
    PRIMARY KEY (league_id, season_id)
  );
`);

// Continuacion de la migracion SofaScore -> FotMob (ver renameTableIfNeeded
// mas arriba, donde ya se corrigieron las columnas de fotmob_corner_snapshots
// y fotmob_forecast_snapshots). stat_results nunca se renombro como tabla
// (sus columnas sofa_* se agregaron via addColumn, no existian en el CREATE
// de mas arriba), asi que sus columnas se corrigen aqui, antes de que los
// addColumn de mas abajo (ya con los nombres nuevos) corran como no-op sobre
// ellas.
renameColumnIfNeeded('stat_results', 'sofa_event_id', 'fotmob_event_id');
renameColumnIfNeeded('stat_results', 'sofa_conteo_final', 'fotmob_conteo_final');
renameColumnIfNeeded('stat_results', 'sofa_lado_ganador', 'fotmob_lado_ganador');
renameColumnIfNeeded('stat_results', 'sofa_extra_stats', 'fotmob_extra_stats');
// Indices viejos que quedaron apuntando al nombre pre-rename (SQLite los
// mantiene funcionales tras el RENAME COLUMN, pero los de mas abajo ya crean
// el equivalente con nombre nuevo — sin este DROP quedarian duplicados).
db.exec('DROP INDEX IF EXISTS idx_sofa_ts');
db.exec('DROP INDEX IF EXISTS idx_sofa_event');

// Columnas del piloto de estadisticas. `corners` se renombra a `conteo` porque
// ya no es solo de corners; las filas viejas conservan su valor.
(function migrarColumnasStats() {
  const cols = db.prepare('PRAGMA table_info(stat_snapshots)').all().map(c => c.name);
  if (cols.includes('corners') && !cols.includes('conteo')) {
    db.exec('ALTER TABLE stat_snapshots RENAME COLUMN corners TO conteo');
  }
})();
addColumn('stat_snapshots', 'conteo', 'INTEGER');
// Familia del mercado: 'corner' | 'tarjeta'. Las filas anteriores al cambio son
// todas de corners y se rellenan una sola vez; a partir de ahi lo escribe el
// extractor. Sin este sello, un analisis sumaria corners y tarjetas en el mismo
// saco sin enterarse.
addColumn('stat_snapshots', 'familia', 'TEXT');
// Relleno unico de las filas anteriores al sello de familia. VA CONDICIONADO a
// que quede alguna: sin el SELECT previo, este UPDATE se ejecutaba en CADA carga
// del modulo y competia por el lock de escritura con el bot vivo — cualquier
// script auxiliar reventaba con SQLITE_BUSY al arrancar.
if (db.prepare('SELECT 1 FROM stat_snapshots WHERE familia IS NULL LIMIT 1').get()) {
  db.prepare("UPDATE stat_snapshots SET familia='corner' WHERE familia IS NULL").run();
}
// oddStatus crudo. Hace falta desde que se dejaron de filtrar los precios
// degenerados: un 0 suspendido y un 1.0 resuelto son cosas distintas y ambas
// son evidencia.
addColumn('stat_snapshots', 'odd_status', 'INTEGER');
addColumn('stat_snapshots', 'feature_version', 'TEXT');
// Indices del mercado del N-esimo abiertos en esa muestra, en JSON. Es la
// EVIDENCIA de la que sale `conteo`. Se aniadio tras descubrir que la regla del
// conteo estaba mal (usaba el maximo en vez del minimo) y no habia forma de
// recalcular el historico, porque solo se habia guardado el escalar derivado.
addColumn('stat_snapshots', 'conteo_indices', 'TEXT');
// SCORER EN SOMBRA (Poisson). Probabilidad que da el proceso de llegada para el
// lado DE ESTA FILA, en la misma orientacion que fair_prob para poder restarlas
// sin pensar. No decide nada: se guarda para poder medir su calibracion HACIA
// ATRAS el dia que haya etiquetas, en vez de empezar a contar ese dia.
addColumn('stat_snapshots', 'p_poisson', 'REAL');
// La lambda con la que se calculo. Va a cambiar en cuanto se mida bien, y sin
// este sello un analisis mezclaria dos modelos distintos sin enterarse — la
// misma leccion que model_version.
addColumn('stat_snapshots', 'lambda_poisson', 'REAL');
// Minuto de la ULTIMA lectura del contador. Es lo que decide si su valor sirve
// como conteo final para etiquetar la escalera entera.
addColumn('stat_results', 'minuto_ultimo_conteo', 'REAL');
// Certeza de la etiqueta. 'cierta' = demostrada (monotonia del contador o precio
// ya colapsado); 'probable' = el contador seguia vivo pasado el 85 y quedo bajo
// la linea, pero un corner en el descuento la voltea. Sin esta columna las dos
// se mezclarian en lado_ganador y un entrenamiento no podria excluir las dudosas.
addColumn('stat_results', 'certeza', 'TEXT');
// Maximo del contador visto en el partido: la base de la regla de monotonia.
addColumn('stat_results', 'conteo_max', 'INTEGER');
// 1 si la serie del contador es creible (no decreciente y con >=2 observaciones).
// 0 si se detecto una lectura corrupta. NULL si nunca hubo contador.
addColumn('stat_results', 'serie_fiable', 'INTEGER');
// SEGUNDA FUENTE: etiqueta derivada del conteo DIRECTO de FotMob (ver
// src/fotmobMatch.js), sobre la MISMA fila en vez de una fila aparte — el
// indice unico de stat_results es (event_id, familia, linea), asi que esto
// permite comparar playdoit vs FotMob linea por linea sin tocarlo.
//
// NULL cuando no hubo match con FotMob o el partido no aparecia como
// terminado en su feed al momento de liquidar (ver getFotmobCornerFinal en
// este archivo) — antes NULL que un conteo a medio partido, la misma regla
// que ya rige lado_ganador.
//
// SIN BACKFILL: se calcula UNA vez, al liquidar el evento de playdoit
// (insertStatResultStmt es INSERT OR IGNORE). Si FotMob no habia marcado
// el partido como terminado en ese instante, estas columnas quedan NULL para
// siempre en esa fila — es una limitacion conocida del pilotaje, no un bug.
addColumn('stat_results', 'fotmob_event_id', 'INTEGER');
addColumn('stat_results', 'fotmob_conteo_final', 'INTEGER');
addColumn('stat_results', 'fotmob_lado_ganador', 'TEXT');
// Aniadida despues del CREATE TABLE original de fotmob_corner_snapshots — en
// cualquier BD donde la tabla ya se hubiera creado sin ella (incluidas las
// de pruebas de esta misma sesion), CREATE TABLE IF NOT EXISTS ya no la
// aplica, hace falta el ALTER explicito.
addColumn('fotmob_corner_snapshots', 'status_type', 'TEXT');
// FASE 2 del plan de features para el modelo de corners (2026-09-10):
// captura SIN USAR de estadisticas de equipo adicionales (posesion, tiros,
// pases, etc., segun lo que traiga cada liga), en JSON. NO decide nada —
// solo permite medir despues, con historico real, si alguna correlaciona
// con lo que falta de corners. Ver src/fotmobScraper.js para el detalle de
// que campos captura.
addColumn('fotmob_corner_snapshots', 'extra_stats', 'TEXT');
// Version del NB que produjo p_modelo/edge de cada pronostico guardado:
// 'nb-orig' (mu=12.985, t/90) o 'nb-cal-1' (calibrado contra finales de
// FotMob, ver src/nbCalibrado.js). NULL = anterior al sello, o sea 'nb-orig'.
// Sin esto el historial mezclaria dos calibraciones distintas del mismo
// modelo sin avisar — la misma leccion que model_version.
addColumn('fotmob_forecast_snapshots', 'nb_version', 'TEXT');
addColumn('stat_results', 'fotmob_extra_stats', 'TEXT');
addColumn('picks', 'result_source', 'TEXT');
addColumn('picks', 'closing_odd_decimal', 'REAL');
addColumn('picks', 'closing_ts', 'TEXT');
addColumn('picks', 'sharp_closing_odd', 'REAL');
// Etapa 2: factores crudos del score + scores heurístico/aprendido (shadow)
addColumn('picks', 'f_prob_justa', 'REAL');
addColumn('picks', 'f_avance', 'REAL');
// f_avance guarda el avance CRUDO (progress), pero el modelo consume una
// versión transformada (invertida para los "Más de" con la línea sin alcanzar).
// Entrenar sobre f_avance y servir la transformada era un train/serve skew: para
// cada Over el modelo veía en producción el espejo de lo que aprendió. Esta
// columna guarda el valor REALMENTE SERVIDO, que es el que debe exportarse al
// dataset. f_avance se conserva tal cual porque el firewall y sus backtests
// dependen del crudo. Backfill: scripts/backfill-avance-model.js
addColumn('picks', 'f_avance_model', 'REAL');
addColumn('picks', 'f_situacion', 'REAL');
addColumn('picks', 'f_linea', 'REAL');
addColumn('picks', 'conf_heuristic', 'REAL');
addColumn('picks', 'conf_learned', 'REAL');
// Etapa 4: fuente sharp de referencia + edge estimado
addColumn('picks', 'sharp_entry_odd', 'REAL');
addColumn('picks', 'sharp_source', 'TEXT');
addColumn('picks', 'sharp_event_id', 'TEXT');
addColumn('picks', 'loss_minute', 'INTEGER');
addColumn('picks', 'sharp_closing_market', 'TEXT');
addColumn('picks', 'sharp_match', 'TEXT');
addColumn('picks', 'edge', 'REAL');
// Unidades de apuesta asignadas al emitir el pick
addColumn('picks', 'stake', 'REAL');
addColumn('picks', 'stake_mode', 'TEXT');
addColumn('picks', 'source', 'TEXT'); // comando que emitió el pick: seguras | golden
// Etapa 5: momio de la primera observación en vivo y drift desde ella
addColumn('picks', 'opening_odd_decimal', 'REAL');
addColumn('picks', 'f_apertura', 'REAL');
// Versión del cálculo de features (ver SCORE_VERSION en confidence.js).
// Los picks anteriores al arreglo de f_linea quedan marcados como v1.
addColumn('picks', 'score_version', 'INTEGER');
db.prepare(`UPDATE picks SET score_version = 1 WHERE score_version IS NULL`).run();
// conf_learned en el grupo de control (2026-08-24). Sin esta columna solo se
// puede simular MEDIA de lo que haria MODEL_MODE=learned: se ve que picks
// EMITIDOS dejaria de emitir, pero no cuales RECHAZADOS empezaria a emitir —
// y esos son justo la poblacion sin validar que hace arriesgado activarlo.
// Con la columna, dentro de unas semanas la simulacion es completa.
addColumn('rejected_picks', 'conf_learned', 'REAL');

// Estado del partido en el instante del pick de sombra. f_avance ya guarda el
// avance normalizado, pero no el marcador ni el minuto crudos, y sin ellos no
// se puede reconstruir por que el modelo eligio lo que eligio ni auditar un
// pick a mano. Los picks reales no los guardan (se reconstruyen desde
// snapshots); aqui se guardan porque la sombra existe justo para ser leida.
// Sello del modelo que produjo conf_learned (ver src/model.js:modelVersion).
// Sin el, agrupar por conf_learned cruzando dos modelos mezcla dos escalas
// distintas sin avisar: cada reentrenamiento mueve el significado del numero,
// y el cambio de calibracion isotonica -> Platt del 2026-08-25 lo movio mucho.
// Las filas anteriores quedan NULL = "modelo desconocido, anterior al sello".
addColumn('picks', 'model_version', 'TEXT');
// El MODO con el que se puntuo la fila. Con MODEL_MODE=learned la columna `conf`
// deja de ser el heuristico y pasa a ser conf_learned: mismo nombre, otra cosa.
// Sin este sello, cualquier analisis que cruce el corte mezcla dos regimenes de
// decision — el mismo error que el sello de version resuelve para el modelo.
addColumn('picks', 'model_mode', 'TEXT');
addColumn('model_picks', 'model_version', 'TEXT');
addColumn('rejected_picks', 'model_version', 'TEXT');

addColumn('model_picks', 'entry_score', 'TEXT');
addColumn('model_picks', 'entry_minute', 'REAL');
addColumn('model_picks', 'entry_live_time', 'TEXT');


// Cursor del prune: por dónde iba el escaneo. Vive entre llamadas para que
// cada pasada avance en vez de re-mirar siempre las mismas filas viejas.
let pruneCursor = 0;

const insertStmt = db.prepare(`
  INSERT INTO snapshots (ts, sport, sport_id, champ, event_id, event, score, live_time, market, selection, odd_decimal, odd_american, suspended)
  VALUES (@ts, @sport, @sportId, @champ, @eventId, @event, @score, @liveTime, @market, @selection, @oddDecimal, @oddAmerican, @suspended)
`);

const insertMany = db.transaction((rows) => {
  for (const r of rows) insertStmt.run(r);
});

function saveSnapshot(rows) {
  const t0 = Date.now();
  insertMany(rows);
  const ms = Date.now() - t0;
  // Temporal: better-sqlite3 es sincrono y esta transaccion bloquea el hilo
  // unico de Node mientras dura, incluida la respuesta a comandos de Telegram
  // que ya hayan llegado. Confirmar si el crecimiento de la BD (17.6GB+) la
  // esta volviendo lo bastante lenta como para notarse en la latencia del bot.
  if (ms > 200) console.log(`[db] saveSnapshot: ${rows.length} filas en ${ms}ms`);
}

const insertPrematchStmt = db.prepare(`
  INSERT INTO prematch_snapshots
    (ts, sport, sport_id, champ, event_id, event, start_date, market, selection, odd_decimal, odd_american, suspended)
  VALUES (@ts, @sport, @sportId, @champ, @eventId, @event, @startDate, @market, @selection, @oddDecimal, @oddAmerican, @suspended)
`);
const insertPrematchMany = db.transaction((rows) => {
  for (const r of rows) insertPrematchStmt.run(r);
});
function savePrematchSnapshot(rows) {
  const t0 = Date.now();
  insertPrematchMany(rows);
  const ms = Date.now() - t0;
  if (ms > 200) console.log(`[db] savePrematchSnapshot: ${rows.length} filas en ${ms}ms`);
}

const insertPrematchScanStmt = db.prepare(`
  INSERT INTO prematch_value_scan
    (ts, event_id, event, champ, sport_key, market, bookmaker, selection, sharp_odd, playdoit_odd, edge_pct, start_date)
  VALUES (@ts, @eventId, @event, @champ, @sportKey, @market, @bookmaker, @selection, @sharpOdd, @playdoitOdd, @edgePct, @startDate)
`);
const insertPrematchScanMany = db.transaction((rows) => {
  for (const r of rows) insertPrematchScanStmt.run(r);
});
function savePrematchValueScan(rows) {
  if (rows.length) insertPrematchScanMany(rows);
}

const insertPrematchXgStmt = db.prepare(`
  INSERT OR REPLACE INTO prematch_xg_scan
    (ts, event_id, event, start_date, fotmob_match_id,
     home_team_id, home_played, home_xg_for, home_xg_against,
     away_team_id, away_played, away_xg_for, away_xg_against,
     xg_esperado_local, xg_esperado_visita, xg_esperado_total,
     league_id, season_id, league_xg_avg, xg_norm_local, xg_norm_visita, xg_norm_total)
  VALUES (@ts, @eventId, @event, @startDate, @fotmobMatchId,
     @homeTeamId, @homePlayed, @homeXgFor, @homeXgAgainst,
     @awayTeamId, @awayPlayed, @awayXgFor, @awayXgAgainst,
     @xgEsperadoLocal, @xgEsperadoVisita, @xgEsperadoTotal,
     @leagueId, @seasonId, @leagueXgAvg, @xgNormLocal, @xgNormVisita, @xgNormTotal)
`);

const upsertLeagueXgStmt = db.prepare(`
  INSERT OR REPLACE INTO league_xg_avg
    (league_id, season_id, league_name, n_equipos, xg_total, partidos_equipo, xg_por_equipo_partido, updated_ts)
  VALUES (@leagueId, @seasonId, @leagueName, @nEquipos, @xgTotal, @partidosEquipo, @xgPorEquipoPartido, @updatedTs)
`);
const getLeagueXgStmt = db.prepare('SELECT * FROM league_xg_avg WHERE league_id = ? AND season_id = ?');
function saveLeagueXg(row) { upsertLeagueXgStmt.run(row); }
function getLeagueXg(leagueId, seasonId) { return getLeagueXgStmt.get(leagueId, String(seasonId)) || null; }
const insReportPick = db.prepare(`INSERT INTO prematch_report_picks
  (ts, dia, kind, event_id, event, champ, start_date, market, selection, odd_decimal, p_justa, xg_local, xg_visita, xg_total)
  VALUES (@ts, @dia, @kind, @event_id, @event, @champ, @start_date, @market, @selection, @odd_decimal, @p_justa, @xg_local, @xg_visita, @xg_total)`);
function saveReportPicks(filas) {
  db.transaction((fs_) => { for (const f of fs_) insReportPick.run({ xg_local: null, xg_visita: null, xg_total: null, ...f }); })(filas);
}
// Patas de reportes desde `desdeDia` (YYYY-MM-DD, CDMX): parlay primero, luego valor, luego top; cada grupo por hora de inicio.
// kind='parlay_prox' (botón /parlayprox, solo lo guarda el dueño) se EXCLUYE de las dos consultas del
// reporte de las 08:00: reporteYaEnviado bloquearía el reporte del día si alguien lo presiona antes de
// las 08:00, y reporteEstado mezclaría sus patas en los KPIs de aciertos y desplazaría filas del tope
// de la imagen. Se audita aparte (scripts/medir-calibracion-parlay-prepartido.js).
const reporteEstado = (desdeDia) => db.prepare(
  "SELECT * FROM prematch_report_picks WHERE dia >= ? AND kind != 'parlay_prox' ORDER BY dia DESC, CASE kind WHEN 'parlay' THEN 0 WHEN 'valor' THEN 1 ELSE 2 END, start_date").all(desdeDia);
const reporteYaEnviado = (dia) => !!db.prepare("SELECT 1 FROM prematch_report_picks WHERE dia = ? AND kind != 'parlay_prox' LIMIT 1").get(dia);

// Firma de un parlay: sus patas (evento|mercado|selección) ordenadas. Dos parlays con las mismas patas
// son el mismo parlay aunque se hayan armado en otro orden o a otra hora.
const firmaParlay = (filas) => filas.map(f => `${f.event_id}|${f.market}|${f.selection}`).sort().join(';');
/**
 * Registra un parlay del botón /parlayprox para auditarlo. Todas las filas comparten `ts`. Devuelve true
 * si se guardó, false si ESE MISMO parlay ya estaba registrado ese día (presionar el botón cinco veces
 * no crea cinco parlays).
 */
function guardarParlayProx(filas, dia) {
  if (!filas || !filas.length) return false;
  const porTs = new Map();
  for (const r of db.prepare("SELECT ts, event_id, market, selection FROM prematch_report_picks WHERE dia = ? AND kind = 'parlay_prox'").all(dia)) {
    if (!porTs.has(r.ts)) porTs.set(r.ts, []);
    porTs.get(r.ts).push(r);
  }
  const nueva = firmaParlay(filas);
  for (const rs of porTs.values()) if (firmaParlay(rs) === nueva) return false;
  saveReportPicks(filas);
  return true;
}
const reportePendientes = (cutoffIso) => db.prepare(
  "SELECT * FROM prematch_report_picks WHERE result IS NULL AND start_date < ? ORDER BY start_date").all(cutoffIso);
const liquidarReportePick = (id, result, finalScore, source) => db.prepare(
  "UPDATE prematch_report_picks SET result=?, final_score=?, score_source=?, settled_ts=? WHERE id=?")
  .run(result, finalScore, source, new Date().toISOString(), id);

function savePrematchXg(row) {
  insertPrematchXgStmt.run(row);
}

const insertStatStmt = db.prepare(`
  INSERT INTO stat_snapshots
    (ts, familia, event_id, event, champ, live_time, minute, market, selection,
     linea, lado, odd_decimal, fair_prob, odd_status, suspended, conteo,
     conteo_indices, p_poisson, lambda_poisson, feature_version)
  VALUES (@ts, @familia, @eventId, @event, @champ, @liveTime, @minute, @market, @selection,
     @linea, @lado, @oddDecimal, @fairProb, @oddStatus, @suspended, @conteo,
     @conteoIndices, @pPoisson, @lambdaPoisson, @featureVersion)
`);
const insertStats = db.transaction((rows) => {
  for (const r of rows) insertStatStmt.run(r);
});
function saveStatSnapshot(rows) {
  if (rows && rows.length) insertStats(rows);
}

const insertFotmobStmt = db.prepare(`
  INSERT INTO fotmob_corner_snapshots
    (ts, fotmob_event_id, home, away, tournament, corners_home, corners_away, status, status_type, extra_stats)
  VALUES (@ts, @fotmobEventId, @home, @away, @tournament, @cornersHome, @cornersAway, @status, @statusType, @extraStats)
`);
const insertFotmob = db.transaction((rows) => {
  for (const r of rows) insertFotmobStmt.run(r);
});
function saveFotmobSnapshot(rows) {
  if (rows && rows.length) insertFotmob(rows);
}

// Ultima lectura de un evento de FotMob. Solo sirve como conteo FINAL si
// status_type='finished' — de lo contrario el partido seguia en curso y el
// numero no es definitivo (ver comentario del CREATE TABLE). El llamador
// (bot.js liquidarEvento) es quien decide que hacer con un NULL; esta query
// no filtra por status_type para poder distinguir "no hay dato" de "hay dato
// pero el partido no habia terminado".
const fotmobUltimaStmt = db.prepare(`
  SELECT * FROM fotmob_corner_snapshots WHERE fotmob_event_id = ? ORDER BY ts DESC LIMIT 1
`);
function getFotmobCornerFinal(fotmobEventId) {
  const fila = fotmobUltimaStmt.get(fotmobEventId);
  if (!fila) return null;
  if (fila.status_type !== 'finished') return null;
  if (fila.corners_home == null || fila.corners_away == null) return null;
  return { total: fila.corners_home + fila.corners_away, status: fila.status };
}

// Misma ultima lectura que getFotmobCornerFinal, pero SIN exigir
// status_type='finished' — para /fotmob en vivo, que quiere el conteo tal
// cual va el partido, no el definitivo.
function getFotmobCornerLatest(fotmobEventId) {
  const fila = fotmobUltimaStmt.get(fotmobEventId);
  if (!fila) return null;
  if (fila.corners_home == null || fila.corners_away == null) return null;
  return {
    total: fila.corners_home + fila.corners_away,
    home: fila.corners_home, away: fila.corners_away,
    status: fila.status, statusType: fila.status_type, ts: fila.ts,
  };
}

// Lineas de corners que SI matchearon con FotMob (fotmob_lado_ganador no
// nulo) — lo que pide /fotmob en Telegram. Mas recientes primero.
const fotmobComparadasStmt = db.prepare(`
  SELECT event, champ, linea, lado_ganador, certeza, conteo_final,
         fotmob_conteo_final, fotmob_lado_ganador, settled_ts
  FROM stat_results
  WHERE familia = 'corner' AND fotmob_lado_ganador IS NOT NULL
  ORDER BY settled_ts DESC LIMIT ?
`);
function getFotmobComparadas(limite = 20) {
  return fotmobComparadasStmt.all(limite);
}

// Historial de pronosticos EN VIVO — ver comentario del CREATE TABLE arriba.
// `sugerida` viene de src/fotmobLive.js:elegirSugerida (misma forma para
// bot.js al guardar y para el dashboard al leer).
const insertForecastStmt = db.prepare(`
  INSERT INTO fotmob_forecast_snapshots
    (ts, event_id, fotmob_event_id, event, minuto, linea, lado, odd, p_modelo, p_mercado, edge, conteo_real, esperados, nb_version)
  VALUES (@ts, @eventId, @fotmobEventId, @event, @minuto, @linea, @lado, @odd, @pModelo, @pMercado, @edge, @conteoReal, @esperados, @nbVersion)
`);
function saveForecastSnapshot(row) {
  insertForecastStmt.run({
    ts: row.ts || new Date().toISOString(),
    eventId: row.eventId,
    fotmobEventId: row.fotmobEventId ?? null,
    event: row.event ?? null,
    minuto: row.minuto ?? null,
    linea: row.linea,
    lado: row.lado,
    odd: row.odd ?? null,
    pModelo: row.pModelo ?? null,
    pMercado: row.pMercado ?? null,
    edge: row.edge ?? null,
    conteoReal: row.conteoReal ?? null,
    esperados: row.esperados ?? null,
    nbVersion: row.nbVersion ?? null,
  });
}

const forecastHistoryStmt = db.prepare(`
  SELECT ts, fotmob_event_id, event, minuto, linea, lado, odd, p_modelo, p_mercado, edge, conteo_real, esperados
  FROM fotmob_forecast_snapshots
  WHERE event_id = ?
  ORDER BY ts DESC LIMIT ?
`);
function getForecastHistory(eventId, limite = 50) {
  return forecastHistoryStmt.all(eventId, limite);
}

// Eventos con muestras y todavia sin etiquetar. Es la cola de liquidacion del
// piloto: el ciclo comprueba cuales han terminado y los cierra.
const statPendientesStmt = db.prepare(`
  SELECT DISTINCT s.event_id FROM stat_snapshots s
  LEFT JOIN stat_results r ON r.event_id = s.event_id
  WHERE r.event_id IS NULL
`);
const statMuestrasStmt = db.prepare(`
  SELECT * FROM stat_snapshots WHERE event_id = ? ORDER BY ts
`);
// INSERT OR IGNORE contra el indice unico: reintentar la liquidacion de un
// evento no duplica ni pisa lo ya escrito.
const insertStatResultStmt = db.prepare(`
  INSERT OR IGNORE INTO stat_results
    (event_id, event, champ, familia, linea, lado_ganador, metodo, certeza,
     conteo_final, conteo_max, serie_fiable, conteo_censurado, minuto_ultimo_conteo,
     ultimo_minuto, ultima_ts, n_muestras,
     ultimo_odd_over, ultimo_odd_under, ultima_justa_over, ultima_justa_under,
     feature_version, settled_ts,
     fotmob_event_id, fotmob_conteo_final, fotmob_lado_ganador, fotmob_extra_stats)
  VALUES (@eventId, @event, @champ, @familia, @linea, @ladoGanador, @metodo, @certeza,
     @conteoFinal, @conteoMax, @serieFiable, @conteoCensurado, @minutoUltimoConteo,
     @ultimoMinuto, @ultimaTs, @nMuestras,
     @ultimoOddOver, @ultimoOddUnder, @ultimaJustaOver, @ultimaJustaUnder,
     @featureVersion, @settledTs,
     @fotmobEventId, @fotmobConteoFinal, @fotmobLadoGanador, @fotmobExtraStats)
`);
const insertStatResults = db.transaction((rows) => {
  for (const r of rows) insertStatResultStmt.run(r);
});
function saveStatResults(rows) {
  if (rows && rows.length) insertStatResults(rows);
}

// Re-etiquetado: borra las etiquetas de un evento para volver a derivarlas. La
// evidencia vive en stat_snapshots, asi que esto NO pierde nada — es justamente
// la razon por la que se guardo la evidencia y no solo la conclusion.
const borrarStatResultsStmt = db.prepare('DELETE FROM stat_results WHERE event_id = ?');

const insertPickStmt = db.prepare(`
  INSERT INTO picks (ts, event_id, event, sport, market, selection, odd_decimal, conf,
    f_prob_justa, f_avance, f_avance_model, f_situacion, f_linea, conf_heuristic, conf_learned, edge, source,
    opening_odd_decimal, f_apertura, score_version, stake, stake_mode, model_version, model_mode)
  VALUES (@ts, @eventId, @event, @sport, @market, @selection, @oddDecimal, @conf,
    @fProbJusta, @fAvance, @fAvanceModel, @fSituacion, @fLinea, @confHeuristic, @confLearned, @edge, @source,
    @openingOdd, @fApertura, @scoreVersion, @stake, @stakeMode, @modelVersion, @modelMode)
`);
// Devuelve los rowid insertados (necesarios para la captura sharp posterior)
const logPicks = db.transaction((picks) => {
  const ids = [];
  for (const p of picks) {
    const info = insertPickStmt.run({
      fProbJusta: null, fAvance: null, fAvanceModel: null, fSituacion: null, fLinea: null,
      confHeuristic: null, confLearned: null, edge: null, source: null,
      openingOdd: null, fApertura: null, scoreVersion: null, stake: null, stakeMode: null,
      modelVersion: null, modelMode: null,
      ...p,
    });
    ids.push(Number(info.lastInsertRowid));
  }
  return ids;
});

// --- Grupo de control (rechazados) ---
// INSERT OR IGNORE: choca contra idx_rejected_uniq y descarta el duplicado sin
// error, que es justo lo que se quiere — el mismo candidato reaparece en cada
// ciclo de muestreo y solo interesa su primera aparición.
const insertRejectedStmt = db.prepare(`
  INSERT OR IGNORE INTO rejected_picks (ts, event_id, event, sport, market, selection,
    odd_decimal, conf, edge, reject_rule, f_prob_justa, f_avance, f_avance_model,
    f_situacion, f_linea, f_apertura, conf_heuristic, conf_learned, score_version, model_version)
  VALUES (@ts, @eventId, @event, @sport, @market, @selection,
    @oddDecimal, @conf, @edge, @rejectRule, @fProbJusta, @fAvance, @fAvanceModel,
    @fSituacion, @fLinea, @fApertura, @confHeuristic, @confLearned, @scoreVersion, @modelVersion)
`);
const logRejected = db.transaction((rows) => {
  let n = 0;
  for (const r of rows) {
    const info = insertRejectedStmt.run({
      eventId: null, event: null, sport: null, market: null, selection: null,
      oddDecimal: null, conf: null, edge: null, fProbJusta: null, fAvance: null,
      fAvanceModel: null, fSituacion: null, fLinea: null, fApertura: null,
      confHeuristic: null, confLearned: null, scoreVersion: null, modelVersion: null,
      ...r,
    });
    if (info.changes) n++;
  }
  return n;
});
const insertModelStmt = db.prepare(`
  INSERT OR IGNORE INTO model_picks (ts, event_id, event, sport, champ, market, selection,
    odd_decimal, conf_learned, conf_heuristic, edge_learned, tambien_heuristico,
    f_prob_justa, f_avance, f_avance_model, f_situacion, f_linea, f_apertura, score_version,
    entry_score, entry_minute, entry_live_time, model_version)
  VALUES (@ts, @eventId, @event, @sport, @champ, @market, @selection,
    @oddDecimal, @confLearned, @confHeuristic, @edgeLearned, @tambienHeuristico,
    @fProbJusta, @fAvance, @fAvanceModel, @fSituacion, @fLinea, @fApertura, @scoreVersion,
    @entryScore, @entryMinute, @entryLiveTime, @modelVersion)
`);
// Devuelve { n, ids }: n para el conteo de siempre (log y "ya estaban
// registrados"), ids paralelo a `rows` (mismo orden, null donde el INSERT OR
// IGNORE descarto un duplicado) para que el aviso de Telegram pueda mostrar
// el #id de cada pick de la sombra — igual que ya hace logPicks con los
// picks reales.
const logModelPicks = db.transaction((rows) => {
  let n = 0;
  const ids = [];
  for (const r of rows) {
    const info = insertModelStmt.run({
      eventId: null, event: null, sport: null, champ: null, market: null, selection: null,
      oddDecimal: null, confLearned: null, confHeuristic: null, edgeLearned: null,
      tambienHeuristico: 0, fProbJusta: null, fAvance: null, fAvanceModel: null,
      fSituacion: null, fLinea: null, fApertura: null, scoreVersion: null,
      entryScore: null, entryMinute: null, entryLiveTime: null, modelVersion: null,
      ...r,
    });
    if (info.changes) { n++; ids.push(Number(info.lastInsertRowid)); }
    else ids.push(null);
  }
  return { n, ids };
});
// Dedup por EVENTO para la sombra, igual que activeEventPickStmt hace con los
// picks reales. idx_model_uniq solo impedia repetir (evento, mercado, seleccion),
// asi que un mismo partido acumulaba varias filas correlacionadas: 155 registros
// sobre 116 eventos hasta el 2026-08-25, con un partido llegando a 4. Eso infla
// el N y rompe la independencia de la muestra, que es justo lo que esta tabla
// existe para preservar. Con esta guarda la sombra es comparable pick a pick
// con el real, sin desduplicar a mano en cada analisis.
const activeEventModelStmt = db.prepare(
  `SELECT 1 FROM model_picks WHERE event_id = ? AND result IS NULL LIMIT 1`);

const unsettledModelStmt = db.prepare(`SELECT * FROM model_picks WHERE result IS NULL`);
const settleModelStmt = db.prepare(
  `UPDATE model_picks SET result = ?, final_score = ?, settled_ts = ? WHERE id = ?`);

const unsettledRejectedStmt = db.prepare(`SELECT * FROM rejected_picks WHERE result IS NULL`);
const settleRejectedStmt = db.prepare(`
  UPDATE rejected_picks SET result = ?, final_score = ?, settled_ts = ? WHERE id = ?
`);

const unsettledStmt = db.prepare(`SELECT * FROM picks WHERE result IS NULL`);
const lastScoreStmt = db.prepare(`
  SELECT score, ts FROM snapshots WHERE event_id = ? AND score != '' ORDER BY ts DESC LIMIT 1
`);
// Ultimo marcador del TIEMPO REGULAR: descarta las muestras de la prorroga ("1ª/2ª Parte Adicional",
// "Descanso prorroga") y de los penales. Medido el 2026-09-25 (China (F) vs Vietnam (F), pick #9188): el partido
// termino 0-0 en el minuto 90, la prorroga lo dejo 1-0 y liquidamos con ese 1-0 => "Empate o Vietnam" salio LOSS
// cuando era WIN. "Esperando prorroga" SI cuenta: su marcador es el de los 90 minutos.
// Devuelve también `live_time` de esa muestra: es lo que permite saber si el marcador es del FINAL
// del partido o de una muestra vieja (results.js: marcadorEsFinal).
const lastRegularScoreStmt = db.prepare(`
  SELECT score, ts, live_time FROM snapshots WHERE event_id = ? AND score != ''
    AND (live_time IS NULL OR (live_time NOT LIKE '%Adicional%' AND live_time NOT LIKE '%Descanso pr%' AND live_time NOT LIKE '%enal%'))
  ORDER BY ts DESC LIMIT 1
`);
const lastSeenStmt = db.prepare(`SELECT MAX(ts) AS ts FROM snapshots WHERE event_id = ?`);
const settleStmt = db.prepare(`
  UPDATE picks SET result = ?, final_score = ?, settled_ts = ?, result_source = ?,
    closing_odd_decimal = ?, closing_ts = ?
  WHERE id = ? AND (result_source IS NULL OR result_source != 'official')
`);
const closingStmt = db.prepare(`
  SELECT odd_decimal, ts FROM snapshots
  WHERE event_id = ? AND market = ? AND selection = ? AND suspended = 0
  ORDER BY ts DESC LIMIT 1
`);
const statsStmt = db.prepare(`
  SELECT
    CASE WHEN conf >= 0.75 THEN 'alta (75%+)'
         WHEN conf >= 0.60 THEN 'media (60-75%)'
         ELSE 'baja (menos de 60%)' END AS bucket,
    SUM(CASE WHEN result = 'win' THEN 1 ELSE 0 END) AS wins,
    SUM(CASE WHEN result = 'loss' THEN 1 ELSE 0 END) AS losses
  FROM picks WHERE result IN ('win','loss')
  GROUP BY bucket ORDER BY bucket
`);
const pendingCountStmt = db.prepare(`SELECT COUNT(*) AS n FROM picks WHERE result IS NULL`);

// --- Picks pendientes de liquidar, con su estado en vivo ---
// A cada pick sin resultado se le pega la última foto que el sampler tomó del
// evento (marcador, minuto, liga) y la última cuota vista de SU misma
// selección. Comparar esa cuota con la de entrada es el único termómetro
// barato de "cómo va": si bajó, el mercado se movió a favor del pick.
// Los dos LEFT JOIN son sobre subconsultas correlacionadas porque un evento
// tiene cientos de filas en snapshots y solo interesa la más reciente.
const pendingDetailedStmt = db.prepare(`
  SELECT p.*,
         (SELECT s.champ FROM snapshots s WHERE s.event_id = p.event_id
           ORDER BY s.ts DESC LIMIT 1) AS champ,
         (SELECT s.score FROM snapshots s WHERE s.event_id = p.event_id AND s.score != ''
           ORDER BY s.ts DESC LIMIT 1) AS live_score,
         (SELECT s.live_time FROM snapshots s WHERE s.event_id = p.event_id
           ORDER BY s.ts DESC LIMIT 1) AS live_time,
         (SELECT MAX(s.ts) FROM snapshots s WHERE s.event_id = p.event_id) AS last_seen_ts,
         (SELECT s.odd_decimal FROM snapshots s
           WHERE s.event_id = p.event_id AND s.market = p.market
             AND s.selection = p.selection AND s.suspended = 0
           ORDER BY s.ts DESC LIMIT 1) AS current_odd
  FROM picks p
  WHERE p.result IS NULL
  ORDER BY p.ts ASC
`);

// Lo mismo para la sombra. Se repite la consulta en vez de parametrizar la
// tabla porque las columnas no coinciden (model_picks no tiene stake ni edge y
// si tiene conf_learned/conf_heuristic), y un SQL generico obligaria a
// interpolar el nombre de tabla, que es justo lo que no se hace aqui.
const pendingModelDetailedStmt = db.prepare(`
  SELECT m.*,
         (SELECT s.score FROM snapshots s WHERE s.event_id = m.event_id AND s.score != ''
           ORDER BY s.ts DESC LIMIT 1) AS live_score,
         (SELECT s.live_time FROM snapshots s WHERE s.event_id = m.event_id
           ORDER BY s.ts DESC LIMIT 1) AS live_time,
         (SELECT MAX(s.ts) FROM snapshots s WHERE s.event_id = m.event_id) AS last_seen_ts,
         (SELECT s.odd_decimal FROM snapshots s
           WHERE s.event_id = m.event_id AND s.market = m.market
             AND s.selection = m.selection AND s.suspended = 0
           ORDER BY s.ts DESC LIMIT 1) AS current_odd
  FROM model_picks m
  WHERE m.result IS NULL
  ORDER BY m.ts ASC
`);

// --- Deduplicación de picks automáticos ---
// Un evento con pick sin liquidar no vuelve a generar picks (los picks del
// mismo partido están correlacionados y romperían la independencia del
// dataset de entrenamiento). Tampoco se repite una selección ya registrada.
const activeEventPickStmt = db.prepare(`SELECT 1 FROM picks WHERE event_id = ? AND result IS NULL LIMIT 1`);
// Cualquier pick del evento, liquidado o no.
//
// activeEventPickStmt solo mira los SIN LIQUIDAR, y eso deja un hueco desde que
// existe la liquidacion temprana: al cerrarse un mercado (un Under que ya paso
// de linea) el pick se liquida con el partido AUN EN JUEGO, el evento queda
// libre y entra un segundo pick sobre el mismo partido. Medido el 2026-08-26:
// dos casos salieron en el MISMO SEGUNDO en que liquido el anterior, porque el
// ciclo del sampler liquida y despues emite.
//
// Eso rompe justo lo que la guarda protege: los picks del mismo partido estan
// correlacionados, y que uno haya cerrado no los descorrelaciona.
const anyEventPickStmt = db.prepare(`SELECT 1 FROM picks WHERE event_id = ? LIMIT 1`);
// El pick ya emitido para esta seleccion, si existe. Lo usan /seguras y /golden
// para MARCARLO en el mensaje en vez de reenviarlo como si fuera nuevo.
const findPickStmt = db.prepare(
  `SELECT id, ts, result FROM picks WHERE event_id = ? AND market = ? AND selection = ? ORDER BY id LIMIT 1`);
const sameSelectionStmt = db.prepare(`
  SELECT 1 FROM picks WHERE event_id = ? AND market = ? AND selection = ? LIMIT 1
`);
// El tope horario cuenta por ORIGEN. Los rescates (source='rescue') llevan su
// propio cupo y no consumen el de los picks normales: son un experimento
// aparte, y dejarlos competir por el mismo tope haria que un dia con muchos
// rescates redujera los picks de produccion.
const pickedTodayStmt = db.prepare(`SELECT COUNT(*) n FROM picks WHERE ts > ? AND source = 'auto'`);
const pickedBySourceStmt = db.prepare(`SELECT COUNT(*) n FROM picks WHERE ts > ? AND source = ?`);
// Picks auto emitidos por debajo del piso normal: solo pueden existir por el
// piloto MIN_CONF_UNDER_LOW (ver confidence.js:minConfFor).
const pickedBelowConfStmt = db.prepare(`SELECT COUNT(*) n FROM picks WHERE ts > ? AND source = 'auto' AND conf < ?`);

// --- Etapa 4: sharp odds ---
const sharpEntryStmt = db.prepare(`
  UPDATE picks SET sharp_entry_odd = @odd, sharp_source = @source, sharp_event_id = @eventId,
    sharp_match = @match, sharp_closing_odd = @odd, sharp_closing_market = @marketJson
  WHERE id = @id
`);
const sharpStatusStmt = db.prepare(`UPDATE picks SET sharp_match = ? WHERE id = ?`);
const sharpClosingStmt = db.prepare(`
  UPDATE picks SET sharp_closing_odd = ?, sharp_closing_market = ? WHERE id = ?
`);

const insertExecProbeStmt = db.prepare(`
  INSERT OR IGNORE INTO pick_exec_probe
    (source, pick_id, delay_s, emit_ts, probe_ts, real_delay_ms, odd_emit, odd_seen, status, score_seen)
  VALUES (@source, @pickId, @delayS, @emitTs, @probeTs, @realDelayMs, @oddEmit, @oddSeen, @status, @scoreSeen)
`);

const insertDryRunJobStmt = db.prepare(`
  INSERT OR IGNORE INTO dry_run_jobs
    (source, pick_id, event_id, sport_id, sport, market, selection, odd_emit, pick_ts,
     mode, status, attempts, max_attempts, available_at, created_at, updated_at)
  VALUES
    (@source, @pickId, @eventId, @sportId, @sport, @market, @selection, @oddDecimal, @pickTs,
     'list_only', 'pending', 0, @maxAttempts, @availableAt, @createdAt, @updatedAt)
`);
const enqueueDryRunJobsTx = db.transaction((source, items, maxAttempts) => {
  const now = new Date().toISOString();
  let n = 0;
  for (const item of items) {
    if (!item?.pickId || item.eventId == null || item.sportId == null || !item.market || !item.selection || !(item.oddDecimal > 1)) continue;
    const info = insertDryRunJobStmt.run({
      source, pickId: item.pickId, eventId: item.eventId, sportId: item.sportId, sport: item.sport || null,
      market: item.market, selection: item.selection, oddDecimal: item.oddDecimal,
      pickTs: item.ts || now, maxAttempts, availableAt: now, createdAt: now, updatedAt: now,
    });
    n += info.changes;
  }
  return n;
});

function enqueueDryRunJobs(source, items, { maxAttempts = 2 } = {}) {
  if (!['heur', 'model'].includes(source)) throw new Error(`source dry-run inválido: ${source}`);
  const max = Math.max(1, Math.min(5, Number(maxAttempts) || 2));
  return enqueueDryRunJobsTx(source, items, max);
}

const reclaimExpiredDryRunJobsStmt = db.prepare(`
  UPDATE dry_run_jobs
  SET status = 'pending', claimed_by = NULL, lease_until = NULL, updated_at = ?
  WHERE status = 'running' AND lease_until IS NOT NULL AND lease_until <= ?
`);
const findNextDryRunJobStmt = db.prepare(`
  SELECT * FROM dry_run_jobs
  WHERE status IN ('pending', 'retry') AND available_at <= ? AND attempts < max_attempts
  ORDER BY available_at ASC, id ASC
  LIMIT 1
`);
const claimDryRunJobStmt = db.prepare(`
  UPDATE dry_run_jobs
  SET status = 'running', attempts = attempts + 1, claimed_by = @workerId,
      lease_until = @leaseUntil, started_at = @startedAt, updated_at = @startedAt
  WHERE id = @id AND status IN ('pending', 'retry')
`);
const getDryRunJobStmt = db.prepare('SELECT * FROM dry_run_jobs WHERE id = ?');
const claimNextDryRunJobTx = db.transaction((workerId, leaseMs) => {
  const now = new Date();
  const nowIso = now.toISOString();
  reclaimExpiredDryRunJobsStmt.run(nowIso, nowIso);
  const next = findNextDryRunJobStmt.get(nowIso);
  if (!next) return null;
  const leaseUntil = new Date(now.getTime() + leaseMs).toISOString();
  const info = claimDryRunJobStmt.run({ id: next.id, workerId, leaseUntil, startedAt: nowIso });
  return info.changes ? getDryRunJobStmt.get(next.id) : null;
});

function claimNextDryRunJob(workerId, { leaseMs = 120000 } = {}) {
  const lease = Math.max(30000, Math.min(15 * 60000, Number(leaseMs) || 120000));
  return claimNextDryRunJobTx(workerId, lease);
}

const finishDryRunJobStmt = db.prepare(`
  UPDATE dry_run_jobs
  SET status = @status, available_at = @availableAt, finished_at = @finishedAt,
      last_error = @lastError, last_run_id = @lastRunId, claimed_by = NULL,
      lease_until = NULL, updated_at = @finishedAt
  WHERE id = @id AND status = 'running' AND claimed_by = @workerId
`);
function finishDryRunJob({ id, workerId, status, lastError = null, lastRunId = null, retryAfterMs = 0 }) {
  if (!['completed', 'retry', 'failed'].includes(status)) throw new Error(`estado final dry-run inválido: ${status}`);
  const now = new Date();
  return finishDryRunJobStmt.run({
    id, workerId, status, lastError, lastRunId,
    finishedAt: now.toISOString(),
    availableAt: new Date(now.getTime() + Math.max(0, retryAfterMs)).toISOString(),
  }).changes;
}

const getDryRunWorkerStateStmt = db.prepare('SELECT * FROM dry_run_worker_state WHERE id = 1');
const setDryRunCircuitStmt = db.prepare(`
  INSERT INTO dry_run_worker_state (id, circuit_open, reason, opened_at, updated_at)
  VALUES (1, @circuitOpen, @reason, @openedAt, @updatedAt)
  ON CONFLICT(id) DO UPDATE SET circuit_open=excluded.circuit_open, reason=excluded.reason,
    opened_at=excluded.opened_at, updated_at=excluded.updated_at
`);
function getDryRunCircuit() {
  return getDryRunWorkerStateStmt.get() || { circuit_open: 0, reason: null, opened_at: null, updated_at: null };
}
function setDryRunCircuit(open, reason = null) {
  const now = new Date().toISOString();
  setDryRunCircuitStmt.run({ circuitOpen: open ? 1 : 0, reason: open ? String(reason || 'sin detalle') : null,
    openedAt: open ? now : null, updatedAt: now });
}

function getExecutionMonitor(hours = 24) {
  const h = Math.max(1, Math.min(24 * 30, Number(hours) || 24));
  const since = new Date(Date.now() - h * 3600000).toISOString();
  const probes = db.prepare(`
    SELECT source, COUNT(*) n,
           SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END) ok,
           SUM(CASE WHEN status = 'gone' THEN 1 ELSE 0 END) gone,
           SUM(CASE WHEN status = 'susp' THEN 1 ELSE 0 END) susp,
           SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) error,
           AVG(real_delay_ms) avg_delay_ms, MAX(real_delay_ms) max_delay_ms,
           AVG(real_delay_ms - delay_s * 1000) avg_lateness_ms,
           MAX(real_delay_ms - delay_s * 1000) max_lateness_ms,
           AVG(CASE WHEN odd_seen IS NOT NULL AND odd_emit > 0 THEN (odd_seen - odd_emit) / odd_emit END) avg_drift,
           MAX(probe_ts) last_probe_ts
    FROM pick_exec_probe WHERE probe_ts >= ? GROUP BY source
  `).all(since);
  const dryRun = db.prepare(`
    SELECT status, COUNT(*) n FROM bot_dry_run_log WHERE ts >= ? GROUP BY status
  `).all(since);
  const jobs = db.prepare(`
    SELECT status, COUNT(*) n, MIN(available_at) oldest_available_at
    FROM dry_run_jobs GROUP BY status
  `).all();
  return { since, hours: h, probes, dryRun, jobs, circuit: getDryRunCircuit() };
}

const countDryRunStartedSinceStmt = db.prepare(
  "SELECT COUNT(*) n FROM dry_run_jobs WHERE started_at IS NOT NULL AND started_at >= ?");
function countDryRunStartedSince(since) {
  return countDryRunStartedSinceStmt.get(since).n;
}

module.exports = {
  db, saveSnapshot, logPicks,
  saveExecProbe: (r) => insertExecProbeStmt.run(r),
  enqueueDryRunJobs, claimNextDryRunJob, finishDryRunJob,
  getDryRunCircuit, setDryRunCircuit, getExecutionMonitor, countDryRunStartedSince,
  saveReportPicks, guardarParlayProx, reporteEstado, reporteYaEnviado, reportePendientes, liquidarReportePick,
  savePrematchSnapshot, savePrematchValueScan, savePrematchXg, saveLeagueXg, getLeagueXg,
  saveStatSnapshot, saveStatResults,
  saveFotmobSnapshot, getFotmobCornerFinal, getFotmobCornerLatest, getFotmobComparadas,
  saveForecastSnapshot, getForecastHistory,
  logCornerPick,
  countCornerPicksSince: (iso) => countCornerSinceStmt.get(iso).n,
  getUnsettledCornerPicks: () => cornerPendStmt.all(),
  // Conteo final de FotMob de ese partido+línea (lo escribe el piloto al etiquetar); undefined si aún no hay.
  getCornerFinalCount: (eventId, linea) => cornerEtiqueta(eventId, linea)?.c,
  settleCornerPick: (id, result, finalCount) => cornerSettleStmt.run(result, finalCount, new Date().toISOString(), id),
  getStatEventosPendientes: () => statPendientesStmt.all().map(r => r.event_id),
  getStatMuestras: (eventId) => statMuestrasStmt.all(eventId),

  // ── Alertas de valor ──
  // Picks vivos, dentro de la ventana de edad y todavia sin alertar. El techo de
  // edad no es cosmetico: sin el, el primer arranque veria miles de picks
  // historicos sin fila en value_alerts y los mandaria todos de golpe.
  getPicksSinAlertar: (desdeTs) => db.prepare(`
    SELECT p.id, p.ts, p.event_id, p.event, p.sport, p.market, p.selection,
           p.odd_decimal, p.conf, p.edge
    FROM picks p
    LEFT JOIN value_alerts a ON a.pick_id = p.id
    WHERE a.pick_id IS NULL AND p.ts >= ? AND p.result IS NULL
    ORDER BY p.id
  `).all(desdeTs),
  marcarAlertado: (pick, dryRun) => db.prepare(`
    INSERT OR IGNORE INTO value_alerts (pick_id, ts, odd_alertada, edge_alertado, conf_alertada, dry_run)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(pick.id, new Date().toISOString(), pick.odd_decimal, pick.edge, pick.conf, dryRun ? 1 : 0).changes,
  yaAlertado: (pickId) => !!db.prepare('SELECT pick_id FROM value_alerts WHERE pick_id = ?').get(pickId),
  // Marcador y minuto actuales del evento. `picks` no los guarda (se
  // reconstruyen desde snapshots), pero una alerta en vivo sin el estado del
  // partido obliga a abrir el enlace para saber de que va. Es una consulta por
  // el indice (event_id, ts), asi que sale barata.
  getEstadoEvento: (eventId) => db.prepare(
    'SELECT score, live_time FROM snapshots WHERE event_id = ? ORDER BY ts DESC LIMIT 1'
  ).get(eventId) || null,
  borrarStatResults: (eventId) => borrarStatResultsStmt.run(eventId).changes,
  getStatEventosEtiquetados: () => db.prepare(
    'SELECT DISTINCT event_id FROM stat_results').all().map(r => r.event_id),
  logRejected,
  logModelPicks,
  isDuplicateModelPick: (eventId) => !!activeEventModelStmt.get(eventId),
  getUnsettledModelPicks: () => unsettledModelStmt.all(),
  settleModelPick: (id, result, finalScore) =>
    settleModelStmt.run(result, finalScore, new Date().toISOString(), id),
  getUnsettledRejected: () => unsettledRejectedStmt.all(),
  settleRejected: (id, result, finalScore) =>
    settleRejectedStmt.run(result, finalScore, new Date().toISOString(), id),
  getUnsettledPicks: () => unsettledStmt.all(),
  getLastScore: (eventId) => lastScoreStmt.get(eventId),
  getLastRegularScore: (eventId) => lastRegularScoreStmt.get(eventId),
  getLastSeen: (eventId) => lastSeenStmt.get(eventId).ts,
  settlePick: (id, result, finalScore, source, closingOdd, closingTs) =>
    settleStmt.run(result, finalScore, new Date().toISOString(), source, closingOdd, closingTs, id),
  getClosingOdd: (eventId, market, selection) => closingStmt.get(eventId, market, selection),
  getStats: () => ({ buckets: statsStmt.all(), pending: pendingCountStmt.get().n }),
  getPendingPicksDetailed: () => pendingDetailedStmt.all(),
  getPendingModelPicksDetailed: () => pendingModelDetailedStmt.all(),
  // Candidatos rechazados SOLO por min_conf: la poblacion elegible del rescate.
  // Se usa para recalcular su umbral (el p70) contra el modelo vigente.
  getRescueEligible: (desde) => db.prepare(`
    SELECT sport, market, selection, f_prob_justa, f_avance_model, f_situacion,
           f_linea, f_apertura
    FROM rejected_picks
    WHERE reject_rule = 'min_conf' AND ts >= ?
      AND f_prob_justa IS NOT NULL AND f_avance_model IS NOT NULL
  `).all(desde),
  // La captura de entrada también inicializa el cierre (semántica "último visto",
  // igual que el cierre de Altenar); refreshSharp lo va sobrescribiendo.
  // Poda de snapshots viejos. Los eventos con pick tienen una retencion MAS
  // LARGA (pickedDays, default 60d) en vez de exencion para siempre — decidido
  // el 2026-09-08 tras confirmar que nada rio abajo necesita el crudo mas alla
  // de eso: las features que leian historico de snapshots (f_apertura,
  // f_linea) ya estan excluidas del modelo por defecto (fuga temporal, ver
  // scripts/train_weights.py), y todo lo demas que el entrenamiento usa ya
  // quedo PERSISTIDO en la propia fila de picks/rejected_picks al momento del
  // pick. Lo unico que de verdad lee snapshots de un pick viejo es la ficha
  // /pick <id> (grafica de cuota), y eso es solo para picks recientes.
  //
  // Los eventos con un rejected_pick SIN LIQUIDAR siguen protegidos SIN limite
  // de tiempo — no son historial, siguen en juego; liquidarlos necesita el
  // crudo pase lo que pase.
  // ACOTADO POR VENTANA DE ESCANEO, no solo por filas borradas. Dos motivos, los
  // dos medidos el 2026-08-19 sobre la BD real (47.5M filas, 13 GB):
  //
  // 1. better-sqlite3 es SÍNCRONO: mientras esto corre no se ejecuta NADA más en
  //    el proceso — ni sampler, ni polling de Telegram. El prune del arranque
  //    dejó el bot clavado >15 min sin un log ni un crash: vivo, quemando CPU,
  //    sin hacer nada.
  // 2. Acotar solo las filas BORRADAS no basta. El 100% de las filas más viejas
  //    están protegidas por la cláusula de `picks`, así que un `LIMIT 5000` de
  //    borrables escanea millones de filas antes de rendirse: 80 s para
  //    encontrar 5000 rowids, contra 12 ms para borrarlos. El coste está en
  //    BUSCAR, no en borrar.
  //
  // Por eso la ventana se acota por rowid (≈ orden de inserción) y el cursor
  // avanza entre llamadas: cada pasada mira como mucho `scan` filas y vuelve.
  //
  // `days` sigue acotando el universo NO elegido (igual que antes);
  // `pickedDays` (nuevo, default 60) acota el universo CON pick — ya no es
  // infinito, pero sigue siendo mas largo que `days` a proposito: un pick
  // liquidado hace 3 semanas todavia es "reciente" para /pick <id>.
  pruneSnapshots: (days = 7, { scan = 50000, maxMs = 2000, pickedDays = 60 } = {}) => {
    const cutoff = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
    const pickedCutoff = new Date(Date.now() - pickedDays * 24 * 3600 * 1000).toISOString();
    const maxRowid = db.prepare('SELECT MAX(rowid) m FROM snapshots').get().m || 0;
    // Ventana: los siguientes `scan` rowids que EXISTEN a partir del cursor. Se
    // pide su máximo en vez de sumar `scan` al cursor porque los rowid tienen
    // huecos tras cada borrado, y sumar a ciegas re-escanearía lo ya visto.
    const windowStmt = db.prepare(
      'SELECT MAX(rowid) m FROM (SELECT rowid FROM snapshots WHERE rowid > ? ORDER BY rowid LIMIT ?)');
    // Los eventos con un rejected_pick SIN LIQUIDAR quedan fuera de las dos
    // ramas de abajo, protegidos sin limite — no son historial, siguen en
    // juego. Las dos ramas del OR aplican cutoffs DISTINTOS segun si el
    // evento tiene pick (pickedCutoff, mas largo) o no (cutoff, el normal).
    const delStmt = db.prepare(`
      DELETE FROM snapshots
      WHERE rowid > ? AND rowid <= ?
        AND event_id NOT IN (SELECT event_id FROM rejected_picks WHERE result IS NULL)
        AND (
          (ts < ? AND event_id NOT IN (SELECT event_id FROM picks))
          OR
          (ts < ? AND event_id IN (SELECT event_id FROM picks))
        )
    `);
    const t0 = Date.now();
    let deleted = 0, examined = 0;
    do {
      if (pruneCursor >= maxRowid) { pruneCursor = 0; break; } // vuelta completa
      const hasta = windowStmt.get(pruneCursor, scan).m;
      if (hasta === null) { pruneCursor = 0; break; }
      deleted += delStmt.run(pruneCursor, hasta, cutoff, pickedCutoff).changes;
      examined += scan;
      pruneCursor = hasta;
    } while (Date.now() - t0 < maxMs);
    return { deleted, cutoff, examined, cursor: pruneCursor,
             pending: pruneCursor > 0 && pruneCursor < maxRowid, ms: Date.now() - t0 };
  },
  // true si el pick ya está cubierto (evento con pick vivo, o misma selección ya registrada)
  // Para candidatos que vienen del feed EN VIVO: el evento esta en juego por
  // definicion, asi que un pick previo —aunque ya liquidara— sigue siendo del
  // mismo partido.
  hasPickForEvent: (eventId) => !!anyEventPickStmt.get(eventId),
  findPick: (eventId, market, selection) => findPickStmt.get(eventId, market, selection),
  isDuplicatePick: (eventId, market, selection) =>
    !!activeEventPickStmt.get(eventId) || !!sameSelectionStmt.get(eventId, market, selection),
  countPicksSince: (isoTs, source) => (source ? pickedBySourceStmt.get(isoTs, source) : pickedTodayStmt.get(isoTs)).n,
  countPicksBelowConfSince: (isoTs, minConf) => pickedBelowConfStmt.get(isoTs, minConf).n,
  setSharpEntry: (params) => sharpEntryStmt.run(params),
  setSharpStatus: (id, status) => sharpStatusStmt.run(status, id),
  setSharpClosing: (id, odd, marketJson) => sharpClosingStmt.run(odd, marketJson, id),

  // Gestión de Suscriptores del Canal VIP
  addSubscriber: (telegramId, username, firstName, days = 30, inviteLink = '') => {
    const now = new Date();
    const expires = new Date(now.getTime() + days * 24 * 3600 * 1000);
    return db.prepare(`
      INSERT INTO subscribers (telegram_id, username, first_name, plan, status, subscribed_at, expires_at, invite_link)
      VALUES (?, ?, ?, 'vip_monthly', 'active', ?, ?, ?)
      ON CONFLICT(telegram_id) DO UPDATE SET
        username = excluded.username,
        first_name = excluded.first_name,
        status = 'active',
        subscribed_at = excluded.subscribed_at,
        expires_at = excluded.expires_at,
        invite_link = excluded.invite_link
    `).run(telegramId, username || '', firstName || '', now.toISOString(), expires.toISOString(), inviteLink);
  },
  getSubscriber: (telegramId) => db.prepare(`SELECT * FROM subscribers WHERE telegram_id = ?`).get(telegramId),
  getActiveSubscribers: () => db.prepare(`SELECT * FROM subscribers WHERE status = 'active' AND expires_at > ?`).all(new Date().toISOString()),
  getExpiredSubscribers: () => db.prepare(`SELECT * FROM subscribers WHERE status = 'active' AND expires_at <= ?`).all(new Date().toISOString()),
  setSubscriberStatus: (telegramId, status) => db.prepare(`UPDATE subscribers SET status = ? WHERE telegram_id = ?`).run(status, telegramId),
};

