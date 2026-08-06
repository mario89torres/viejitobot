import sqlite3
import pandas as pd
import numpy as np

conn = sqlite3.connect('snapshots.db')

df = pd.read_sql_query("""
    SELECT id, ts, event, sport, market, selection, odd_decimal, conf, edge, stake, result
    FROM picks
    WHERE result IN ('win', 'loss') AND stake IS NOT NULL AND edge IS NOT NULL
""", conn)
conn.close()

df['win'] = (df['result'] == 'win').astype(int)
df['profit'] = np.where(df['win'] == 1, df['stake'] * (df['odd_decimal'] - 1), -df['stake'])

# Baseline Actual
base_n = len(df)
base_staked = df['stake'].sum()
base_profit = df['profit'].sum()
base_roi = 100 * base_profit / base_staked if base_staked > 0 else 0
base_wr = 100 * df['win'].mean()

print("========================================================================")
print("                   BASELINE ACTUAL EN PRODUCCIÓN                        ")
print("========================================================================")
print(f"Picks: {base_n} | Apostado: {base_staked:.1f}u | Ganancia: +{base_profit:.2f}u | WR: {base_wr:.1f}% | ROI: +{base_roi:.2f}%")
print("========================================================================\n")

# Escenario 1: Filtrar momios extremadamente bajos (< 1.35)
f1 = df[df['odd_decimal'] >= 1.35]
s1_staked = f1['stake'].sum()
s1_profit = f1['profit'].sum()
s1_roi = 100 * s1_profit / s1_staked
s1_wr = 100 * f1['win'].mean()

print("--- Escenario 1: Piso de Momio >= 1.35 (Elimina cuotas muy bajas con ROI mediocre) ---")
print(f"Picks: {len(f1)} (retendidos {len(f1)/base_n:.1%}) | Apostado: {s1_staked:.1f}u | Ganancia: +{s1_profit:.2f}u | WR: {s1_wr:.1f}% | ROI: +{s1_roi:.2f}% (Diferencia: {s1_roi - base_roi:+.2f}%)")

# Escenario 2: Piso de Edge mínimo (MIN_EDGE >= 0.03 o +3%)
f2 = df[df['edge'] >= 0.03]
s2_staked = f2['stake'].sum()
s2_profit = f2['profit'].sum()
s2_roi = 100 * s2_profit / s2_staked
s2_wr = 100 * f2['win'].mean()

print("\n--- Escenario 2: Piso de Edge >= +3% (Filtra jugadas con ventaja marginal) ---")
print(f"Picks: {len(f2)} (retendidos {len(f2)/base_n:.1%}) | Apostado: {s2_staked:.1f}u | Ganancia: +{s2_profit:.2f}u | WR: {s2_wr:.1f}% | ROI: +{s2_roi:.2f}% (Diferencia: {s2_roi - base_roi:+.2f}%)")

# Escenario 3: Combinado (Momio >= 1.35 AND Edge >= +3%)
f3 = df[(df['odd_decimal'] >= 1.35) & (df['edge'] >= 0.03)]
s3_staked = f3['stake'].sum()
s3_profit = f3['profit'].sum()
s3_roi = 100 * s3_profit / s3_staked
s3_wr = 100 * f3['win'].mean()

print("\n--- Escenario 3: Combinado (Momio >= 1.35 Y Edge >= +3%) ---")
print(f"Picks: {len(f3)} (retendidos {len(f3)/base_n:.1%}) | Apostado: {s3_staked:.1f}u | Ganancia: +{s3_profit:.2f}u | WR: {s3_wr:.1f}% | ROI: +{s3_roi:.2f}% (Diferencia: {s3_roi - base_roi:+.2f}%)")

# Escenario 4: Combinado + Filtro de Momio Máximo (1.35 <= Momio <= 2.10)
f4 = df[(df['odd_decimal'] >= 1.35) & (df['odd_decimal'] <= 2.10) & (df['edge'] >= 0.03)]
s4_staked = f4['stake'].sum()
s4_profit = f4['profit'].sum()
s4_roi = 100 * s4_profit / s4_staked
s4_wr = 100 * f4['win'].mean()

print("\n--- Escenario 4: Zona Óptima (1.35 <= Momio <= 2.10 Y Edge >= +3%) ---")
print(f"Picks: {len(f4)} (retendidos {len(f4)/base_n:.1%}) | Apostado: {s4_staked:.1f}u | Ganancia: +{s4_profit:.2f}u | WR: {s4_wr:.1f}% | ROI: +{s4_roi:.2f}% (Diferencia: {s4_roi - base_roi:+.2f}%)")
