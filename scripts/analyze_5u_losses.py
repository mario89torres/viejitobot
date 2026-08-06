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
    WHERE ts >= '2026-08-05T00:00:00.000Z' AND result IN ('win', 'loss')
    ORDER BY ts ASC
""", conn)
conn.close()

def calc_profit_orig(r):
    return r['stake'] * (r['odd_decimal'] - 1) if r['result'] == 'win' else -r['stake']

def calc_profit_capped(r):
    # Cap de stake según momio:
    # odd < 1.50: max 5.0u
    # 1.50 <= odd < 1.70: max 3.5u
    # odd >= 1.70: max 2.5u
    orig_stake = r['stake']
    odd = r['odd_decimal']
    if odd >= 1.70:
        capped_stake = min(orig_stake, 2.5)
    elif odd >= 1.50:
        capped_stake = min(orig_stake, 3.5)
    else:
        capped_stake = min(orig_stake, 5.0)
        
    return capped_stake * (r['odd_decimal'] - 1) if r['result'] == 'win' else -capped_stake, capped_stake

df['profit_orig'] = df.apply(calc_profit_orig, axis=1)

res = df.apply(calc_profit_capped, axis=1)
df['profit_capped'] = [x[0] for x in res]
df['stake_capped'] = [x[1] for x in res]

print("==========================================================================")
print("       ANÁLISIS DE PICKS DE 5.0u Y SIMULACIÓN DE DYNAMIC STAKE CAP        ")
print("==========================================================================")

five_u_picks = df[df['stake'] >= 4.9].copy()
print(f"Picks emitidos hoy con 5.0u: {len(five_u_picks)}")
wins_5u = len(five_u_picks[five_u_picks['result'] == 'win'])
loss_5u = len(five_u_picks[five_u_picks['result'] == 'loss'])
print(f"Aciertos en 5.0u: {wins_5u} | Fallos en 5.0u: {loss_5u} | Win Rate: {wins_5u/len(five_u_picks)*100:.1f}%")
print(f"Ganancia Orig 5.0u: {five_u_picks['profit_orig'].sum():+.2f}u\n")

print("--- DETALLE DE PICKS DE 5.0u QUE SE PERDIERON HOY ---")
for idx, r in five_u_picks[five_u_picks['result'] == 'loss'].iterrows():
    print(f"❌ ID {r['id']:4d} | {r['event']} ({r['sport']})")
    print(f"   Mercado: {r['market']} -> {r['selection']} @ {r['odd_decimal']:.2f} | Conf: {r['conf']*100:.1f}%")
    print(f"   Stake Orig: 5.0u (-5.00u) ➔ Stake Capped: {r['stake_capped']:.1f}u (-{r['stake_capped']:.2f}u)\n")

print("==========================================================================")
print("               COMPARATIVA GLOBAL HOY CON STAKE CAP DINÁMICO               ")
print("==========================================================================")
print(f"Original: Staked {df['stake'].sum():.2f}u | Net Profit {df['profit_orig'].sum():+.2f}u | ROI {df['profit_orig'].sum()/df['stake'].sum()*100:+.2f}%")
print(f"Con Stake Cap: Staked {df['stake_capped'].sum():.2f}u | Net Profit {df['profit_capped'].sum():+.2f}u | ROI {df['profit_capped'].sum()/df['stake_capped'].sum()*100:+.2f}%")
print(f"Diferencia Ganancia: {df['profit_capped'].sum() - df['profit_orig'].sum():+.2f}u")
print("==========================================================================")
