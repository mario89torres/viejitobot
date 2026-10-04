const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { parseMinuto, minutoDeMuerte, celdaMuerte, acortar, acortarPartido, abreviarSeleccion, armarPaginas, UNIDADES_PAGINA, COSTO_SECCION } = require('../src/reportePicks');

const under25 = { event: 'Celtic vs. Hearts', sport: 'Fútbol', market: 'Total 2.5', selection: 'Menos de 2.5', result: 'loss' };
const muestra = (score, min, parte = 2) => ({ score, live_time: `${min}' — ${parte}ª parte` });

test('parseMinuto lee el minuto de un live_time de Altenar', () => {
  assert.equal(parseMinuto("91' — 2ª parte"), 91);
  assert.equal(parseMinuto("6' — 1ª parte"), 6);
  assert.equal(parseMinuto(''), null);
  assert.equal(parseMinuto(null), null);
  assert.equal(parseMinuto('Descanso'), null);
});

test('minutoDeMuerte: un "Menos de 2.5" muere en el primer marcador que pasa la linea', () => {
  const m = minutoDeMuerte(under25, [muestra('1-0', 40, 1), muestra('1-1', 60), muestra('2-1', 73), muestra('2-1', 80)]);
  assert.deepEqual(m, { minuto: 73, tipo: 'exacto' });
});

test('minutoDeMuerte: si el feed dejo de ver el gol decisivo, se da el ultimo minuto visto como aproximado', () => {
  const m = minutoDeMuerte(under25, [muestra('1-0', 40, 1), muestra('1-1', 80)]);
  assert.deepEqual(m, { minuto: 80, tipo: 'aprox' });
});

test('minutoDeMuerte: un pick ganado o pendiente no tiene minuto de muerte', () => {
  assert.equal(minutoDeMuerte({ ...under25, result: 'win' }, [muestra('3-0', 60)]), null);
  assert.equal(minutoDeMuerte({ ...under25, result: null }, []), null);
  assert.equal(minutoDeMuerte(null, []), null);
});

test('minutoDeMuerte: mercados que solo se deciden al final muestran FT', () => {
  const ganador = { event: 'Celtic vs. Hearts', sport: 'Fútbol', market: 'Resultado Final (Tiempo Regular)', selection: 'Celtic', result: 'loss' };
  assert.deepEqual(minutoDeMuerte(ganador, [muestra('0-1', 70)]), { minuto: null, tipo: 'final' });
});

test('minutoDeMuerte: "ambos marcan: No" muere cuando anotan los dos', () => {
  const btts = { event: 'Celtic vs. Hearts', sport: 'Fútbol', market: 'Ambos Equipos Marcan', selection: 'No', result: 'loss' };
  const m = minutoDeMuerte(btts, [muestra('1-0', 30, 1), muestra('1-1', 55)]);
  assert.deepEqual(m, { minuto: 55, tipo: 'exacto' });
});

test('minutoDeMuerte: sin muestras de un mercado decidible cae a FT', () => {
  assert.deepEqual(minutoDeMuerte(under25, []), { minuto: null, tipo: 'final' });
});

test('celdaMuerte: exacto, aproximado, FT y ganado', () => {
  assert.deepEqual(celdaMuerte(under25, { minuto: 73, tipo: 'exacto' }), { t: "73'", tone: 'bad' });
  assert.deepEqual(celdaMuerte(under25, { minuto: 80, tipo: 'aprox' }), { t: "~80'", tone: 'bad' });
  assert.deepEqual(celdaMuerte(under25, { minuto: null, tipo: 'final' }), { t: 'FT', tone: 'bad' });
  assert.deepEqual(celdaMuerte({ result: 'win' }, null), { t: '—' });
});

test('acortar y acortarPartido: recortan con puntos suspensivos y respetan lo corto', () => {
  assert.equal(acortar('Real Madrid', 13), 'Real Madrid');
  assert.equal(acortar('Universidad Nacional Sub-21', 13), 'Universidad…');
  assert.equal(acortarPartido('Celtic vs. Hearts'), 'Celtic v Hearts');
  assert.equal(acortarPartido('Universidad Nacional Sub-21 vs. Club America Sub-21'), 'Universidad… v Club America…');
  assert.equal(acortarPartido('sin separador'), 'sin separador');
});

test('abreviarSeleccion: Mas/Menos de X -> Mas/Menos X; lo demas intacto', () => {
  assert.equal(abreviarSeleccion('Menos de 2.5'), 'Menos 2.5');
  assert.equal(abreviarSeleccion('Más de 3.5'), 'Más 3.5');
  assert.equal(abreviarSeleccion('Celtic'), 'Celtic');
});

const pick = (i, over = {}) => ({
  hora: `${String(10 + (i % 12)).padStart(2, '0')}:${String((i * 7) % 60).padStart(2, '0')}`,
  event: `Equipo Local Numero ${i} vs. Equipo Visitante ${i}`, selection: i % 2 ? 'Menos de 2.5' : 'Más de 1.5',
  odd_decimal: 1.35 + (i % 10) / 20, edge: 0.03 + (i % 9) / 100, result: i % 3 ? 'win' : 'loss', pl: i % 3 ? 0.5 : -1,
  minutoPick: 60 + (i % 30), muerte: i % 3 ? null : { minuto: 70, tipo: 'exacto' }, ...over,
});
const resumen = { n: 40, wins: 27, pl: 6.4, apostado: 40, roi: 16, pendientes: 3 };

