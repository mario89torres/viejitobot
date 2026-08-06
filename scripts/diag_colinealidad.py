#!/usr/bin/env python3
"""Diagnóstico de colinealidad entre features y comparación de parametrizaciones.

No escribe model.json: solo mide. Responde tres preguntas:

  1. ¿Están f_linea y f_apertura realmente colineales? (correlación + VIF)
  2. ¿La regularización L2 está distorsionando el reparto de peso entre ellas?
     Test: la reparametrización (f_apertura, f_mov = f_linea − f_apertura) es un
     cambio de base invertible. SIN penalización las predicciones deben ser
     idénticas y los coeficientes deben cumplir exactamente:
         β_mov       = β_linea
         β_apertura' = β_linea + β_apertura
     Si no se cumple, el L2 está encogiendo una dirección mal identificada.
  3. ¿Qué parametrización predice mejor out-of-sample, bajo el mismo
     walk-forward temporal del entrenador?
         A = actual (f_linea, f_apertura)
         B = reparam (f_mov, f_apertura)
         C = sin f_apertura (solo f_linea)

Uso: python scripts/diag_colinealidad.py [dataset.csv] [--version N]
"""
import sys
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression, LogisticRegressionCV
from sklearn.metrics import brier_score_loss, log_loss
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
BASE = ["f_prob_justa", "f_avance", "f_situacion"]
HEUR_W = np.array([0.45, 0.20, 0.20, 0.15])
CLIP = (0.001, 0.999)


def metrics(y, p):
    p = np.clip(p, *CLIP)
    return brier_score_loss(y, p), log_loss(y, p, labels=[0, 1])


def vif(X, names):
    """Variance Inflation Factor: 1/(1-R²) de regresar cada columna contra el resto."""
    out = {}
    for j, nm in enumerate(names):
        others = np.delete(X, j, axis=1)
        A = np.hstack([np.ones((len(X), 1)), others])
        coef, *_ = np.linalg.lstsq(A, X[:, j], rcond=None)
        resid = X[:, j] - A @ coef
        ss_res = float(resid @ resid)
        ss_tot = float(((X[:, j] - X[:, j].mean()) ** 2).sum())
        r2 = 1 - ss_res / ss_tot if ss_tot > 0 else 0.0
        out[nm] = float("inf") if r2 >= 1 else 1 / (1 - r2)
    return out


