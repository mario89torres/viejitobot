// Derivacion de etiquetas del piloto de estadisticas (src/matchStats.js).
//
// Es el codigo mas peligroso del piloto: si etiqueta de mas, mete resultados
// inventados en el dataset y todo lo que se entrene despues aprende de ruido —
// exactamente lo que paso con las features fabricadas de global_draw. Estos
// tests fijan la frontera: cuando SI se etiqueta y, sobre todo, cuando NO.
const test = require('node:test');
const assert = require('node:assert');
const { derivarEtiquetas } = require('../src/matchStats');

// Fila tal como sale de stat_snapshots (snake_case, que es lo que lee la funcion)
const fila = (o) => ({
  ts: '2026-08-29T20:00:00.000Z', familia: 'corner',
  event_id: 1, event: 'Alfa vs. Beta', champ: 'Liga',
  minute: 90, market: 'Total Tiros De Esquina 9.5', selection: 'Más de 9.5',
  linea: 9.5, lado: 'over', odd_decimal: 1.9, fair_prob: 0.5, conteo: null, ...o,
});

// Un par over/under de la misma linea en el mismo instante
const par = (o = {}) => [
  fila({ lado: 'over', selection: 'Más de 9.5', odd_decimal: o.over ?? 1.9, ...o }),
  fila({ lado: 'under', selection: 'Menos de 9.5', odd_decimal: o.under ?? 1.9, ...o }),
];

test('MONOTONÍA: el over ya ganado se etiqueta con certeza', () => {
  // Los córners solo suben: si el conteo superó la línea, no hay vuelta atrás.
  const m = [
    ...par({ ts: '2026-08-29T20:00:00.000Z', minute: 60, conteo: 5 }),
    ...par({ ts: '2026-08-29T20:30:00.000Z', minute: 90, conteo: 11 }),
  ];
  const [r] = derivarEtiquetas(m);
  assert.strictEqual(r.metodo, 'monotonia');
  assert.strictEqual(r.certeza, 'cierta');
  assert.strictEqual(r.ladoGanador, 'over', '11 córners superan la línea 9.5');
  assert.strictEqual(r.conteoMax, 11);
});

test('MONOTONÍA: vale aunque el contador muera antes del final', () => {
  // Es el caso REAL medido: la casa retira el mercado del N-ésimo ~2.6 min antes
  // del pitido. La regla vieja exigía contador vivo al final y no se disparaba
  // nunca (0 de 286). Aquí el over ya estaba ganado en el minuto 70.
  const m = [
    ...par({ ts: '2026-08-29T20:00:00.000Z', minute: 60, conteo: 8 }),
    ...par({ ts: '2026-08-29T20:15:00.000Z', minute: 70, conteo: 11 }),
    ...par({ ts: '2026-08-29T20:30:00.000Z', minute: 93, conteo: null }),
  ];
  const [r] = derivarEtiquetas(m);
  assert.strictEqual(r.conteoCensurado, 1, 'el canal murió, y aun así se etiqueta');
  assert.strictEqual(r.metodo, 'monotonia');
  assert.strictEqual(r.ladoGanador, 'over');
});

test('el conteo bajo la línea al final es PROBABLE, no cierto', () => {
  // Un córner en el descuento lo voltea, así que se etiqueta pero se marca.
  const m = [
    ...par({ ts: '2026-08-29T20:00:00.000Z', minute: 80, conteo: 6 }),
    ...par({ ts: '2026-08-29T20:10:00.000Z', minute: 92, conteo: 7 }),
  ];
  const [r] = derivarEtiquetas(m);
  assert.strictEqual(r.ladoGanador, 'under');
  assert.strictEqual(r.metodo, 'escalera');
  assert.strictEqual(r.certeza, 'probable', 'no puede pasar por cierta');
});

test('NO etiqueta si el contador murió y no llegó a superar la línea', () => {
  const m = [
    ...par({ ts: '2026-08-29T20:00:00.000Z', minute: 60, conteo: 7 }),
    ...par({ ts: '2026-08-29T20:15:00.000Z', minute: 70, conteo: 8 }),
    ...par({ ts: '2026-08-29T20:30:00.000Z', minute: 93, conteo: null }),
  ];
  const [r] = derivarEtiquetas(m);
  assert.strictEqual(r.ladoGanador, null, '8 córners no superan 9.5 y faltan 23 min');
  assert.strictEqual(r.conteoMax, 8, 'la evidencia se conserva');
});

test('NO etiqueta por conteo si el partido no había terminado', () => {
  const m = [
    ...par({ ts: '2026-08-29T20:00:00.000Z', minute: 50, conteo: 6 }),
    ...par({ ts: '2026-08-29T20:10:00.000Z', minute: 60, conteo: 7 }),
  ];
  const [r] = derivarEtiquetas(m);
  assert.strictEqual(r.ladoGanador, null, 'al minuto 60 aún pueden caer más');
});

