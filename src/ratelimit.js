// Ventana deslizante: nunca más de MAX_REQ_PER_MIN peticiones por minuto
const MAX_REQ_PER_MIN = Number(process.env.MAX_REQ_PER_MIN || 60);

let stamps = [];

async function acquire() {
  while (true) {
    const now = Date.now();
    stamps = stamps.filter(t => now - t < 60000);
    if (stamps.length < MAX_REQ_PER_MIN) {
      stamps.push(now);
      return;
    }
    await new Promise(r => setTimeout(r, 1000));
  }
}

function usage() {
  const now = Date.now();
  stamps = stamps.filter(t => now - t < 60000);
  return { used: stamps.length, max: MAX_REQ_PER_MIN };
}

module.exports = { acquire, usage };
