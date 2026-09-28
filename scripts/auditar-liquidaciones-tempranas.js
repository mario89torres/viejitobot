// scripts/auditar-liquidaciones-tempranas.js
//
// Busca picks de fútbol liquidados win/loss con un marcador de una muestra vieja (el último snapshot
// del evento no era del final: ver marcadorEsFinal en src/results.js) y los compara con el marcador
// OFICIAL de FotMob. Por defecto SOLO LEE: no escribe nada en snapshots.db.
//
//   node scripts/auditar-liquidaciones-tempranas.js [dias=14]            # informe
//   node scripts/auditar-liquidaciones-tempranas.js 14 --apply           # corrige lo verificado
//
// --apply: solo toca filas cuyo marcador oficial se verificó, y antes guarda los valores anteriores en
// scratch/_relabel_backup_<fecha>.json (revertible). Lo que FotMob no pudo verificar NO se toca.
//
// Nota de infraestructura: src/validate.js y src/results.js cargan src/db.js, que abre la BD en
// DB_PATH y ejecuta su esquema. Para no depender de él contra la BD real, este script fija DB_PATH a
// una BD temporal ANTES de requerirlos y lee snapshots.db por su cuenta (solo lectura).
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const REAL_DB = process.env.AUDIT_DB || path.join(__dirname, '..', 'snapshots.db');
const TMP_DB = path.join(os.tmpdir(), `audit-liquidaciones-${process.pid}.db`);
process.env.DB_PATH = TMP_DB;

const { marcadorEsFinal } = require('../src/results');
const { gradePick } = require('../src/markets');
const { _internal: V } = require('../src/validate');
const fotmob = require('../src/fotmobScraper');

const DIAS = Number(process.argv[2]) || 14;
const APPLY = process.argv.includes('--apply');
const TABLAS = ['model_picks', 'rejected_picks', 'picks'];

const real = new Database(REAL_DB, { readonly: !APPLY, timeout: 20000 });
const ultimoRegular = real.prepare(`
  SELECT score, ts, live_time FROM snapshots WHERE event_id = ? AND score != ''
    AND (live_time IS NULL OR (live_time NOT LIKE '%Adicional%' AND live_time NOT LIKE '%Descanso pr%' AND live_time NOT LIKE '%enal%'))
  ORDER BY ts DESC LIMIT 1`);

// 1) Candidatos: liquidados win/loss cuyo marcador no era del final.
const candidatos = [];
const cache = new Map();
for (const tabla of TABLAS) {
  const filas = real.prepare(`SELECT id, ts, event_id, event, sport, market, selection, result, final_score
      FROM ${tabla} WHERE result IN ('win','loss') AND settled_ts >= datetime('now', ?)`).all(`-${DIAS} days`)
    .filter((r) => V.esFutbol(r.sport));
  for (const r of filas) {
    if (!cache.has(r.event_id)) cache.set(r.event_id, ultimoRegular.get(r.event_id) || null);
    const u = cache.get(r.event_id);
    if (!u || marcadorEsFinal(r.sport, u.live_time)) continue;
    candidatos.push({ ...r, tabla, ultimo_live_time: u.live_time });
  }
}

// 2) Un partido por evento (el pick más temprano ancla la ventana de emparejamiento con FotMob).
const porEvento = new Map();
for (const c of candidatos) {
  const p = porEvento.get(c.event_id);
  if (!p || c.ts < p.ts) porEvento.set(c.event_id, { ts: c.ts, event: c.event, sport: c.sport, event_id: c.event_id });
}

