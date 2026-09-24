# Glosario — ViejitoBot

> Acumulativo: se alimenta después de cada reporte técnico. Formato: término — definición corta — de dónde salió.

## Matemáticos / estadísticos

- **De-vig** — remover el margen de la casa de una cuota para obtener la probabilidad "justa" del evento. `src/devig.js`. (Reporte 1)
- **Edge** — diferencia entre la probabilidad justa calculada y la que implica la cuota ofrecida; es el "valor" que el sistema busca detectar. (Reporte 1)
- **Brier score** — error cuadrático medio entre probabilidad predicha y resultado real (0/1); menor es mejor. Métrica principal para comparar heurístico vs aprendido. (Reporte 2)
- **Log-loss** — pérdida logarítmica; penaliza con más fuerza una predicción confiada y equivocada que el Brier. Se reporta junto al Brier en cada fold. (Reporte 2)
- **Walk-forward** — validación temporal: se entrena en bloques de tiempo pasados y se valida en el bloque siguiente, nunca al revés. Evita que el modelo "vea el futuro". (Reporte 2)
- **Fold** — cada partición train/test dentro de un walk-forward (K bloques → K−1 folds). (Reporte 2)
- **Calibración isotónica** — ajuste no paramétrico monótono que mapea el score crudo a probabilidad; en este proyecto se manifestó como una "escalera" de ~30 peldaños que colapsaba el orden fino. (Reporte 2)
- **Calibración de Platt (sigmoid)** — ajuste paramétrico (regresión logística sobre el score) para mapear a probabilidad; elegido sobre isotónica por preservar continuidad, con Brier/log-loss casi idénticos. (Reporte 2)
- **Score crudo (`learnedRaw`)** — salida del modelo antes de calibrar; se usa para ordenar picks porque conserva más resolución que el calibrado. (Reporte 2)
- **IC95% (intervalo de confianza al 95%)** — rango donde se espera que caiga el ROI real dado el ruido de la muestra; un IC que cruza cero significa "no distinguible de cero". (Reporte 1, regla R7 del firewall)
- **Correlación de Spearman** — correlación de rangos (no lineal); usada para medir si una feature (ej. `f_situacion`, confianza de Kelly) ordena correctamente los aciertos. Valores cercanos a 0 o negativos indican que la feature no sirve para ordenar. (Memoria: kelly-no-ordena-usar-plano, edge-audit-findings)
- **Kelly (criterio de Kelly)** — fórmula de sizing de apuestas proporcional al edge y la probabilidad estimada; descartada en este proyecto porque su ranking no correlaciona con acertar (Spearman 0.09) y duplicó el drawdown sin mejorar el ROI. (Memoria: kelly-no-ordena-usar-plano)
- **ROI (retorno sobre inversión)** — ganancia/pérdida neta dividida entre lo apostado; métrica principal de resultado de negocio en todos los backtests del proyecto.
- **WR (win rate)** — porcentaje de picks que acertaron; se reporta siempre junto al ROI porque un WR alto con ROI negativo es señal de momios sistemáticamente malos.
- **Método de Shin (de-vig)** — método de remoción de margen que modela una fracción `z` de "dinero informado" en el mercado, en vez de repartir el margen por igual entre selecciones; método por defecto del proyecto (`src/devig.js`). (Reporte 14 §1)
- **Verosimilitud censurada** — en una binomial negativa, tratar una observación incompleta (un piso, no un valor exacto) como `P(X ≥ observado)` en vez de `P(X = observado)`, para no fabricar una distribución falsa a partir de datos truncados. Usado en el modelo de córners. (Reporte 14 §9)
- **Test de permutación** — comparar un resultado observado (ej. ROI por franja horaria) contra miles de reordenamientos aleatorios de los mismos datos, para decidir si la dispersión observada excede la que produciría el azar. (Reporte 14 §8)
- **Sobredispersión** — cuando la varianza de un conteo excede su media; motivo de usar binomial negativa en vez de Poisson para modelar córners. (Reporte 14 §9)

## Walk-forward y calibración a profundidad (Reporte 19)

