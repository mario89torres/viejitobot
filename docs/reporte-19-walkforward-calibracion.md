# Reporte 19 — Walk-forward y calibración de probabilidades, a profundidad

> Los dos métodos más citados en toda la serie de reportes ([2](reporte-02-modelos-entrenamiento.md), [14](reporte-14-metodos-estadisticos.md), [17](reporte-17-desempeno-modelo-learned.md), [18](reporte-18-pipeline-entrenamiento.md)), aquí con su definición formal, su implementación exacta en `scripts/train_weights.py`, y su red de correlaciones con el resto del proyecto — pensado para poder aprenderlos aquí y reconocerlos en cualquier otro reporte.

---

## PARTE 1 — Walk-forward

### 1.1 Definición técnica

Walk-forward (también "rolling-origin evaluation" o "forward chaining") es un esquema de validación para datos **ordenados en el tiempo**: se divide la serie en `K` bloques temporales consecutivos y se generan `K−1` folds donde el fold `i` entrena con todo lo anterior al bloque `i+1` y valida **solo** sobre el bloque `i+1`.

```
bloque:     [ 1 ][ 2 ][ 3 ][ 4 ][ 5 ]
fold 1:     train=[1]        test=[2]
fold 2:     train=[1,2]      test=[3]
fold 3:     train=[1,2,3]    test=[4]
fold 4:     train=[1,2,3,4]  test=[5]
```

Formalmente: para una serie de observaciones `{(x_t, y_t)}` con `t = 1..n` ordenada por tiempo, y una partición en `K` bloques de frontera `e_0=0 < e_1 < ... < e_K=n`, el fold `i` usa `train_i = {t : t ≤ e_i}` y `test_i = {t : e_i < t ≤ e_{i+1}}`, para `i = 1..K-1`.

**Qué lo distingue de un k-fold aleatorio (cross-validation estándar)**: en k-fold aleatorio, cualquier observación puede caer en cualquier partición sin importar el orden temporal. Eso permite que el modelo "vea" información estadística de un periodo futuro al validar sobre un periodo pasado (o viceversa) — una forma de **fuga temporal** (leakage). Walk-forward la elimina por construcción: ningún fold de test contiene una observación anterior a las de su propio train.

**Qué lo distingue de un simple split train/test único**: un solo corte (ej. 80%/20%) da **una** medición, con toda la varianza de un único periodo de prueba. Walk-forward da `K-1` mediciones independientes, permitiendo preguntar no solo "¿mejora en promedio?" sino "¿mejora *consistentemente*, o solo en un periodo afortunado?" — la base del criterio de "mayoría de folds" (§1.4).

### 1.2 Por qué existe walk-forward en este proyecto

La causa raíz, medida directamente: **el mapa precio→resultado no es estacionario**. El lift sobre el precio (WR real menos `f_prob_justa`, que es exactamente el edge explotable) pasó de **+8.9pp en un tramo de entrenamiento a +1.8pp en el tramo de prueba siguiente** — una caída del 80% en tres semanas, con bandas individuales moviéndose hasta −21pp (memoria: [por-que-no-entrena](../memory/por-que-no-entrena.md)). Cualquier modelo que se valide con un esquema que ignore el orden temporal reportaría una calidad que no existe en producción, porque en producción el modelo siempre opera *hacia adelante* sobre un mercado que ya se movió.

Esto conecta directamente con dos reglas metodológicas transversales del proyecto:

- **[Comparar en la misma ventana](../memory/comparar-en-la-misma-ventana.md)**: todo grupo se compara contra los picks emitidos del mismo periodo, nunca contra su propio pasado. Walk-forward es la versión *algorítmica* de esa misma disciplina, aplicada dentro del entrenamiento en vez de entre auditorías.
- **CLV descartado como objetivo de entrenamiento** ([por-que-no-entrena](../memory/por-que-no-entrena.md)): parecía una señal casi perfecta (correlación 0.567 con acierto) hasta descubrir que el "cierre" se toma 31 minutos antes de liquidar, con el partido casi resuelto — una fuga de etiqueta que ningún walk-forward puede arreglar por sí solo, porque la fuga está en la *definición* de la feature, no en el orden de validación. Es la lección complementaria: walk-forward previene la fuga *entre folds*, no la fuga *dentro de una fila*.

### 1.3 Implementación exacta (`scripts/train_weights.py`)

