import sqlite3
import pandas as pd
import numpy as np

# Conectar a la base de datos
conn = sqlite3.connect('snapshots.db')

# Cargar picks liquidados con stake y resultado definitivo
df = pd.read_sql_query("""
    SELECT id, ts, event, sport, market, selection, odd_decimal, conf, edge, stake, result, final_score
    FROM picks
    WHERE result IN ('win', 'loss') AND stake IS NOT NULL AND edge IS NOT NULL
""", conn)

conn.close()

print(f"Total de picks liquidados analizados con Edge: {len(df)}")

if len(df) == 0:
    print("No se encontraron picks con edge y stake para analizar.")
    exit()

# Calcular ganancia/pérdida individual en unidades y retorno
df['win'] = (df['result'] == 'win').astype(int)
df['profit'] = np.where(df['win'] == 1, df['stake'] * (df['odd_decimal'] - 1), -df['stake'])
df['ev_implied'] = df['edge'] * 100 # % Edge estimado

# 1. Agrupación por Rangos de Edge
bins = [-1.0, 0.0, 0.05, 0.10, 0.20, 0.40, 10.0]
labels = ['< 0%', '0% - 5%', '5% - 10%', '10% - 20%', '20% - 40%', '> 40%']
df['edge_bucket'] = pd.cut(df['edge'], bins=bins, labels=labels)

print("\n========================================================================")
print("              ANÁLISIS DE EFICIENCIA POR RANGOS DE EDGE                 ")
print("========================================================================")

grouped = df.groupby('edge_bucket', observed=False).agg(
    n=('id', 'count'),
    conf_media=('conf', 'mean'),
    edge_medio=('edge', lambda x: x.mean() * 100),
    odd_medio=('odd_decimal', 'mean'),
    win_rate=('win', lambda x: x.mean() * 100),
    staked=('stake', 'sum'),
    profit=('profit', 'sum')
).reset_index()

grouped['roi'] = np.where(grouped['staked'] > 0, 100 * grouped['profit'] / grouped['staked'], 0)
grouped['stake_medio'] = np.where(grouped['n'] > 0, grouped['staked'] / grouped['n'], 0)

print(grouped.to_string(index=False, formatters={
    'conf_media': '{:.1%}'.format,
    'edge_medio': '{:+.1f}%'.format,
    'odd_medio': '{:.2f}'.format,
    'win_rate': '{:.1f}%'.format,
    'staked': '{:.1f}u'.format,
    'profit': '{:+.2f}u'.format,
    'roi': '{:+.1f}%'.format,
    'stake_medio': '{:.2f}u'.format
}))

# 2. Análisis por Momio (Odds Band) vs Edge
print("\n========================================================================")
print("              ANÁLISIS DE EDGE POR BANDA DE MOMIOS                      ")
print("========================================================================")
odd_bins = [1.0, 1.20, 1.40, 1.70, 2.00, 3.00, 100.0]
odd_labels = ['1.05 - 1.20', '1.20 - 1.40', '1.40 - 1.70', '1.70 - 2.00', '2.00 - 3.00', '> 3.00']
df['odd_bucket'] = pd.cut(df['odd_decimal'], bins=odd_bins, labels=odd_labels)

odd_grouped = df.groupby('odd_bucket', observed=False).agg(
    n=('id', 'count'),
    edge_medio=('edge', lambda x: x.mean() * 100),
    win_rate=('win', lambda x: x.mean() * 100),
    staked=('stake', 'sum'),
    profit=('profit', 'sum')
).reset_index()
odd_grouped['roi'] = np.where(odd_grouped['staked'] > 0, 100 * odd_grouped['profit'] / odd_grouped['staked'], 0)

print(odd_grouped.to_string(index=False, formatters={
    'edge_medio': '{:+.1f}%'.format,
    'win_rate': '{:.1f}%'.format,
    'staked': '{:.1f}u'.format,
    'profit': '{:+.2f}u'.format,
    'roi': '{:+.1f}%'.format
}))

# 3. Métricas Estadísticas Globales de Correlación
corr_edge_profit = df['edge'].corr(df['profit'])
corr_edge_win = df['edge'].corr(df['win'])

print("\n========================================================================")
print("                   MÉTRICAS ESTADÍSTICAS DEL EDGE                       ")
print("========================================================================")
print(f"Edge Promedio Global        : +{df['edge'].mean()*100:.2f}%")
print(f"Edge Mediana Global         : +{df['edge'].median()*100:.2f}%")
print(f"Edge Mínimo                 : {df['edge'].min()*100:+.2f}%")
print(f"Edge Máximo                 : {df['edge'].max()*100:+.2f}%")
print(f"Correlación Edge vs Win     : {corr_edge_win:+.4f}")
print(f"Correlación Edge vs Profit  : {corr_edge_profit:+.4f}")
print("========================================================================")
