const test = require('node:test');
const assert = require('node:assert');
const { textoExperimentos, resumirGrupo, MIN_N } = require('../src/experimentos');

const corner = (id, result, extra = {}) => ({ id, event: `Equipo ${id} vs. Otro`, linea: 9.5, lado: 'over', odd: 2.0, minuto: 40, result, final_count: result ? 11 : null, ...extra });

test('resumirGrupo: ROI a 1u plano, pendientes aparte, push sin P/L', () => {
  const g = resumirGrupo([{ odd: 2, result: 'win' }, { odd: 1.5, result: 'loss' }, { odd: 3, result: 'push' }, { odd: 2, result: null }]);
  assert.deepStrictEqual({ n: g.n, w: g.w, l: g.l, push: g.push, pend: g.pend, dec: g.dec }, { n: 4, w: 1, l: 1, push: 1, pend: 1, dec: 2 });
  assert.ok(Math.abs(g.pl - 0) < 1e-9);       // +1 de la ganada, -1 de la perdida
  assert.strictEqual(resumirGrupo([]).roi, null);
});

test('sin picks registrados lo dice, sin inventar cifras', () => {
  const t = textoExperimentos({ corners: [], rescate: [] });
  assert.match(t, /Corners/);
  assert.match(t, /Aún no hay ninguno registrado/);
  assert.doesNotMatch(t, /ROI/);
});

test('con pocos liquidados advierte que no se puede concluir', () => {
  const t = textoExperimentos({ corners: [corner(3, 'win'), corner(2, 'loss'), corner(1, null)] });
  assert.match(t, /3 registrados · 2 liquidados \(1✅ 1❌\) · 1 pendientes/);
  assert.match(t, /ROI a 1u/);
  assert.match(t, new RegExp(`muy pocos para concluir nada \\(mínimo ${MIN_N}\\)`));
  assert.match(t, /✅ #C3/);
  assert.match(t, /⏳ #C1/);
});

test('sin ninguno liquidado no muestra ROI; con >= MIN_N quita la advertencia', () => {
  assert.doesNotMatch(textoExperimentos({ corners: [corner(1, null)] }), /ROI a 1u/);
  const muchos = Array.from({ length: MIN_N }, (_, i) => corner(i + 1, i % 2 ? 'win' : 'loss'));
  assert.doesNotMatch(textoExperimentos({ corners: muchos }), /muy pocos para concluir/);
});

test('escapa HTML de los nombres y limita la lista a las más recientes', () => {
  const t = textoExperimentos({ corners: Array.from({ length: 10 }, (_, i) => corner(10 - i, 'win', { event: 'A <b> & B' })) });
  assert.match(t, /A &lt;b&gt; &amp; B/);
  assert.strictEqual((t.match(/#C\d+/g) || []).length, 6);
});

test('rescate: usa odd_decimal y el marcador final', () => {
  const t = textoExperimentos({ rescate: [{ id: 99, event: 'X vs. Y', market: 'Total 2.5', selection: 'Menos de 2.5', odd_decimal: 1.45, result: 'loss', final_score: '3-1' }] });
  assert.match(t, /❌ #99 X vs\. Y — Menos de 2\.5 @ 1\.45 \(3-1\)/);
});
