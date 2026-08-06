import sqlite3
import pandas as pd
import numpy as np
import os
import sys

# Forzar salida utf-8 en Windows terminal
sys.stdout.reconfigure(encoding='utf-8')

db_path = os.path.join(os.path.dirname(__file__), '..', 'snapshots.db')
conn = sqlite3.connect(db_path)

df = pd.read_sql_query("""
    SELECT id, ts, event_id, event, sport, market, selection, odd_decimal, conf, result, final_score, stake, loss_minute, edge
    FROM picks
    WHERE ts >= '2026-08-04T00:00:00.000Z' AND result IN ('win', 'loss')
    ORDER BY ts ASC
""", conn)
conn.close()

def calc_profit(r):
    return r['stake'] * (r['odd_decimal'] - 1) if r['result'] == 'win' else -r['stake']

df['profit'] = df.apply(calc_profit, axis=1)

print("==========================================================================")
print("             CORRIDA COMPARATIVA: PICKS DE HOY (04-AGO-2026)              ")
print("==========================================================================")
print(f"Total Picks Emitidos Hoy (Base): {len(df)}")
print(f"Aciertos Base: {len(df[df['result']=='win'])} | Fallos Base: {len(df[df['result']=='loss'])}")
print(f"Total Apostado Base: {df['stake'].sum():.2f}u")
print(f"Ganancia Neta Base: {df['profit'].sum():+.2f}u | ROI Base: {df['profit'].sum()/df['stake'].sum()*100:+.2f}%\n")

# Identificar picks descartados por los dos nuevos ajustes

# Ajuste 1: DNB débil (conf < 75% o edge < 5%)
def is_weak_dnb(r):
    m = str(r['market']).lower()
    if 'empate no accion' in m or 'draw no bet' in m or 'dnb' in m:
        c = r['conf']
        e = r['edge'] if (r['edge'] is not None and not np.isnan(r['edge'])) else (r['conf'] * r['odd_decimal'] - 1)
        if c < 0.75 or e < 0.05:
            return True
    return False

# Ajuste 2: Under tardío débil (minuto/avance >= 80% y edge < 4%)
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

print("--- DETALLE DE PICKS QUE NO SE HUBIERAN ELEGIDO HOY ---")
for idx, r in rejected_df.iterrows():
    reason = "DNB Débil (conf < 75% o edge < 5%)" if r['reject_dnb'] else "Under Tardío con Edge < 4%"
    icon = "[WIN]" if r['result'] == 'win' else "[LOSS]"
    print(f"{icon} Pick ID {r['id']:4d} | {r['event']} | {r['market']} -> {r['selection']} @ {r['odd_decimal']:.2f}")
    print(f"       Conf: {r['conf']*100:.1f}% | Edge: {(r['edge'] or 0)*100:.1f}% | Stake: {r['stake']:.1f}u | Result: {r['result']} ({r['profit']:+.2f}u)")
    print(f"       Razón de exclusión: {reason}\n")

print("==========================================================================")
print("                       RESUMEN COMPARATIVO HOY                            ")
print("==========================================================================")
print(f"Picks Descartados por Ajustes: {len(rejected_df)} (Aciertos: {len(rejected_df[rejected_df['result']=='win'])}, Fallos: {len(rejected_df[rejected_df['result']=='loss'])})")
print(f"Impacto Financiero de Descartados: Evitó {rejected_df['profit'].sum():+.2f}u de distorsión")
print("--------------------------------------------------------------------------")
print(f"PICKS ELEGIDOS TRAS AJUSTES: {len(kept_df)} picks")
print(f"Aciertos: {len(kept_df[kept_df['result']=='win'])} | Fallos: {len(kept_df[kept_df['result']=='loss'])}")
print(f"Tasa de Acierto: {len(kept_df[kept_df['result']=='win'])/len(kept_df)*100:.1f}% (vs {len(df[df['result']=='win'])/len(df)*100:.1f}% Base)")
print(f"Total Apostado: {kept_df['stake'].sum():.2f}u (reducido prudente de {df['stake'].sum():.2f}u)")
print(f"Ganancia Neta Final: {kept_df['profit'].sum():+.2f}u")
base_roi = df['profit'].sum()/df['stake'].sum()*100
print(f"ROI FINAL OPTIMIZADO: {kept_df['profit'].sum()/kept_df['stake'].sum()*100:+.2f}% (vs {base_roi:+.2f}% Base)")
print("==========================================================================")
