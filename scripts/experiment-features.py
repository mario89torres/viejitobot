#!/usr/bin/env python3
"""¿Mejora el modelo si se le dan features de MERCADO y LÍNEA?

LA HIPÓTESIS. El modelo entrena con f_prob_justa, f_avance, f_situacion,
f_linea, f_apertura + dummies de deporte. NO tiene ninguna feature que codifique
QUÉ mercado es ni en qué línea — y eso es justo lo único que hemos demostrado
que discrimina de verdad:

  Under línea <= 2.5   ROI +11.6%  IC [+3.5%, +19.7%]
  Under línea <= 3.5   ROI  +9.8%  IC [+3.1%, +16.4%]
  Under línea  > 3.5   ROI  +0.7%  IC [-9.0%, +10.5%]   <- cruza cero
  Over                 ROI -22.2%  IC [-39.9%, -4.6%]
  (ver memoria edge-concentrado-en-under)

Ese edge está IMPLEMENTADO a mano en el firewall (R1, R7) y en el
dimensionamiento (STAKE_MODE=tiered), pero el modelo de confianza es ciego a
él. Si se lo damos como feature, ¿aprende algo que hoy no puede?

MÉTRICA QUE DECIDE: Brier/log loss y mayoría de folds sobre picks EMITIDOS. El
agregado se reporta solo como contraste — es la cifra que ya engañó una vez
(2026-08-16, ver memoria entrenamiento-con-grupo-control).

CONTROL NEGATIVO: una variante que añade una feature de RUIDO puro (aleatoria,
semilla fija). Si "mejora" como las demás, el test no distingue señal de
capacidad extra del modelo y el resultado no vale.

Uso: python scripts/experiment-features.py [dataset_con_regla.csv]
"""
import os
import re
import sys
import unicodedata
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")

import warnings
warnings.filterwarnings("ignore")

import numpy as np
import pandas as pd
from sklearn.calibration import CalibratedClassifierCV
from sklearn.linear_model import LogisticRegressionCV
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler
from sklearn.metrics import brier_score_loss, log_loss

ROOT = Path(__file__).resolve().parent.parent
HEUR_FEATURES = ["f_prob_justa", "f_avance", "f_situacion", "f_linea"]
HEUR_WEIGHTS = np.array([0.4375, 0.375, 0.0, 0.1875])  # = HEURISTIC_WEIGHTS de src/model.js
BASE_FEATURES = HEUR_FEATURES + ["f_apertura"]
SPORT_MIN = 50
ISOTONIC_MIN = int(os.environ.get("ISOTONIC_MIN", 2000))
CLIP = (0.001, 0.999)
CS_GRID = np.logspace(-3, 2, 12)


def clipped(p):
    return np.clip(p, CLIP[0], CLIP[1])


def metrics(y, p):
    return brier_score_loss(y, p), log_loss(y, clipped(p), labels=[0, 1])


def make_lr(cv=4):
    return make_pipeline(
        StandardScaler(),
        LogisticRegressionCV(Cs=CS_GRID, cv=cv, max_iter=5000, scoring="neg_log_loss"),
    )


def deacc(s):
    s = unicodedata.normalize("NFD", str(s or ""))
    return "".join(c for c in s if unicodedata.category(c) != "Mn").lower()