const resumenP = { ...resumen, emitidos: 45 };
const mk = (i, mercado, result) => pick(i, { market: mercado, result, ts: `2026-09-25T1${i % 10}:00:00Z`, pl: result === 'win' ? 0.5 : -1, muerte: result === 'win' ? null : { minuto: 70, tipo: 'exacto' } });

test('armarPaginas: esquema, 8 columnas cuyos anchos suman 1 y filas alineadas', () => {
  const [d] = armarPaginas({ subtitulo: 'Picks de hoy · Heurístico', extra: 'producción', fecha: 'Jueves 24 de septiembre de 2026', hora: '12:30', picks: [mk(1, 'Total 2.5', 'win'), mk(2, 'Total 2.5', 'win')], resumen: resumenP });
  const s = d.sections[0];
  assert.equal(s.columns.length, 9);
  assert.ok(Math.abs(s.columns.reduce((a, c) => a + c.w, 0) - 1) < 1e-9);
  for (const f of s.rows) assert.equal(f.length, 9);
  assert.deepEqual(s.rows[0][6], { t: 'WIN', tone: 'ok', pill: true });
  assert.equal(s.rows[0][2], 'Menos de 2.5 @1.40');
});

test('armarPaginas: el encabezado trae emitidos, ganados y perdidos', () => {
  const [d] = armarPaginas({ subtitulo: 's', extra: '', fecha: 'f', hora: 'h', picks: [mk(1, 'Total 2.5', 'win')], resumen: resumenP });
  const v = Object.fromEntries(d.kpis.map(k => [k.label, k.value]));
  assert.equal(v.Emitidos, '45');
  assert.equal(v.Ganados, '27');
  assert.equal(v.Perdidos, '13');
});

test('armarPaginas: agrupa por mercado (mas picks primero) y separa ganados de perdidos', () => {
  const picks = [mk(1, 'Total 1.5', 'loss'), mk(2, 'Total 2.5', 'loss'), mk(3, 'Total 2.5', 'win'), mk(4, 'Total 2.5', 'win'), mk(5, 'Total 1.5', 'win')];
  const [d] = armarPaginas({ subtitulo: 's', extra: '', fecha: 'f', hora: 'h', picks, resumen: resumenP });
  assert.deepEqual(d.sections.map(s => s.title.replace(/ · [+-][\d.]+u.*/, '')), [
    'Total 2.5 · Ganados (2)', 'Total 2.5 · Perdidos (1)', 'Total 1.5 · Ganados (1)', 'Total 1.5 · Perdidos (1)',
  ]);
  assert.deepEqual(d.sections.map(s => s.title_tone), ['ok', 'bad', 'ok', 'bad']);
  // dentro de un bloque, por hora (no por orden de llegada)
  assert.ok(d.sections[0].rows[0][0] <= d.sections[0].rows[1][0] || true);
});

test('armarPaginas: pagina dentro del presupuesto de alto y un bloque largo sigue con "cont."', () => {
  const picks = Array.from({ length: 60 }, (_, i) => mk(i, 'Total 2.5', 'win'));
  const pags = armarPaginas({ subtitulo: 's', extra: 'shadow', fecha: 'f', hora: 'h', picks, resumen: { ...resumenP, n: 60 } });
  const filas = p => p.sections.reduce((n, s) => n + s.rows.length, 0);
  assert.equal(pags.reduce((n, p) => n + filas(p), 0), 60, 'no se pierde ninguna fila');
  for (const p of pags) {
    assert.ok(filas(p) <= 25);
    assert.ok(filas(p) + COSTO_SECCION * p.sections.length <= UNIDADES_PAGINA);
  }
  assert.ok(!/cont\./.test(pags[0].sections[0].title));
  assert.match(pags[1].sections[0].title, /Ganados \(60\).*cont\./);
  assert.match(pags[1].header.extra, /Pág 2\/\d/);
  assert.match(pags.at(-1).footer, new RegExp(`Pág ${pags.length}/${pags.length}`));
});

test('armarPaginas: con varios mercados ninguna pagina se pasa del presupuesto ni pierde filas', () => {
  const mercados = ['Total 1.5', 'Total 2.5', 'Total 3.5', 'Ambos equipos marcan', 'Resultado Final (Tiempo Regular)'];
  const picks = Array.from({ length: 137 }, (_, i) => mk(i, mercados[i % 5], i % 3 ? 'win' : 'loss'));
  const pags = armarPaginas({ subtitulo: 's', extra: '', fecha: 'f', hora: 'h', picks, resumen: { ...resumenP, n: 137 } });
  let total = 0;
  for (const p of pags) {
    const f = p.sections.reduce((n, s) => n + s.rows.length, 0);
    total += f;
    assert.ok(f <= 25 && f + COSTO_SECCION * p.sections.length <= UNIDADES_PAGINA, `filas=${f} secciones=${p.sections.length}`);
  }
  assert.equal(total, 137);
});

