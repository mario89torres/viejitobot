# Playdoit Monitor

Sistema de monitoreo de momios en vivo de [Playdoit.mx](https://www.playdoit.mx/) con bot interactivo de Telegram, almacenamiento histórico de snapshots, análisis de confianza y backtesting.

> **Aviso legal**: este sistema consume la API del sportsbook (Altenar) que usa Playdoit. El uso automatizado puede violar los términos de servicio del sitio. Úsalo bajo tu propio riesgo, con intervalos moderados. No constituye consejo de apuestas.

---

## Arquitectura

```
┌─────────────┐   ┌──────────────┐   ┌────────────┐   ┌────────────┐
│ Recolección │ → │Normalización │ → │Almacenam.  │ → │  Análisis  │
│ fetcher.js  │   │ normalize.js │   │   db.js    │   │ analyze.js │
│ (API JSON)  │   │ (formato     │   │  (SQLite)  │   │confidence.js│
└─────────────┘   │  común)      │   └────────────┘   └────────────┘
                  └──────────────┘                          ↓
                  ┌──────────────────────────────────────────┐
                  │        bot.js — Telegram (comandos)      │
                  │  + recolector de fondo + liquidación     │
                  └──────────────────────────────────────────┘
```

**Fuente de datos**: en lugar de raspar el DOM con un navegador, el sistema consume directamente la API JSON del proveedor del sportsbook de Playdoit (Altenar, `sb2frontend-altenar2.biahosted.com`). Es más rápido (~7 s por ciclo completo), más estable y entrega los momios ya en formato decimal.

### Módulos

| Archivo | Responsabilidad |
|---|---|
| `bot.js` | Punto de entrada principal. Bot de Telegram (long-polling), recolector de fondo y liquidación de picks. |
| `index.js` | Modo alternativo: envía el top 10 por intervalos fijos (`--once` para un solo ciclo). |
| `src/fetcher.js` | Descarga el overview en vivo de todos los deportes con reintentos y pausa entre peticiones. |
| `src/normalize.js` | Aplana eventos/mercados/momios a filas comunes; calcula momio americano, probabilidad justa (sin vig), minuto y set. |
| `src/db.js` | SQLite (`snapshots.db`): tablas `snapshots` (histórico de momios) y `picks` (registro y liquidación de `/seguras`). |
| `src/analyze.js` | Top N por momio decimal ascendente con filtros (rango de momios, deportes excluidos, 1 jugada por evento). |
| `src/markets.js` | Interpreta cada mercado (ganador, 1x2, doble oportunidad, totales, hándicap, ambos marcan), evalúa su situación en vivo y lo califica contra un marcador final. |
| `src/confidence.js` | Algoritmo de confianza de `/seguras` (ver abajo). |
| `src/telegram.js` | Envío de mensajes HTML al bot de Telegram. |
| `probe*.js` | Scripts de exploración usados durante el desarrollo (pueden borrarse). |

---

## Instalación

Requisitos: Node.js 18+ (usa `fetch` nativo).

```bash
npm install
```

Configura `.env`:

```ini
TELEGRAM_BOT_TOKEN=123456:ABC...   # token de @BotFather
TELEGRAM_CHAT_ID=123456789         # tu chat id
INTERVAL_MINUTES=10                # intervalo del modo index.js
SAMPLE_MINUTES=3                   # frecuencia del recolector de fondo
TOP_N=10                           # tamaño del top por defecto
MIN_ODDS=1.05                      # momio decimal mínimo
MAX_ODDS=100                       # momio decimal máximo
EXCLUDE_SPORTS=                    # deportes a excluir (coma-separados)
```

## Uso

```bash
node bot.js          # modo principal: bot interactivo + recolector de fondo
node index.js        # modo alternativo: envío por intervalos
node index.js --once # un solo ciclo (útil para probar)
```

---

## Comandos de Telegram

| Comando | Descripción |
|---|---|
| `/top` | Top 10 momios más bajos de todos los deportes en vivo. |
| `/top 5` | Top N (máx. 25). |
| `/top futbol` | Filtra por deporte (búsqueda parcial, sin acentos). |
| `/top 1.5-3` | Solo momios dentro del rango decimal. |
| `/top futbol +60` | Solo partidos con 60+ minutos jugados. |
| `/top tenis s2` | Solo partidos en el 2º set (o parte/cuarto) en adelante. |
| `/top 5 futbol +75 1.2-3` | Todos los filtros son combinables. |
| `/seguras` | Top 3 jugadas con mayor índice de confianza (e-sports excluidos). |
| `/seguras futbol` | Ídem, filtrado por deporte (permite pedir e-sports explícitamente). |
| `/stats` | Tasa de acierto por confianza + calibración (Brier, log loss, ECE), CLV y semáforo de edge. |
| `/health` | ECE de los últimos 200 picks liquidados; alerta si hay drift de calibración. |
| `/deportes` | Deportes en vivo ahora con conteo de eventos y jugadas. |
| `/help` | Ayuda. |

---

## Algoritmo de confianza (`/seguras`)

Cada jugada candidata (momio decimal entre 1.05 y 3.0) recibe un índice de confianza `[0..1]`:

```
conf = 0.45·probJusta + 0.20·avance + 0.20·situación + 0.15·línea
```

| Factor | Peso | Cálculo |
|---|---|---|
| **Probabilidad justa** | 45% | `(1/momio) / Σ(1/momios del mercado)` — elimina el margen de la casa (vig). |
| **Avance del juego** | 20% | `minuto / duración` o `set / setsTotales`, con parámetros por deporte. A menos tiempo restante, más certeza. |
| **Situación del juego** | 20% | Depende del tipo de mercado (ver tabla siguiente). |
| **Tendencia de línea** | 15% | Sobre los snapshots de la última hora: pendiente relativa (línea bajando = el mercado confía) menos penalización por volatilidad (línea que rebota = incertidumbre). |

### Situación por tipo de mercado

| Mercado | Evaluación en vivo |
|---|---|
| Ganador / 1x2 | Ventaja del marcador a favor del pick, normalizada por el margen "decisivo" del deporte. |
| Empate | Favorable mientras menor sea la diferencia actual. |
| Doble oportunidad | Mide solo el riesgo del resultado NO cubierto. |
| Hándicap | Aplica el hándicap al marcador actual. |
| Total (Más/Menos) | Proyecta el ritmo de anotación al final del juego y lo compara con la línea. Si la línea ya se superó: ganado (Más) o descartado (Menos). |
| Ambos marcan | Detecta si ya se cumplió; si no, pondera el tiempo restante. |

### Parámetros por deporte

| Deporte | Duración | Margen decisivo | Sets |
|---|---|---|---|
| Fútbol | 90' | 2 goles | — |
| Fútbol Rápido | 40' | 2 goles | — |
| Baloncesto | 48' | 12 puntos | — |
| Hockey | 60' | 2 goles | — |
| Béisbol | 9 innings | 3 carreras | — |
| Tenis | — | 1 set | 3 |
| Voleibol / Tenis de mesa / Dardos | — | 2 | 5 |
| Otros (default) | 90' | 3 | 3 |

---

## Backtesting

1. Cada `/seguras` registra sus picks en la tabla `picks` (momio, confianza, timestamp).
2. El recolector de fondo detecta cuándo un evento sale del listado en vivo y lo **liquida** automáticamente: califica el pick (`win`/`loss`) contra el último marcador conocido usando `src/markets.js`.
3. `/stats` muestra la tasa de acierto por nivel de confianza (alta ≥75%, media 60–75%, baja <60%), para verificar la calibración de los pesos con datos reales.

**Limitación**: la liquidación usa el último marcador muestreado (cada `SAMPLE_MINUTES`), no el resultado oficial. En finales muy cerrados el resultado puede diferir. Los picks no calificables se marcan `unknown` y no cuentan en las estadísticas.

---

## Pipeline de mejora continua (Etapas 0–4)

```
snapshots densos ──► /seguras registra pick (4 features + conf + edge)
      │                        │
      │                        ├─► captura sharp (The Odds API / Pinnacle):
      │                        │     sharp_entry_odd + matching por nombres
      │                        │     normalizados e inicio ± 15 min
      │                        ▼
      └────────────► liquidación (win/loss) + cierre Altenar + cierre sharp
                               │
                               ▼
             dataset.csv ──► train_weights.py (walk-forward + calibración)
                               │                    │
                               ▼                    ▼
                          model.json ◄──── regla de adopción (Brier+logloss OOS)
                               │
                               ▼
             MODEL_MODE: heuristic → shadow → learned  (reversible por .env)
                               │
                               ▼
              /stats: Brier · log loss · ECE · CLV_altenar · CLV_sharp · semáforo
              /health: drift de calibración (ECE últimos 200 > 0.05 → reentrenar)
```

- **De-vig** (`src/devig.js`): probabilidad justa con el método de Shin por defecto (`DEVIG_METHOD`).
- **Score aprendido** (`src/model.js` + `scripts/train_weights.py`): logística calibrada sobre los 4 factores, evaluada en walk-forward temporal; solo se adopta si mejora Brier y log loss out-of-sample reteniendo ≥60% de la mejora in-sample.
- **Fuente sharp** (`src/sharp.js`): The Odds API con prioridad Pinnacle → Betfair exchange (`ODDS_API_KEY`, `SHARP_*` en `.env`). Solo mercados de ganador/empate (h2h). **Consumo bajo demanda**: el matching de eventos usa el endpoint `/events` (gratuito); solo se gasta 1 crédito al capturar el momio de entrada de un pick matcheado y 1 más al cierre, cuando el evento desaparece del feed de Altenar (sin polling). ~2 créditos por pick matcheado ⇒ la cuota gratuita de ~500/mes cubre ~250 picks. Si el evento ya salió del feed sharp al capturar el cierre, se conserva el último momio visto (como mínimo el de entrada).
- **Edge estimado**: `edge = conf·momio − 1` se guarda en cada pick. `MIN_EDGE` (default 0 = desactivado) filtra la emisión de `/seguras`; activarlo reduce volumen y alarga el camino a N=300.

### Métrica primaria de decisión: CLV_sharp

`CLV_sharp = prob_shin(cierre sharp) / prob_shin(entrada Altenar) − 1`. **Solo el CLV
contra la línea sharp cuenta como evidencia de edge**; el CLV contra el propio cierre
de Altenar (línea blanda) es únicamente diagnóstico. Semáforo de `/stats`
(N = picks liquidados con match sharp):

| Condición | Veredicto |
|---|---|
| CLV_sharp medio > 0 y N ≥ 300 | **EDGE PROBABLE**: el sistema bate la línea de cierre; el ROI llegará con volumen. |
| CLV_sharp ≤ 0 pero ROI > 0 | **PRECAUCIÓN**: resultado positivo sin batir el cierre = probablemente varianza. No escalar. |
| CLV_sharp > 0 pero ROI < 0 | **VARIANZA NEGATIVA**: mantener proceso, revisar en +100 picks. |
| N < 300 | **MUESTRA INSUFICIENTE** (N/300). |

### Limitaciones (léelas antes de sacar conclusiones)

- **Matching entre proveedores**: el emparejamiento Altenar ↔ The Odds API es heurístico
  (nombres normalizados + hora de inicio estimada ± 15 min). Habrá falsos negativos
  (picks sin match) y, con equipos homónimos, posibles falsos positivos. Los no-matcheados
  quedan en `picks.sharp_match = 'unmatched'` y la tasa de match se reporta en `/stats`.
- **Cobertura sharp parcial**: solo ligas configuradas en `SHARP_SPORT_KEYS` y solo mercados
  h2h; totales, hándicaps y deportes de nicho no tienen referencia sharp. El cierre sharp es
  el "último visto" antes de liquidar, limitado por la cuota gratuita de la API (~500 req/mes).
- **Riesgo de limitación de cuenta**: si se apostara con dinero real, las casas blandas
  limitan o cierran cuentas ganadoras; el CLV positivo sostenido acelera ese resultado.
- **Nada de esto constituye consejo de apuestas**: es un sistema de medición y aprendizaje.
  El bot no coloca apuestas ni debe automatizarse para hacerlo.

---

## Base de datos (`snapshots.db`)

**`snapshots`** — una fila por momio observado:
`ts, sport, sport_id, champ, event_id, event, score, live_time, market, selection, odd_decimal, odd_american`

**`picks`** — registro de `/seguras`:
`ts, event_id, event, sport, market, selection, odd_decimal, conf, result, final_score, settled_ts`
más las columnas de las etapas 0–4: `result_source, closing_odd_decimal, closing_ts` (cierre Altenar),
`f_prob_justa, f_avance, f_situacion, f_linea, conf_heuristic, conf_learned` (features y scores),
`sharp_entry_odd, sharp_closing_odd, sharp_closing_market, sharp_source, sharp_event_id, sharp_match, edge` (fuente sharp y edge estimado).

Consultas útiles:

```sql
-- Movimiento de línea de un evento
SELECT ts, market, selection, odd_decimal FROM snapshots
WHERE event_id = 16838147 ORDER BY ts;

-- Historial de picks liquidados
SELECT ts, event, selection, odd_decimal, conf, result, final_score
FROM picks WHERE result IS NOT NULL ORDER BY ts DESC;
```

---

## Notas operativas

- El bot corre como tarea programada de Windows (`PlaydoitMonitorBot`): arranca oculto al iniciar sesión y `scripts/run-bot.cmd` lo relanza solo si crashea (log en `bot.log`, rotado a `bot.log.old` en cada arranque). Tras cambiar código o `.env`, ejecuta `scripts\restart-bot.cmd`. Limitación: corre desde que inicias sesión; para que arranque sin login habría que marcar "Ejecutar tanto si el usuario inició sesión como si no" en el Programador de tareas (pide tu contraseña).
- La API se consulta con `User-Agent` de navegador y `Referer` de playdoit.mx; hay una pausa de 500 ms entre deportes y reintentos con backoff ante fallos.
- Solo responde al `TELEGRAM_CHAT_ID` configurado; mensajes de otros chats se ignoran.
- El factor de línea mejora con historial: el recolector de fondo alimenta la BD cada 3 minutos aunque no uses comandos.
