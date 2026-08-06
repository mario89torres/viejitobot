// Diagnóstico retroactivo de cobertura sharp.
//
// Responde la pregunta que el matching en vivo no puede responder: de los picks
// que quedaron sin match, ¿CUÁNTOS estaban realmente disponibles en la fuente
// sharp? Sin ese número no se puede decidir si conviene pagar por otra API.
//
// Método (idea del usuario): una vez terminado el partido, el MARCADOR FINAL es
// una llave de matching mucho más fuerte que nombres + hora. El endpoint
// /scores devuelve partidos ya jugados con su marcador, así que se puede
// confirmar la identidad del evento sin ambigüedad.
//
// Coste: 2 créditos por liga barrida (daysFrom). El barrido completo de las
// ~46 ligas configuradas son ~92 créditos. Usa --limit para acotarlo y
// --dry-run para ver el plan sin gastar nada.
//
// Uso:
//   node scripts/diag-sharp-retro.js --dry-run
//   node scripts/diag-sharp-retro.js            (barrido completo)
//   node scripts/diag-sharp-retro.js --limit 10 (solo 10 ligas = 20 créditos)
require('dotenv').config();
const { db } = require('../src/db');
const { _internal } = require('../src/sharp');

const BASE = 'https://api.the-odds-api.com/v4';
const KEY = process.env.ODDS_API_KEY;
const DAYS = 3;                       // máximo que admite /scores
const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const LIMIT = (() => { const i = args.indexOf('--limit'); return i >= 0 ? Number(args[i + 1]) : Infinity; })();

const { teamsMatch } = _internal;

function splitTeams(event) {
  const p = (event || '').split(/\s+vs\.?\s+|\s+@\s+/i);
  return p.length >= 2 ? [p[0].trim(), p[1].trim()] : null;
}
const parseScore = s => {
  const m = (s || '').match(/^(\d+)-(\d+)$/);
  return m ? [Number(m[1]), Number(m[2])] : null;
};

