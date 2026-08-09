/**
 * Verifica que globalDrawScanner.ts haya dejado de inventar features.
 *
 * Contexto (2026-08-09): el scanner insertaba sus picks con una ÚNICA
 * combinación hardcodeada — f_prob_justa=0.72, f_avance=0.85, f_situacion=0.75,
 * f_linea=0.82, conf=0.76 — idéntica en las 184 filas. Eso contaminó el dataset
 * de entrenamiento y fabricó una regla de firewall falsa (R6), que capturaba el
 * 100% de esos picks vía el 0.82 fijo y parecía medir "steam" cuando solo
 * detectaba la huella del scanner.
 *
 * Este script NO afirma que el arreglo sea correcto; solo comprueba que los
 * síntomas medibles hayan desaparecido en los picks NUEVOS. Un pick con
 * features reales varía entre eventos: si siguen siendo constantes, siguen
 * siendo inventadas.
 *
 * Uso: node scripts/verify-scanner-features.js [--since 2026-08-09T05:00:00Z]
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const Database = require('better-sqlite3');

const i = process.argv.indexOf('--since');
const SINCE = i > -1 ? process.argv[i + 1] : null;

const db = new Database(path.join(__dirname, '..', 'snapshots.db'), { readonly: true });

const FINGERPRINT = { f_prob_justa: 0.72, f_avance: 0.85, f_situacion: 0.75, f_linea: 0.82, conf: 0.76 };
const FEATS = ['f_prob_justa', 'f_avance', 'f_situacion', 'f_linea'];

const rows = db.prepare(`
  SELECT id, ts, event, market, selection, conf, f_prob_justa, f_avance,
         f_avance_model, f_situacion, f_linea, f_apertura
  FROM picks
  WHERE source = 'global_draw' ${SINCE ? 'AND ts >= ?' : ''}
  ORDER BY ts
`).all(...(SINCE ? [SINCE] : []));

console.log(`Picks de global_draw${SINCE ? ` desde ${SINCE}` : ' (todos)'}: ${rows.length}\n`);
if (!rows.length) {
  console.log('No hay filas que evaluar. Si el scanner aún no ha emitido desde el arreglo,');
  console.log('espera a que lo haga y vuelve a correr esto con --since <ts del despliegue>.');
  process.exit(0);
}

let fails = 0;
const check = (label, ok, detail) => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) fails++;
};

// 1. Ninguna fila debe llevar la huella hardcodeada completa.
const stamped = rows.filter(r => Object.entries(FINGERPRINT).every(([k, v]) => Math.abs((r[k] ?? -1) - v) < 1e-9));
check('ninguna fila con la huella hardcodeada', stamped.length === 0,
  stamped.length ? `${stamped.length}/${rows.length} siguen con 0.72/0.85/0.75/0.82/0.76` : `${rows.length} filas limpias`);

// 2. Las features deben VARIAR entre eventos. Constantes = siguen inventadas.
for (const f of FEATS) {
  const vals = new Set(rows.map(r => r[f]).filter(v => v != null));
  check(`${f} varía entre picks`, vals.size > 1 || rows.length < 2,
    `${vals.size} valor(es) distinto(s) en ${rows.length} filas`);
}

// 3. f_avance_model debe estar poblada (si no, el pick se cae del dataset).
const sinModel = rows.filter(r => r.f_avance_model == null);
check('f_avance_model poblada', sinModel.length === 0,
  sinModel.length ? `${sinModel.length} filas sin valor: quedarían fuera del entrenamiento` : 'todas');

// 4. f_apertura debe existir: export-dataset.js la exige en el WHERE.
const sinApertura = rows.filter(r => r.f_apertura == null);
check('f_apertura poblada', sinApertura.length === 0,
  sinApertura.length ? `${sinApertura.length} filas sin valor: export-dataset.js las descartaría` : 'todas');

// 5. Coherencia: para un total, f_avance_model debe diferir del crudo al menos
// en alguna fila; si SIEMPRE coincide, la transformación no se está aplicando.
const totals = rows.filter(r => /^total/i.test(r.market || '') && r.f_avance != null && r.f_avance_model != null);
if (totals.length) {
  const distintos = totals.filter(r => Math.abs(r.f_avance - r.f_avance_model) > 1e-9).length;
  console.log(`  ℹ️  totales con f_avance_model != f_avance: ${distintos}/${totals.length}` +
    (distintos === 0 ? '  (revisar: puede ser legítimo si ninguna línea aplicaba transformación)' : ''));
}

console.log(`\nMuestra (${Math.min(5, rows.length)} filas):`);
for (const r of rows.slice(-5)) {
  console.log(`  #${r.id} ${String(r.event).slice(0, 28).padEnd(28)} conf=${(r.conf ?? 0).toFixed(3)} ` +
    FEATS.map(f => `${f.replace('f_', '')}=${r[f] != null ? r[f].toFixed(3) : '—'}`).join(' ') +
    ` av_model=${r.f_avance_model != null ? r.f_avance_model.toFixed(3) : '—'}`);
}

console.log(fails === 0
  ? '\n✅ Sin síntomas de features fabricadas.'
  : `\n❌ ${fails} comprobación(es) fallida(s): el arreglo no está completo.`);
process.exit(fails === 0 ? 0 : 1);
