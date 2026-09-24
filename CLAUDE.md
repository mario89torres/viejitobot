# CLAUDE.md — contexto para agentes en Playdoit Monitor / ViejitoBot

Detección de valor en apuestas deportivas en vivo (playdoit.mx): muestrea cuotas → calcula
probabilidad justa (de-vig) → filtra con un firewall basado en evidencia → entrega picks por
Telegram. Un modelo aprendido corre en paralelo en modo sombra/veto, nunca como decisor único.
Dashboard web para auditar el pipeline después del hecho.

Antes de tocar código, lee (en este orden):
1. [`docs/contexto-ia.md`](docs/contexto-ia.md) — roles, dónde SÍ/NO se usa IA, la línea entre
   construir y decidir. **Léelo primero**: define qué puedes hacer sin preguntar y qué no.
2. [`README.md`](README.md) — arquitectura, scoring, firewall, dimensionamiento (desactualizado
   en cifras puntuales — ver "Estado real" abajo).
3. [`docs/contexto-tecnico.md`](docs/contexto-tecnico.md) — mapa completo de módulos, con qué está
   vivo y qué es investigación de un solo uso.
4. `memory/` (fuera de este repo, en el directorio de memoria de Claude Code) — hallazgos
   medidos con N e intervalo de confianza. Antes de citar una cifra de ahí, verifica que el
   código/umbral no cambió.

## Regla dura (de `contexto-ia.md`, no la repitas mal)

La IA construye y diagnostica; **no decide sin auditoría humana del porqué**. En concreto:
- Nunca cambies `MODEL_MODE` a `learned` ni actives cosas que dejen al modelo aprendido decidir
  solo. Vino de un incidente real (confianza inflada + Kelly multiplicando el stake).
- Nunca cambies `STAKE_MODE` a `kelly`/`half_kelly` sin que el usuario lo pida explícitamente —
  `tiered` está así a propósito porque **no lee `conf`**, y eso es una medida de seguridad, no
  una preferencia de performance.
- No trates un backtest, correlación o racha corta como "la respuesta" — repórtalo como
  candidato con su N, y señala explícitamente si el tamaño de muestra alcanza para actuar.
- Cualquier comando nuevo de Telegram que lance procesos, escriba en disco o gaste cuota de API
  **debe** pasar por `isOwner()` (`src/telegram.js`) — el resto son de solo lectura y el bot
  atiende a cualquier chat a propósito.

## Comandos

```bash
npm install
node bot.js            # proceso principal (bot + sampler + emisión)
node index.js --once    # modo alternativo, un solo ciclo
npm test                 # node --test "tests/*.test.js"
npx tsc                  # compila src/**/*.ts -> dist/ (globalDrawScanner, server/dashboardApi)
```

- **`npm test` falla 8 de 120 a propósito** (ver README § Limitaciones): `isRejectedBy5Guards`
  exige historial de snapshots que los fixtures sintéticos no tienen. No es una regresión que
  haya que "arreglar" sin más contexto — si tocas `rankPicks`/firewall y ves fallos nuevos,
  compara contra ese baseline conocido antes de asumir que rompiste algo.
- Tras editar cualquier `.ts` en `src/`, hay que recompilar con `npx tsc` — `dist/` está
  versionado y el dashboard/scanner leen el `.js` compilado, no el `.ts`.
- El proceso corre bajo una tarea programada de Windows con `scripts/run-bot.cmd`, que fija
  `NODE_HOME=C:\Users\Invitadow\node` porque el Node del PATH normal pertenece al perfil de
  **otra** cuenta de Windows y romper el ABI rompe `better-sqlite3` (nativo). Si algo funciona
  en tu shell pero falla en producción, sospecha primero de esto antes que del código.
- Reinicio real: `scripts\restart-bot.cmd` o `/reboot` en Telegram (exige `BOT_SUPERVISED=1`).
  Un `kill` directo al proceso no basta: el `cmd.exe` supervisor lo relanza a los 10 s.

## Mapa mínimo (detalle completo en `docs/contexto-tecnico.md`)

| Capa | Módulos |
|---|---|
| Ingesta | `src/fetcher.js`, `src/sofaScraper.js`/`sofaMatch.js` (córners, ver piloto), `src/fotmobScraper.js` |
| Probabilidad/valor | `src/devig.js`, `src/normalize.js`, `src/confidence.js`, `src/model.js`, `src/sharp.js` |
| Filtro | `src/firewall.js`, `src/validate.js`, `src/health.js`, `src/metrics.js` |
| Persistencia | `src/db.js` (SQLite/`better-sqlite3`, síncrono), `src/results.js` |
| Distribución | `src/telegram.js`, `src/betlink.js`, `src/badgeStats.js`, `src/valueAlerts.js` |
| Nuevo (TS) | `src/globalDrawScanner.ts`, `src/server/dashboardApi.ts` → compilan a `dist/` |
| Orquestador | `bot.js` |

`scripts/` es grande y heterogénea: distingue **scripts vivos** (entrenamiento, backtests que se
re-ejecutan) de **scripts de investigación de un solo uso** (ya capturados en `memory/`, no
mantener). `scratch/` es exploración descartable, no arquitectura.

## Gotchas operativos (medidos, no supuestos — ver README § Limitaciones)

- **`better-sqlite3` es síncrono**: una consulta pesada congela sampler, Telegram y timers a la
  vez. Cualquier operación nueva sobre `snapshots.db` que pueda tardar necesita ventana acotada
  (patrón `PRUNE_MAX_MS`/`PRUNE_DELAY_MS`), no un `await` ingenuo.
- **El sampler puede enmudecer sin morir**: guard de instancia única + `await` colgado = deja de
  muestrear para siempre sin error visible. Cualquier `fetch` nuevo en el ciclo del sampler
  necesita timeout explícito (`AbortSignal.timeout`), y ciclos largos necesitan su propio
  watchdog `*_STUCK_MS` (patrón usado en sampler, `STATS_PILOT`, `FOTMOB_PILOT`).
  Ver memoria `incidente-bot-mudo` si tienes acceso al sistema de memoria de Claude Code.
- **La BD crece sin freno real**: el prune protege el historial completo de cualquier evento que
  alguna vez dio un pick. No asumas que `pruneSnapshots` libera espacio sin medirlo primero.
- **Umbrales y modos documentan el "por qué" en `.env.example`**, no solo el valor — sigue esa
  convención si añades una variable nueva: cifra medida, fecha, y qué se probó y se descartó.

## Convenciones

- Idioma del proyecto: **español** — código, commits, comentarios, docs y memoria. Responde y
  documenta en español salvo que el usuario pida lo contrario.
- No inventes cifras. Si algo no está medido en el código actual o en memoria vigente, dilo en
  vez de rellenar con un número plausible.
- `STATS_PILOT`, `FOTMOB_PILOT`, `EXEC_PROBE` y `valueAlerts` son de **solo lectura/medición**:
  no puntúan, no emiten, no tocan el firewall ni el modelo. Si tocas alguno, no dejes que se
  filtre hacia el camino crítico de emisión sin que el usuario lo pida.
