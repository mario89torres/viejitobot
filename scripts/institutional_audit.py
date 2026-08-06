import sqlite3
import pandas as pd
import numpy as np
import os
import sys

sys.stdout.reconfigure(encoding='utf-8')

db_path = os.path.join(os.path.dirname(__file__), '..', 'snapshots.db')
conn = sqlite3.connect(db_path)

df = pd.read_sql_query("""
    SELECT id, ts, event_id, event, sport, market, selection, odd_decimal, conf, result, final_score, stake, loss_minute, edge
    FROM picks
    WHERE stake IS NOT NULL AND result IN ('win', 'loss')
    ORDER BY ts ASC
""", conn)
conn.close()

def calc_profit(r):
    return r['stake'] * (r['odd_decimal'] - 1) if r['result'] == 'win' else -r['stake']

df['profit'] = df.apply(calc_profit, axis=1)

print("==========================================================================")
print("             CHEQUEO PROFUNDO Y AUDITORÍA DE GRADO INSTITUCIONAL          ")
print("==========================================================================")
print(f"Total picks liquidados en histórico BD: {len(df)}")
print(f"Ganancia Neta Global Acumulada: {df['profit'].sum():+.2f}u | ROI Global: {df['profit'].sum()/df['stake'].sum()*100:+.2f}%\n")

# 1. AUDITORÍA POR DEPORTE
print("--- 1. DESGLOSE POR DEPORTE ---")
sp_grp = df.groupby('sport').agg(
    n=('id', 'count'),
    wins=('result', lambda x: (x == 'win').sum()),
    staked=('stake', 'sum'),
    profit=('profit', 'sum')
).reset_index()
sp_grp['wr%'] = (sp_grp['wins'] / sp_grp['n'] * 100).round(1)
sp_grp['roi%'] = (sp_grp['profit'] / sp_grp['staked'] * 100).round(1)
print(sp_grp[['sport', 'n', 'wins', 'wr%', 'staked', 'profit', 'roi%']])

# 2. AUDITORÍA POR TIPO DE MERCADO
print("\n--- 2. DESGLOSE POR MERCADO ---")
mkt_grp = df.groupby('market').agg(
    n=('id', 'count'),
    wins=('result', lambda x: (x == 'win').sum()),
    staked=('stake', 'sum'),
    profit=('profit', 'sum')
).reset_index()
mkt_grp['wr%'] = (mkt_grp['wins'] / mkt_grp['n'] * 100).round(1)
mkt_grp['roi%'] = (mkt_grp['profit'] / mkt_grp['staked'] * 100).round(1)
print(mkt_grp[['market', 'n', 'wins', 'wr%', 'staked', 'profit', 'roi%']])

# 3. AUDITORÍA POR RANGO DE MOMIO
print("\n--- 3. DESGLOSE POR RANGO DE MOMIO ---")
df['odd_bin'] = pd.cut(df['odd_decimal'], bins=[1.0, 1.25, 1.35, 1.50, 1.70, 2.00, 4.00])
odd_grp = df.groupby('odd_bin', observed=False).agg(
    n=('id', 'count'),
    wins=('result', lambda x: (x == 'win').sum()),
    staked=('stake', 'sum'),
    profit=('profit', 'sum')
).reset_index()
odd_grp['wr%'] = (odd_grp['wins'] / odd_grp['n'] * 100).round(1)
odd_grp['roi%'] = (odd_grp['profit'] / odd_grp['staked'] * 100).round(1)
print(odd_grp[['odd_bin', 'n', 'wins', 'wr%', 'staked', 'profit', 'roi%']])

# 4. AUDITORÍA POR SELECCIÓN ESPECÍFICA (Over/Under/BTTS/DNB)
print("\n--- 4. DESGLOSE POR TIPO DE SELECCIÓN (OVER/UNDER/DNB/1X2) ---")
def sel_category(r):
    sel = str(r['selection']).lower()
    mkt = str(r['market']).lower()
    if 'mas de' in sel or 'over' in sel: return 'Over (Más de)'
    if 'menos de' in sel or 'under' in sel: return 'Under (Menos de)'
    if 'empate no accion' in mkt or 'draw no bet' in mkt: return 'Empate No Acción'
    if 'doble oportunidad' in mkt: return 'Doble Oportunidad'
    if 'ambos' in mkt: return 'Ambos Marcan'
    return '1X2 / Ganador Directo'

df['cat'] = df.apply(sel_category, axis=1)
cat_grp = df.groupby('cat').agg(
    n=('id', 'count'),
    wins=('result', lambda x: (x == 'win').sum()),
    staked=('stake', 'sum'),
    profit=('profit', 'sum')
).reset_index()
cat_grp['wr%'] = (cat_grp['wins'] / cat_grp['n'] * 100).round(1)
cat_grp['roi%'] = (cat_grp['profit'] / cat_grp['staked'] * 100).round(1)
print(cat_grp[['cat', 'n', 'wins', 'wr%', 'staked', 'profit', 'roi%']])
