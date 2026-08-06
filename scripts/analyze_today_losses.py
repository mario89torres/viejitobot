import sqlite3
import pandas as pd
import numpy as np
import os
import json
import re

db_path = os.path.join(os.path.dirname(__file__), '..', 'snapshots.db')
conn = sqlite3.connect(db_path)

df = pd.read_sql_query("""
    SELECT id, ts, event_id, event, sport, market, selection, odd_decimal, conf, result, final_score, stake, loss_minute
    FROM picks
    WHERE ts >= '2026-08-04T00:00:00.000Z' AND result IN ('win', 'loss')
""", conn)

conn.close()

print(f"=== ANÁLISIS DE PICKS DE HOY (04-AGO-2026) ===")
print(f"Total picks liquidados hoy: {len(df)}")

wins = df[df['result'] == 'win']
losses = df[df['result'] == 'loss']

print(f"Aciertos: {len(wins)} | Fallos: {len(losses)} | Win Rate: {len(wins)/len(df)*100:.1f}%")
print(f"Unidades Apostadas: {df['stake'].sum():.2f}u")

def calc_profit(r):
    return r['stake'] * (r['odd_decimal'] - 1) if r['result'] == 'win' else -r['stake']

df['profit'] = df.apply(calc_profit, axis=1)
print(f"Ganancia Neta Hoy: {df['profit'].sum():+.2f}u | ROI: {df['profit'].sum()/df['stake'].sum()*100:+.1f}%\n")

print("--- PICKS FALLIDOS DE HOY ---")
for idx, r in losses.iterrows():
    print(f"ID {r['id']:4d} | {r['event']} | {r['market']} -> {r['selection']} @ {r['odd_decimal']:.2f}")
    print(f"       Conf: {r['conf']*100:.1f}% | Stake: {r['stake']:.1f}u | Final: {r['final_score']} | Perdido Min: {r['loss_minute']}")

print("\n=== PATRONES Y FACTORES COMUNES EN FALLOS ===")

# 1. Por Rango de Momios
print("\n1. RENDIMIENTO POR RANGO DE MOMIOS:")
df['odd_bin'] = pd.cut(df['odd_decimal'], bins=[1.0, 1.35, 1.50, 1.70, 2.00, 3.50])
odd_grp = df.groupby('odd_bin', observed=False).agg(
    n=('id', 'count'),
    wins=('result', lambda x: (x == 'win').sum()),
    losses=('result', lambda x: (x == 'loss').sum()),
    staked=('stake', 'sum'),
    profit=('profit', 'sum')
)
odd_grp['wr%'] = (odd_grp['wins'] / odd_grp['n'] * 100).round(1)
odd_grp['roi%'] = (odd_grp['profit'] / odd_grp['staked'] * 100).round(1)
print(odd_grp[['n', 'wins', 'losses', 'wr%', 'staked', 'profit', 'roi%']])

# 2. Por Tipo de Mercado
print("\n2. RENDIMIENTO POR MERCADO:")
mkt_grp = df.groupby('market').agg(
    n=('id', 'count'),
    wins=('result', lambda x: (x == 'win').sum()),
    losses=('result', lambda x: (x == 'loss').sum()),
    staked=('stake', 'sum'),
    profit=('profit', 'sum')
)
mkt_grp['wr%'] = (mkt_grp['wins'] / mkt_grp['n'] * 100).round(1)
mkt_grp['roi%'] = (mkt_grp['profit'] / mkt_grp['staked'] * 100).round(1)
print(mkt_grp[['n', 'wins', 'losses', 'wr%', 'staked', 'profit', 'roi%']])

# 3. Analizar loss_minute en los fallos
print("\n3. DISTRIBUCIÓN DEL MINUTO DE PÉRDIDA:")
loss_mins = losses['loss_minute'].dropna()
print(f"Minuto promedio de pérdida: {loss_mins.mean():.1f}' | Mediana: {loss_mins.median():.1f}'")
print(f"Pérdidas en el 2º Tiempo (>= 45'): {len(loss_mins[loss_mins >= 45])}/{len(loss_mins)} ({len(loss_mins[loss_mins >= 45])/len(loss_mins)*100:.1f}%)")
print(f"Pérdidas en los últimos 15 min (>= 75'): {len(loss_mins[loss_mins >= 75])}/{len(loss_mins)} ({len(loss_mins[loss_mins >= 75])/len(loss_mins)*100:.1f}%)")

# 4. Por Stake Asignado
print("\n4. RENDIMIENTO POR TAMAÑO DE STAKE:")
stake_grp = df.groupby('stake').agg(
    n=('id', 'count'),
    wins=('result', lambda x: (x == 'win').sum()),
    losses=('result', lambda x: (x == 'loss').sum()),
    profit=('profit', 'sum')
)
stake_grp['wr%'] = (stake_grp['wins'] / stake_grp['n'] * 100).round(1)
print(stake_grp[['n', 'wins', 'losses', 'wr%', 'profit']])