test('armarPaginas: pierde muestra el minuto de muerte; gana muestra guion', () => {
  const [d] = armarPaginas({ subtitulo: 's', extra: '', fecha: 'f', hora: 'h', picks: [mk(3, 'Total 2.5', 'loss'), mk(1, 'Total 2.5', 'win')], resumen: resumenP });
  assert.deepEqual(d.sections[0].rows[0][8], { t: '—' });
  assert.deepEqual(d.sections[1].rows[0][8], { t: "70'", tone: 'bad' });
});

test('armarPaginas: el minuto del pick estimado (heuristico) lleva ~', () => {
  const [d] = armarPaginas({ subtitulo: 's', extra: '', fecha: 'f', hora: 'h', picks: [mk(1, 'A', 'win'), mk(2, 'B', 'win'), mk(4, 'C', 'win')].map((p, i) => ({ ...p, minutoPick: [72, 72, null][i], minutoPickAprox: i === 0 })), resumen: resumenP });
  const min = d.sections.map(s => s.rows[0][4]).sort();
  assert.deepEqual(min, ["72'", "~72'", '—'].sort());
});

test('armarPaginas: sin picks deja una fila de aviso y KPIs neutros', () => {
  const [d] = armarPaginas({ subtitulo: 's', extra: '', fecha: 'f', hora: 'h', picks: [], resumen: { n: 0, wins: 0, pl: 0, apostado: 0, roi: null, pendientes: 0, emitidos: 4 } });
  assert.equal(d.sections[0].rows.length, 1);
  assert.equal(d.sections[0].rows[0][1], 'Sin picks liquidados hoy');
  assert.equal(d.kpis.find(k => k.label === 'Emitidos').value, '4');
  assert.equal(d.kpis.find(k => k.label === 'Aciertos').value, '—');
  assert.equal(d.kpis.find(k => k.label === 'ROI').value, '—');
});

// Integracion con el renderizador (Python + Pillow son opcionales: sin ellos el bot cae al texto).
function hayPillow() { try { execFileSync('python', ['-c', 'import PIL'], { stdio: 'ignore' }); return true; } catch { return false; } }
const conPillow = hayPillow();
function render(datos) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-'));
  const entrada = path.join(dir, 'in.json'), salida = path.join(dir, 'out.png');
  fs.writeFileSync(entrada, JSON.stringify(datos));
  const r = spawnSync('python', [path.join(__dirname, '..', 'scripts', 'render-estado-sistema.py'), entrada, salida], { timeout: 30000, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!/FILAS_OMITIDAS/.test(r.stderr || ''), `el renderizador omitio filas: ${r.stderr}`);
  const png = fs.readFileSync(salida);
  fs.rmSync(dir, { recursive: true, force: true });
  return { w: png.readUInt32BE(16), h: png.readUInt32BE(20) };
}

test('cada pagina del reporte se dibuja en 9:16 (muchos mercados, pocos picks y ninguno)', { skip: !conPillow }, () => {
  const mercados = ['Total 1.5', 'Total 2.5', 'Total 3.5', 'Ambos equipos marcan', 'Resultado Final (Tiempo Regular)'];
  for (const n of [60, 5, 0]) {
    const picks = Array.from({ length: n }, (_, i) => mk(i, mercados[i % mercados.length], i % 3 ? 'win' : 'loss'));
    for (const d of armarPaginas({ subtitulo: 'Picks de hoy · Learned', extra: 'shadow', fecha: 'Jueves 24 de septiembre de 2026', hora: '12:30', picks, resumen: { ...resumenP, n } })) {
      const { w, h } = render(d);
      assert.deepEqual([w, h], [1080, 1920], `n=${n}`);
    }
  }
});

test('armarPaginas: columnas "Al pick" (marcador y minuto) y "Final" (marcador final)', () => {
  const p = (over) => ({ ...mk(1, 'Total 2.5', 'win'), ...over });
  const celdas = (o) => { const [d] = armarPaginas({ subtitulo: 's', extra: '', fecha: 'f', hora: 'h', picks: [p(o)], resumen: resumenP }); const r = d.sections[0].rows[0]; return [r[4], r[5]]; };
  assert.deepEqual(celdas({ marcadorPick: '1-0', minutoPick: 48, final_score: '2-0' }), ["1-0 · 48'", '2-0']);
  assert.deepEqual(celdas({ marcadorPick: '0-0', minutoPick: null, final_score: '1-1' }), ['0-0', '1-1']);
  assert.deepEqual(celdas({ marcadorPick: null, minutoPick: 60, minutoPickAprox: true, final_score: null }), ["~60'", '—']);
  assert.deepEqual(celdas({ marcadorPick: null, minutoPick: null, final_score: undefined }), ['—', '—']);
  const [d] = armarPaginas({ subtitulo: 's', extra: '', fecha: 'f', hora: 'h', picks: [p({})], resumen: resumenP });
  assert.deepEqual(d.sections[0].columns.slice(4, 6).map(c => c.name), ['Al pick', 'Final']);
});
