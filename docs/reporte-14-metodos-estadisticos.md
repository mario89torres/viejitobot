# Reporte 14 — Métodos estadísticos

> Catálogo transversal: qué método, para qué se usa en este proyecto, y por qué ese y no otro. Complementa [glosario.md](glosario.md) (definiciones cortas) — aquí va el razonamiento detrás de cada elección. Fuentes ya citadas en los reportes [1](reporte-01-arquitectura-flujo.md) y [2](reporte-02-modelos-entrenamiento.md) se enlazan, no se repiten.

## 1. De-vig (remoción del margen de la casa)

`src/devig.js` implementa **4 métodos** con la misma firma (`devig(oddsArray, method) → probsArray`), seleccionable por `.env` (`DEVIG_METHOD`, default `shin`):

| Método | Idea | Cuándo degenera |
|---|---|---|
| `proportional` | Normaliza probabilidades implícitas para que sumen 1: `(1/o_i) / Σ(1/o_j)` | Nunca — es el fallback universal |
| `additive` | Resta el margen a partes iguales: `p_i − (Σp−1)/n` | Si alguna prob. resultante ≤ 0 |
| `power` | Encuentra `k` tal que `Σ p_i^k = 1` (bisección) | Convergencia numérica en casos extremos |
| `shin` (1993) | Modela una fracción `z` de "dinero informado" y resuelve `π_i` para que sumen 1 | Mercado sin sobre-margen (`Σp≤1`), o no convergencia en `z∈[0,1)` |

**Por qué Shin por defecto**: es el único que modela explícitamente que el margen no se reparte igual entre selecciones — las favoritas suelen llevar menos margen relativo que las mal cotizadas. Cuando degenera, cada método cae a `proportional` marcando `probs.warning` y `probs.methodUsed`, para que el fallback quede auditable en vez de silencioso.

## 2. Bootstrap / intervalos de confianza (IC95%)

