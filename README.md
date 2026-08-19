# Playdoit Monitor

Sistema de monitoreo de momios en vivo de [Playdoit.mx](https://www.playdoit.mx/) con bot de Telegram, histórico de snapshots, scoring de confianza, firewall de jugadas y un pipeline de aprendizaje con grupo de control.

> **Aviso legal**: consume la API del sportsbook (Altenar) que usa Playdoit. El uso automatizado puede violar los términos de servicio. Úsalo bajo tu propio riesgo. No constituye consejo de apuestas, y el bot no coloca apuestas ni debe automatizarse para hacerlo.

---

## Estado actual (2026-08-19)

| | |
|---|---|
| Picks registrados | 2 887 (2 521 liquidados, **WR 70.3%**) |
| Grupo de control | 11 220 rechazados etiquetados, 11 148 liquidados |
| Snapshots | ~47.5 M filas (13 GB) |
| Quién decide los picks | **el heurístico** |
| `MODEL_MODE` | `shadow` — el modelo se calcula y se guarda, **no decide** |
| `STAKE_MODE` | `tiered` — escalonado por mercado/línea/apertura, **no lee `conf`** |
| Firewall | activo, R1/R2/R5/R7 |

El modelo aprendido **pasa su regla de adopción** desde el 2026-08-19 (ver [Modelo aprendido](#modelo-aprendido)) pero corre en shadow a propósito: la ventaja medida es pequeña y su intervalo de confianza roza el cero. Está acumulando historial fuera de muestra antes de que se le deje decidir nada.

---

## Arquitectura

```
        ┌──────────────┐   ┌──────────────┐   ┌────────────┐
        │  Recolección │ → │Normalización │ → │ SQLite     │
        │  fetcher.js  │   │ normalize.js │   │ db.js      │
        │  (API JSON)  │   │  devig.js    │   │snapshots.db│
        └──────────────┘   └──────────────┘   └─────┬──────┘
                                                    │
   ┌────────────────────────────────────────────────┴─────────────┐
   │  Scoring y emisión                                           │
   │                                                              │
   │  confidence.js ──► model.js ──► POST_SCORE_GATES ──► firewall│
   │   (4 factores)     (aprendido)   (7 puertas)         (R1..R7)│
   │        │                              │                      │
   │        │                              ├─► EMITE ──► picks    │
   │        │                              └─► RECHAZA ─► rejected_picks
   │        ▼                                            (grupo de control)
   │  results.js ──► liquidación (win/loss/push)                  │
   └──────────────────────────────┬───────────────────────────────┘
                                  ▼
              ┌───────────────────────────────────────┐
              │  bot.js — Telegram + sampler + panel  │
              └───────────────────────────────────────┘
```

**Fuente de datos**: consume directamente la API JSON del proveedor del sportsbook (Altenar, `sb2frontend-altenar2.biahosted.com`) en lugar de raspar el DOM. Más rápido, más estable, y entrega los momios ya en decimal.

### Módulos

| Archivo | Responsabilidad |
|---|---|
| `bot.js` | Entrada principal: bot de Telegram (long-polling), sampler de fondo, emisión automática, liquidación. |
| `src/fetcher.js` | Descarga el overview en vivo de todos los deportes. Reintentos, backoff y `AbortSignal.timeout(20 s)`. |
| `src/normalize.js` | Aplana eventos/mercados/momios a filas comunes; momio americano, minuto, set. |
| `src/devig.js` | Probabilidad justa sin margen de la casa. Método de Shin por defecto (`DEVIG_METHOD`). |
| `src/confidence.js` | Scoring (4 factores), puertas post-scoring, dimensionamiento (`computeStake`), grupo de control (`auditRejections`). |
| `src/model.js` | Inferencia del modelo aprendido y features de mercado (`marketFeatures`). |
| `src/firewall.js` | Filtro duro R1–R7 derivado de buckets con ROI negativo medido. |
| `src/markets.js` | Interpreta cada mercado, evalúa su situación en vivo y lo califica contra un marcador. |
| `src/results.js` | Liquidación: `win`/`loss`/`push`/`unknown`, con espera antes de liquidar el grupo de control. |
| `src/db.js` | SQLite: esquema, migraciones y prune por lotes. |
| `src/sharp.js` | Referencia sharp (The Odds API → Pinnacle/Betfair) con presupuesto de créditos. |
| `src/metrics.js` | Brier, log loss, ECE, CLV, ROI por segmento. |
| `src/health.js` | Detección de drift de calibración. |
| `src/telegram.js` | Envío de mensajes HTML, botonera y gráficas. |
| `src/singleInstance.js` | Lock de instancia única (`.bot.lock`). |
| `src/ratelimit.js` | Ventana deslizante, tope `MAX_REQ_PER_MIN`. |
| `src/validate.js` | Contrasta resultados liquidados contra marcador oficial. |
| `src/betlink.js` | Enlaces directos a la jugada en Playdoit. |
| `index.js` | Modo alternativo: top N por intervalos (`--once` para un ciclo). |
| `probe*.js` | Exploración del desarrollo inicial. Se pueden borrar. |

---

## Instalación

Requisitos: Node.js 22 (`better-sqlite3` es nativo y está compilado contra ese ABI). Python 3 solo para reentrenar.

```bash
npm install
```

Copia `.env.example` a `.env` y rellena los tokens. Las claves están comentadas allí con **el porqué**, no solo el valor — especialmente `MODEL_MODE` y `STAKE_MODE`, donde el valor que suena mejor es el peligroso.

```bash
node bot.js          # modo principal
node index.js --once # un ciclo del modo alternativo
npm test             # suite de tests
```

---

## Comandos de Telegram

| Comando | Descripción |
|---|---|
| `/top [N] [deporte] [rango] [+min] [sN]` | Momios más bajos. Todos los filtros combinables. |
| `/seguras [deporte]` | Top 3 por índice de confianza. |
| `/golden [deporte]` | Un solo pick: edge máximo con `conf ≥ 70%` y momio ≥ 1.15. |
| `/parlay [deporte]` | Combos sugeridos, +EV verificado por pata. |
| `/stats` | Acierto por confianza, calibración (Brier, log loss, ECE), CLV y semáforo de edge. |
| `/health` | ECE de los últimos 200 liquidados; alerta de drift. |
| `/unidades [hoy\|ayer\|fecha]` | Unidades apostadas vs ganadas; con argumento, detalle pick por pick. |
| `/pick <id>` | Ficha de un pick con gráfica de evolución de cuota. El `#id` sale en cada pick automático. |
| `/dia [ayer\|fecha]` | Gráfica de P/L acumulado del día. |
| `/validar [6h]` | Contrasta liquidaciones contra el marcador oficial. |
| `/deportes` | Deportes en vivo con conteo de eventos. |
| `/start`, `/vip`, `/ticket` | Alta y suscripción VIP. |
| `/help` | Ayuda y botonera. |

**Solo administrador** (`isOwner()`, contra `TELEGRAM_CHAT_ID`):

| Comando | Descripción |
|---|---|
| `/train` | Exporta el dataset y reentrena (walk-forward + calibración). |
| `/dashboard` (`/panel`) | Levanta el panel web (puerto 3001). `status` / `off`. |
| `/reboot` (`/reiniciar`) | Reinicia el bot. Exige `BOT_SUPERVISED`; si nadie lo relanzaría, se niega. |

### Control de acceso

El bot **atiende a cualquier chat** a propósito: los suscriptores VIP necesitan `/start` y `/vip`. Los comandos que lanzan procesos, escriben en disco o gastan cuota de API están tras `isOwner()`. **Cualquier comando nuevo de ese tipo debe pasar por `isOwner()`** — el resto son de solo lectura.

---

## Scoring de confianza

Cada candidata (momio 1.35–3.0) recibe un índice `[0..1]`:

```
conf = 0.4375·probJusta + 0.375·avance + 0·situación + 0.1875·línea
```

| Factor | Peso | Cálculo |
|---|---|---|
| Probabilidad justa | **43.75%** | De-vig por Shin sobre el mercado completo. |
| Avance del juego | **37.5%** | `minuto / duración` o `set / setsTotales`, por deporte. |
| Situación del juego | **0%** | Se sigue calculando y persistiendo (el firewall la usa en R5), pero **salió de la mezcla**. |
| Tendencia de línea | **18.75%** | Pendiente relativa sobre la última hora, menos penalización por volatilidad. |

**Por qué `f_situacion` pesa 0.** Medido sobre picks liquidados (N=1151): su correlación con acertar es **negativa (−0.119)** y la heurística le daba el 20% del peso, así que restaba señal. La mezcla completa (corr +0.080) rendía *peor* que su mejor componente sola (`f_prob_justa`, +0.131). Con corte temporal, quitarla mejoró dentro y fuera de muestra. Reversible sin tocar código: `HEURISTIC_W_SITUACION`.

<details>
<summary>Situación por tipo de mercado y parámetros por deporte</summary>

| Mercado | Evaluación en vivo |
|---|---|
| Ganador / 1x2 | Ventaja del marcador, normalizada por el margen "decisivo" del deporte. |
| Empate | Favorable mientras menor sea la diferencia. |
| Doble oportunidad | Mide solo el riesgo del resultado NO cubierto. |
| Hándicap | Aplica el hándicap al marcador actual. |
| Total (Más/Menos) | Proyecta el ritmo de anotación y lo compara con la línea. |
| Ambos marcan | Detecta si ya se cumplió; si no, pondera el tiempo restante. |

| Deporte | Duración | Margen decisivo | Sets |
|---|---|---|---|
| Fútbol | 90' | 2 goles | — |
| Fútbol Rápido | 40' | 2 goles | — |
| Baloncesto | 48' | 12 puntos | — |
| Hockey | 60' | 2 goles | — |
| Béisbol | 9 innings | 3 carreras | — |
| Tenis | — | 1 set | 3 |
| Voleibol / Tenis de mesa / Dardos | — | 2 | 5 |
| Otros | 90' | 3 | 3 |

</details>

---

## Puertas de emisión y grupo de control

Tras puntuar, cada candidata pasa por `POST_SCORE_GATES` **en orden**:

```
incierto → over_bloqueado → mercado_bloqueado → guardas5 → firewall → min_conf → min_edge → modelo_veto
```

La lista se declara **una sola vez** porque la consumen dos caminos: `rankPicks` (producción) y `auditRejections` (el grupo de control). Si divergieran, el control quedaría mal etiquetado y se entrenaría contra una frontera que el bot no usa.

Lo rechazado se guarda en **`rejected_picks`** con la puerta que lo frenó, y **se liquida igual que un pick real**. Reparto actual:

| Puerta | Rechazados | Liquidados |
|---|---|---|
| `min_conf` | 7 649 | 7 581 |
| `incierto` | 1 705 | 1 704 |
| `mercado_bloqueado` | 748 | 748 |
| `firewall` | 625 | 622 |
| `guardas5` | 300 | 299 |
| `min_edge` | 194 | 194 |

**Para qué sirve.** Sin él, el entrenamiento solo veía picks que ya habían pasado `MIN_CONF`/`MIN_EDGE`/firewall: puro sesgo de selección, que comprime el 80% de las confianzas en 9 puntos y deja al clasificador **sin negativos de verdad**. El grupo de control cubre un rango de `f_prob_justa` que los picks emitidos nunca vieron.

> **Al entrenar, la adopción se decide sobre `origin='picks'`, no sobre el agregado.** El 2026-08-16 un modelo pasó la regla con +0.0070 de Brier en el agregado mientras **empeoraba −0.0026** sobre los picks emitidos: el 95% del pool de evaluación eran rechazados, así que el agregado medía sobre todo distinguir "rechazado típico" de "pick típico", que es trivial y no vale dinero.

---

## Firewall (`src/firewall.js`)

Filtro duro **después** del scoring. Cada regla sale de un bucket con ROI negativo medido sobre picks liquidados y validado **fuera de muestra** con corte temporal (`scripts/backtest_firewall.js`, que reutiliza la misma función que producción).

| Regla | Bloquea | Estado |
|---|---|---|
| R1 | mercado Over ("Más de") | activa |
| R2 | `progress < FIREWALL_MIN_AVANCE` (0.40) | activa |
| R3 | momio > `FIREWALL_MAX_ODDS` (3.0) | inerte — `rankPicks` ya acota a 3.0 |
| R4 | momio < `FIREWALL_MIN_ODDS` | **desactivada** — evidencia invertida |
| R5 | `f_situacion ≥ FIREWALL_MAX_SITUACION` (0.99) | activa |
| R6 | `f_linea ≥ FIREWALL_MAX_LINEA` | **desactivada** — era un artefacto |
| R7 | Under con línea > `FIREWALL_MAX_UNDER_LINE` (3.5) | activa |

```
TEST (fuera de muestra)   sin firewall: N=719 WR=62.9% ROI=-3.2%
                          CON firewall: N=629 WR=65.0% ROI=-0.8%  (retiene 87%)
```

R1 y R2 están **muy solapadas**: fuera de muestra bloquean el mismo conjunto (Overs tardíos). Su aporte no es aditivo.

**Por qué R7.** El edge de los Under no es uniforme por línea: `≤ 3.5` rinde **ROI +9.8%** (IC [+3.1%, +16.4%]); `> 3.5` rinde **+0.7%** con el IC cruzando cero. R7 corta donde el edge se desvanece.

**Por qué R4 y R6 nacen desactivadas.** Se derivaron de un dataset contaminado: `globalDrawScanner.ts` insertaba picks directo en la BD, sin pasar por `rankPicks`, con features **hardcodeadas** (una única combinación para 184 filas). Como `0.82 ≥ 0.80`, R6 capturaba el 100% de esos picks: medía "el scanner rinde mal", no un fenómeno de mercado. Sobre picks reales, `f_linea ≥ 0.80` rinde **+2.3%** y `momio < 1.30` rinde **+8.9%**: activarlas bloquearía buckets **ganadores**. Los backtests excluyen `source='global_draw'` y esas filas están marcadas `score_version = 0`.

**Qué hace y qué no**: quita daño, **no crea edge** — pasa de perdedor a break-even. El techo medido en el subconjunto más selectivo es ~80–84% WR. `FIREWALL_ENABLED=false` lo apaga entero. No se aplica a `parlayCombos`.

La marca 🛡️ **ELITE** señala el único subconjunto que quedó positivo fuera de muestra (Under + `progress ≥ 0.75` + `f_linea ≥ 0.55`: N=37, WR 75.7%, ROI +11.8%). N pequeño: es orientativa, no una recomendación de stake.

---

## Dimensionamiento (`STAKE_MODE`)

| Modo | Qué hace |
|---|---|
| `flat` | 1 unidad siempre. |
| `kelly` / `half_kelly` | Fracción de Kelly sobre `conf` y momio. |
| **`tiered`** (activo) | Escalonado por **mercado + línea + `f_apertura`**. |

**Por qué `tiered` y no Kelly.** La confianza **no ordena** el resultado: Spearman entre `conf` y acierto = 0.09, y las cuatro políticas dan el mismo ROI por unidad arriesgada — pero Kelly duplica el drawdown. Escalonar por línea y apertura sube el P/L ~50% y baja el drawdown ~37%.

Y hay una razón de seguridad: **`tiered` no lee `conf`**. Eso cierra el vector del incidente de agosto, en el que un modelo mal calibrado infló la confianza y Kelly multiplicó el tamaño de la apuesta.

---

## Modelo aprendido

`src/model.js` + `scripts/train_weights.py`: logística calibrada, evaluada en **walk-forward temporal** (nunca partición aleatoria — sería fuga temporal).

**Regla de adopción**: mejorar Brier **y** log loss fuera de muestra, ganar la mayoría de folds, **y** cumplir lo mismo sobre `origin='picks'` con `N ≥ MIN_PICKS_OOS` (300). Todo queda en `model.json:oos_metrics.picks_only`.

### Features de mercado (2026-08-19)

El modelo era **ciego al mercado** pese a que el mercado es lo único que hemos demostrado que discrimina. Añadidas `is_under`, `is_over`, `is_btts`, `is_ganador`, `is_dnb`, `linea`. Sobre picks emitidos (N=439):

| variante | d_Brier | folds |
|---|---|---|
| base (5 features) | −0.0010 | 2/4 |
| **+ mercado + línea** | **+0.0044** | **4/4** |
| CONTROL: + ruido aleatorio | −0.0006 | 1/4 |

El **control con ruido** es lo que hace creíble el resultado: una feature aleatoria no mejora, así que la ganancia es información real y no capacidad extra. Bootstrap pareado: **P(mejora>0) = 95.4%** (el modelo rechazado el 08-16 daba 18.8%). Los coeficientes coinciden con mediciones previas e independientes: `is_over` = −0.520, que concuerda con su ROI de −22.2%.

**Una sola fuente de verdad**: `marketFeatures()` vive en `src/model.js` y `export-dataset.js` escribe las columnas **ya calculadas** al CSV. Python nunca las recalcula. Si cada lado las derivara por su cuenta, cualquier divergencia sería un *train/serve skew* silencioso.

### Por qué sigue en `shadow`

El IC95% roza el cero ([−0.0009, +0.0096]) y la hipótesis "el mercado importa" salió de **este mismo dataset**, así que el sesgo de selección no es cero. En shadow el modelo se calcula y se persiste (`conf_learned`) sin decidir nada, acumulando historial genuinamente fuera de muestra.

**Veto, probado y apagado.** Existe una puerta `modelo_veto` (`MODEL_VETO=1`) que exige pasar **ambos** umbrales, `conf_heuristic` y `conf_learned` — el modelo solo puede *quitar* picks, nunca añadir. Se apagó tras medirla fuera de muestra: a 0.70 recorta ~23% del volumen para dejar el P/L igual o peor (+29.5u con veto vs **+30.4u sin él**, N=439), y el segmento vetado resulta rentable. La medición in-sample decía −23.5u; era sobreajuste casi entero.

### `f_avance` vs `f_avance_model`

`f_avance` guarda el avance **crudo**; `f_avance_model` el valor **realmente servido al modelo**, que para un "Más de X" sin la línea alcanzada es `1 - progress`. Hasta el 2026-08-09 el dataset se exportaba desde la columna cruda mientras producción servía la transformada: un *train/serve skew* que afectaba al 20.4% de las filas. El firewall sigue leyendo el **crudo**: sus umbrales se derivaron sobre esa escala.

---

## Fuente sharp y CLV

`src/sharp.js`: The Odds API con prioridad Pinnacle → Betfair. Solo mercados h2h. **Consumo bajo demanda**: el matching usa el endpoint `/events` (gratuito); se gasta 1 crédito al capturar la entrada y 1 al cierre. ~2 créditos por pick matcheado.

**Métrica primaria de decisión**: `CLV_sharp = prob_shin(cierre sharp) / prob_shin(entrada Altenar) − 1`. **Solo el CLV contra la línea sharp cuenta como evidencia de edge**; el CLV contra el cierre de Altenar (línea blanda) es diagnóstico.

| Condición | Veredicto |
|---|---|
| CLV_sharp > 0 y N ≥ 300 | **EDGE PROBABLE** |
| CLV_sharp ≤ 0 pero ROI > 0 | **PRECAUCIÓN**: probablemente varianza. No escalar. |
| CLV_sharp > 0 pero ROI < 0 | **VARIANZA NEGATIVA**: mantener proceso. |
| N < 300 | **MUESTRA INSUFICIENTE** |

---

## Base de datos (`snapshots.db`)

| Tabla | Filas | Contenido |
|---|---|---|
| `snapshots` | ~47.5 M | Una fila por momio observado. |
| `picks` | 2 887 | Picks emitidos, features, scores, liquidación, datos sharp. |
| `rejected_picks` | 11 220 | Grupo de control: candidatas rechazadas con `reject_rule`, liquidadas igual. |
| `subscribers` | 1 | Suscriptores VIP. |
| `sharp_budget` | 16 | Consumo de créditos de The Odds API. |
| `alerted_events` | 1 304 | Deduplicación de alertas. |

```sql
-- Movimiento de línea de un evento
SELECT ts, market, selection, odd_decimal FROM snapshots
WHERE event_id = 16838147 ORDER BY ts;

-- Rendimiento por puerta del grupo de control
SELECT reject_rule, COUNT(*) n,
       ROUND(100.0*SUM(result='win')/SUM(result IN ('win','loss')),1) wr
FROM rejected_picks WHERE result IN ('win','loss') GROUP BY reject_rule;
```

---

## Backtesting y liquidación

1. Cada pick emitido se registra con momio, confianza, edge, stake y las features.
2. El sampler detecta cuándo un evento sale del listado en vivo y lo **liquida** contra el último marcador conocido (`src/markets.js`).
3. `/stats` y `/health` reportan calibración; `/validar` contrasta contra el marcador oficial.

**Limitación**: la liquidación usa el último marcador muestreado, no el resultado oficial. En finales cerrados puede diferir. Los no calificables se marcan `unknown` y no cuentan.

El grupo de control **espera `CONTROL_SETTLE_MIN` minutos** antes de liquidar. Sin esa espera, el 45% se liquidaba en menos de 20 minutos contra un marcador aún provisional, fabricando ~159 unidades de edge inexistente.

---

## Notas operativas

- El bot corre como tarea programada de Windows (`PlaydoitMonitorBot`). `scripts/run-bot.cmd` lo envuelve en un bucle que lo relanza a los 10 s de cualquier salida y exporta `BOT_SUPERVISED=1`, que es lo que permite `/reboot`. Log en `bot.log`, rotado a `bot.log.old`.
- **Reiniciar**: `scripts\restart-bot.cmd`, o `/reboot` desde Telegram. Un `kill` a secas no basta si el proceso está atascado — el supervisor lo relanza a los 10 s y vuelve a caer en lo mismo; hay que matar primero el `cmd.exe` supervisor.
- Node se toma de `C:\Users\Invitadow\node` a propósito: `C:\nvm4w\nodejs` apunta al perfil de **otro** usuario y cualquier `nvm use` rompería `better-sqlite3`, que es nativo.
- La API se consulta con `User-Agent` de navegador y `Referer` de playdoit.mx, con 500 ms entre deportes y tope `MAX_REQ_PER_MIN`.
- El sampler corre cada `SAMPLE_MINUTES` (**1 min** en producción) y alimenta la BD aunque no uses comandos: el factor de línea mejora con historial.

---

## Limitaciones conocidas

Todo lo de aquí está **medido**, no supuesto.

- **La base de datos crece sin freno y el prune no lo arregla.** La guarda `event_id NOT IN (SELECT event_id FROM picks)` conserva el historial **entero, sin límite temporal**, de los 2 737 eventos que alguna vez dieron un pick. El **100%** de las filas más viejas que `RETENTION_DAYS` están protegidas: el prune examina millones y borra **cero**. Buscar 5 000 filas borrables cuesta 80 s; borrarlas, 12 ms. Decidir cuánta historia necesita un pick liquidado es una decisión de producto pendiente.
- **`better-sqlite3` es síncrono.** Cualquier consulta pesada **congela el proceso entero** — sampler, Telegram y timers incluidos. Por eso `prune()` va diferido y con ventana acotada (`PRUNE_MAX_MS`, `PRUNE_DELAY_MS`). Un bot "vivo, quemando CPU y sin escribir logs" es este síntoma.
- **El sampler puede enmudecer sin morirse.** `sample()` tiene guard de instancia única; si un `await` interno se colgara, el guard quedaría puesto y el bot dejaría de muestrear **para siempre**, sin error y con Telegram respondiendo normal. Mitigado con timeouts en todos los `fetch` y el watchdog `SAMPLE_STUCK_MS`.
- **8 tests fallan** (`npm test` → 112 pass / 8 fail). No son flaky ni ajenos: `isRejectedBy5Guards` exige "mínimo 4 snapshots activos", así que rechaza toda fila **sintética** por no tener histórico en la BD. Los tests afectados son de `rankPicks` y necesitan fixtures con historial.
- **`is_ganador` está fragmentado**: casa con `Resultado Final (Tiempo Regular)` pero no con `1x2`, `Ganador` ni `Ganador (incl. prórroga)`. Son 51 de 2 310 picks emitidos (2.2%), así que el +0.0044 medido ya incluye el defecto.
- **Matching sharp heurístico**: nombres normalizados + hora de inicio ± 15 min. Habrá falsos negativos y, con equipos homónimos, falsos positivos.
- **Cobertura sharp parcial**: solo `SHARP_SPORT_KEYS` y solo h2h. Totales y hándicaps no tienen referencia sharp.
- **El mapa precio→resultado no es estacionario**: el lift sobre el precio cayó de +8.9 pp a +1.8 pp en tres semanas. Ningún modelo captura un mapa que se mueve más rápido de lo que se acumulan datos — de ahí que las ganancias sean de milésimas de Brier, no de centésimas.
- **Riesgo de limitación de cuenta**: si se apostara con dinero real, las casas blandas limitan cuentas ganadoras.