def derivar_mercado(df):
    """Mismas categorías que usa el resto del sistema (firewall, análisis)."""
    sel = df["selection"].map(deacc)
    mkt = df["market"].map(deacc)

    es_total = mkt.str.startswith("total")
    df["is_under"] = (es_total & sel.str.startswith("menos de")).astype(float)
    df["is_over"] = (es_total & sel.str.startswith("mas de")).astype(float)
    df["is_btts"] = mkt.str.contains("ambos equipos marcan").astype(float)
    df["is_ganador"] = mkt.str.contains("resultado final").astype(float)
    df["is_dnb"] = mkt.str.contains("empate no accion").astype(float)

    # Línea del total (0 cuando no aplica). Se acota a 6.5 para que un "Menos de
    # 10.5" no domine la escala; por encima de eso el edge ya se desvaneció.
    # Exige al menos un dígito: `[\d.]+` llegaba a capturar un punto suelto de
    # selecciones sin número (ej. nombres de equipo abreviados) y reventaba el
    # astype con "could not convert string to float: '.'".
    linea = pd.to_numeric(
        df["selection"].str.extract(r"(\d+(?:\.\d+)?)")[0], errors="coerce"
    )
    df["linea"] = np.where(es_total, linea.clip(upper=6.5).fillna(0.0), 0.0)
    # Indicador directo de la banda con edge demostrado (Under <= 3.5).
    df["under_baja"] = ((df["is_under"] == 1) & (df["linea"] <= 3.5)).astype(float)
    return df


def build_matrix(df, cols, sport_groups):
    X = df[cols].to_numpy(dtype=float)
    dummies = np.zeros((len(df), len(sport_groups)))
    for j, g in enumerate(sport_groups):
        dummies[:, j] = (df["sport_grp"] == g).to_numpy(dtype=float)
    return np.hstack([X, dummies])


def evaluar(df, cols, sport_groups, etiqueta):
    n = len(df)
    k_blocks = 5 if n >= 600 else 4
    edges = np.linspace(0, n, k_blocks + 1, dtype=int)

    pool = {"y": [], "heur": [], "cal": [], "is_pick": []}
    wins_all_b = wins_p_b = wins_p_l = 0
    n_folds = 0

    for i in range(1, k_blocks):
        tr = df.iloc[: edges[i]]
        te = df.iloc[edges[i] : edges[i + 1]]
        y_tr, y_te = tr["y"].to_numpy(int), te["y"].to_numpy(int)
        if len(np.unique(y_tr)) < 2 or len(np.unique(y_te)) < 2 or min(np.bincount(y_tr)) < 4:
            continue

        method = "isotonic" if len(tr) >= ISOTONIC_MIN else "sigmoid"
        X_tr = build_matrix(tr, cols, sport_groups)
        X_te = build_matrix(te, cols, sport_groups)
        min_class = int(min(np.bincount(y_tr, minlength=2)))
        cal = CalibratedClassifierCV(make_lr(), method=method, cv=max(2, min(5, min_class)))
        cal.fit(X_tr, y_tr)
        p_cal = cal.predict_proba(X_te)[:, 1]
        p_heur = te["heur"].to_numpy()

        n_folds += 1
        b_h, _ = metrics(y_te, p_heur)
        b_c, _ = metrics(y_te, p_cal)
        wins_all_b += b_c < b_h

        mask_p = (te["origin"] == "picks").to_numpy()
        if mask_p.sum() >= 20 and len(np.unique(y_te[mask_p])) == 2:
            pb_h, pl_h = metrics(y_te[mask_p], p_heur[mask_p])
            pb_c, pl_c = metrics(y_te[mask_p], p_cal[mask_p])
            wins_p_b += pb_c < pb_h
            wins_p_l += pl_c < pl_h

        pool["y"].append(y_te)
        pool["heur"].append(p_heur)
        pool["cal"].append(p_cal)
        pool["is_pick"].append(mask_p)

    Y = np.concatenate(pool["y"])
    H = np.concatenate(pool["heur"])
    C = np.concatenate(pool["cal"])
    P = np.concatenate(pool["is_pick"])

    ab_h, _ = metrics(Y, H)
    ab_c, _ = metrics(Y, C)
    pb_h, pl_h = metrics(Y[P], H[P])
    pb_c, pl_c = metrics(Y[P], C[P])

    return dict(etiqueta=etiqueta, n_folds=n_folds, n_cols=len(cols),
                agg_d_brier=ab_h - ab_c, agg_wins=wins_all_b,
                picks_n=int(P.sum()),
                picks_d_brier=pb_h - pb_c, picks_d_ll=pl_h - pl_c,
                picks_wins_b=wins_p_b, picks_wins_l=wins_p_l)


