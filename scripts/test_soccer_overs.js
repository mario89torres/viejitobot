require('dotenv').config();
const { scoreRow } = require('../src/confidence');

// Caso 1: Fútbol min 85', marcador 1-1, apuestan Más de 2.5 (No cubierto aún)
const soccerOverUncovered = {
  sportId: 66,
  sport: 'Fútbol',
  event: 'Real Madrid vs Barcelona',
  score: '1-1',
  minute: 85,
  market: 'Total 2.5',
  selection: 'Más de 2.5',
  oddDecimal: 2.10,
  fairProb: 1 / 2.10,
  eventId: 8881,
};

// Caso 2: Fútbol min 85', marcador 1-1, apuestan Menos de 2.5 (A punto de ganar)
const soccerUnder = {
  sportId: 66,
  sport: 'Fútbol',
  event: 'Real Madrid vs Barcelona',
  score: '1-1',
  minute: 85,
  market: 'Total 2.5',
  selection: 'Menos de 2.5',
  oddDecimal: 1.65,
  fairProb: 1 / 1.65,
  eventId: 8882,
};

// Caso 3: Fútbol min 85', marcador 2-1, apuestan Más de 2.5 (Ya cubierto)
const soccerOverCovered = {
  sportId: 66,
  sport: 'Fútbol',
  event: 'Real Madrid vs Barcelona',
  score: '2-1',
  minute: 85,
  market: 'Total 2.5',
  selection: 'Más de 2.5',
  oddDecimal: 1.10,
  fairProb: 1 / 1.10,
  eventId: 8883,
};

console.log('=== CASO 1: Fútbol Over 2.5 a min 85\' (Marcador 1-1, Faltan goles) ===');
const r1 = scoreRow(soccerOverUncovered);
console.log(`Conf: ${(100*r1.conf).toFixed(1)}% | Edge: ${(100*r1.edge).toFixed(1)}% | Stake: ${r1.stake}u`);

console.log('\n=== CASO 2: Fútbol Under 2.5 a min 85\' (Marcador 1-1, En camino de ganar) ===');
const r2 = scoreRow(soccerUnder);
console.log(`Conf: ${(100*r2.conf).toFixed(1)}% | Edge: ${(100*r2.edge).toFixed(1)}% | Stake: ${r2.stake}u`);

console.log('\n=== CASO 3: Fútbol Over 2.5 a min 85\' (Marcador 2-1, Ya ganado) ===');
const r3 = scoreRow(soccerOverCovered);
console.log(`Conf: ${(100*r3.conf).toFixed(1)}% | Edge: ${(100*r3.edge).toFixed(1)}% | Stake: ${r3.stake}u`);