Usado en **todos** los backtests citados en los reportes 1 y 2 (firewall R7, features de mercado, banda de edge de alertas). Un IC que cruza cero se lee como "no distinguible de cero" — la regla dura del proyecto para no confundir ruido con señal. Ejemplo aplicado: Under línea≤3.5 IC[+3.1%,+16.4%] (edge real) vs Under línea>3.5 IC[−9.0%,+10.5%] (cruza cero) → ver [reporte-01 §2.4](reporte-01-arquitectura-flujo.md#24-firewall-firewalljs).

**Por qué no solo el punto estimado**: con N en cientos, un ROI puntual de +9.8% y otro de +0.7% pueden ser la misma realidad estadística. El proyecto trata el punto estimado como el hallazgo *candidato* y el IC como el filtro que decide si es *señal*.

## 3. Correlación de Spearman

Usada para responder una pregunta específica: **¿esta feature ordena los aciertos, o solo los acompaña?** Un Spearman cercano a 0 significa que ordenar por esa variable no separa ganadores de perdedores, aunque el promedio se vea razonable.

- `f_situacion` vs acierto: **−0.119** → llevó a ponerla en peso 0 en el heurístico ([reporte-02 §2](reporte-02-modelos-entrenamiento.md#2-modelo-heurístico)).
- Confianza estilo Kelly vs acierto: **0.09** → llevó a descartar Kelly como criterio de sizing (memoria: [kelly-no-ordena-usar-plano](../memory/kelly-no-ordena-usar-plano.md)).

**Por qué Spearman y no Pearson**: no asume relación lineal ni distribución normal — solo pregunta si el ranking es consistente. Para decidir "¿sirve esto para priorizar apuestas?", el ranking es lo único que importa.

## 4. Brier score y log-loss

Métricas de calidad de una probabilidad predicha contra el resultado binario real. Se usan en pareja, nunca solas, porque penalizan distinto:

- **Brier** (error cuadrático medio) — penaliza suave, es la métrica "cuánto te desviaste en promedio".
- **Log-loss** — penaliza con fuerza creciente una predicción confiada y equivocada (`p≈1` cuando el resultado fue 0). Es la métrica que expone un modelo "seguro de sí mismo" sin razón.

Regla del proyecto: un cambio se adopta solo si mejora **ambas** en la mayoría de los folds ([reporte-02 §3.1](reporte-02-modelos-entrenamiento.md#31-validación-walk-forward-no-k-fold-aleatorio)) — no basta con ganar en una.

## 5. Walk-forward (validación temporal)

Ver [reporte-02 §3.1](reporte-02-modelos-entrenamiento.md#31-validación-walk-forward-no-k-fold-aleatorio) para el detalle de implementación. La razón estadística de fondo: el mercado de momios **no es estacionario** — el mapa precio→resultado se movió 80% en 3 semanas (memoria: [por-que-no-entrena](../memory/por-que-no-entrena.md)). Un k-fold aleatorio mezclaría datos de regímenes distintos en train y test, produciendo una métrica optimista que no sobrevive en producción.

## 6. Calibración de probabilidades (isotónica vs Platt)

Ver [reporte-02 §3.2](reporte-02-modelos-entrenamiento.md#32-calibración-platt-no-isotónica-decisión-revertida). Nota estadística que no está en el reporte 2: ambos métodos resuelven el mismo problema (mapear un score arbitrario a una probabilidad bien calibrada) con supuestos distintos — isotónica es no paramétrica y monótona a trozos (por eso "escalera"), Platt es paramétrica (una logística sobre el score) y por tanto continua. La elección de Platt aquí es un caso de **preferir menos varianza a cambio de un sesgo de forma funcional** que en la práctica no costó discriminación (4/4 folds igual).

## 7. Significancia de rachas cortas

No hay un módulo dedicado — es una **regla de trabajo** aplicada de forma consistente en todo el proyecto: ninguna racha (ni un 18/19) se trata como evidencia sin antes calcular si es distinguible de una tasa de acierto base por azar, con el tamaño de muestra que realmente hay. Ver [contexto-ia.md §4](contexto-ia.md). Es la misma lógica del IC95% (§2) aplicada a un caso extremo de N pequeño.

## 8. Test de permutación (estructura horaria)

Usado para responder: ¿alguna franja horaria tiene de verdad menos varianza o mejor rendimiento, o la dispersión observada es la que produciría el simple azar? Resultado: ninguna franja se distingue de una redistribución aleatoria de los mismos picks (memoria: [sin-estructura-horaria](../memory/sin-estructura-horaria.md)). **Por qué permutación y no un test paramétrico**: no exige asumir una distribución para el ROI por franja — compara la partición observada contra miles de particiones aleatorias de los mismos datos, lo cual es más robusto cuando N por franja es chico y desigual.

## 9. Distribución binomial negativa (córners)

`src/negBinomial.js` — parametrizada por media (`mu`) y dispersión (`r`); converge a Poisson cuando `r→∞`. Se eligió sobre Poisson simple porque los conteos de córners tienen **sobredispersión** (varianza > media), que Poisson no puede representar (`var=mu` fijo).

**Verosimilitud censurada por la derecha**: cuando la casa retira el mercado de córners antes del pitido final, el último conteo visto es un *piso*, no el valor exacto — los córners no bajan. Tratar esa observación como exacta (o descartarla, lo que sesga hacia partidos con mercado activo hasta tarde) fabricaría una distribución irreal — "el mismo tipo de atajo que ya costó 184 picks inservibles en `global_draw`" (comentario del propio código). Por eso cada observación censurada aporta `P(X ≥ conteo_observado)` a la verosimilitud, no `P(X = conteo_observado)`.

El ajuste (`fit()`) usa ascenso coordenado con pasos multiplicativos decrecientes en vez de una librería de optimización — el proyecto no trae ninguna dependencia de cálculo numérico, y para 2 parámetros con verosimilitud unimodal converge sin necesitarla.

## 10. Resumen: qué pregunta responde cada método

| Pregunta | Método |
|---|---|
| ¿Cuál es la probabilidad "justa" detrás de una cuota? | De-vig (Shin) |
| ¿Este resultado es distinguible del azar dado el tamaño de muestra? | Bootstrap/IC95% |
| ¿Esta variable sirve para ordenar picks, o solo acompaña? | Spearman |
| ¿Qué tan buena es una probabilidad predicha? | Brier + log-loss (juntos) |
| ¿Este modelo funcionará en datos futuros, no solo pasados? | Walk-forward |
| ¿Cómo leo un score como probabilidad sin distorsionarlo? | Calibración (Platt) |
| ¿Una racha corta es señal? | Regla de significancia + IC95% |
| ¿Existe estructura horaria explotable? | Test de permutación |
| ¿Cómo modelo conteos con datos incompletos (censura)? | Binomial negativa + verosimilitud censurada |
