# Índice de reportes técnicos — ViejitoBot

> Mapa de la documentación necesaria para entender el sistema de principio a fin. Cada fila es un reporte: los marcados ✅ ya existen, los demás son la propuesta de cobertura restante. Basado en el barrido de `src/`, `scripts/`, `tests/`, `dashboard/` y el esquema de `db.js`. Ver [contexto-tecnico.md](contexto-tecnico.md) para el mapa de módulos y [glosario.md](glosario.md) para términos.

## Hallazgo del barrido: hay DOS implementaciones de scoring en paralelo

- `src/model.js` + `src/confidence.js` + `src/firewall.js` (CommonJS) — la que corre en producción (`bot.js` la importa).
- `src/engines/{IScoringEngine,HeuristicEngine,MLEngine,UnifiedScorer}.ts` (TypeScript) — misma lógica (`MODEL_MODE`, sigmoid, half-Kelly con stake dinámico por cuota) reescrita como clases, pero **no referenciada desde `bot.js`**.

No se puede documentar la arquitectura como si solo existiera una. El reporte 4 debe determinar si `engines/` es código muerto, un refactor a medio terminar, o lo que consume el dashboard nuevo — antes de que un reporte futuro la presente como "la" arquitectura.

## Índice

| # | Reporte | Cubre | Estado |
|---|---|---|---|
| 1 | [Arquitectura y flujo de decisión](reporte-01-arquitectura-flujo.md) | Pipeline fetch→devig→scoring→firewall→emisión, modos del modelo, comandos de Telegram | ✅ |
| 2 | [Modelos y entrenamiento](reporte-02-modelos-entrenamiento.md) | Heurístico vs aprendido, walk-forward, calibración, features de mercado, resultados por etapa | ✅ |
| 3 | Sizing y gestión de stake | `computeStake` (Kelly / half-Kelly / plano / escalonado), por qué Kelly no ordena, por qué el escalonado por línea+apertura ganó, `STAKE_MODE`/`STAKE_UNIT_SCALE`/topes dinámicos por cuota | Pendiente |
| 4 | Duplicidad de motores de scoring (`engines/` vs `model.js`) | Comparar `UnifiedScorer`/`HeuristicEngine`/`MLEngine` contra `model.js`/`confidence.js`; determinar cuál es la fuente de verdad y si `engines/` está vivo, muerto o en migración | Pendiente — bloquea que reportes futuros describan una sola arquitectura con confianza |
| 5 | Esquema de datos y ciclo de vida de un pick | Las 10 tablas de `db.js` (`snapshots`, `picks`, `rejected_picks`, `model_picks`, `subscribers`, `alerted_events`, `stat_snapshots`, `stat_results`, `sofa_corner_snapshots`, `sofa_forecast_snapshots`, `value_alerts`) y cómo se relacionan; retención y crecimiento de la BD | Pendiente |
| 6 | Firewall y grupo de control en profundidad | Extensión del reporte 1 §2.4: cada regla R1–R7 con su historial de activación/desactivación, y cómo `rejected_picks` retroalimenta el reentrenamiento | Pendiente (parcial en reporte 1; memoria ya tiene el detalle) |
| 7 | Alertas de valor (`alertas-valor.js`) | Proceso independiente que notifica picks en banda de edge 3–8% sin apostar; por qué el edge es banda y no piso; por qué no hay re-alerta; dedupe vía `value_alerts` | Pendiente (ya documentado en [alertas-valor.md](alertas-valor.md), falta integrarlo a la narrativa de arquitectura) |
| 8 | Piloto de córners (SofaScore) | `sofaScraper.js`/`sofaMatch.js`/`sofaLive.js`, `sofa_corner_snapshots`/`sofa_forecast_snapshots`, `negBinomial.js`, `scripts/entrenar-nb-corners.js` — frente nuevo, distinto del pipeline de momios | Pendiente |
| 9 | Empates estructurales (`global_draw`) | Historia completa: por qué se creó, el bug de features hardcodeadas, retiro del dashboard (commit `b9811a6`), estado de la fuga en Empate directo | Pendiente (memoria completa, falta consolidar en reporte narrativo) |
| 10 | Suscripciones VIP y facturación | Ciclo `subscribers`: alta, cobro con Telegram Stars (`pre_checkout_query`/`successful_payment`), vigencia/expiración, comandos asociados | Pendiente |
| 11 | Dashboard y API de auditoría | `dashboard/` (`app.js`, `design-system/`) + `src/server/dashboardApi.ts` → qué vistas expone, cómo se relacionan con las tablas del reporte 5, qué corre "adentro" del panel (bucle de alertas viejo, mencionado en alertas-valor.md, que muere con cada reinicio) | Pendiente |
| 12 | Operación e incidentes de infraestructura | Candado de instancia (dos cuentas de Windows), bot mudo (fetch sin timeout, prune síncrono), ausencia de auth-gate en Telegram, crecimiento insostenible de BD — consolidación de los 4 incidentes de memoria en un solo reporte operativo | Pendiente |
| 13 | Metodología de auditoría propia del proyecto | Reglas transversales que todos los reportes anteriores deben respetar: comparar siempre contra la misma ventana temporal, no tratar rachas cortas como señal, sin estructura horaria explotable, cuidado con sesgo de selección en % iniciales | Pendiente — es más una guía de lectura que un reporte de un componente |
| 14 | [Métodos estadísticos](reporte-14-metodos-estadisticos.md) | De-vig, IC95%/bootstrap, Spearman, Brier/log-loss, walk-forward, calibración (isotónica/Platt), significancia de rachas cortas, test de permutación, binomial negativa censurada (córners). El "por qué este método y no otro" en cada caso | ✅ |
| 19 | [Walk-forward y calibración a profundidad](reporte-19-walkforward-calibracion.md) | Definición técnica formal de ambos métodos, implementación exacta en el proyecto, y tabla de correlaciones con Spearman, regularización, la trampa de agregación y verosimilitud censurada — pensado para aprenderlos, no solo consultarlos | ✅ |
| 18 | [Arquitectura del pipeline de entrenamiento](reporte-18-pipeline-entrenamiento.md) | `export-dataset.js` + `train_weights.py` a fondo: construcción del dataset (unión picks/rechazados, `origin`), walk-forward, `LogisticRegressionCV` estandarizado, historia de la calibración (isotónica→sigmoid→intento de "none"→vuelta a sigmoid), poda de features, regla de adopción formal, truco de `unscale()`, scripts satélite | ✅ |
| 17 | [Desempeño del modelo learned — historia completa](reporte-17-desempeno-modelo-learned.md) | Reconstrucción cronológica exhaustiva (jul 2026→hoy): incidente #1 (04-08 ago), diagnósticos, features de mercado, calibración, y un **segundo incidente de adopción no documentado en memoria** (26-29 ago) reconstruido directo de `snapshots.db`. Estado del modelo vigente hoy | ✅ |
| 16 | [Ejemplo end-to-end: Shin en un pick real](reporte-16-ejemplo-shin-pick.md) | Traza numérica completa de un pick (Under 2.5 @1.25): de-vig con Shin → features → score heurístico y aprendido (coeficientes reales de `model.json`) → edge → firewall/ELITE. Sirve de ancla concreta para los reportes 1, 2, 14 y 15 | ✅ |
| 15 | [Algoritmos y estructuras computacionales](reporte-15-algoritmos.md) | De-vig como algoritmo numérico (bisección), matching de eventos entre playdoit/SofaScore (`teamMatch.js`), interpolación de la tabla de calibración (`interp()`), dedupe, candado de instancia (EPERM-aware), rate limiting (ventana deslizante), poda/retención de la BD (`pruneSnapshots`) | ✅ |

