const { test } = require('node:test');
const assert = require('node:assert');
const { db, hasPickForEvent, findPick, isDuplicatePick } = require('../src/db');

// Dos reglas distintas, y la diferencia importa:
//   isDuplicatePick  -> ¿ya hay una POSICIÓN abierta en este evento, o esta
//                       misma selección alguna vez?
//   hasPickForEvent  -> ¿este partido ya recibió ALGÚN pick, liquidado o no?
//
// La segunda existe porque la liquidación temprana cierra mercados con el
// partido aún en juego: sin ella el evento quedaba libre a mitad de partido y
// entraba un segundo pick correlado con el primero.

const insertar = (extra = {}) => {
  const f = {
    ts: new Date().toISOString(), event_id: -4242, event: 'D vs. D', sport: 'Fútbol',
    market: 'Total 2.5', selection: 'Menos de 2.5', odd_decimal: 1.5, conf: 0.72,
    result: null, ...extra,
  };
  return db.prepare(`INSERT INTO picks (ts,event_id,event,sport,market,selection,odd_decimal,conf,result)
    VALUES (@ts,@event_id,@event,@sport,@market,@selection,@odd_decimal,@conf,@result)`).run(f).lastInsertRowid;
};
const limpiar = () => db.prepare('DELETE FROM picks WHERE event_id = ?').run(-4242);

test('un pick LIQUIDADO ya no bloquea por isDuplicatePick, pero sí por hasPickForEvent', () => {
  limpiar();
  insertar({ result: 'loss' });          // cerrado temprano, partido aún en juego
  try {
    // La regla vieja deja pasar otro mercado del mismo partido...
    assert.equal(isDuplicatePick(-4242, 'Ambos equipos marcan', 'No'), false);
    // ...y la nueva lo frena, que es lo que queremos en un partido vivo.
    assert.equal(hasPickForEvent(-4242), true);
  } finally { limpiar(); }
});

test('un pick sin liquidar bloquea por las dos reglas', () => {
  limpiar();
  insertar();
  try {
    assert.equal(isDuplicatePick(-4242, 'Ambos equipos marcan', 'No'), true);
    assert.equal(hasPickForEvent(-4242), true);
  } finally { limpiar(); }
});

test('un evento sin picks no bloquea nada', () => {
  limpiar();
  assert.equal(hasPickForEvent(-4242), false);
  assert.equal(isDuplicatePick(-4242, 'Total 2.5', 'Menos de 2.5'), false);
});

test('findPick localiza el pick ya emitido para marcarlo en el mensaje', () => {
  limpiar();
  const id = insertar({ result: 'win' });
  try {
    const p = findPick(-4242, 'Total 2.5', 'Menos de 2.5');
    assert.ok(p, 'debe encontrar el pick ya emitido');
    assert.equal(p.id, Number(id));
    assert.equal(p.result, 'win');
    // Otra selección del mismo evento no es el mismo pick.
    assert.equal(findPick(-4242, 'Total 3.5', 'Menos de 3.5'), undefined);
  } finally { limpiar(); }
});

test('findPick devuelve el PRIMERO si por lo que sea hubiera varios', () => {
  limpiar();
  const a = insertar({ result: 'win' });
  const b = insertar({ result: 'loss' });
  try {
    assert.equal(findPick(-4242, 'Total 2.5', 'Menos de 2.5').id, Number(a));
    assert.notEqual(Number(a), Number(b));
  } finally { limpiar(); }
});