(async () => {
  console.log(`Candidatos (fútbol, últimos ${DIAS} días, marcador no final): ${candidatos.length} picks en ${porEvento.size} partidos`);
  const v = await V.verificarConFotmob([...porEvento.values()], { ...fotmob, maxEventos: 1000 });
  const oficialPorEvento = new Map(v.verificados.map((x) => [x.pick.event_id, x.oficial]));
  console.log(`FotMob: verificados ${v.verificados.length} · sin emparejar ${v.sinMatch} · sin terminar/sin dato ${v.pendientes}`);

  const resumen = {};
  const cambios = [];
  for (const c of candidatos) {
    const g = (resumen[c.tabla] = resumen[c.tabla] || { candidatos: 0, verificados: 0, cambian: 0, igual: 0, win_a_loss: 0, loss_a_win: 0, a_push: 0 });
    g.candidatos++;
    const oficial = oficialPorEvento.get(c.event_id);
    if (!oficial) continue;
    g.verificados++;
    const nuevo = gradePick({ market: c.market, selection: c.selection, event: c.event }, oficial) || 'push';
    if (nuevo === c.result) { g.igual++; continue; }
    g.cambian++;
    if (nuevo === 'push') g.a_push++;
    else if (c.result === 'win') g.win_a_loss++;
    else g.loss_a_win++;
    cambios.push({ tabla: c.tabla, id: c.id, event: c.event, selection: c.selection, market: c.market,
      antes: c.result, antes_final: c.final_score, despues: nuevo, oficial, ultimo_live_time: c.ultimo_live_time });
  }
  console.table(resumen);

  const salida = path.join(__dirname, '..', 'scratch', '_relabel_propuesta.json');
  fs.mkdirSync(path.dirname(salida), { recursive: true });
  fs.writeFileSync(salida, JSON.stringify(cambios, null, 2));
  // Todos los candidatos con su estado, para medir el efecto de la corrección sin escribir en la BD.
  fs.writeFileSync(path.join(__dirname, '..', 'scratch', '_relabel_candidatos.json'), JSON.stringify(
    candidatos.map((c) => ({ tabla: c.tabla, id: c.id, result: c.result, oficial: oficialPorEvento.get(c.event_id) || null })), null, 1));
  console.log(`Propuesta (${cambios.length} filas que cambian) guardada en ${salida}`);

  // Los 6582 y compañía: muestra de los cambios para revisar a ojo.
  for (const c of cambios.slice(0, 8)) {
    console.log(`  ${c.tabla}#${c.id} ${c.event} | ${c.selection} | ${c.antes} (${c.antes_final}) -> ${c.despues} (oficial ${c.oficial}; último snapshot "${c.ultimo_live_time}")`);
  }

  if (APPLY && cambios.length) {
    const respaldo = path.join(__dirname, '..', 'scratch', `_relabel_backup_${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    fs.writeFileSync(respaldo, JSON.stringify(cambios, null, 2));
    console.log(`Respaldo de los valores anteriores: ${respaldo}`);
    const upd = {
      picks: real.prepare("UPDATE picks SET result = ?, final_score = ?, result_source = 'official_fotmob' WHERE id = ? AND result = ?"),
      model_picks: real.prepare('UPDATE model_picks SET result = ?, final_score = ? WHERE id = ? AND result = ?'),
      rejected_picks: real.prepare('UPDATE rejected_picks SET result = ?, final_score = ? WHERE id = ? AND result = ?'),
    };
    let n = 0;
    real.transaction(() => {
      for (const c of cambios) n += upd[c.tabla].run(c.despues, c.oficial, c.id, c.antes).changes;
    })();
    console.log(`Filas corregidas: ${n} de ${cambios.length}`);
  } else if (!APPLY) {
    console.log('Modo informe: no se escribió nada. Usa --apply para corregir lo verificado.');
  }
})().catch((e) => { console.error('Error:', e.message); process.exitCode = 1; })
  .finally(() => {
    // Windows mantiene bloqueada la BD temporal (la abrió src/db.js): si no se puede borrar, se deja.
    for (const s of ['', '-wal', '-shm']) { try { fs.rmSync(TMP_DB + s, { force: true }); } catch { /* en uso */ } }
  });
