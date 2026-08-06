// Corrige picks calificados con un mercado que el sistema no sabía interpretar.
//
// 1) "N-ésimo Gol" (Primer/Cuarto/Quinto Gol...): apuestas a quién anota el gol
//    número N. Caían en la rama 'winner' y se evaluaban como "¿ganó el partido?",
//    lo que produjo 52 picks marcados WIN sin una sola excepción — 16 de ellos
//    con menos goles totales que el número apostado, o sea imposibles de ganar.
//    Aportaban +23.3u de beneficio ficticio al fútbol.
//
// 2) "Empate No Acción" (draw no bet): el empate DEVUELVE la apuesta. Se
//    contaban como derrota, no como nulo.
//
// Ambos pasan a result='unknown', que el sistema ya trata como "no computa":
// queda fuera de ROI, calibración, CLV y dataset de entrenamiento. No se borra
// nada; el pick sigue ahí con su marcador para poder auditarlo.
const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, '..', 'snapshots.db'));

const NTH = /^(primer|segundo|tercer|cuarto|quinto|sexto|septimo|séptimo|octavo|noveno|decimo|décimo)\s+gol/i;

const settled = db.prepare(`
  SELECT id, market, selection, final_score, result FROM picks WHERE result IN ('win','loss')
`).all();

const nth = settled.filter(p => NTH.test(p.market || ''));
const dnbDraw = settled.filter(p => {
  if (!/no accion|no acción/i.test(p.market || '')) return false;
  const m = (p.final_score || '').match(/^(\d+)-(\d+)$/);
  return m && m[1] === m[2];            // solo el empate anula; el resto se califica bien
});

const upd = db.prepare(`UPDATE picks SET result = 'unknown' WHERE id = ?`);
const marcar = db.transaction((rows) => { for (const r of rows) upd.run(r.id); });

marcar(nth);
marcar(dnbDraw);

console.log(`"N-ésimo gol" marcados unknown: ${nth.length}`);
console.log(`"Empate No Acción" con empate (devolución): ${dnbDraw.length}`);
console.log(`Total corregidos: ${nth.length + dnbDraw.length}`);

const quedan = db.prepare(`SELECT COUNT(*) n FROM picks WHERE result IN ('win','loss')`).get().n;
console.log(`Picks liquidados restantes: ${quedan}`);
