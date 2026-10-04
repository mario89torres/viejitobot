const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'render-estado-sistema.py');
const MUESTRA = path.join(__dirname, 'helpers', 'estado-sistema-muestra.json');

// Python + Pillow son opcionales en esta maquina: sin ellos el bot cae al texto
// (ver poll() en bot.js), asi que el test se omite en vez de fallar.
function pythonConPillow() {
  try { execFileSync('python', ['-c', 'import PIL'], { stdio: 'ignore' }); return true; } catch { return false; }
}
const hayPillow = pythonConPillow();

function dimensionesPng(buf) {
  assert.equal(buf.subarray(1, 4).toString(), 'PNG', 'no es un PNG');
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}
function render(datos) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'estado-'));
  const entrada = path.join(dir, 'in.json'), salida = path.join(dir, 'out.png');
  fs.writeFileSync(entrada, JSON.stringify(datos));
  execFileSync('python', [SCRIPT, entrada, salida], { timeout: 30000 });
  const png = fs.readFileSync(salida);
  fs.rmSync(dir, { recursive: true, force: true });
  return png;
}

test('el panel sale en 9:16 (1080x1920)', { skip: !hayPillow }, () => {
  const { w, h } = dimensionesPng(render(JSON.parse(fs.readFileSync(MUESTRA, 'utf8'))));
  assert.equal(w, 1080);
  assert.equal(h, 1920);
  assert.ok(Math.abs(w / h - 9 / 16) < 1e-9);
});

test('sigue siendo 9:16 con muchas mas filas (las filas se comprimen, no crece el lienzo)', { skip: !hayPillow }, () => {
  const datos = JSON.parse(fs.readFileSync(MUESTRA, 'utf8'));
  const extra = Array.from({ length: 12 }, (_, i) => [`Piloto extra ${i}`, { t: 'ACTIVO', tone: 'ok', pill: true }, '1 min', '2 min', 'x']);
  datos.sections[1].rows.push(...extra);
  const { w, h } = dimensionesPng(render(datos));
  assert.deepEqual([w, h], [1080, 1920]);
});

test('tolera secciones vacias, sin indicadores y celdas faltantes o con tono desconocido', { skip: !hayPillow }, () => {
  const datos = {
    header: { hora: '01:05', fecha: 'Jueves 24 de septiembre de 2026' },
    kpis: [],
    sections: [
      { title: 'Vacia', columns: [{ name: 'A', w: 1 }], rows: [] },
      { title: 'Rara', columns: [{ name: 'A', w: 0.5 }, { name: 'B', w: 0.5 }], rows: [['solo una celda'], [{ t: 'x', tone: 'inventado', pill: true }, { t: 'ñandú áéíóú', tone: 'ok' }]] },
    ],
  };
  const { w, h } = dimensionesPng(render(datos));
  assert.deepEqual([w, h], [1080, 1920]);
});

test('un texto muy largo se recorta en vez de desbordar la tabla', { skip: !hayPillow }, () => {
  const datos = JSON.parse(fs.readFileSync(MUESTRA, 'utf8'));
  datos.sections[0].rows[0][2] = 'detalle '.repeat(80);
  assert.doesNotThrow(() => render(datos));
});
