#!/usr/bin/env python3
"""¿Mejora el modelo si se excluyen ciertos tipos de rechazo del entrenamiento?

CONTEXTO. El 2026-08-16 el primer entrenamiento con grupo de control pasó la
regla de adopción vieja (+0.0070 Brier, 4/4 folds) pero era un falso positivo:
sobre los picks EMITIDOS —la población que recibe dinero— daba -0.0027 y ganaba
1/4 folds. La regla se corrigió para exigir mejora sobre origin='picks'.

Quedó una hipótesis sin probar: el grupo de control no es homogéneo.
`guardas5` (suspensión/inestabilidad del feed) y `mercado_bloqueado` tienen
WR ~2x el de `min_conf` y tasa de 0-0 ~2.5x. No se rechazan por SEÑAL sino por
condiciones del proveedor, así que como negativos podrían estar enseñando una
frontera que no existe.

Este script mide esa hipótesis con la métrica que decide: Brier/log loss y
mayoría de folds SOBRE PICKS EMITIDOS. El agregado se reporta solo como
contraste — es justo la cifra que engañó la primera vez.

METODOLOGÍA. Replica el pipeline de train_weights.py (mismo walk-forward por
bloques temporales, mismo StandardScaler + LogisticRegressionCV con
Cs=logspace(-3,2,12), misma calibración isotonic/sigmoid según ISOTONIC_MIN).
El FILTRO se aplica solo al conjunto de ENTRENAMIENTO: el bloque de test se
deja intacto para que todas las variantes se evalúen contra exactamente la
misma población y sean comparables entre sí.

CAVEAT: la hipótesis salió de mirar estos datos, así que cualquier mejora está
inflada por selección. Lo que se busca aquí no es un número para adoptar sino
una señal de dirección — y el control negativo sirve para saber si el test
distingue señal de ruido.

Uso: python scripts/experiment-control-filter.py [dataset_con_regla.csv]
"""
import os
import sys
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
FEATURES = HEUR_FEATURES + ["f_apertura"]
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


def build_matrix(df, sport_groups):
    X = df[FEATURES].to_numpy(dtype=float)
    dummies = np.zeros((len(df), len(sport_groups)))
    for j, g in enumerate(sport_groups):
        dummies[:, j] = (df["sport_grp"] == g).to_numpy(dtype=float)
    return np.hstack([X, dummies])


def evaluar(df, sport_groups, filtro_train, etiqueta):
    """Walk-forward con `filtro_train` aplicado SOLO a las filas de entrenamiento."""
    n = len(df)
    k_blocks = 5 if n >= 600 else 4
    edges = np.linspace(0, n, k_blocks + 1, dtype=int)

    pool = {"y": [], "heur": [], "cal": [], "is_pick": []}
    wins_all_b = wins_all_l = wins_p_b = wins_p_l = 0
    n_folds = 0

    for i in range(1, k_blocks):
        tr_full = df.iloc[: edges[i]]
        te = df.iloc[edges[i] : edges[i + 1]]
        tr = tr_full[filtro_train(tr_full)]

        y_tr, y_te = tr["y"].to_numpy(int), te["y"].to_numpy(int)
        if len(np.unique(y_tr)) < 2 or len(np.unique(y_te)) < 2 or min(np.bincount(y_tr)) < 4:
            continue

        method = "isotonic" if len(tr) >= ISOTONIC_MIN else "sigmoid"
        X_tr, X_te = build_matrix(tr, sport_groups), build_matrix(te, sport_groups)
        min_class = int(min(np.bincount(y_tr, minlength=2)))
        cal = CalibratedClassifierCV(make_lr(), method=method, cv=max(2, min(5, min_class)))
        cal.fit(X_tr, y_tr)
        p_cal = cal.predict_proba(X_te)[:, 1]
        p_heur = te["heur"].to_numpy()

        n_folds += 1
        b_h, l_h = metrics(y_te, p_heur)
        b_c, l_c = metrics(y_te, p_cal)
        wins_all_b += b_c < b_h
        wins_all_l += l_c < l_h

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

    ab_h, al_h = metrics(Y, H)
    ab_c, al_c = metrics(Y, C)
    pb_h, pl_h = metrics(Y[P], H[P])
    pb_c, pl_c = metrics(Y[P], C[P])

    return dict(
        etiqueta=etiqueta, n_folds=n_folds,
        agg_d_brier=ab_h - ab_c, agg_d_ll=al_h - al_c,
        agg_wins=f"{wins_all_b}/{n_folds}",
        picks_n=int(P.sum()),
        picks_d_brier=pb_h - pb_c, picks_d_ll=pl_h - pl_c,
        picks_wins_b=wins_p_b, picks_wins_l=wins_p_l,
    )


