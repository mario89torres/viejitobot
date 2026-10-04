// BD temporal: sin esto el test abre el snapshots.db REAL (este escribia un pick falso en produccion).
require('./helpers/db-temporal');
// Estadísticas vivas de los badges. Lo que más importa probar no es que el
// número salga bien, sino que NO salga cuando no debe: un badge con una cifra
// construida sobre veinte picks es exactamente el error que retiramos con el 🔥.
const test = require('node:test');
const assert = require('node:assert');

// Historial propio en la BD temporal: el test exige > 100 picks liquidados y antes dependia de que existieran en
// el snapshots.db de produccion. 150 picks, 2 de cada 3 ganados, repartidos hacia atras de hora en hora.
{
  const { db } = require('../src/db');
  const ins = db.prepare(`INSERT INTO picks (ts,event_id,event,sport,market,selection,odd_decimal,conf,result,stake,stake_mode,source)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
  const ahora = Date.now();
  for (let i = 0; i < 150; i++) {
    ins.run(new Date(ahora - i * 3600e3).toISOString(), 9000 + i, 'A vs. B', 'Fútbol', 'Total 2.5', 'Menos de 2.5', 1.5, 0.7, i % 3 ? 'win' : 'loss', 1, 'tiered', 'auto');
  }
}

const conEnv = (vars, fn) => {
  const prev = {};
  for (const [k, v] of Object.entries(vars)) { prev[k] = process.env[k]; process.env[k] = v; }
  // El módulo cachea; hay que recargarlo para que lea el entorno nuevo.
  delete require.cache[require.resolve('../src/badgeStats')];
  try { return fn(require('../src/badgeStats')); } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    delete require.cache[require.resolve('../src/badgeStats')];
  }
};

test('recalcular devuelve la forma esperada y usa el histórico completo', () => {
  const s = conEnv({}, B => B.recalcular());
  assert.ok(s.base > 100, `base demasiado pequeña: ${s.base}`);
  for (const k of ['rectaFinal', 'elite']) {
    if (s[k] === null) continue; // legítimo si no hay muestra
    assert.ok(s[k].n > 0, `${k} sin n`);
    assert.strictEqual(typeof s[k].roi, 'number');
    assert.ok(Number.isFinite(s[k].roi), `${k}.roi no es finito`);
  }
});

test('con BADGE_MIN_N imposible NO inventa cifra: devuelve null y frase vacía', () => {
  conEnv({ BADGE_MIN_N: '999999' }, B => {
    const s = B.estadisticas();
    assert.strictEqual(s.rectaFinal, null, 'debería negarse a dar cifra');
    assert.strictEqual(s.elite, null);
    assert.strictEqual(B.frase('rectaFinal'), '', 'sin muestra, la frase debe ir vacía');
    assert.strictEqual(B.frase('elite'), '');
  });
});

test('frase() incluye el N para que el lector juzgue la muestra', () => {
  conEnv({ BADGE_MIN_N: '1' }, B => {
    const s = B.estadisticas();
    if (!s.rectaFinal) return; // sin datos, nada que comprobar
    const f = B.frase('rectaFinal');
    assert.match(f, /%/, 'debe llevar el porcentaje');
    assert.match(f, new RegExp(`${s.rectaFinal.n} picks`), 'debe llevar el tamaño de muestra');
  });
});

test('una clave desconocida no revienta: devuelve cadena vacía', () => {
  conEnv({}, B => assert.strictEqual(B.frase('noExiste'), ''));
});

test('la segunda llamada viene de caché (no re-consulta la BD)', () => {
  conEnv({}, B => {
    const a = B.estadisticas();
    const b = B.estadisticas();
    assert.strictEqual(a, b, 'debería ser el mismo objeto cacheado');
  });
});
