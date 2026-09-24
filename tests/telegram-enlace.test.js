// El enlace del pick dentro del HTML de Telegram.
//
// EL FALLO QUE ESTO IMPIDE. El 2026-09-04 el deep link paso de
//   https://www.playdoit.mx/#/sport/66/event/123        (sin ningun &)
// a
//   https://www.playdoit.mx/#page=event&eventId=123&sportId=66   (dos &)
// y los cinco sitios que lo incrustaban en <a href="..."> lo hacian en crudo.
// Un & sin escapar dentro de un atributo es HTML invalido, y parse_mode=HTML de
// Telegram rechaza el mensaje ENTERO: el pick no llega sin enlace, no llega en
// absoluto. Con el formato viejo el bug estaba latente porque no habia ningun &.
const test = require('node:test');
const assert = require('node:assert');
const { enlaceHtml } = require('../src/telegram');
const { generateBetLink } = require('../src/betlink');

test('el & del deep link viaja escapado', () => {
  const url = 'https://www.playdoit.mx/#page=event&eventId=17523335&sportId=66';
  const html = enlaceHtml(url, 'Apostar en Playdoit');
  assert.match(html, /&amp;eventId=17523335&amp;sportId=66/);
  assert.ok(!/&(?!amp;|lt;|gt;)/.test(html), 'no puede quedar ningún & sin escapar');
});

test('el enlace que genera betlink sale apto para HTML', () => {
  // La prueba de fondo: lo que produce el generador real, pasado por el
  // incrustador real, no puede contener un & crudo.
  const url = generateBetLink({ event_id: 17523335, sport_id: 66 });
  assert.match(url, /&/, 'el formato actual SÍ trae &, por eso hace falta escapar');
  const html = enlaceHtml(url, 'Apostar');
  assert.ok(!/&(?!amp;)/.test(html), `& sin escapar en: ${html}`);
});

test('el texto del enlace también se escapa', () => {
  const html = enlaceHtml('https://x/y', 'Ver <b>esto</b> & aquello');
  assert.match(html, /Ver &lt;b&gt;esto&lt;\/b&gt; &amp; aquello/);
});

test('un evento sin sportId no rompe el HTML', () => {
  const url = generateBetLink({ event_id: 999999999 });
  const html = enlaceHtml(url, 'Abrir');
  assert.ok(!/&(?!amp;)/.test(html));
  assert.match(html, /eventId=999999999/);
});
