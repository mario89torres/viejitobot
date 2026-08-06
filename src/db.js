const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, '..', 'snapshots.db'));
db.pragma('journal_mode = WAL');

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

  CREATE TABLE IF NOT EXISTS picks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    event_id INTEGER, event TEXT, sport TEXT,
    market TEXT, selection TEXT,
    odd_decimal REAL, conf REAL,
    result TEXT, final_score TEXT, settled_ts TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_picks_result ON picks(result);

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
`);

// Columnas de Etapa 0 (idempotente: en BDs ya migradas no hace nada)
function addColumn(table, col, def) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
}
addColumn('snapshots', 'suspended', 'INTEGER NOT NULL DEFAULT 0');
addColumn('picks', 'result_source', 'TEXT');
addColumn('picks', 'closing_odd_decimal', 'REAL');
addColumn('picks', 'closing_ts', 'TEXT');
addColumn('picks', 'sharp_closing_odd', 'REAL');
// Etapa 2: factores crudos del score + scores heurístico/aprendido (shadow)
addColumn('picks', 'f_prob_justa', 'REAL');
addColumn('picks', 'f_avance', 'REAL');
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

const insertStmt = db.prepare(`
  INSERT INTO snapshots (ts, sport, sport_id, champ, event_id, event, score, live_time, market, selection, odd_decimal, odd_american, suspended)
  VALUES (@ts, @sport, @sportId, @champ, @eventId, @event, @score, @liveTime, @market, @selection, @oddDecimal, @oddAmerican, @suspended)
`);

const insertMany = db.transaction((rows) => {
  for (const r of rows) insertStmt.run(r);
});

function saveSnapshot(rows) {
  insertMany(rows);
}

const insertPickStmt = db.prepare(`
  INSERT INTO picks (ts, event_id, event, sport, market, selection, odd_decimal, conf,
    f_prob_justa, f_avance, f_situacion, f_linea, conf_heuristic, conf_learned, edge, source,
    opening_odd_decimal, f_apertura, score_version, stake, stake_mode)
  VALUES (@ts, @eventId, @event, @sport, @market, @selection, @oddDecimal, @conf,
    @fProbJusta, @fAvance, @fSituacion, @fLinea, @confHeuristic, @confLearned, @edge, @source,
    @openingOdd, @fApertura, @scoreVersion, @stake, @stakeMode)
`);
// Devuelve los rowid insertados (necesarios para la captura sharp posterior)
const logPicks = db.transaction((picks) => {
  const ids = [];
  for (const p of picks) {
    const info = insertPickStmt.run({
      fProbJusta: null, fAvance: null, fSituacion: null, fLinea: null,
      confHeuristic: null, confLearned: null, edge: null, source: null,
      openingOdd: null, fApertura: null, scoreVersion: null, stake: null, stakeMode: null,
      ...p,
    });
    ids.push(Number(info.lastInsertRowid));
  }
  return ids;
});

const unsettledStmt = db.prepare(`SELECT * FROM picks WHERE result IS NULL`);
const lastScoreStmt = db.prepare(`
  SELECT score, ts FROM snapshots WHERE event_id = ? AND score != '' ORDER BY ts DESC LIMIT 1
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

// --- Deduplicación de picks automáticos ---
// Un evento con pick sin liquidar no vuelve a generar picks (los picks del
// mismo partido están correlacionados y romperían la independencia del
// dataset de entrenamiento). Tampoco se repite una selección ya registrada.
const activeEventPickStmt = db.prepare(`SELECT 1 FROM picks WHERE event_id = ? AND result IS NULL LIMIT 1`);
const sameSelectionStmt = db.prepare(`
  SELECT 1 FROM picks WHERE event_id = ? AND market = ? AND selection = ? LIMIT 1
`);
const pickedTodayStmt = db.prepare(`SELECT COUNT(*) n FROM picks WHERE ts > ?`);

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

module.exports = {
  db, saveSnapshot, logPicks,
  getUnsettledPicks: () => unsettledStmt.all(),
  getLastScore: (eventId) => lastScoreStmt.get(eventId),
  getLastSeen: (eventId) => lastSeenStmt.get(eventId).ts,
  settlePick: (id, result, finalScore, source, closingOdd, closingTs) =>
    settleStmt.run(result, finalScore, new Date().toISOString(), source, closingOdd, closingTs, id),
  getClosingOdd: (eventId, market, selection) => closingStmt.get(eventId, market, selection),
  getStats: () => ({ buckets: statsStmt.all(), pending: pendingCountStmt.get().n }),
  // La captura de entrada también inicializa el cierre (semántica "último visto",
  // igual que el cierre de Altenar); refreshSharp lo va sobrescribiendo.
  // Poda de snapshots viejos preservando los eventos con picks (base del CLV)
  pruneSnapshots: (days = 7) => {
    const cutoff = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
    const info = db.prepare(`
      DELETE FROM snapshots WHERE ts < ?
        AND event_id NOT IN (SELECT DISTINCT event_id FROM picks)
    `).run(cutoff);
    return { deleted: info.changes, cutoff };
  },
  // true si el pick ya está cubierto (evento con pick vivo, o misma selección ya registrada)
  isDuplicatePick: (eventId, market, selection) =>
    !!activeEventPickStmt.get(eventId) || !!sameSelectionStmt.get(eventId, market, selection),
  countPicksSince: (isoTs) => pickedTodayStmt.get(isoTs).n,
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

