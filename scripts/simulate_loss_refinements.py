import sqlite3
import pandas as pd
import numpy as np
import os

db_path = os.path.join(os.path.dirname(__file__), '..', 'snapshots.db')
conn = sqlite3.connect(db_path)

df = pd.read_sql_query("""
    SELECT id, ts, event_id, event, sport, market, selection, odd_decimal, conf, result, final_score, stake, loss_minute
    FROM picks
    WHERE ts >= '2026-08-04T00:00:00.000Z' AND result IN ('win', 'loss')
""", conn)
conn.close()

def calc_profit(r):
    return r['stake'] * (r['odd_decimal'] - 1) if r['result'] == 'win' else -r['stake']

df['profit'] = df.apply(calc_profit, axis=1)

base_staked = df['stake'].sum()
base_profit = df['profit'].sum()
base_roi = base_profit / base_staked * 100

print(f"BASELINE HOY: {len(df)} picks | Staked: {base_staked:.2f}u | Net Profit: {base_profit:+.2f}u | ROI: {base_roi:+.2f}%\n")

# Regla 1: Exigir Edge >= 5.0% y Conf >= 75% en Empate No Acción (DNB)
dnb_low = df[(df['market'] == 'Empate No Accion') & ((df['conf'] < 0.75) | ((df['conf'] * df['odd_decimal'] - 1) < 0.05))]

df_r1 = df.drop(dnb_low.index)
r1_staked = df_r1['stake'].sum()
r1_profit = df_r1['profit'].sum()
r1_roi = r1_profit / r1_staked * 100

print(f"AJUSTE 1 (Filtro DNB Exigente - conf >= 75%, edge >= 5%):")
print(f"   Picks eliminados: {len(dnb_low)} | Evitó pérdidas: {dnb_low['profit'].sum():+.2f}u")
print(f"   Resultado: {len(df_r1)} picks | Staked: {r1_staked:.2f}u | Net Profit: {r1_profit:+.2f}u | ROI: {r1_roi:+.2f}%\n")

# Regla 2: Exigir Edge >= 4.0% en Menos de X emitidos en min >= 70'
under_late_low = df[df['market'].str.contains('Total', na=False) & df['selection'].str.contains('Menos de', na=False) & ((df['conf'] * df['odd_decimal'] - 1) < 0.04)]

df_r2 = df_r1.drop(under_late_low.index, errors='ignore')
r2_staked = df_r2['stake'].sum()
r2_profit = df_r2['profit'].sum()
r2_roi = r2_profit / r2_staked * 100

print(f"AJUSTE 2 (Piso Edge +4% en Totales 'Menos de' tardíos):")
print(f"   Picks eliminados adicionales: {len(under_late_low)} | Evitó pérdidas: {under_late_low['profit'].sum():+.2f}u")
print(f"   Resultado Final Simulado: {len(df_r2)} picks | Staked: {r2_staked:.2f}u | Net Profit: {r2_profit:+.2f}u | ROI: {r2_roi:+.2f}%")