test('una sola observación del contador NO basta para la monotonía', () => {
  // El caso New Mexico United: llegó con 8 córners en el MINUTO 1. Sin una
  // segunda lectura que lo corrobore, una corrupción etiquetaría mal.
  const m = par({ minute: 1, conteo: 11 });
  const [r] = derivarEtiquetas(m);
  assert.strictEqual(r.ladoGanador, null);
  assert.strictEqual(r.serieFiable, 0, 'marcada como no fiable');
  assert.strictEqual(r.conteoMax, 11, 'pero la lectura se guarda');
});

test('un contador que BAJA invalida la serie entera', () => {
  // Los córners no bajan: si baja, alguna lectura está corrupta.
  const m = [
    ...par({ ts: '2026-08-29T20:00:00.000Z', minute: 60, conteo: 11 }),
    ...par({ ts: '2026-08-29T20:10:00.000Z', minute: 70, conteo: 4 }),
    ...par({ ts: '2026-08-29T20:20:00.000Z', minute: 90, conteo: 12 }),
  ];
  const [r] = derivarEtiquetas(m);
  assert.strictEqual(r.serieFiable, 0);
  assert.strictEqual(r.ladoGanador, null, 'con la serie rota no se etiqueta');
});

test('etiqueta por precio colapsado cuando no hay conteo', () => {
  const m = par({ minute: 94, over: 12, under: 1.01 });
  const [r] = derivarEtiquetas(m);
  assert.strictEqual(r.metodo, 'precio_colapsado');
  assert.strictEqual(r.ladoGanador, 'under');
});

test('tarjetas: sin canal de conteo, censurado es null (no 1)', () => {
  // Distinguir "el canal murió" de "nunca hubo canal" importa: lo primero es un
  // fallo del piloto, lo segundo es la familia que no lo tiene.
  const m = par({ familia: 'tarjeta', minute: 92, conteo: null });
  const [r] = derivarEtiquetas(m);
  assert.strictEqual(r.conteoCensurado, null);
  assert.strictEqual(r.conteoFinal, null);
  assert.strictEqual(r.ladoGanador, null);
});

test('la evidencia cruda viaja siempre, se etiquete o no', () => {
  const m = par({ minute: 50, over: 1.75, under: 2.05 });
  const [r] = derivarEtiquetas(m);
  assert.strictEqual(r.ladoGanador, null);
  assert.strictEqual(r.ultimoOddOver, 1.75);
  assert.strictEqual(r.ultimoOddUnder, 2.05);
  assert.ok(r.ultimaTs && r.featureVersion, 'ts y sello de versión presentes');
});

test('una fila por (familia, línea) y cuenta las muestras', () => {
  const m = [
    ...par({ ts: '2026-08-29T20:00:00.000Z' }),
    ...par({ ts: '2026-08-29T20:10:00.000Z' }),
    fila({ ts: '2026-08-29T20:10:00.000Z', linea: 10.5, lado: 'over', selection: 'Más de 10.5' }),
    fila({ ts: '2026-08-29T20:10:00.000Z', familia: 'tarjeta', linea: 4.5, lado: 'over', selection: 'Más de 4.5' }),
  ];
  const r = derivarEtiquetas(m);
  assert.strictEqual(r.length, 3, 'corner 9.5, corner 10.5 y tarjeta 4.5');
  const c95 = r.find(x => x.familia === 'corner' && x.linea === 9.5);
  assert.strictEqual(c95.nMuestras, 4, 'dos instantes x over/under');
});

test('sin muestras no inventa nada', () => {
  assert.deepStrictEqual(derivarEtiquetas([]), []);
  assert.deepStrictEqual(derivarEtiquetas(null), []);
});

// ─────────────────────────────────────────────────────────────────────────────
// ESCALERA COMPLETA — el arreglo del sesgo de selección.
//
// Etiquetando solo lo demostrable, la monotonía produce únicamente 'over' (por
// construcción) y el precio colapsado tira a 'under'. El reparto que salía
// describía las reglas, no el mercado. Con el conteo final se etiquetan TODAS
// las líneas del partido, los dos lados, sin elegir cuáles.
// ─────────────────────────────────────────────────────────────────────────────

test('ESCALERA: el conteo final etiqueta todas las líneas, los dos lados', () => {
  const inst = (ts, minute, conteo, lineas) => lineas.flatMap(L => [
    fila({ ts, minute, conteo, linea: L, lado: 'over', selection: 'Más de ' + L }),
    fila({ ts, minute, conteo, linea: L, lado: 'under', selection: 'Menos de ' + L }),
  ]);
  const m = [
    ...inst('2026-08-30T20:00:00.000Z', 60, 5, [7.5, 9.5, 11.5]),
    ...inst('2026-08-30T20:20:00.000Z', 88, 9, [7.5, 9.5, 11.5]),
  ];
  const r = derivarEtiquetas(m).sort((a, b) => a.linea - b.linea);
  assert.strictEqual(r.length, 3);
  // 9 córners: supera 7.5 (over, demostrado) y se queda bajo 9.5 y 11.5.
  assert.deepStrictEqual(r.map(x => x.ladoGanador), ['over', 'under', 'under']);
  assert.strictEqual(r[0].metodo, 'monotonia', 'el over lo demuestra la monotonía');
  assert.strictEqual(r[0].certeza, 'cierta');
  assert.strictEqual(r[1].metodo, 'escalera');
  assert.strictEqual(r[1].certeza, 'probable', 'un córner en el descuento lo voltea');
  assert.strictEqual(r[2].metodo, 'escalera');
});