- **Fold** (walk-forward) — una partición train/test donde train es todo lo anterior a una frontera temporal y test es el bloque inmediatamente siguiente; a diferencia de k-fold aleatorio, ningún test contiene datos anteriores a los de su propio train. (Reporte 19 §1.1)
- **Reliability diagram (diagrama de confiabilidad)** — gráfico que agrupa predicciones en bins de score y compara el score medio de cada bin contra la fracción real de positivos observada; un modelo bien calibrado cae sobre la diagonal. (Reporte 19 §2.1)
- **ECE (Expected Calibration Error)** — número único que resume la desviación de un reliability diagram respecto a la diagonal perfecta, ponderando cada bin por su tamaño. (Reporte 19 §2.1)
- **Discriminación vs. calibración** — dos propiedades distintas de un score: discriminación es si ordena bien positivos antes que negativos (lo que mide Spearman o AUC); calibración es si el valor absoluto del score coincide con la frecuencia real. Un modelo puede tener una sin la otra. (Reporte 19 §2.1, §2.5)
- **PAVA (Pool Adjacent Violators Algorithm)** — algoritmo estándar para ajustar una regresión isotónica: fusiona (\"pool\") bloques adyacentes de datos que violan la monotonía hasta que la función resultante es no decreciente. (Reporte 19 §2.1)
- **Trade-off sesgo-varianza en calibración** — isotónica (no paramétrica) tiene menos sesgo potencial pero más varianza con pocos datos; Platt (paramétrica, sigmoide) tiene más sesgo potencial pero mucho menos varianza. La elección depende del tamaño de la muestra de calibración disponible. (Reporte 19 §2.2)

## Pipeline de entrenamiento (Reporte 18)

- **Grupo de control como negativos de entrenamiento** — unir `picks` (emitidos) con `rejected_picks` (bloqueados) en el dataset de entrenamiento para romper la restricción de rango: entrenar solo con picks emitidos nunca le muestra al clasificador un negativo claro, porque todo pasó ya un filtro que lo hacía parecer bueno. (Reporte 18 §2.1)
- **`origin` (columna de procedencia)** — marca si una fila del dataset viene de `picks` o `rejected_picks`; permite evaluar la regla de adopción sobre la población que recibe dinero real, por separado del agregado. (Reporte 18 §2.2, §8)
- **Restricción de rango** — cuando los datos disponibles para entrenar ya pasaron un filtro previo, comprimiendo el rango de valores observado y ocultando la frontera de decisión real. Motivo original de incorporar el grupo de control. (Reporte 18 §2.1)
- **`unscale()` (deshacer estandarización)** — recuperar coeficientes de una regresión logística entrenada sobre features estandarizadas, en el espacio original de las features, para poder aplicar el modelo en producción sin reimplementar el escalador. (Reporte 18 §9)
- **`cross_val_predict` para calibración** — generar las predicciones que alimentan el ajuste de la tabla de calibración fuera de muestra (out-of-fold), para no calibrar y evaluar sobre las mismas predicciones que produjeron esos parámetros. (Reporte 18 §10)
- **Regla de adopción (5 condiciones)** — el modelo solo reemplaza al heurístico si mejora Brier y log-loss en el agregado, gana la mayoría de folds, tiene suficiente población de picks emitidos evaluable (`MIN_PICKS_OOS`), y repite esa misma mejora y mayoría de folds sobre esa población específica. Las cinco condiciones son necesarias. (Reporte 18 §8)
- **Retención (in-sample vs out-of-sample)** — proporción de la mejora medida en entrenamiento que sobrevive fuera de muestra; se reporta como señal de alerta, no como condición de bloqueo para adoptar. (Reporte 18 §8)
- **`DRY_RUN`** — modo del entrenador que evalúa y exporta a un archivo candidato sin tocar el modelo de producción, aunque la regla de adopción diga que sí adoptaría; existe porque comparar variantes en bucle sin él reemplaza producción en cada corrida que adopte. (Reporte 18 §6)

## Algoritmos (Reporte 15)

- **Bisección** — método numérico para resolver una ecuación `f(x)=0` cuando `f` es monótona, sin necesitar su derivada; usado en dos de los cuatro métodos de de-vig (`power`, `shin`). (Reporte 15 §1)
- **Distancia de Levenshtein** — número mínimo de ediciones (inserción/borrado/sustitución de caracteres) para transformar una cadena en otra; usada para tolerar variantes de idioma en nombres de equipo (Zimbabue/Zimbabwe). (Reporte 15 §2)
- **EPERM-aware (verificación de proceso vivo)** — al comprobar si un PID sigue activo, tratar el error `EPERM` (el proceso existe pero pertenece a otro usuario) igual que "vivo", en vez de solo comprobar `ESRCH` (no existe). Necesario en máquinas con más de una cuenta de Windows ejecutando el mismo bot. (Reporte 15 §5)
- **Ventana deslizante (rate limiting)** — limitar peticiones por minuto filtrando timestamps recientes en cada intento, en vez de un contador que se reinicia en bloques fijos; evita el efecto ráfaga al inicio de cada minuto. (Reporte 15 §6)
- **Cursor adaptativo por rowid** — al podar una tabla grande por lotes, avanzar el cursor al máximo `rowid` que de verdad existe dentro de la ventana (no sumar un tamaño fijo), porque los borrados previos dejan huecos que harían re-escanear rangos vacíos. (Reporte 15 §7)

## Computacionales / de arquitectura

- **`MODEL_MODE`** — interruptor de operación del modelo aprendido: `heuristic` (solo heurístico), `shadow` (ambos se calculan, decide el heurístico — default de producción), `learned` (decide el aprendido, con fallback a heurístico si no hay modelo). (Reporte 1 y 2)
- **Shadow/veto** — patrón de despliegue donde un modelo nuevo corre en paralelo al que decide, sin intervenir, solo para auditar su desempeño antes de confiarle la decisión. (Reporte 1)
- **Train/serve skew** — divergencia entre cómo se calcula una feature en entrenamiento vs en producción; causa de al menos un incidente grave en este proyecto (reconstrucción de 2228 filas de `f_avance`). (Reporte 1, Reporte 2 §4)
- **Sello de versión del modelo (`modelVersion`)** — identificador `<trained_at>-<hash7>` que se adjunta a cada score para saber qué modelo lo produjo, incluso si `model.json` se recarga en caliente. (Reporte 2 §5)
- **Grupo de control (`rejected_picks`)** — tabla que registra los picks que el firewall o `MIN_CONF` bloquean, para poder medir después si el rechazo estaba justificado. (Reporte 1 §2.4; memoria: grupo-control-rechazados)
- **Candado de instancia única** — mecanismo (`singleInstance.js`) que impide que dos procesos del bot corran a la vez sobre la misma base de datos. (Reporte 1 §3; memoria: two-windows-accounts)

## De estrategia / dominio

- **Firewall (de picks)** — capa de reglas, posterior al scoring, que bloquea buckets con ROI negativo medido y validado fuera de muestra. No genera edge, solo lo protege. (Reporte 1 §2.4)
- **Tier ELITE** — subconjunto de picks (dentro de los que pasan el firewall) con el único ROI positivo fuera de muestra medido hasta ahora; marca orientativa, no garantía, por tamaño de muestra chico. (Reporte 1 §2.4)
- **Zona dulce del edge** — rango de magnitud de edge (2–6% en las mediciones del proyecto) donde el edge sí se traduce en resultado; fuera de ese rango, la magnitud del edge deja de ordenar el acierto. (Memoria: edge-audit-findings)
- **Sizing escalonado (`STAKE_MODE=tiered`)** — apostar un tamaño de stake distinto según línea+apertura del mercado, en vez de un tamaño plano o proporcional a Kelly; subió el P/L 50% y bajó el drawdown 37% en las mediciones del proyecto. (Memoria: sizing-y-f-apertura)
- **`f_apertura`** — feature que captura la línea de apertura del mercado (antes de moverse en vivo); usada para el sizing escalonado.
- **Under / Over** — mercados de "menos de X" / "más de X" (típicamente goles, córners, etc.). En este proyecto todo el edge medido está concentrado en Under con línea baja; Over pierde en todos los tramos medidos.
- **DNB (Draw No Bet)** — mercado que anula la apuesta en caso de empate; tratado como "neutral" en los hallazgos de empates del proyecto.
- **`global_draw` (scanner de empates estructurales)** — módulo que insertaba picks de empate directo a la base de datos sin pasar por el scoring/firewall normal; sus picks llevaban features hardcodeadas y contaminaron varios análisis retrospectivos hasta identificarse. (Memoria: global-draw-fabricated-features)
