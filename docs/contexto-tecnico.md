# Contexto técnico — ViejitoBot (Playdoit Monitor)

> Archivo semilla para generar la documentación técnica del proyecto (estructura, arquitectura, evolución por hallazgos, glosario). Se lee al inicio de cada sesión de documentación; se actualiza cuando la arquitectura cambia — no cuando cambia un hallazgo puntual (eso va a `memory/` y se referencia desde aquí).

## 1. Qué es el sistema

Detección de valor en apuestas deportivas en vivo sobre momios de playdoit.mx. Pipeline: muestreo de cuotas en tiempo real → cálculo de probabilidad justa (de-vig) → firewall basado en evidencia → picks entregados por Telegram, con un modelo aprendido corriendo en paralelo en modo sombra/veto (nunca decisor único). Dashboard web para auditar el pipeline después del hecho.

Contexto de colaboración con IA (roles, qué se automatiza y qué no, y por qué): [contexto-ia.md](contexto-ia.md). Este archivo (`contexto-tecnico.md`) es el complemento orientado a arquitectura/código, no a reglas de colaboración.

## 2. Mapa de módulos (`src/`)

Runtime principal (CommonJS, Node.js) más un módulo TypeScript nuevo compilado a `dist/`.

**Ingesta y muestreo**
- `fetcher.js` — descarga cuotas en vivo de playdoit.mx (todas las líneas, todos los deportes)
- `sofaScraper.js`, `sofaMatch.js`, `sofaLive.js` — scraping de SofaScore (estadísticas de partido, córners) y matching contra los eventos de playdoit
- `matchStats.js` — extracción de estadísticas del partido y derivación de etiquetas de estado
- `ratelimit.js`, `singleInstance.js` — control de tasa de peticiones y candado de instancia única (ver hallazgo de las dos cuentas de Windows)

**Cálculo de probabilidad y valor**
- `devig.js` — remoción del margen de la casa (de-vig) para obtener probabilidad justa
- `normalize.js` — normalización de nombres de equipos/mercados entre fuentes
- `markets.js` — catálogo/soporte de mercados
- `negBinomial.js` — modelo estadístico auxiliar (binomial negativa)
- `confidence.js` — scoring de picks: `safestPicks`, `rankPicks`, `goldenPick`, `parlayCombos`, `rescuePicks`, `scoreCandidates` (`SCORE_VERSION`), `modelPicks`
- `analyze.js` — `topPicks` y análisis general de picks
- `model.js` — carga/modo del modelo aprendido (`getMode`, `reloadModel`) — ver `model.json`, `scripts/train_weights.py`
- `sharp.js` — comparación contra casas "sharp" (líneas de referencia) para auditar el edge

**Control de calidad / firewall**
- `firewall.js` — filtro basado en evidencia que decide qué picks se emiten (`isElite`)
- `validate.js` — validación de resultados liquidados contra marcador oficial
- `health.js` — cálculo de calibración/drift sobre los últimos N picks
- `metrics.js` — métricas agregadas: `computeMetrics`, `compareScores`, `edgeStats`, `computeHealth`, `stakeStats`, `rescueStats`

**Persistencia**
- `db.js` — capa sobre SQLite (better-sqlite3): snapshots de cuotas, picks, rechazados (`rejected_picks`, el grupo de control), suscriptores, resultados
- `results.js` — liquidación de picks (`processSettlements`)

**Distribución**
- `telegram.js` — formato y envío de mensajes, comandos del bot
- `betlink.js` — generación de enlaces de apuesta directa
- `badgeStats.js` — badges descriptivos del pick calculados sobre el histórico completo (ver commit `b3e07b2`)
- `valueAlerts.js` — alertas de valor (ver `docs/alertas-valor.md`)

**Nuevo (TypeScript)**
- `globalDrawScanner.ts` → `dist/globalDrawScanner.js` — scanner de empates estructurales (el scanner global de empates ya fue retirado del dashboard, ver commit `b9811a6`, pero el módulo de detección persiste)
- `server/dashboardApi.ts` → `dist/server/dashboardApi.js` — API que alimenta el dashboard
- `types/` — tipados compartidos
- `engines/` — motores de cálculo (revisar contenido al redactar el reporte de arquitectura; no explorado en este contexto)