async function main() {
  if (!KEY) return console.error('Falta ODDS_API_KEY en .env');

  // picks liquidados de los últimos DAYS días, con marcador, que NO matchearon
  const since = new Date(Date.now() - DAYS * 86400e3).toISOString();
  const picks = db.prepare(`
    SELECT id, ts, sport, event, event_id, final_score, sharp_match
    FROM picks
    WHERE ts >= ? AND result IN ('win','loss') AND final_score IS NOT NULL
      AND (sharp_match IS NULL OR sharp_match != 'matched')
  `).all(since);

  const champOf = db.prepare('SELECT champ FROM snapshots WHERE event_id=? LIMIT 1');
  for (const p of picks) {
    const c = champOf.get(p.event_id);
    p.champ = c ? c.champ : '';
    p.mapped = _internal.keyForChamp(p.champ, p.sport);
  }

  console.log(`Picks sin match, liquidados, últimos ${DAYS} días: ${picks.length}`);
  if (!picks.length) return console.log('Nada que diagnosticar.');

  const keys = (process.env.SHARP_SPORT_KEYS || '').split(',').map(s => s.trim()).filter(Boolean);
  const toSweep = keys.slice(0, LIMIT === Infinity ? keys.length : LIMIT);
  console.log(`Ligas a barrer: ${toSweep.length} de ${keys.length} configuradas`);
  console.log(`Coste estimado: ${toSweep.length * 2} créditos\n`);
  if (DRY) {
    const porLiga = {};
    for (const p of picks) {
      porLiga[p.champ] = porLiga[p.champ] || { n: 0, mapped: p.mapped };
      porLiga[p.champ].n++;
    }
    console.log('Picks por liga de Altenar (los que se intentará confirmar):');
    for (const [k, v] of Object.entries(porLiga).sort((a, b) => b[1].n - a[1].n)) {
      console.log(`  ${String(v.n).padStart(3)}  ${k}${v.mapped ? `   -> ${v.mapped}` : '   (sin mapeo)'}`);
    }
    return console.log('\n--dry-run: no se gastó ningún crédito.');
  }

  // barrido: partidos terminados con marcador, por liga
  const sharpEvents = [];
  let gastados = 0;
  for (const k of toSweep) {
    try {
      const r = await fetch(`${BASE}/sports/${k}/scores/?daysFrom=${DAYS}&apiKey=${KEY}`, { signal: AbortSignal.timeout(20000) });
      gastados += Number(r.headers.get('x-requests-last') || 0);
      if (!r.ok) { console.error(`  ${k}: HTTP ${r.status}`); continue; }
      const evs = await r.json();
      for (const e of evs) {
        if (!e.completed || !e.scores) continue;
        const home = e.scores.find(s => s.name === e.home_team);
        const away = e.scores.find(s => s.name === e.away_team);
        if (!home || !away) continue;
        sharpEvents.push({ key: k, home: e.home_team, away: e.away_team, hs: Number(home.score), as: Number(away.score), when: e.commence_time });
      }
    } catch (e) { console.error(`  ${k}: ${e.message}`); }
  }
  console.log(`Eventos terminados recuperados: ${sharpEvents.length} | créditos gastados: ${gastados}\n`);

  // confirmación: nombres + marcador final
  const hallazgos = [], porLigaNueva = {};
  let confirmados = 0, soloNombre = 0;
  for (const p of picks) {
    const t = splitTeams(p.event), sc = parseScore(p.final_score);
    if (!t) continue;
    for (const e of sharpEvents) {
      const directo = teamsMatch(t[0], e.home) && teamsMatch(t[1], e.away);
      const invertido = teamsMatch(t[0], e.away) && teamsMatch(t[1], e.home);
      if (!directo && !invertido) continue;
      const scoreOk = sc && (directo ? (sc[0] === e.hs && sc[1] === e.as) : (sc[0] === e.as && sc[1] === e.hs));
      if (scoreOk) confirmados++; else soloNombre++;
      hallazgos.push({ pick: p, ev: e, scoreOk });
      if (!p.mapped) porLigaNueva[p.champ] = { key: e.key, n: (porLigaNueva[p.champ]?.n || 0) + 1 };
      break;
    }
  }

  console.log('=== RESULTADO ===');
  console.log(`picks sin match analizados:      ${picks.length}`);
  console.log(`confirmados por nombre+marcador: ${confirmados}   <- estaban disponibles y los perdimos`);
  console.log(`solo por nombre (dudosos):       ${soloNombre}`);
  console.log(`sin rastro en la fuente sharp:   ${picks.length - confirmados - soloNombre}   <- genuinamente sin cobertura`);
  const techo = 100 * (confirmados + soloNombre) / picks.length;
  console.log(`\n=> techo real de cobertura sobre estos picks: ${techo.toFixed(1)}%`);
  console.log(techo < 15
    ? '   Comprar otra API NO resolvería: el problema es que las ligas no se cotizan.'
    : '   Hay margen recuperable; conviene revisar el mapeo de ligas antes de pagar nada.');

  if (Object.keys(porLigaNueva).length) {
    console.log('\n=== LIGAS QUE FALTAN EN CHAMP_MAP (añadirlas es gratis) ===');
    for (const [champ, v] of Object.entries(porLigaNueva).sort((a, b) => b[1].n - a[1].n)) {
      console.log(`  ['${champ.toLowerCase()}', '${v.key}'],   // ${v.n} pick(s)`);
    }
  }
  if (hallazgos.length) {
    console.log('\n=== EJEMPLOS CONFIRMADOS ===');
    for (const h of hallazgos.filter(x => x.scoreOk).slice(0, 8)) {
      console.log(`  ${h.pick.event.slice(0, 34).padEnd(34)} ${h.pick.final_score}  ==  ${h.ev.home} ${h.ev.hs}-${h.ev.as} ${h.ev.away}  [${h.ev.key}]`);
    }
  }
}

main().catch(e => console.error('ERROR:', e.message));
