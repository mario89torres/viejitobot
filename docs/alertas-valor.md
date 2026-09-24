# Alertas de valor

Manda a Telegram los picks que el heurístico ya emitió y caen en la banda de
valor medida. **No coloca apuestas** — el último clic es manual, a propósito.

```
picks (SQLite)  →  filtro  →  dedupe  →  Telegram
```

## Cómo correrlo

```bash
node scripts/alertas-valor.js --dry-run    # imprime a stdout, no envía
node scripts/alertas-valor.js --una-vez    # un ciclo y sale
node scripts/alertas-valor.js              # en marcha, envía a Telegram
```

Es un **proceso aparte**, no cuelga del bot ni del panel. Eso es deliberado: el
bucle de alertas que ya existía vive dentro de `dashboardApi.ts`, así que solo
corre mientras el panel esté vivo — y el panel es proceso hijo del bot, o sea que
cada reinicio se lo lleva.

## Configuración

Todo por `.env` (ver `.env.example` para el detalle de cada clave):

| Clave | Default | Qué hace |
|---|---|---|
| `ALERTA_EDGE_MIN` | `0.03` | Piso de la banda de edge |
| `ALERTA_EDGE_MAX` | `0.08` | Techo de la banda — **no es un piso** |
| `ALERTA_SOLO_UNDER` | `1` | Solo selecciones "Menos de" |
| `ALERTA_DEPORTES` | `Fútbol` | Lista separada por comas; vacío = todos |
| `ALERTA_INTERVALO_SEG` | `60` | Cada cuánto mira la tabla |
| `ALERTA_MAX_EDAD_MIN` | `20` | Edad máxima del pick para alertarlo |
| `ALERTA_MAX_POR_CICLO` | `5` | Tope por ciclo |
| `ALERTA_CHAT_ID` | `TELEGRAM_CHAT_ID` | Canal de destino |

Credenciales: `TELEGRAM_BOT_TOKEN` y `TELEGRAM_CHAT_ID`, nunca en el código.
No hace falta ninguna credencial de Playdoit.

## Por qué el edge es una banda y no un piso

Es lo contraintuitivo del módulo. Medido sobre 3.554 picks liquidados en 49 días:

```
>= 3%   +3.74%  [1.1, 6.3] *
>= 5%   +3.22%  [0.1, 6.3] *
>= 7%   +2.34%  [-1.3, 6.0]
>= 10%  +1.75%  [-3.3, 6.8]
>= 15%  +0.53%  [-6.8, 7.9]
>= 20%  -3.89%  [-14.0, 6.2]   WR 53.5%, n=318
```

Subir el piso empeora de forma monótona y la cola alta pierde dinero. Un edge
enorme significa que el modelo discrepa mucho del mercado, y de media el mercado
tiene razón.

La combinación elegida:

```
Under + Fútbol + edge 3-8%    +9.48%  [4.1, 14.8]  n=527   ~11 alertas/día
```

**Ese +9.48% está inflado**: se eligió sobre la misma muestra que lo produjo,
entre unas seis combinaciones. Mide el resultado hacia delante antes de creértelo.

## Por qué no hay re-alerta

El diseño original contemplaba re-alertar si el precio se movía X% o pasaban Y
horas. Los datos lo descartaron:

- **Duración del pick**: p50 36 min, p90 1.0 h, **p95 1.3 h**. Una ventana en
  horas no puede dispararse nunca.
- **Movimiento de precio** durante esa vida: p50 25%, p75 51%, p90 140%. Un
  umbral del 10% alertaría de casi todo; uno útil sería tan alto que para
  entonces el pick ya estaría decidido.

Ese caso ya lo cubren `PROFIT_LOCK` y `POSITION_DYING`, con condiciones mejor
afinadas. Aquí: **una alerta por pick**.

## Dedupe

Tabla `value_alerts`, una fila por pick alertado, clave `pick_id`. Al consumir
picks ya emitidos el pick *es* la unidad, así que no hacen falta ids de mercado
ni de selección — que además el repo no persiste.

Se marca **antes** de enviar: ante un fallo a mitad es preferible perder una
alerta que repetirla en el chat.

`odd_alertada` se guarda aunque no haya re-alerta, para poder medir después el
CLV entre el precio del aviso y el de cierre.

## Formato del mensaje

```
💡 Valor detectado

Toluca vs. León
Menos de 2.5 — Total 2.5

Casa 1.85 · Justo 1.39 · Edge +5.0%
⏱ 1-0 · 34'

Abrir en Playdoit
```

El valor justo se muestra como **cuota** (1/conf), no como probabilidad, porque
es lo comparable de un vistazo con el precio de la casa.

## Tests

```bash
node --test tests/alertas-valor.test.js
```

Cubren el filtro (banda de edge, Under, deporte), el formateador (las seis cosas
del mensaje, escape de HTML, deep link) y el dedupe (dos ciclos → una alerta,
techo de edad, picks ya liquidados). Corren contra una BD temporal, nunca contra
`snapshots.db`.
