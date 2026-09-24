# Contexto para colaboración con IA — ViejitoBot

> Documento de referencia reutilizable. Pégalo o enlázalo al inicio de una conversación nueva con cualquier IA (Claude, u otra) para que entienda el proyecto, tu rol, y dónde está la línea entre "construir" y "decidir".

## 1. Qué es esto

**ViejitoBot** (antes *Playdoit Monitor*): sistema de detección de valor en apuestas deportivas en vivo.

Pipeline: monitorea cuotas de playdoit.mx en tiempo real → calcula probabilidad justa (de-vig) → filtra picks de baja calidad con un firewall basado en evidencia → entrega los que pasan por Telegram. Un modelo aprendido corre en paralelo en modo sombra/veto — nunca como decisor único. Un dashboard permite auditar todo el pipeline después del hecho.

**Usuarios:** el operador (tú) y suscriptores VIP del canal de Telegram que reciben los picks.

**El problema real que resuelve:** nadie puede vigilar manualmente cientos de partidos en vivo buscando cuotas mal puestas — pero automatizar esa vigilancia sin rigor produce ruido, no señal (ya se vivió con `global_draw` y sus features fabricadas — ver [global-draw-fabricated-features](../memory/global-draw-fabricated-features.md) si migras memoria). El producto no es "detectar valor": es **detectarlo con evidencia que se pueda auditar después**.

## 2. Tu rol

Dueño, desarrollador y operador a la vez — sin separación de roles. Responsable del pipeline completo: desde que la muestra entra hasta que el pick sale por Telegram, pasando por facturación VIP, el dashboard, y frentes nuevos en construcción (piloteo de córners con SofaScore). Nadie más revisa esto.

**Implicación para la IA:** no asumas que hay otro humano validando lo que la IA construye o diagnostica. Si algo queda ambiguo o a medias, probablemente se queda así hasta que tú lo notes — así que prioriza dejar el porqué documentado, no solo el qué.

## 3. Dónde SÍ se usa IA

- Diagnóstico de incidentes de producción (BD lenta, procesos colgados, contención con otros proyectos)
- Construcción de scrapers y piezas técnicas nuevas
- Diseño y revisión de metodología estadística
- Reescritura y mantenimiento del dashboard

## 4. Dónde NO se usa IA — y por qué

**Regla dura: la IA construye y diagnostica, pero no decide sin auditoría humana del porqué.**

- El modelo aprendido **nunca decide solo**. Corre en `MODEL_MODE=shadow`/veto, nunca en modo "learned" puro. Esto no es una preferencia arbitraria — viene de un incidente real donde el modo "learned" infló la confianza y el sizing tipo Kelly multiplicó el stake sobre esa confianza inflada (ver [model-adoption-incident](../memory/model-adoption-incident.md)).
- Ninguna racha corta se trata como evidencia — ni un 18/19 — sin medir significancia estadística primero.
- Cualquier hallazgo estadístico nuevo (un backtest, una correlación, un "esto sube el ROI") se trata como candidato, no como conclusión, hasta que se audite contra ventanas comparables y tamaño de muestra suficiente.

**Por qué esta línea existe:** el proyecto ya tiene un historial de features fabricadas y reglas espurias colándose como si fueran señal real cuando nadie las auditó a tiempo. La disciplina de "shadow/veto, nunca decisor único" es la respuesta directa a eso.

## 5. Qué desbloquea esto — la frase que resume el trade-off

> Si la IA se encarga de diagnosticar y reparar incidentes operativos, y de la construcción técnica de cada pieza nueva, el tiempo del operador se libera para decidir **qué** vale la pena construir y **cuándo** confiar en una señal — por ejemplo, si perseguir un mercado como Caliente vale el costo, o si una racha de 18/19 es señal o suerte. Ahí es donde están las decisiones importantes.

**Implicación práctica para la IA:** cuando termines de construir o diagnosticar algo, no te limites a reportar "listo" — señala explícitamente si lo que encontraste es candidato a señal real o todavía no tiene el tamaño de muestra/rigor para tratarse como tal. Esa distinción es el trabajo que este documento existe para proteger.

## 6. Cómo usar este documento

- Al empezar una conversación nueva sobre ViejitoBot, comparte este archivo o resume las secciones 2–5.
- Si una de las reglas de la sección 4 deja de aplicar (cambia el modo del modelo, cambia el criterio de significancia), actualiza este documento — no dejes que quede desactualizado silenciosamente.