**Orquestador**
- `bot.js` — proceso principal: adquiere el candado de instancia, arranca el ciclo de muestreo/emisión, registra los comandos de Telegram (`/top`, `/seguras`, `/golden`, `/parlay`, `/stats`, `/health`, `/unidades`, `/pick`, `/dia`, `/validar`, `/train`, `/reboot`, `/pendientes`, entre otros).

## 3. Dashboard (`dashboard/`)

`index.html` + `app.js` + `design-system/` (tokens en `tokens.css`). Consume `dist/server/dashboardApi.js`. Sirve para auditar el pipeline después del hecho — no participa en la decisión en vivo.

## 4. Scripts operativos (`scripts/`)

Carpeta grande y heterogénea: entrenamiento (`train_weights.py`, `entrenar-nb-corners.js`), backtests (`backtest-under-only.js`, `backtest_draw_thresholds.js`, `backtest_firewall.js`, `backtest_flatline_mfe.js`), análisis ad-hoc (`analyze-*.js`, `analyze_*.py`), utilidades de mantenimiento de BD (`backfill-*.js`), y generación de reportes/renders (`render-estado-sistema.py`, `render-pic*`). Muchos scripts de análisis son de un solo uso — al documentar, distinguir entre **scripts vivos** (parte del pipeline operativo, p. ej. entrenamiento) y **scripts de investigación** (produjeron un hallazgo puntual, ya capturado en `memory/`, no necesitan mantenerse).

`scratch/` (no versionado en git de forma permanente, aparece como untracked): prototipos y sondas de diagnóstico (`_sofa_*probe*.js`, `_check_db_*.js`, `_vacuum.js`) — territorio de exploración, no arquitectura estable.

## 5. Persistencia y datos

- SQLite vía `better-sqlite3`. Tablas relevantes conocidas: picks emitidos, `rejected_picks` (grupo de control — ver [grupo-control-rechazados](../memory/grupo-control-rechazados.md)), snapshots de cuotas/estadísticas, suscriptores VIP.
- Crecimiento de BD y retención: ver [db-growth-unsustainable](../memory/db-growth-unsustainable.md).
- `model.json` — pesos del modelo aprendido, regenerado por `scripts/train_weights.py`.

## 6. Configuración y despliegue

- `.env` / `.env.example` — variables de entorno (tokens de Telegram, umbrales `MIN_CONF`, `MODE`, retención, etc.)
- Corre como tarea programada de Windows bajo el usuario `Invitadow`, aunque Node vive en el perfil de otra cuenta de Windows (`PC`) — fuente del error 9009 documentado en memoria. Ver [two-windows-accounts](../memory/two-windows-accounts.md).
- `MODEL_MODE` controla si el modelo aprendido opera en `shadow`/veto o (nunca en producción) `learned` puro.

## 7. Líneas de evolución conocidas (para el reporte de "cómo se ha ido afinando el sistema")

Estas son las vetas de trabajo identificadas hasta ahora en memoria — cada una es candidata a su propia sección o subsección en el reporte de evolución. Fecha aproximada de exploración, no de ocurrencia del hecho:

