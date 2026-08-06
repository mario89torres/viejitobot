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

# De la hora UTC restar 6 horas para fecha local
df['ts_dt'] = pd.to_datetime(df['ts'], utc=True)
df['local_date'] = df['ts_dt'].dt.tz_convert('America/Mexico_City').dt.strftime('%Y-%m-%d')

def calc_profit(r):
    return r['stake'] * (r['odd_decimal'] - 1) if r['result'] == 'win' else -r['stake']

df['profit'] = df.apply(calc_profit, axis=1)

# Agrupar por día local
daily = df.groupby('local_date').agg(
    n=('id', 'count'),
    wins=('result', lambda x: (x == 'win').sum()),
    losses=('result', lambda x: (x == 'loss').sum()),
    staked=('stake', 'sum'),
    profit=('profit', 'sum')
).reset_index()

daily['wr%'] = (daily['wins'] / daily['n'] * 100).round(1)
daily['roi%'] = (daily['profit'] / daily['staked'] * 100).round(1)
daily['acumulado'] = daily['profit'].cumsum().round(2)

print("==========================================================================")
print("                   EVOLUCIÓN HISTÓRICA DÍA POR DÍA                        ")
print("==========================================================================")
for idx, r in daily.iterrows():
    print(f"Fecha: {r['local_date']} | Picks: {r['n']:3d} | Acierto: {r['wins']:2d}/{r['n']:2d} ({r['wr%']:5.1f}%) | Staked: {r['staked']:6.2f}u | Net Profit: {r['profit']:+6.2f}u | ROI: {r['roi%']:+6.1f}% | Banca Acum: {r['acumulado']:+6.2f}u")
print("==========================================================================")

# Desglose de Hoy en 2 Sesiones (antes y después de 10:02 AM CDMX)
df_today = df[df['local_date'] == '2026-08-04']
cutoff_ts = '2026-08-04T16:02:00.000Z'

s1 = df_today[df_today['ts'] < cutoff_ts]
s2 = df_today[df_today['ts'] >= cutoff_ts]

def print_sub(name, subdf):
    st = subdf['stake'].sum()
    pr = subdf['profit'].sum()
    w = (subdf['result'] == 'win').sum()
    n = len(subdf)
    wr = (w/n*100) if n > 0 else 0
    roi = (pr/st*100) if st > 0 else 0
    print(f"  {name}: {n} picks | Acierto: {w}/{n} ({wr:.1f}%) | Staked: {st:.2f}u | Profit: {pr:+.2f}u | ROI: {roi:+.1f}%")

print("\n--- DESGLOSE DEL DÍA 04-AGO (HOY) EN 2 SESIONES ---")
print_sub("Sesión 1 (Pre-Ajustes - antes 10:02 AM)", s1)
print_sub("Sesión 2 (Post-Ajustes - desde 10:02 AM)", s2)
