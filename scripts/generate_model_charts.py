import os
import matplotlib.pyplot as plt
import numpy as np

# Configurar estilo visual moderno / dark theme
plt.style.use('dark_background')
fig_color = '#121212'
card_color = '#1e1e1e'
accent_blue = '#00d2ff'
accent_green = '#00e676'
accent_purple = '#9c27b0'
accent_orange = '#ff9100'
accent_red = '#ff5252'

output_dir = r"C:\Users\Invitadow\.gemini\antigravity\brain\f81c323a-8bc4-412e-9092-e9335d4f5cd1"
os.makedirs(output_dir, exist_ok=True)

# 1. Gráfica de Evolución de Métricas a través de Entrenamientos
iterations = ['v0 (Heurístico 88p)', 'v1 (IA 374p)', 'v2a (IA 782p)', 'v2b (IA 824p)']
brier_scores = [0.2105, 0.1938, 0.1929, 0.1922]
log_losses = [0.6115, 0.5759, 0.5729, 0.5711]

fig, ax1 = plt.subplots(figsize=(9, 5), facecolor=fig_color)
ax1.set_facecolor(card_color)

color = accent_blue
ax1.set_xlabel('Iteración de Entrenamiento / Dataset', color='white', fontsize=11, fontweight='bold', labelpad=10)
ax1.set_ylabel('Brier Score (Menor es mejor)', color=color, fontsize=11, fontweight='bold')
line1 = ax1.plot(iterations, brier_scores, color=color, marker='o', linewidth=3, markersize=8, label='Brier Score')
ax1.tick_params(axis='y', labelcolor=color)
ax1.set_ylim(0.185, 0.215)

for i, txt in enumerate(brier_scores):
    ax1.annotate(f"{txt:.4f}", (iterations[i], brier_scores[i]), textcoords="offset points", xytext=(0,10), ha='center', color=color, fontweight='bold')

ax2 = ax1.twinx()
color = accent_green
ax2.set_ylabel('Log Loss (Menor es mejor)', color=color, fontsize=11, fontweight='bold')
line2 = ax2.plot(iterations, log_losses, color=color, marker='s', linewidth=3, linestyle='--', markersize=8, label='Log Loss')
ax2.tick_params(axis='y', labelcolor=color)
ax2.set_ylim(0.560, 0.620)

for i, txt in enumerate(log_losses):
    ax2.annotate(f"{txt:.4f}", (iterations[i], log_losses[i]), textcoords="offset points", xytext=(0,-18), ha='center', color=color, fontweight='bold')

plt.title('Evolución de Precisión del Modelo de IA (v0 → v2b)', color='white', fontsize=14, fontweight='bold', pad=15)
fig.tight_layout()
chart1_path = os.path.join(output_dir, "evolucion_metricas_ia.png")
plt.savefig(chart1_path, dpi=200, bbox_inches='tight')
plt.close()

# 2. Gráfica Comparativa por Folds Out-Of-Sample (Walk-Forward)
folds = ['Fold 1 (p1-165)', 'Fold 2 (p166-330)', 'Fold 3 (p331-495)', 'Fold 4 (p496-660)']
heuristic_brier = [0.2105, 0.2120, 0.1915, 0.1625]
ai_brier = [0.2085, 0.2078, 0.1888, 0.1606]

x = np.arange(len(folds))
width = 0.35

fig, ax = plt.subplots(figsize=(9, 5), facecolor=fig_color)
ax.set_facecolor(card_color)

rects1 = ax.bar(x - width/2, heuristic_brier, width, label='Heurístico Fijo', color=accent_red, alpha=0.85)
rects2 = ax.bar(x + width/2, ai_brier, width, label='Modelo IA (Aprendido)', color=accent_green, alpha=0.9)

ax.set_ylabel('Brier Score (Menor es mejor)', color='white', fontsize=11, fontweight='bold')
ax.set_title('Comparativa por Bloques Temporales Walk-Forward (OOS)', color='white', fontsize=14, fontweight='bold', pad=15)
ax.set_xticks(x)
ax.set_xticklabels(folds, color='white', fontweight='bold')
ax.legend(facecolor=card_color, edgecolor='none')
ax.set_ylim(0.140, 0.230)

for rect in rects1:
    height = rect.get_height()
    ax.annotate(f'{height:.4f}', xy=(rect.get_x() + rect.get_width() / 2, height), xytext=(0, 3), textcoords="offset points", ha='center', va='bottom', color='#ff8a80', fontsize=9)

