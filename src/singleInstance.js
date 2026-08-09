/**
 * Candado de instancia única para bot.js.
 *
 * EL PROBLEMA (medido el 2026-08-09): nada impedía correr dos bots a la vez.
 * Con las dos cuentas de Windows de esta máquina es fácil que pase — bastó con
 * que alguien abriera una consola bajo la cuenta PC y lanzara el bot mientras
 * la tarea programada de Invitadow ya lo tenía corriendo. Síntomas:
 *
 *   [poll error] Conflict: terminated by other getUpdates request
 *
 * Telegram solo admite un getUpdates por token, así que las dos instancias se
 * expulsan mutuamente y los comandos responden de forma errática. Peor: ambas
 * muestrean, liquidan y emiten picks sobre la MISMA base de datos, duplicando
 * la exposición de stake y contaminando el dataset con picks repetidos.
 *
 * LA SOLUCIÓN: un lockfile con el PID del dueño. Al arrancar, si el PID
 * apuntado sigue vivo, esta instancia se niega a continuar en vez de pelear.
 *
 * Detalle importante para el caso de las dos cuentas: comprobar si un PID de
 * OTRO usuario sigue vivo no es trivial. `process.kill(pid, 0)` lanza ESRCH si
 * no existe, pero EPERM si existe y no tenemos permiso sobre él — y EPERM es
 * justo la respuesta cuando el dueño es la otra cuenta. Por eso EPERM cuenta
 * como "vivo": es exactamente el escenario que esto viene a evitar.
 *
 * El lock es best-effort a propósito: si el archivo está corrupto o el proceso
 * murió sin limpiarlo, se reclama y se sigue. Nunca debe impedir un arranque
 * legítimo tras un crash.
 */
const fs = require('fs');
const path = require('path');

const LOCK = path.join(__dirname, '..', '.bot.lock');

/** true si el PID existe, aunque pertenezca a otro usuario. */
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM = el proceso existe pero es de otra cuenta: cuenta como vivo.
    return e.code === 'EPERM';
  }
}

/**
 * Toma el lock o aborta el arranque.
 * @param {(msg: string) => void} log
 * @returns {boolean} true si se tomó el lock
 */
function acquire(log = console.error) {
  try {
    if (fs.existsSync(LOCK)) {
      const raw = fs.readFileSync(LOCK, 'utf8').trim();
      const prev = Number(raw.split(/\s+/)[0]);
      if (Number.isInteger(prev) && prev > 0 && prev !== process.pid && pidAlive(prev)) {
        log(`[lock] Ya hay un bot corriendo (PID ${prev}). Esta instancia NO arranca.`);
        log('[lock] Dos instancias se expulsan mutuamente en getUpdates y duplican picks');
        log(`[lock] sobre la misma BD. Si el PID ${prev} es un proceso muerto, borra ${path.basename(LOCK)}.`);
        return false;
      }
      // PID muerto, ilegible o el nuestro: el lock quedó huérfano, se reclama.
    }
  } catch (e) {
    log(`[lock] no se pudo leer el lock (${e.message}); se continúa sin bloquear`);
    return true;
  }

  try {
    fs.writeFileSync(LOCK, `${process.pid} ${new Date().toISOString()}\n`);
  } catch (e) {
    log(`[lock] no se pudo escribir el lock (${e.message}); se continúa sin bloquear`);
    return true;
  }

  const release = () => {
    try {
      const raw = fs.readFileSync(LOCK, 'utf8').trim();
      // Solo borra si el lock sigue siendo nuestro: si otra instancia lo
      // reclamó, borrarlo la dejaría desprotegida.
      if (Number(raw.split(/\s+/)[0]) === process.pid) fs.unlinkSync(LOCK);
    } catch { /* el archivo ya no está o no es legible: nada que hacer */ }
  };
  process.on('exit', release);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => { release(); process.exit(0); });
  }
  return true;
}

module.exports = { acquire, pidAlive, LOCK };