test('ESCALERA: se mira el minuto del CONTADOR, no el de la última muestra', () => {
  // El caso real: la casa retira el mercado del N-ésimo ~2.6 min antes del
  // final, así que la última muestra no trae conteo. Exigir contador vivo en esa
  // última muestra era lo que impedía etiquetar (0 de 286).
  const m = [
    ...par({ ts: '2026-08-30T20:00:00.000Z', minute: 70, conteo: 6 }),
    ...par({ ts: '2026-08-30T20:10:00.000Z', minute: 87, conteo: 8 }),
    ...par({ ts: '2026-08-30T20:20:00.000Z', minute: 93, conteo: null }),
  ];
  const [r] = derivarEtiquetas(m);
  assert.strictEqual(r.conteoCensurado, 1, 'el contador murió antes del pitido');
  assert.strictEqual(r.minutoUltimoConteo, 87);
  assert.strictEqual(r.ladoGanador, 'under', '8 córners bajo la línea 9.5');
  assert.strictEqual(r.metodo, 'escalera');
});

test('ESCALERA: no etiqueta si el contador murió pronto', () => {
  const m = [
    ...par({ ts: '2026-08-30T20:00:00.000Z', minute: 50, conteo: 4 }),
    ...par({ ts: '2026-08-30T20:10:00.000Z', minute: 62, conteo: 5 }),
    ...par({ ts: '2026-08-30T20:20:00.000Z', minute: 93, conteo: null }),
  ];
  const [r] = derivarEtiquetas(m);
  assert.strictEqual(r.minutoUltimoConteo, 62);
  assert.strictEqual(r.ladoGanador, null, 'del 62 al final caben muchos córners');
});

// ─────────────────────────────────────────────────────────────────────────────
// POISSON EN SOMBRA
// ─────────────────────────────────────────────────────────────────────────────
const { probUnderPoisson, esMercadoGlobal } = require('../src/matchStats');

test('Poisson: el colchón usa floor(línea), no la línea', () => {
  // Línea 9.5 con 7 córners: el under aguanta hasta 9 en total, o sea 2 más.
  // Con 5 min restantes (media 0.6) eso es casi seguro.
  assert.ok(probUnderPoisson(7, 9.5, 85) > 0.97);
  // Con 30 min restantes (media 3.6) ya no.
  assert.ok(probUnderPoisson(7, 9.5, 60) < 0.35);
});

test('Poisson: casos límite sin ambigüedad', () => {
  assert.strictEqual(probUnderPoisson(10, 9.5, 70), 0, 'ya se pasó: el under perdió');
  assert.strictEqual(probUnderPoisson(7, 9.5, 90), 1, 'no queda tiempo: el under ganó');
  assert.strictEqual(probUnderPoisson(7, 9.5, 95), 1, 'pasado el 90 tampoco');
});

test('Poisson: sin ingredientes devuelve null, no 0.5', () => {
  // Un 0.5 de relleno se leería como "el modelo cree que es una moneda", que es
  // justo la clase de dato fabricado que arruinó los picks de global_draw.
  assert.strictEqual(probUnderPoisson(null, 9.5, 60), null);
  assert.strictEqual(probUnderPoisson(7, null, 60), null);
  assert.strictEqual(probUnderPoisson(7, 9.5, null), null);
  assert.strictEqual(probUnderPoisson(7, 9.5, 60, 0), null, 'lambda no positiva');
});

test('Poisson: es monótono en el tiempo y en el conteo', () => {
  const a = probUnderPoisson(5, 9.5, 40);
  const b = probUnderPoisson(5, 9.5, 70);
  assert.ok(b > a, 'menos tiempo restante => más probable el under');
  const c = probUnderPoisson(8, 9.5, 60);
  assert.ok(c < probUnderPoisson(5, 9.5, 60), 'más córners ya caídos => menos probable');
});

test('solo el mercado global lleva Poisson', () => {
  // El contador cuenta córners del PARTIDO: aplicarlo a una línea por equipo o
  // de media parte compara dos cosas distintas.
  assert.ok(esMercadoGlobal('Total Tiros De Esquina 9.5'));
  assert.ok(esMercadoGlobal('Total de tarjetas 4.5'));
  assert.ok(!esMercadoGlobal('America Total de Tiros de Esquina 4.5'));
  assert.ok(!esMercadoGlobal('1ª mitad - Total Tiros de Esquina 3.5'));
});
