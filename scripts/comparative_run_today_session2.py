import sqlite3
import pandas as pd
import numpy as np
import os
import sys

# Forzar salida utf-8 en Windows terminal
sys.stdout.reconfigure(encoding='utf-8')

db_path = os.path.join(os.path.dirname(__file__), '..', 'snapshots.db')
conn = sqlite3.connect(db_path)

# 10:02 AM CDMX (UTC-6) = 16:02:00 UTC
df = pd.read_sql_query("""
    SELECT id, ts, event_id, event, sport, market, selection, odd_decimal, conf, result, final_score, stake, loss_minute, edge
    FROM picks
    WHERE ts >= '2026-08-04T16:02:00.000Z' AND result IN ('win', 'loss')
    ORDER BY ts ASC
""", conn)
conn.close()

def calc_profit(r):
    return r['stake'] * (r['odd_decimal'] - 1) if r['result'] == 'win' else -r['stake']

df['profit'] = df.apply(calc_profit, axis=1)

print("==========================================================================")
print("     CORRIDA COMPARATIVA: SEGUNDA PARTE DE HOY (POST 10:02 AM CDMX)       ")
print("==========================================================================")
print(f"Total Picks Emitidos en la 2ª Parte: {len(df)}")
print(f"Aciertos Base: {len(df[df['result']=='win'])} | Fallos Base: {len(df[df['result']=='loss'])}")
print(f"Total Apostado Base: {df['stake'].sum():.2f}u")
base_staked = df['stake'].sum()
base_profit = df['profit'].sum()
base_roi = (base_profit / base_staked * 100) if base_staked > 0 else 0
print(f"Ganancia Neta Base: {base_profit:+.2f}u | ROI Base: {base_roi:+.2f}%\n")

# Identificar picks descartados por los dos nuevos ajustes

def is_weak_dnb(r):
    m = str(r['market']).lower()
    if 'empate no accion' in m or 'draw no bet' in m or 'dnb' in m:
        c = r['conf']
        e = r['edge'] if (r['edge'] is not None and not np.isnan(r['edge'])) else (r['conf'] * r['odd_decimal'] - 1)
        if c < 0.75 or e < 0.05:
            return True
    return False

def is_weak_late_under(r):
    m = str(r['market']).lower()
    sel = str(r['selection']).lower()
    if 'total' in m or 'menos de' in sel:
        e = r['edge'] if (r['edge'] is not None and not np.isnan(r['edge'])) else (r['conf'] * r['odd_decimal'] - 1)
        if e < 0.04:
            return True
    return False

df['reject_dnb'] = df.apply(is_weak_dnb, axis=1)
df['reject_under'] = df.apply(is_weak_late_under, axis=1)
df['rejected'] = df['reject_dnb'] | df['reject_under']

rejected_df = df[df['rejected']]
kept_df = df[~df['rejected']]

print("--- DETALLE DE PICKS DE LA 2ª PARTE QUE NO SE HUBIERAN ELEGIDO ---")
for idx, r in rejected_df.iterrows():
    reason = "DNB Débil (conf < 75% o edge < 5%)" if r['reject_dnb'] else "Under Tardío con Edge < 4%"
    icon = "[WIN]" if r['result'] == 'win' else "[LOSS]"
    print(f"{icon} Pick ID {r['id']:4d} | {r['event']} | {r['market']} -> {r['selection']} @ {r['odd_decimal']:.2f}")
    print(f"       Conf: {r['conf']*100:.1f}% | Edge: {(r['edge'] or 0)*100:.1f}% | Stake: {r['stake']:.1f}u | Result: {r['result']} ({r['profit']:+.2f}u)")
    print(f"       Razón de exclusión: {reason}\n")

print("==========================================================================")
print("               RESUMEN COMPARATIVO 2ª PARTE (SESIÓN NUEVA)                 ")
print("==========================================================================")
print(f"Picks Descartados en 2ª Parte: {len(rejected_df)} (Aciertos: {len(rejected_df[rejected_df['result']=='win'])}, Fallos: {len(rejected_df[rejected_df['result']=='loss'])})")
if len(rejected_df) > 0:
    print(f"Impacto Financiero de Descartados: Evitó {rejected_df['profit'].sum():+.2f}u de distorsión")
print("--------------------------------------------------------------------------")
print(f"PICKS ELEGIDOS TRAS AJUSTES (2ª PARTE): {len(kept_df)} picks")
print(f"Aciertos: {len(kept_df[kept_df['result']=='win'])} | Fallos: {len(kept_df[kept_df['result']=='loss'])}")
opt_wr = (len(kept_df[kept_df['result']=='win']) / len(kept_df) * 100) if len(kept_df) > 0 else 0
base_wr = (len(df[df['result']=='win']) / len(df) * 100) if len(df) > 0 else 0
print(f"Tasa de Acierto: {opt_wr:.1f}% (vs {base_wr:.1f}% Base)")
opt_staked = kept_df['stake'].sum()
opt_profit = kept_df['profit'].sum()
opt_roi = (opt_profit / opt_staked * 100) if opt_staked > 0 else 0
print(f"Total Apostado: {opt_staked:.2f}u (reducido prudente de {base_staked:.2f}u)")
print(f"Ganancia Neta Final: {opt_profit:+.2f}u")
print(f"ROI FINAL OPTIMIZADO (2ª PARTE): {opt_roi:+.2f}% (vs {base_roi:+.2f}% Base)")
print("==========================================================================")