def folds(n, k=4):
    edges = np.linspace(0, n, k + 1, dtype=int)
    return [(slice(0, edges[i]), slice(edges[i], edges[i + 1])) for i in range(1, k)]


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    csv = Path(args[0]) if args else ROOT / "dataset.csv"
    ver = None
    for i, a in enumerate(sys.argv):
        if a == "--version" and i + 1 < len(sys.argv):
            ver = int(sys.argv[i + 1])

    df = pd.read_csv(csv)
    if "score_version" in df.columns:
        df["score_version"] = df["score_version"].fillna(1).astype(int)
        if ver is None:
            counts = df["score_version"].value_counts()
            ver = int(max(v for v, c in counts.items() if c >= 80))
        df = df[df["score_version"] == ver]
    df = df.dropna(subset=BASE + ["f_linea", "f_apertura", "y"]).sort_values("ts").reset_index(drop=True)
    n = len(df)
    print(f"Dataset: {csv.name} | versión v{ver} | n={n}\n")

    y = df["y"].to_numpy(int)
    F = BASE + ["f_linea", "f_apertura"]

    # ---------- 1. colinealidad ----------
    print("=" * 66)
    print("1. COLINEALIDAD")
    print("=" * 66)
    corr = df[F].corr()
    print("\nMatriz de correlación:")
    print("                " + "".join(f"{c[2:10]:>10}" for c in F))
    for a in F:
        print(f"  {a[2:14]:<14}" + "".join(f"{corr.loc[a, b]:>10.3f}" for b in F))

    r_la = corr.loc["f_linea", "f_apertura"]
    Xa = df[F].to_numpy(float)
    v = vif(Xa, F)
    print("\nVIF (>10 = colinealidad problemática):")
    for k_, val in v.items():
        flag = "  <-- PROBLEMA" if val > 10 else ("  <-- alto" if val > 5 else "")
        print(f"  {k_:<16}{val:>8.2f}{flag}")
    cond = np.linalg.cond(np.hstack([np.ones((n, 1)), Xa]))
    print(f"\nCorrelación f_linea<->f_apertura: r = {r_la:.4f}")
    print(f"Número de condición (métrica global, se diluye): {cond:.1f}")

    # ---------- 2. test del cambio de base ----------
    print("\n" + "=" * 66)
    print("2. TEST DEL CAMBIO DE BASE (¿el L2 está distorsionando?)")
    print("=" * 66)
    df["f_mov"] = df["f_linea"] - df["f_apertura"]
    Xa = df[BASE + ["f_linea", "f_apertura"]].to_numpy(float)
    Xb = df[BASE + ["f_mov", "f_apertura"]].to_numpy(float)

    for label, kw in [("CON L2 (C=1.0, el default actual)", dict(C=1.0)),
                      ("SIN penalización (penalty=None)", dict(penalty=None))]:
        ma = LogisticRegression(max_iter=5000, **kw).fit(Xa, y)
        mb = LogisticRegression(max_iter=5000, **kw).fit(Xb, y)
        b_lin, b_ap = ma.coef_[0][3], ma.coef_[0][4]
        pred_mov, pred_ap = b_lin, b_lin + b_ap
        got_mov, got_ap = mb.coef_[0][3], mb.coef_[0][4]
        dp = float(np.abs(ma.predict_proba(Xa)[:, 1] - mb.predict_proba(Xb)[:, 1]).max())
        print(f"\n  {label}")
        print(f"    β_linea={b_lin:+.4f}  β_apertura={b_ap:+.4f}")
        print(f"    β_mov       esperado {pred_mov:+.4f}   obtenido {got_mov:+.4f}   Δ={abs(got_mov-pred_mov):.4f}")
        print(f"    β_apertura' esperado {pred_ap:+.4f}   obtenido {got_ap:+.4f}   Δ={abs(got_ap-pred_ap):.4f}")
        print(f"    máx |Δ predicción| entre A y B: {dp:.2e}")
        ok = abs(got_mov - pred_mov) < 1e-3 and abs(got_ap - pred_ap) < 1e-3
        print(f"    => {'coeficientes se transforman por álgebra pura (sin distorsión)' if ok else 'NO coincide: la penalización mueve el reparto'}")

    # ---------- 3. comparación de parametrizaciones ----------
    print("\n" + "=" * 66)
    print("3. WALK-FORWARD: ¿cuál predice mejor fuera de muestra?")
    print("=" * 66)
    heur = df[["f_prob_justa", "f_avance", "f_situacion", "f_linea"]].to_numpy(float) @ HEUR_W

    variants = {
        "A actual (linea+apertura)": BASE + ["f_linea", "f_apertura"],
        "B reparam (mov+apertura)":  BASE + ["f_mov", "f_apertura"],
        "C sin apertura":            BASE + ["f_linea"],
    }
    setups = {
        "crudo C=1.0 (actual)": lambda: LogisticRegression(max_iter=5000),
        "escalado C=1.0":       lambda: make_pipeline(StandardScaler(), LogisticRegression(max_iter=5000)),
        "escalado + C por CV":  lambda: make_pipeline(
            StandardScaler(),
            LogisticRegressionCV(Cs=np.logspace(-3, 2, 12), cv=4, max_iter=5000, scoring="neg_log_loss")),
    }

    fl = folds(n)
    pooled_h = np.concatenate([heur[te] for _, te in fl])
    y_pool = np.concatenate([y[te] for _, te in fl])
    bh, lh = metrics(y_pool, pooled_h)
    print(f"\n  {'configuración':<26}{'parametrización':<28}{'Brier':>9}{'LogLoss':>10}")
    print("  " + "-" * 71)
    print(f"  {'heurístico (referencia)':<26}{'—':<28}{bh:>9.4f}{lh:>10.4f}")

    best = None
    for sname, mk in setups.items():
        for vname, cols in variants.items():
            X = df[cols].to_numpy(float)
            preds = []
            for tr, te in fl:
                m = mk().fit(X[tr], y[tr])
                preds.append(m.predict_proba(X[te])[:, 1])
            b, l = metrics(y_pool, np.concatenate(preds))
            mark = ""
            if best is None or b < best[0]:
                best = (b, l, sname, vname); mark = ""
            print(f"  {sname:<26}{vname:<28}{b:>9.4f}{l:>10.4f}{mark}")
        print()

    print(f"  MEJOR: {best[2]} + {best[3]}  (Brier {best[0]:.4f}, LogLoss {best[1]:.4f})")
    print(f"  vs heurístico: Brier {bh - best[0]:+.4f}  LogLoss {lh - best[1]:+.4f}")

    # C elegido por CV
    print("\n  Valores de C elegidos por CV (por fold, variante B):")
    Xb2 = df[BASE + ["f_mov", "f_apertura"]].to_numpy(float)
    cs = []
    for tr, _ in fl:
        p = make_pipeline(StandardScaler(),
                          LogisticRegressionCV(Cs=np.logspace(-3, 2, 12), cv=4, max_iter=5000,
                                               scoring="neg_log_loss")).fit(Xb2[tr], y[tr])
        cs.append(float(p[-1].C_[0]))
    print("    " + ", ".join(f"{c:.4g}" for c in cs) + f"   (default actual: 1.0)")


if __name__ == "__main__":
    main()
