const { test } = require('node:test');
const assert = require('node:assert');

// Telegram rechaza mensajes de más de 4096 caracteres. El troceo vive en
// sendTelegram y no en cada handler: cualquier comando puede crecer, y
// arreglarlo caso por caso deja el siguiente sin cubrir.
//
// La regla que no se puede romper: cortar SIEMPRE por salto de línea. Con
// parse_mode HTML, partir dentro de una etiqueta invalida el mensaje entero.

const { trocear, TG_MAX } = require('../src/telegram');

test('un mensaje corto no se toca', () => {
  assert.deepEqual(trocear('hola'), ['hola']);
  assert.equal(trocear('a'.repeat(TG_MAX)).length, 1);
});

test('parte por líneas y ninguna parte excede el tope', () => {
  const linea = '<b>Pick</b> Equipo A vs. Equipo B — Menos de 2.5 @ 1.50';
  const texto = Array.from({ length: 400 }, () => linea).join('\n');
  const partes = trocear(texto);
  assert.ok(partes.length > 1, 'debe partirse');
  partes.forEach((p, i) => assert.ok(p.length <= TG_MAX, `parte ${i} mide ${p.length}`));
});

test('no pierde ni duplica contenido', () => {
  const lineas = Array.from({ length: 300 }, (_, i) => `línea número ${i} con texto de relleno`);
  const partes = trocear(lineas.join('\n'));
  assert.deepEqual(partes.join('\n').split('\n'), lineas);
});

test('nunca corta a mitad de una etiqueta HTML', () => {
  const texto = Array.from({ length: 500 }, (_, i) => `<b>fila ${i}</b> <i>dato</i>`).join('\n');
  for (const p of trocear(texto)) {
    // cada parte debe tener las etiquetas balanceadas
    for (const tag of ['b', 'i']) {
      const abre = (p.match(new RegExp(`<${tag}>`, 'g')) || []).length;
      const cierra = (p.match(new RegExp(`</${tag}>`, 'g')) || []).length;
      assert.equal(abre, cierra, `<${tag}> descompensada en una parte`);
    }
  }
});

test('una sola línea gigantesca se corta en duro sin colgarse', () => {
  const partes = trocear('x'.repeat(TG_MAX * 3 + 7));
  assert.equal(partes.length, 4);
  partes.forEach(p => assert.ok(p.length <= TG_MAX));
  assert.equal(partes.join('').length, TG_MAX * 3 + 7);
});

test('el caso real que falló: el listado de pendientes', () => {
  // 30 picks × 4 líneas, que es lo que genera el botón ⏳ Pendientes
  const pick = i => [
    `🤖 <b>${i}. 🏳️ Equipo Local vs. Equipo Visitante</b> <i>[12:34]</i>`,
    `   Total 2.5: <b>Menos de 2.5</b> @ 1.50`,
    `   Marcador: <b>1-0</b> <i>(67')</i>`,
    `   Cuota ahora: <b>1.40</b> → 🟢 a favor (-7%)`,
  ].join('\n');
  const texto = Array.from({ length: 30 }, (_, i) => pick(i + 1)).join('\n\n');
  assert.ok(texto.length > 4096, 'el caso real debe superar el límite de Telegram');
  const partes = trocear(texto);
  partes.forEach(p => assert.ok(p.length <= TG_MAX));
  assert.ok(partes.length >= 2);
});