```python
k_blocks = 5 if n >= 600 else 4
edges = np.linspace(0, n, k_blocks + 1, dtype=int)
for i in range(1, k_blocks):
    tr = df.iloc[: edges[i]]
    te = df.iloc[edges[i] : edges[i + 1]]
```

Detalles de diseño que no son obvios a simple vista:

1. **Bloques de tamaño creciente para train, tamaño fijo para test.** El fold 1 entrena con el bloque 1 y valida con el 2; el fold 3 entrena con los bloques 1-3 (tres veces más datos) y valida con el 4. Es la esencia de "walk-forward": el train siempre crece hacia adelante, nunca se descarta el pasado.
2. **`k_blocks` depende de `n`.** Con pocas filas, 5 bloques dejarían folds de test demasiado chicos para medir nada con estabilidad — el proyecto prefiere 4 folds más grandes a 5 folds ruidosos cuando `n<600`.
3. **Un fold se OMITE, no se fuerza**, si `train` o `test` tienen una sola clase, o si la clase minoritaria del train tiene menos de 4 filas (`min(np.bincount(y_tr)) < 4`). La alternativa — entrenar o evaluar igual — produciría una métrica sin sentido estadístico disfrazada de número válido.
4. **Doble medición por fold**: sobre el bloque de test completo (agregado, incluye grupo de control) y sobre el subconjunto `origin='picks'` de ese mismo bloque, exigiendo al menos 20 filas y ambas clases presentes — si no se cumple, la métrica de ese fold se marca `NaN` explícito, que en Python nunca cuenta como "victoria" en una comparación (`NaN < x` es `False`). Ver [reporte-18 §5.2](reporte-18-pipeline-entrenamiento.md#52-walk-forward-con-protección-explícita-contra-folds-degenerados).

### 1.4 Cómo se usa el resultado: agregado + consistencia por fold

Walk-forward produce dos tipos de evidencia, no una sola cifra:

- **Agregado out-of-sample**: se concatenan las predicciones de test de *todos* los folds y se calcula Brier/log-loss sobre el conjunto completo — una sola cifra con el poder estadístico de toda la muestra de validación.
- **Consistencia por fold** (`fold_wins`): cuántos de los `K-1` folds individuales el modelo le gana al heurístico, en Brier y en log-loss por separado. La regla de adopción exige **mayoría** en ambas, no solo una mejora agregada — porque un agregado positivo puede estar cargado por un solo fold con una racha favorable, exactamente el patrón que "ninguna racha corta es evidencia" (regla general del proyecto, [contexto-ia.md](contexto-ia.md)) pide vigilar.

Caso real donde la distinción importó: el modelo del 2026-08-16 pasaba el agregado con margen (4/4 folds, Brier +0.0070) pero solo ganaba **1/4 folds sobre picks emitidos** — sin la medición por fold *y* por población, se habría adoptado un modelo que en la práctica no mejoraba nada que recibiera dinero (ver [reporte-18 §8](reporte-18-pipeline-entrenamiento.md#8-la-regla-de-adopción-formalmente)).

### 1.5 Walk-forward vs. el resto del proyecto que usa ventanas temporales

Walk-forward no es la única técnica de este proyecto que respeta el tiempo — es la versión formal, dentro de un algoritmo de aprendizaje, de un principio que aparece en todos lados:

| Dónde | Cómo aparece la misma idea |
|---|---|
| Firewall R7 (Under línea alta) | Reglas derivadas en TRAIN (17-jul→06-ago) y verificadas en TEST (06-ago→09-ago) sin mirar el periodo de prueba al derivarlas — walk-forward de un solo fold, aplicado a un umbral en vez de a un modelo ([reporte-01 §2.4](reporte-01-arquitectura-flujo.md#24-firewall-firewalljs)) |
| Sizing escalonado por línea+apertura | Validado con el mismo estándar temporal antes de adoptarse (memoria: [sizing-y-f-apertura](../memory/sizing-y-f-apertura.md)) |
| `MIN_CONF` candidato en Under | Explícitamente pospuesto hasta tener 14-21 días de historia limpia, "el mismo estándar que se usó para validar R7" (memoria: [min-conf-under-candidato](../memory/min-conf-under-candidato.md)) |
| Bootstrap pareado sobre folds | Cuando walk-forward por sí solo no basta para saber si la ventaja es estable, se añade bootstrap (500-5000 resamples) sobre los resultados por fold — ver [reporte-14 §2](reporte-14-metodos-estadisticos.md#2-bootstrap--intervalos-de-confianza-ic95) |

La lección transversal: **cualquier validación en este proyecto que no respete el orden temporal está descalificada de entrada**, sin importar qué tan buena se vea la métrica.

---

## PARTE 2 — Calibración de probabilidades

### 2.1 Definición técnica

Un clasificador produce un score `ŝ(x) ∈ [0,1]` que se *interpreta* como una probabilidad. Está **bien calibrado** si, entre todas las observaciones donde predijo `ŝ(x) = p`, la fracción real de positivos es efectivamente `p`. Formalmente: `P(y=1 | ŝ(x)=p) = p` para todo `p`.

Un modelo puede **discriminar bien** (ordenar correctamente positivos antes que negativos — lo que mide el AUC) y estar **mal calibrado** al mismo tiempo (siempre sobreestimar o subestimar el nivel absoluto). Son propiedades distintas: discriminación es sobre el *orden*, calibración es sobre la *magnitud*.

**Cómo se mide**: el diagrama de confiabilidad (*reliability diagram*) agrupa las predicciones en bins de score y grafica la fracción real de positivos contra el score medio de cada bin — un modelo perfectamente calibrado cae sobre la diagonal. El **ECE** (*Expected Calibration Error*) resume esa desviación en un solo número, ponderando cada bin por su tamaño.

**Los dos métodos usados en este proyecto**:

- **Platt scaling (regresión sigmoide)**: ajusta una regresión logística de una sola variable sobre el *logit* del score crudo, `P(y=1) = σ(a·logit(ŝ) + b)`, con `a, b` aprendidos por máxima verosimilitud. Es **paramétrica** — asume que la relación entre score y probabilidad real tiene forma sigmoide — y por tanto produce una curva **continua** y suave.
- **Regresión isotónica**: ajusta la función **no decreciente** que minimiza el error cuadrático respecto a las etiquetas reales, sin asumir ninguna forma funcional (típicamente vía el algoritmo PAVA — *Pool Adjacent Violators*). Es **no paramétrica**, más flexible, pero produce una función **escalonada** por construcción — el precio de esa flexibilidad es que dentro de cada "escalón" todos los scores distintos se colapsan al mismo valor calibrado.

### 2.2 El trade-off sesgo-varianza, aplicado

Isotónica tiene menos sesgo potencial (puede aproximar cualquier función monótona) pero más varianza (con pocos datos, el ajuste "seguido de los puntos" sobreajusta el ruido de la muestra de calibración). Platt tiene más sesgo potencial (fuerza una forma sigmoide) pero mucho menos varianza (solo 2 parámetros).

Este proyecto midió ambos lados de ese trade-off, con números concretos (walk-forward, 4 folds, n=17.904):

```
             Brier     logloss   peor fold    valores distintos en 200 puntos
isotónica    0.22756   0.64691   0.66289      30
Platt        0.22889   0.64963   0.67682      200
crudo        0.22362   0.63867   0.64510      2629 (no aplica "puntos", es continuo)
```

Isotónica gana por poco en el promedio, pero **pierde fuerte en su peor fold** (log-loss 0.72 vs 0.59 de Platt en un fold de 630 muestras) — exactamente el patrón de alta varianza que la teoría predice cuando el conjunto de calibración es chico. Y con solo 30 valores distintos en 200 puntos de tabla, isotónica **colapsó** el 94.8% de los picks que pasaban `MIN_CONF=0.70` en un único valor idéntico (0.7025) — el hueco entre 0.6678 y 0.7025 caía justo sobre el umbral de decisión (memoria: [calibracion-isotonica-colapso](../memory/calibracion-isotonica-colapso.md)).

### 2.3 El hallazgo contraintuitivo: el crudo gana a ambos

Sobre el agregado, el score **sin calibrar** superó a los dos métodos de calibración en Brier y en log-loss. La explicación técnica: una regresión logística entrenada minimizando log-loss **ya sale razonablemente calibrada por construcción** — el objetivo de entrenamiento y el objetivo de calibración son, en ese caso, el mismo objetivo. Recalibrar añade un paso más de ajuste sobre las mismas predicciones, lo que suma varianza sin corregir un sesgo que ya era pequeño.

Pero (ver [reporte-18 §6](reporte-18-pipeline-entrenamiento.md#6-calibración--la-pieza-que-más-cambió-de-opinión-con-la-evidencia)) sobre la población que **decide** (`origin='picks'`), el crudo sin calibrar **no pasaba** la regla de adopción (2/4 folds) donde Platt sí (3/4) — la misma trampa de agregación de §1.4/§2.2, esta vez aplicada al método de calibración en vez de al dataset. **Sigmoid quedó como default no porque gane en la métrica más simple, sino porque es lo único que pasa la prueba que de verdad importa.**

### 2.4 Cómo se usa esto en producción (`src/model.js`)

Dos consumidores distintos del mismo modelo, con necesidades opuestas:

- **`learnedRaw()`** — el sigmoide sin calibrar. Se usa para **ordenar** picks entre sí, porque conserva resolución continua (2629 valores distintos vs 30-200 de las tablas calibradas).
- **`learnedConf()`** — pasa el crudo por la tabla de calibración (interpolación lineal, búsqueda binaria — ver [reporte-15 §3](reporte-15-algoritmos.md#3-interpolación-de-la-tabla-de-calibración-interp-en-modeljs)) y se usa para **leer** el resultado como una probabilidad con sentido (por ejemplo, al comparar contra `MIN_CONF` como umbral absoluto, o al calcular `edge = conf × momio − 1`).

La distinción "ordenar con el crudo, leer con el calibrado" es la resolución práctica y en código del mismo trade-off sesgo-varianza de §2.2: para ordenar, la varianza extra del crudo no importa (solo importa la posición relativa); para leer un número absoluto, sí importa, y por eso se paga el costo de calibrar.

### 2.5 Correlaciones para reforzar el aprendizaje

| Concepto de este reporte | Dónde vuelve a aparecer | Qué aprender de la conexión |
|---|---|---|
| Colapso por poca resolución (isotónica) | `MIN_CONF` como puerta binaria ([reporte-01](reporte-01-arquitectura-flujo.md)) | Un umbral fijo sobre una variable de baja resolución puede volverse casi aleatorio — el mismo riesgo existiría si `MIN_CONF` se aplicara sobre cualquier score con pocos valores distintos, no solo sobre `conf_learned` |
| Discriminación vs. calibración (propiedades distintas) | Spearman ([reporte-14 §3](reporte-14-metodos-estadisticos.md#3-correlación-de-spearman)) | Spearman mide *discriminación* (orden), Brier/log-loss miden *calibración + discriminación* juntas. `conf` heurística con Spearman 0.09 (memoria: [kelly-no-ordena-usar-plano](../memory/kelly-no-ordena-usar-plano.md)) es un fallo de discriminación — ninguna calibración lo arregla, porque calibrar no reordena, solo re-escala |
| Bias-varianza en calibración | Regularización en `LogisticRegressionCV` ([reporte-18 §5.1](reporte-18-pipeline-entrenamiento.md#51-por-qué-logisticregressioncv-y-no-logisticregression-a-secas)) | El mismo trade-off aparece dos veces en el mismo pipeline: una vez al elegir `C` (regularización del clasificador) y otra al elegir el calibrador — ambas son decisiones de "cuánta flexibilidad comprar a cambio de cuánta varianza" |
| Trampa de agregación (población incorrecta decide) | Regla de adopción con `origin='picks'` ([reporte-18 §8](reporte-18-pipeline-entrenamiento.md#8-la-regla-de-adopción-formalmente)) | El mismo error puede ocurrir en cualquier decisión que se mida "en general" cuando la población que importa es un subconjunto minoritario del pool medido — pasó con el dataset de entrenamiento (fase 2, reporte 17) y volvió a pasar con el método de calibración (§2.3 de aquí) |
| Verosimilitud censurada (córners) | Binomial negativa ([reporte-14 §9](reporte-14-metodos-estadisticos.md#9-distribución-binomial-negativa-córners)) | No es calibración de probabilidades, pero comparte la lección de fondo: un ajuste estadístico que ignora cómo se generaron realmente los datos (censura, o aquí resolución de la tabla) produce una distribución que parece razonable y no lo es |

### 2.6 Resumen ejecutable

```
¿Necesito ORDENAR picks entre sí?           -> usar el score SIN calibrar (más resolución)
¿Necesito LEER un número como probabilidad? -> usar el score CALIBRADO (sigmoid/Platt en este proyecto)
¿Tengo pocos datos de calibración (<2000)?  -> Platt, nunca isotónica (varianza)
¿La decisión se juega en una sub-población
 minoritaria del pool medido?               -> medir la regla AHÍ, no en el agregado
¿Los datos están ordenados en el tiempo?    -> walk-forward, nunca k-fold aleatorio
```
