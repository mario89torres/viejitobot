// Sobre el snapshot actual: filtra y devuelve las N jugadas con menor momio decimal
function topPicks(rows, config) {
  const { minOdds, maxOdds, excludeSports, topN } = config;
  const seen = new Set();

  return rows
    .filter(r => !r.suspended)
    .filter(r => r.oddDecimal >= minOdds && r.oddDecimal <= maxOdds)
    .filter(r => !excludeSports.includes(r.sport.toLowerCase()))
    .sort((a, b) => a.oddDecimal - b.oddDecimal)
    .filter(r => {
      // máximo una jugada por evento para diversificar
      if (seen.has(r.eventId)) return false;
      seen.add(r.eventId);
      return true;
    })
    .slice(0, topN);
}

module.exports = { topPicks };
