const { devig, defaultMethod } = require('./devig');

function decimalToAmerican(dec) {
  if (dec >= 2) return `+${Math.round((dec - 1) * 100)}`;
  return `${Math.round(-100 / (dec - 1))}`;
}

// Aplana la respuesta de GetLiveOverview a filas: una por momio (selección)
function normalize(sportResults) {
  const rows = [];
  const ts = new Date().toISOString();

  for (const { sport, data } of sportResults) {
    const champsById = new Map((data.champs || []).map(c => [c.id, c.name]));
    const marketsById = new Map((data.markets || []).map(m => [m.id, m]));
    const oddsById = new Map((data.odds || []).map(o => [o.id, o]));

    for (const ev of data.events || []) {
      const score = Array.isArray(ev.score) && ev.score.length ? ev.score.join('-') : '';
      const minuteMatch = (ev.liveTime || '').match(/(\d+)/);
      const periodMatch = (ev.ls || '').match(/(\d+)/);
      let minute = minuteMatch ? Number(minuteMatch[1]) : null;
      // Béisbol: el feed distingue mitad alta y baja del inning ("1st inning
      // bottom"). Sumar 0.5 en la baja duplica la resolución del avance, que
      // con solo 9 innings era demasiado gruesa: el 61% de los picks quedaba
      // saturado en 1.0, dando por terminado un partido que aún anotaba.
      if (minute !== null && /bottom/i.test(ev.liveTime || '')) minute += 0.5;
      const setNum = periodMatch ? Number(periodMatch[1]) : null;
      for (const mId of ev.marketIds || []) {
        const market = marketsById.get(mId);
        if (!market) continue;
        const marketName = market.sv ? `${market.name} ${market.sv}` : market.name;
        const validOdds = (market.oddIds || [])
          .map(id => oddsById.get(id))
          .filter(o => o && typeof o.price === 'number' && o.price > 1);
        // prob. justa: quita el margen de la casa con devig() sobre los momios
        // activos del mercado (método configurable vía DEVIG_METHOD, default shin)
        const activeOdds = validOdds.filter(o => o.oddStatus === 0);
        let probByOddId = null;
        if (activeOdds.length > 1) {
          const probs = devig(activeOdds.map(o => o.price), defaultMethod());
          probByOddId = new Map(activeOdds.map((o, i) => [o.id, probs[i]]));
        }
        for (const odd of validOdds) {
          const fairProb = probByOddId && probByOddId.has(odd.id)
            ? probByOddId.get(odd.id)
            : 1 / odd.price;
          rows.push({
            ts,
            sport: sport.name,
            sportId: sport.id,
            champ: champsById.get(ev.champId) || '',
            eventId: ev.id,
            event: ev.name,
            score,
            liveTime: [ev.liveTime, ev.ls].filter(Boolean).join(' — '),
            minute,
            setNum,
            market: marketName,
            selection: odd.name,
            oddDecimal: odd.price,
            oddAmerican: decimalToAmerican(odd.price),
            fairProb,
            suspended: odd.oddStatus === 0 ? 0 : 1,
          });
        }
      }
    }
  }
  return rows;
}

module.exports = { normalize, decimalToAmerican };
