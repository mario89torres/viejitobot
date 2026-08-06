require('dotenv').config();
const { scoreRow } = require('../src/confidence');
const { parsePick } = require('../src/markets');

const pick1481 = {
  sportId: 76,
  sport: 'Béisbol',
  event: 'Kufu Hayate Reserves @ Hokkaido Nippon-Ham Fighters Reserve',
  score: '9-4',
  minute: 9,
  market: 'Totales (incl. extra innings) 13.5',
  selection: 'Más de 13.5',
  oddDecimal: 1.952,
  fairProb: 1 / 1.952,
  eventId: 999999,
};

console.log('Parsed:', parsePick(pick1481));
const result = scoreRow(pick1481);
console.log('=== Diagnóstico del Pick 1481 ===');
console.log('Confianza final:', (100 * result.conf).toFixed(1) + '%');
console.log('Conf Heurístico:', (100 * result.confHeuristic).toFixed(1) + '%');
console.log('Conf Learned:', result.confLearned ? (100 * result.confLearned).toFixed(1) + '%' : 'N/A');
console.log('Edge:', (100 * result.edge).toFixed(1) + '%');
console.log('Stake:', result.stake + 'u');
console.log('Progress:', result.progress);