def main():
    csv = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "dataset_con_regla.csv"
    if not csv.exists():
        sys.exit(f"Falta {csv}. Genéralo con: node scripts/experiment-control-filter.js")

    df = pd.read_csv(csv).dropna(subset=FEATURES + ["y"])
    df["reject_rule"] = df["reject_rule"].fillna("")
    df = df[df["score_version"] == 2].sort_values("ts").reset_index(drop=True)

    counts = df["sport"].value_counts()
    keep = sorted(counts[counts >= SPORT_MIN].index.tolist())
    df["sport_grp"] = df["sport"].where(df["sport"].isin(keep), "otros")
    sport_groups = sorted(df["sport_grp"].unique().tolist())
    df["heur"] = df[HEUR_FEATURES].to_numpy(dtype=float) @ HEUR_WEIGHTS

    n_picks = int((df["origin"] == "picks").sum())
    print(f"Dataset v2: {len(df)} filas ({n_picks} picks + {len(df) - n_picks} rechazados)")
    print("El FILTRO se aplica solo al TRAIN; el test se deja intacto en todas las")
    print("variantes para que sean comparables entre sí.\n")

    ruidosos = {"guardas5", "mercado_bloqueado"}

    VARIANTES = [
        ("completo (lo que se entrenó hoy)", lambda d: pd.Series(True, index=d.index)),
        ("sin guardas5 + mercado_bloqueado", lambda d: ~d["reject_rule"].isin(ruidosos)),
        ("sin guardas5",                     lambda d: d["reject_rule"] != "guardas5"),
        ("sin mercado_bloqueado",            lambda d: d["reject_rule"] != "mercado_bloqueado"),
        ("solo min_conf como negativo",      lambda d: (d["origin"] == "picks") | (d["reject_rule"] == "min_conf")),
        ("SIN grupo de control (solo picks)", lambda d: d["origin"] == "picks"),
        # Control negativo: quitar una porción ALEATORIA del mismo tamaño que
        # guardas5+mercado_bloqueado. Si esto "mejora" tanto como el filtro con
        # criterio, es que el test no distingue señal de ruido de muestreo.
        ("CONTROL: quitar 9% al azar",       None),
    ]

    print(f"{'variante':<36}{'AGREGADO':>22}{'SOLO PICKS (decide)':>30}")
    print(f"{'':<36}{'d_Brier':>10}{'folds':>12}{'d_Brier':>12}{'d_logloss':>11}{'folds':>7}")
    print("-" * 88)

    rng = np.random.default_rng(42)
    for etiqueta, filtro in VARIANTES:
        if filtro is None:
            idx_rej = df.index[df["origin"] == "rejected"]
            n_quitar = int((df["reject_rule"].isin(ruidosos)).sum())
            quitar = set(rng.choice(idx_rej, size=n_quitar, replace=False).tolist())
            filtro = lambda d, q=quitar: ~d.index.isin(q)

        r = evaluar(df, sport_groups, filtro, etiqueta)
        marca = " *" if (r["picks_d_brier"] > 0 and r["picks_d_ll"] > 0
                         and r["picks_wins_b"] > r["n_folds"] / 2
                         and r["picks_wins_l"] > r["n_folds"] / 2) else ""
        print(f"{r['etiqueta']:<36}"
              f"{r['agg_d_brier']:>+10.4f}{r['agg_wins']:>12}"
              f"{r['picks_d_brier']:>+12.4f}{r['picks_d_ll']:>+11.4f}"
              f"{str(r['picks_wins_b']) + '/' + str(r['n_folds']):>7}{marca}")

    print("\n* = pasaría la regla de adopción corregida (mejora en ambas métricas")
    print("    Y mayoría de folds, todo sobre picks emitidos).")
    print("\nEl CONTROL debería NO mejorar: quita el mismo volumen sin criterio.")
    print("Si mejora tanto como los filtros con criterio, el efecto es de tamaño")
    print("de muestra, no de calidad de los negativos.")


if __name__ == "__main__":
    main()
