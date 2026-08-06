// Recalibración del béisbol (2026-07-29): los picks anteriores usaron una
// fórmula de avance distinta y no son comparables con los nuevos.
//
// Por qué no se sube SCORE_VERSION global: el cambio afecta SOLO al béisbol
// (curva de anotación + resolución media-entrada). Fútbol, tenis y el resto
// calculan exactamente igual que antes, así que subir la versión tiraría a la
// basura 435 picks válidos de fútbol para el entrenamiento.
//
// En su lugar se marcan los picks viejos de béisbol con score_version = 0,
// valor reservado para "régimen superado". El entrenador filtra por versión,
// así que quedan fuera sin perder el dato.
const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, '..', 'snapshots.db'));

const antes = db.prepare(`
  SELECT COUNT(*) n FROM picks WHERE sport = 'Béisbol' AND score_version = 2
`).get().n;

const info = db.prepare(`
  UPDATE picks SET score_version = 0 WHERE sport = 'Béisbol' AND score_version = 2
`).run();

console.log(`${info.changes} picks de béisbol marcados como score_version = 0 (régimen superado).`);
console.log(`  eran ${antes} con la fórmula anterior (avance lineal inning/9, sin media entrada).`);

const dist = db.prepare('SELECT score_version v, COUNT(*) n FROM picks GROUP BY v ORDER BY v').all();
console.log('Distribución de versiones:', JSON.stringify(dist));

const v2f = db.prepare(`
  SELECT COUNT(*) n FROM picks WHERE score_version = 2 AND result IN ('win','loss')
`).get().n;
console.log(`v2 liquidados restantes (fútbol y otros, intactos): ${v2f}`);
