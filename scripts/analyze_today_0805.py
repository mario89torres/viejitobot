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
    WHERE ts >= '2026-08-05T00:00:00.000Z'
    ORDER BY ts ASC
""", conn)
conn.close()

df['ts_dt'] = pd.to_datetime(df['ts'], utc=True)
df['local_date'] = df['ts_dt'].dt.tz_convert('America/Mexico_City').dt.strftime('%Y-%m-%d')

print(f"=== ANÁLISIS DE PICKS DE HOY (05-AGO-2026) ===")
print(f"Total picks registrados hoy en BD: {len(df)}")

df_settled = df[df['result'].isin(['win', 'loss'])].copy()
print(f"Picks liquidados hoy: {len(df_settled)}")

def calc_profit(r):
    return r['stake'] * (r['odd_decimal'] - 1) if r['result'] == 'win' else -r['stake']

if len(df_settled) > 0:
    df_settled['profit'] = df_settled.apply(calc_profit, axis=1)
    wins = df_settled[df_settled['result'] == 'win']
    losses = df_settled[df_settled['result'] == 'loss']
    staked = df_settled['stake'].sum()
    profit = df_settled['profit'].sum()
    roi = (profit / staked * 100) if staked > 0 else 0
    print(f"Aciertos: {len(wins)} | Fallos: {len(losses)} | Acierto: {len(wins)/len(df_settled)*100:.1f}%")
    print(f"Apostado: {staked:.2f}u | Ganancia Neta: {profit:+.2f}u | ROI: {roi:+.2f}%\n")

print("--- ANÁLISIS ESPECÍFICO DE LÍNEAS >= 4.5 O TOTALES ALTOS HOY ---")

def extract_line(row):
    m = str(row['market'])
    s = str(row['selection'])
    # Buscar número con decimal o entero en market o selection
    match = re.search(r'(\d+\.?\d*)', m + ' ' + s)
    if match:
        try:
            val = float(match.group(1))
            if val >= 4.0: return val
        except:
            pass
    return None

import re
df['line_val'] = df.apply(extract_line, axis=1)

high_lines = df[df['line_val'] >= 4.5].copy()

print(f"Picks con Línea >= 4.5 encontrados hoy: {len(high_lines)}")
for idx, r in high_lines.iterrows():
    icon = "✅" if r['result'] == 'win' else ("❌" if r['result'] == 'loss' else "⏳")
    loss_str = f" | Perdido min {r['loss_minute']}'" if r['result'] == 'loss' and r['loss_minute'] else ""
    print(f"{icon} ID {r['id']:4d} | {r['ts'][11:16]} | {r['event']} ({r['sport']})")
    print(f"   Mercado: {r['market']} -> {r['selection']} (Línea {r['line_val']}) @ {r['odd_decimal']:.2f}")
    print(f"   Conf: {r['conf']*100:.1f}% | Stake: {r['stake'] or 1.0:.1f}u | Resultado: {r['result'] or 'pendiente'} ({r['final_score'] or '—'}){loss_str}\n")