1. **Calidad del edge / firewall** — auditoría del edge, piso 0.02, zona dulce 2–6%, firewall bien calibrado (ni añadir ni soltar reglas). Ver [edge-audit-findings](../memory/edge-audit-findings.md), [firewall-bien-calibrado](../memory/firewall-bien-calibrado.md), [edge-concentrado-en-under](../memory/edge-concentrado-en-under.md).
2. **Sizing / staking** — de Kelly (no ordena, Spearman 0.09) a plano, luego a escalonado por línea+apertura (+50% P/L, −37% drawdown). Ver [kelly-no-ordena-usar-plano](../memory/kelly-no-ordena-usar-plano.md), [sizing-y-f-apertura](../memory/sizing-y-f-apertura.md).
3. **Modelo aprendido** — incidente de adopción (confianza inflada + Kelly), por qué no entrenaba (señal débil, f_situacion restando, mapa precio→resultado inestable), aprendizaje del contexto de mercado, entrenamiento con grupo de control (dos bugs de datos corregidos), estado actual (3/4 folds, cerca de la barra sin cruzarla). Ver [model-adoption-incident](../memory/model-adoption-incident.md), [por-que-no-entrena](../memory/por-que-no-entrena.md), [modelo-aprende-mercado](../memory/modelo-aprende-mercado.md), [entrenamiento-con-grupo-control](../memory/entrenamiento-con-grupo-control.md), [modelo-parte-los-rechazados](../memory/modelo-parte-los-rechazados.md).
4. **Grupo de control (`rejected_picks`)** — creación, bug de liquidación prematura (+159u falsas), uso para medir calibración de `MIN_CONF`. Ver [grupo-control-rechazados](../memory/grupo-control-rechazados.md), [control-liquidacion-prematura](../memory/control-liquidacion-prematura.md), [min-conf-diagnostico](../memory/min-conf-diagnostico.md), [min-conf-under-candidato](../memory/min-conf-under-candidato.md).
5. **Empates / DNB / global_draw** — features fabricadas (184 picks con constantes hardcodeadas, deben excluirse de análisis), backtest de umbrales, estado de empates (DNB neutral, fuga de global_draw sin decidir), retiro del scanner global del dashboard. Ver [global-draw-fabricated-features](../memory/global-draw-fabricated-features.md), [draw-threshold-backtest](../memory/draw-threshold-backtest.md), [empates-estado](../memory/empates-estado.md).
6. **Cobertura de mercados / sharp** — 59% de mercados sin soporte sharp (solo h2h), bug de abreviaturas MLB. Ver [sharp-coverage-diagnosis](../memory/sharp-coverage-diagnosis.md).
7. **Calibración** — colapso de la calibración isotónica (escalera de 30 peldaños, 94.8% con conf idéntico). Ver [calibracion-isotonica-colapso](../memory/calibracion-isotonica-colapso.md).
8. **Metodología de auditoría propia** — comparar siempre contra la misma ventana temporal (nunca contra el propio pasado), sin estructura horaria explotable (dispersión es azar). Ver [comparar-en-la-misma-ventana](../memory/comparar-en-la-misma-ventana.md), [sin-estructura-horaria](../memory/sin-estructura-horaria.md).
9. **Infraestructura / operación** — incidente del bot mudo (fetch sin timeout, prune síncrono), sin control de acceso en Telegram, crecimiento insostenible de BD, arquitectura de dos cuentas de Windows. Ver [incidente-bot-mudo](../memory/incidente-bot-mudo.md), [no-telegram-auth-gate](../memory/no-telegram-auth-gate.md), [db-growth-unsustainable](../memory/db-growth-unsustainable.md), [two-windows-accounts](../memory/two-windows-accounts.md).
10. **Producto / UX del pick** — de prometer rendimiento a describir el pick (badges), cálculo de cifras sobre histórico completo. Ver commits `99ce4b1`, `b3e07b2`.

Nota: todas las cifras de estos hallazgos vienen de memoria persistida entre sesiones — **antes de citarlas en el reporte final, verificar que siguen vigentes** (código no renombrado/eliminado, umbral no cambiado) releyendo el archivo de memoria y, si aplica, el código actual.

## 8. Convenciones para los reportes que se generen a partir de este contexto

- **Idioma**: español (consistente con el código, commits y memoria del proyecto).
- **Un reporte de arquitectura ≠ un reporte de evolución.** Arquitectura describe el estado actual (secciones 2–6 de este archivo, expandidas). Evolución narra cómo se llegó ahí, ordenado por hallazgo/incidente (sección 7), no por fecha de commit.
- **Glosario acumulativo**: después de cada reporte, extraer términos matemáticos (de-vig, Kelly, Spearman, calibración isotónica, drift...), computacionales (candado de instancia, shadow/veto, grupo de control...) y de estrategia (firewall, edge, zona dulce, sizing escalonado...) y añadirlos a `docs/glosario.md` (crear si no existe) con definición corta + de dónde salió el término (módulo o memoria).
- **No inventar cifras.** Si un hallazgo de memoria no trae número o el número no se pudo verificar contra el código actual, decirlo explícitamente en el reporte en vez de omitirlo silenciosamente.
