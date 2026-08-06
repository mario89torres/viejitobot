require('dotenv').config();
const { db } = require('../src/db');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

console.log('=== Buscando picks de Dardos ===');
const dartsPicks = db.prepare(`
  SELECT id, ts, event, sport, market, selection, odd_decimal, conf, result, final_score, stake
  FROM picks
  WHERE sport LIKE '%Dardos%' OR sport LIKE '%Darts%'
`).all();

console.log('Picks de Dardos encontrados:', dartsPicks);

if (dartsPicks.length) {
  const stmt = db.prepare('DELETE FROM picks WHERE id = ?');
  for (const p of dartsPicks) {
    stmt.run(p.id);
    console.log(`Eliminado Pick ID ${p.id}: ${p.event} (${p.sport}) - ${p.market}`);
  }
} else {
  console.log('No se encontraron picks con sport = Dardos en la tabla picks.');
}

console.log('\n=== Re-exportando dataset.csv limpio ===');
try {
  const out = execSync('node scripts/export-dataset.js', { encoding: 'utf8' });
  console.log(out);
} catch (e) {
  console.error('Error exportando dataset:', e.message);
}

console.log('Proceso de eliminación de Dardos completado.');