## Orden sugerido de redacción

1. **Reporte 4 primero** (duplicidad de motores) — condiciona cómo se escribe todo lo demás si `engines/` resulta ser la dirección futura.
2. **Reporte 5** (esquema de datos) — es la base factual que todos los demás reportes citan cuando hablan de una tabla.
3. **Reportes 3, 6, 7, 8, 9** (lógica de negocio) — pueden ir en cualquier orden, son independientes entre sí.
4. **Reporte 10 y 11** (producto/operación del negocio, no del algoritmo) — última prioridad si el objetivo es entender la toma de decisiones de apuesta.
5. **Reporte 12** puede escribirse en paralelo, no depende de los demás.
6. **Reportes 13, 14 y 15** son transversales — se escriben al final, como catálogos de referencia, y se enlazan (no se duplican) desde los reportes 1–12 donde corresponda. 14 y 15 pueden nutrirse directamente de lo que ya se citó en los reportes 1 y 2 (Brier, log-loss, walk-forward, calibración, interpolación) más lo que aporten los reportes 3–9 pendientes.

## Qué NO necesita reporte propio

- `scripts/` de un solo uso (backtests puntuales, backfills, sondas de `scratch/`) — ya están resumidos en la sección 7 de [contexto-tecnico.md](contexto-tecnico.md); solo ameritan mención si un reporte cita su resultado.
- `tests/` — no se documentan como arquitectura; se citan como evidencia dentro de cada reporte cuando corresponda (p. ej. `dnb-veto.test.js` al hablar del firewall, `alertas-valor.test.js` en el reporte 7).