for rect in rects2:
    height = rect.get_height()
    ax.annotate(f'{height:.4f}', xy=(rect.get_x() + rect.get_width() / 2, height), xytext=(0, 3), textcoords="offset points", ha='center', va='bottom', color='#b9f6ca', fontsize=9, fontweight='bold')

fig.tight_layout()
chart2_path = os.path.join(output_dir, "comparativa_folds_oos.png")
plt.savefig(chart2_path, dpi=200, bbox_inches='tight')
plt.close()

# 3. Importancia de Variables en el Modelo IA
features = ['caída de línea (f_linea)', 'probabilidad justa (f_prob)', 'drift de apertura (f_apertura)', 'avance de juego (f_avance)', 'marcador (f_situacion)']
weights = [35, 21, 18, 18, 8]
colors = [accent_blue, accent_green, accent_purple, accent_orange, '#78909c']

fig, ax = plt.subplots(figsize=(9, 4.5), facecolor=fig_color)
ax.set_facecolor(card_color)

bars = ax.barh(features[::-1], weights[::-1], color=colors[::-1], height=0.55)
ax.set_xlabel('Peso Relativo Estimado (%)', color='white', fontsize=11, fontweight='bold', labelpad=10)
ax.set_title('Ponderación de Variables Aprendida por la IA (824 Picks)', color='white', fontsize=14, fontweight='bold', pad=15)
ax.set_xlim(0, 42)

for bar in bars:
    w = bar.get_width()
    ax.annotate(f'{w}%', xy=(w + 0.8, bar.get_y() + bar.get_height()/2), va='center', color='white', fontweight='bold', fontsize=10)

fig.tight_layout()
chart3_path = os.path.join(output_dir, "importancia_variables_ia.png")
plt.savefig(chart3_path, dpi=200, bbox_inches='tight')
plt.close()

# 4. NUEVA: Gráfica Comparativa Directa (Pesos Heurístico vs Pesos Modelo IA)
features_labels = ['Caída de Línea\n(f_linea)', 'Prob. Justa\n(f_prob)', 'Drift Apertura\n(f_apertura)', 'Avance Tiempo\n(f_avance)', 'Marcador\n(f_situacion)']
heuristic_w = [15, 45, 0, 20, 20]
ai_w = [35, 21, 18, 18, 8]

x_feat = np.arange(len(features_labels))
width_bar = 0.35

fig, ax = plt.subplots(figsize=(9.5, 5), facecolor=fig_color)
ax.set_facecolor(card_color)

rects_h = ax.bar(x_feat - width_bar/2, heuristic_w, width_bar, label='Heurístico Fijo (Manual)', color=accent_red, alpha=0.85)
rects_ai = ax.bar(x_feat + width_bar/2, ai_w, width_bar, label='Modelo IA (Aprendido 824p)', color=accent_blue, alpha=0.9)

ax.set_ylabel('Peso asignado (%)', color='white', fontsize=11, fontweight='bold')
ax.set_title('Comparativa Directa de Ponderaciones: Heurístico vs IA', color='white', fontsize=14, fontweight='bold', pad=15)
ax.set_xticks(x_feat)
ax.set_xticklabels(features_labels, color='white', fontweight='bold', fontsize=9.5)
ax.legend(facecolor=card_color, edgecolor='none')
ax.set_ylim(0, 52)

for rect in rects_h:
    height = rect.get_height()
    ax.annotate(f'{height}%', xy=(rect.get_x() + rect.get_width() / 2, height), xytext=(0, 3), textcoords="offset points", ha='center', va='bottom', color='#ff8a80', fontsize=9, fontweight='bold')

for rect in rects_ai:
    height = rect.get_height()
    ax.annotate(f'{height}%', xy=(rect.get_x() + rect.get_width() / 2, height), xytext=(0, 3), textcoords="offset points", ha='center', va='bottom', color='#80d8ff', fontsize=9, fontweight='bold')

fig.tight_layout()
chart4_path = os.path.join(output_dir, "comparativa_pesos_modelos.png")
plt.savefig(chart4_path, dpi=200, bbox_inches='tight')
plt.close()

print('TODAS LAS GRÁFICAS GENERADAS EXITOSAMENTE EN:', output_dir)