def main():
    csv = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "dataset_con_regla.csv"
    if not csv.exists():
        sys.exit(f"Falta {csv}. Genéralo con: node scripts/experiment-control-filter.js")

    df = pd.read_csv(csv).dropna(subset=BASE_FEATURES + ["y"])
    df = df[df["score_version"] == 2].sort_values("ts").reset_index(drop=True)
    df = derivar_mercado(df)

    counts = df["sport"].value_counts()
    keep = sorted(counts[counts >= SPORT_MIN].index.tolist())
    df["sport_grp"] = df["sport"].where(df["sport"].isin(keep), "otros")
    sport_groups = sorted(df["sport_grp"].unique().tolist())
    df["heur"] = df[HEUR_FEATURES].to_numpy(dtype=float) @ HEUR_WEIGHTS

    rng = np.random.default_rng(42)
    df["ruido"] = rng.standard_normal(len(df))

    n_picks = int((df["origin"] == "picks").sum())
    print(f"Dataset v2: {len(df)} filas ({n_picks} picks + {len(df) - n_picks} rechazados)")
    print(f"Under: {int(df['is_under'].sum())} | Over: {int(df['is_over'].sum())} | "
          f"BTTS: {int(df['is_btts'].sum())} | Ganador: {int(df['is_ganador'].sum())} | "
          f"DNB: {int(df['is_dnb'].sum())}")
    print(f"Under con línea <= 3.5: {int(df['under_baja'].sum())}\n")

    MERCADO = ["is_under", "is_over", "is_btts", "is_ganador", "is_dnb"]

    VARIANTES = [
        ("base (las 5 de hoy)",            BASE_FEATURES),
        ("+ tipo de mercado",              BASE_FEATURES + MERCADO),
        ("+ línea del total",              BASE_FEATURES + ["linea"]),
        ("+ mercado + línea",              BASE_FEATURES + MERCADO + ["linea"]),
        ("+ under_baja (la banda con edge)", BASE_FEATURES + ["under_baja"]),
        ("+ todo (mercado+línea+banda)",   BASE_FEATURES + MERCADO + ["linea", "under_baja"]),
        ("CONTROL: + ruido aleatorio",     BASE_FEATURES + ["ruido"]),
    ]

    print(f"{'variante':<36}{'AGREGADO':>16}{'SOLO PICKS (decide)':>32}")
    print(f"{'':<36}{'d_Brier':>9}{'folds':>7}{'d_Brier':>12}{'d_logloss':>11}{'folds':>9}")
    print("-" * 84)

    for etiqueta, cols in VARIANTES:
        r = evaluar(df, cols, sport_groups, etiqueta)
        pasa = (r["picks_d_brier"] > 0 and r["picks_d_ll"] > 0
                and r["picks_wins_b"] > r["n_folds"] / 2
                and r["picks_wins_l"] > r["n_folds"] / 2)
        print(f"{r['etiqueta']:<36}"
              f"{r['agg_d_brier']:>+9.4f}{str(r['agg_wins']) + '/' + str(r['n_folds']):>7}"
              f"{r['picks_d_brier']:>+12.4f}{r['picks_d_ll']:>+11.4f}"
              f"{str(r['picks_wins_b']) + '/' + str(r['n_folds']):>9}"
              f"{'  *' if pasa else ''}")

    print(f"\nN picks en el pool OOS: {evaluar(df, BASE_FEATURES, sport_groups, '')['picks_n']}")
    print("* = pasaría la regla de adopción (mejora en ambas métricas Y mayoría de folds,")
    print("    todo sobre picks emitidos).")
    print("\nEl CONTROL con ruido debería NO mejorar. Si mejora como las demás, lo que se")
    print("está midiendo es capacidad extra del modelo, no información nueva.")


if __name__ == "__main__":
    main()
