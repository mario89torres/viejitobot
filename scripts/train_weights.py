#!/usr/bin/env python3
"""Entrena pesos aprendidos para el índice de confianza de Playdoit Monitor.

Pipeline:
  1. Lee dataset.csv (generado por scripts/export-dataset.js), ordena por ts.
  2. Walk-forward temporal (>=3 folds): entrena en el pasado, valida en el
     bloque siguiente. Nunca split aleatorio (fuga temporal).
  3. LogisticRegression sobre los 4 factores + dummy por deporte (>=50 picks;
     el resto se agrupa en 'otros').
  4. Calibración con CalibratedClassifierCV: isotonic si el train del fold
     tiene >=300 muestras, si no sigmoid (Platt). La calibración se cross-fitea
     dentro del train; la evaluación es siempre sobre el bloque de validación.
  5. Reporta Brier/log loss por fold y agregado para: (a) heurístico actual,
     (b) logística sin calibrar, (c) logística calibrada.
  6. Regla de adopción y export a model.json (adoptado) o model_candidate.json.

Versiones de features (score_version): v1 tenía f_linea saturada en 1.0 para el
82% de los picks (feature muerta); v2 la reescala sin saturación. Como no son
comparables, por defecto se entrena SOLO con la versión más reciente que tenga
muestras suficientes. Con SCORE_VERSION=all se usan todas añadiendo la versión
como dummy (útil solo cuando el bloque nuevo aún es pequeño).

Uso: python scripts/train_weights.py [ruta/dataset.csv]
     SCORE_VERSION=all python scripts/train_weights.py   # mezcla con dummy
     SCORE_VERSION=1   python scripts/train_weights.py   # fuerza una versión
"""
import json
import os
import sys

# consolas Windows con cp1252 no soportan β/flechas; fuerza utf-8 tolerante
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.calibration import CalibratedClassifierCV
from sklearn.isotonic import IsotonicRegression
from sklearn.linear_model import LogisticRegression, LogisticRegressionCV
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler
from sklearn.metrics import brier_score_loss, log_loss
from sklearn.model_selection import cross_val_predict

ROOT = Path(__file__).resolve().parent.parent
# El heurístico de referencia usa sus 4 factores con pesos fijos; el modelo
# aprende además con f_apertura (drift desde la primera observación en vivo).
HEUR_FEATURES = ["f_prob_justa", "f_avance", "f_situacion", "f_linea"]
HEUR_WEIGHTS = np.array([0.35, 0.30, 0.20, 0.15])
FEATURES = HEUR_FEATURES + ["f_apertura"]
MIN_SAMPLES = 80          # mínimo absoluto para intentar entrenar
SPORT_MIN = 50            # picks mínimos para dummy propia de deporte
ISOTONIC_MIN = 300        # train >= 300 -> isotonic; si no, sigmoid (Platt)
RETENTION_MIN = 0.60      # retención mínima de la mejora in-sample
CAL_TABLE_POINTS = 200
CLIP = (0.001, 0.999)

ADOPTION_RULE = (
    "REGLA DE ADOPCIÓN: adoptar el modelo solo si mejora Brier Y log loss\n"
    "out-of-sample frente al heurístico, Y gana en la mayoría de los folds.\n"
    "La retención de la mejora in-sample se reporta como señal, no como veto.\n"
    "Si no cumple, mantener el heurístico."
)


def clipped(p):
    return np.clip(p, CLIP[0], CLIP[1])


def metrics(y, p):
    return brier_score_loss(y, p), log_loss(y, clipped(p), labels=[0, 1])


def build_matrix(df, sport_groups, ver_dummies=()):
    """features + one-hot de deporte (+ one-hot de score_version si se mezclan)."""
    X = df[FEATURES].to_numpy(dtype=float)
    dummies = np.zeros((len(df), len(sport_groups)))
    for j, g in enumerate(sport_groups):
        dummies[:, j] = (df["sport_grp"] == g).to_numpy(dtype=float)
    blocks = [X, dummies]
    if ver_dummies:
        vd = np.zeros((len(df), len(ver_dummies)))
        for j, v in enumerate(ver_dummies):
            vd[:, j] = (df["score_version"] == v).to_numpy(dtype=float)
        blocks.append(vd)
    return np.hstack(blocks)


# Estimador base: estandariza y elige la fuerza de regularización por CV interna.
#
# Por qué no basta con LogisticRegression() a secas (diagnóstico 2026-07-28,
# scripts/diag_colinealidad.py sobre n=374):
#   - El default de sklearn trae C=1.0 con L2 activo. Con este volumen el óptimo
#     por CV cae entre 0.001 y 0.19, es decir mucho más regularizado.
#   - Sin estandarizar, el L2 castiga más a las features de escala pequeña solo
#     por su escala, no por su utilidad. Escalar sin retunear C empeora
#     (Brier 0.1853 -> 0.1867); escalar Y retunear mejora (-> 0.1845).
# El escalador se ajusta dentro del pipeline, así que en cada fold usa solo los
# datos de entrenamiento: no hay fuga del bloque de validación.
CS_GRID = np.logspace(-3, 2, 12)


def make_lr(cv=4):
    return make_pipeline(
        StandardScaler(),
        LogisticRegressionCV(Cs=CS_GRID, cv=cv, max_iter=5000, scoring="neg_log_loss"),
    )


def unscale(pipe):
    """Devuelve (coef, intercepto) en el espacio ORIGINAL de las features.

    El pipeline aprende sobre datos estandarizados; Node aplica el modelo sobre
    features crudas. Deshacer la escala aquí evita tener que exportar el
    escalador y tocar src/model.js:
        z = Σ β_s·(x−μ)/σ + b_s = Σ (β_s/σ)·x + (b_s − Σ β_s·μ/σ)
    """
    sc, lr = pipe[0], pipe[-1]
    beta_s, b_s = lr.coef_[0], float(lr.intercept_[0])
    scale = np.where(sc.scale_ == 0, 1.0, sc.scale_)
    beta = beta_s / scale
    return beta, b_s - float(np.sum(beta_s * sc.mean_ / scale))


def fit_calibrated(X, y, method):
    base = make_lr()
    min_class = int(min(np.bincount(y, minlength=2)))
    cv = max(2, min(5, min_class))
    cal = CalibratedClassifierCV(base, method=method, cv=cv)
    cal.fit(X, y)
    raw = make_lr().fit(X, y)
    return raw, cal


def main():
    csv_path = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "dataset.csv"
    if not csv_path.exists():
        sys.exit(f"No existe {csv_path}. Genera el dataset con: node scripts/export-dataset.js")

    df = pd.read_csv(csv_path)
    df = df.dropna(subset=FEATURES + ["y"]).sort_values("ts").reset_index(drop=True)

    # --- selección de versión de features ---
    # v1 y v2 calculan f_linea de forma distinta: mezclarlas sin distinguir
    # equivale a entrenar sobre dos variables diferentes en la misma columna.
    if "score_version" not in df.columns:
        df["score_version"] = 1
    df["score_version"] = df["score_version"].fillna(1).astype(int)
    counts_ver = df["score_version"].value_counts().sort_index()
    print(f"Muestras por versión de features: " +
          ", ".join(f"v{v}={c}" for v, c in counts_ver.items()))

    want = os.environ.get("SCORE_VERSION", "").strip().lower()
    mix_versions = want == "all"
    if want.isdigit():
        chosen = int(want)
        df = df[df["score_version"] == chosen]
        print(f"Entrenando SOLO con v{chosen} (forzado por SCORE_VERSION).")
    elif mix_versions:
        print("Entrenando con TODAS las versiones, añadiendo score_version como dummy.")
    else:
        # por defecto: la versión más reciente que llegue al mínimo; si ninguna
        # llega, la que más muestras tenga (avisando de la limitación)
        eligible = [v for v, c in counts_ver.items() if c >= MIN_SAMPLES]
        chosen = max(eligible) if eligible else int(counts_ver.idxmax())
        if not eligible:
            print(f"⚠️ Ninguna versión alcanza {MIN_SAMPLES} muestras; se usa v{chosen} (la mayor).")
            print("   Alternativa: SCORE_VERSION=all para mezclar versiones con dummy.")
        df = df[df["score_version"] == chosen]
        print(f"Entrenando con v{chosen} ({len(df)} muestras). Las otras versiones se ignoran.")
    df = df.sort_values("ts").reset_index(drop=True)

    n = len(df)
    print(f"Dataset: {n} picks liquidados ({csv_path})")
    if n < MIN_SAMPLES:
        sys.exit(f"Muestras insuficientes ({n} < {MIN_SAMPLES}). Acumula más picks antes de entrenar.")
    y_all = df["y"].to_numpy(dtype=int)
    if len(np.unique(y_all)) < 2:
        sys.exit("El dataset solo tiene una clase (todo win o todo loss); no se puede entrenar.")

    # --- agrupación de deportes ---
    counts = df["sport"].value_counts()
    keep = sorted(counts[counts >= SPORT_MIN].index.tolist())
    df["sport_grp"] = df["sport"].where(df["sport"].isin(keep), "otros")
    sport_groups = sorted(df["sport_grp"].unique().tolist())
    # al mezclar versiones se añade one-hot (sin la primera, que hace de base)
    ver_dummies = tuple(sorted(df["score_version"].unique().tolist())[1:]) if mix_versions else ()
    if ver_dummies:
        print(f"Dummies de versión añadidas: {list(ver_dummies)}")
    print(f"Deportes con dummy propia (>= {SPORT_MIN} picks): {keep or ['(ninguno)']}")

    df["heur"] = df[HEUR_FEATURES].to_numpy(dtype=float) @ HEUR_WEIGHTS

    # --- walk-forward: K bloques temporales iguales -> K-1 folds ---
    k_blocks = 5 if n >= 600 else 4
    edges = np.linspace(0, n, k_blocks + 1, dtype=int)
    folds, skipped = [], 0
    pooled = {m: {"y": [], "heur": [], "raw": [], "cal": []} for m in ["test"]}
    is_rows = []  # in-sample por fold (para la retención)

    print(f"\nWalk-forward: {k_blocks} bloques -> {k_blocks - 1} folds (entrena pasado, valida bloque siguiente)")
    header = f"{'fold':<5}{'train':>6}{'test':>6}  {'metodo':<9}{'brier_h':>9}{'brier_raw':>10}{'brier_cal':>10}{'ll_h':>8}{'ll_raw':>8}{'ll_cal':>8}"
    print(header)
    print("-" * len(header))

    for i in range(1, k_blocks):
        tr = df.iloc[: edges[i]]
        te = df.iloc[edges[i] : edges[i + 1]]
        y_tr, y_te = tr["y"].to_numpy(int), te["y"].to_numpy(int)
        if len(np.unique(y_tr)) < 2 or len(np.unique(y_te)) < 2 or min(np.bincount(y_tr)) < 4:
            print(f"{i:<5}{len(tr):>6}{len(te):>6}  omitido (clases insuficientes)")
            skipped += 1
            continue

        method = "isotonic" if len(tr) >= ISOTONIC_MIN else "sigmoid"
        X_tr = build_matrix(tr, sport_groups, ver_dummies)
        X_te = build_matrix(te, sport_groups, ver_dummies)
        raw, cal = fit_calibrated(X_tr, y_tr, method)

        p_raw_te = raw.predict_proba(X_te)[:, 1]
        p_cal_te = cal.predict_proba(X_te)[:, 1]
        p_cal_tr = cal.predict_proba(X_tr)[:, 1]

        b_h, l_h = metrics(y_te, te["heur"].to_numpy())
        b_r, l_r = metrics(y_te, p_raw_te)
        b_c, l_c = metrics(y_te, p_cal_te)
        b_h_is, l_h_is = metrics(y_tr, tr["heur"].to_numpy())
        b_c_is, l_c_is = metrics(y_tr, p_cal_tr)

        folds.append(dict(fold=i, n_train=len(tr), n_test=len(te), method=method,
                          brier=(b_h, b_r, b_c), logloss=(l_h, l_r, l_c)))
        is_rows.append(dict(n=len(tr), d_brier=b_h_is - b_c_is, d_logloss=l_h_is - l_c_is))
        pooled["test"]["y"].append(y_te)
        pooled["test"]["heur"].append(te["heur"].to_numpy())
        pooled["test"]["raw"].append(p_raw_te)
        pooled["test"]["cal"].append(p_cal_te)

        print(f"{i:<5}{len(tr):>6}{len(te):>6}  {method:<9}{b_h:>9.4f}{b_r:>10.4f}{b_c:>10.4f}{l_h:>8.4f}{l_r:>8.4f}{l_c:>8.4f}")

    if len(folds) < 2:
        sys.exit(f"\nSolo {len(folds)} folds válidos ({skipped} omitidos): datos insuficientes para evaluar. Mantener heurístico.")

    # --- agregado out-of-sample (predicciones agrupadas de todos los folds) ---
    Y = np.concatenate(pooled["test"]["y"])
    P_h = np.concatenate(pooled["test"]["heur"])
    P_r = np.concatenate(pooled["test"]["raw"])
    P_c = np.concatenate(pooled["test"]["cal"])
    oos = {
        "heuristic": metrics(Y, P_h),
        "raw": metrics(Y, P_r),
        "calibrated": metrics(Y, P_c),
    }
    print("-" * len(header))
    print(f"{'AGREG':<5}{'':>6}{len(Y):>6}  {'':<9}{oos['heuristic'][0]:>9.4f}{oos['raw'][0]:>10.4f}"
          f"{oos['calibrated'][0]:>10.4f}{oos['heuristic'][1]:>8.4f}{oos['raw'][1]:>8.4f}{oos['calibrated'][1]:>8.4f}")

    # --- regla de adopción ---
    w = np.array([r["n"] for r in is_rows], dtype=float)
    is_d_brier = float(np.average([r["d_brier"] for r in is_rows], weights=w))
    is_d_logloss = float(np.average([r["d_logloss"] for r in is_rows], weights=w))
    oos_d_brier = oos["heuristic"][0] - oos["calibrated"][0]
    oos_d_logloss = oos["heuristic"][1] - oos["calibrated"][1]

    def retention(oos_d, is_d):
        if oos_d <= 0:
            return 0.0
        return float("inf") if is_d <= 0 else oos_d / is_d

    ret_b, ret_l = retention(oos_d_brier, is_d_brier), retention(oos_d_logloss, is_d_logloss)

    # Consistencia por fold: en cuántos bloques de validación gana el modelo.
    # Sustituye a la retención como salvaguarda dura — es evidencia directa de
    # que la ventaja no depende de un solo periodo afortunado.
    wins_b = sum(1 for f in folds if f["brier"][2] < f["brier"][0])
    wins_l = sum(1 for f in folds if f["logloss"][2] < f["logloss"][0])
    n_folds = len(folds)
    majority = wins_b > n_folds / 2 and wins_l > n_folds / 2

    adopted = oos_d_brier > 0 and oos_d_logloss > 0 and majority
    low_ret = ret_b < RETENTION_MIN or ret_l < RETENTION_MIN

    print(f"\n{ADOPTION_RULE}")
    print(f"\nMejora OOS:  Brier {oos_d_brier:+.4f} | log loss {oos_d_logloss:+.4f}   <- criterio principal")
    print(f"Consistencia: gana en {wins_b}/{n_folds} folds (Brier), {wins_l}/{n_folds} (log loss)   <- requiere mayoría")
    print(f"Mejora IS:   Brier {is_d_brier:+.4f} | log loss {is_d_logloss:+.4f}")
    print(f"Retención:   Brier {ret_b:.0%} | log loss {ret_l:.0%}   <- señal, no veto (referencia {RETENTION_MIN:.0%})")
    print(f"\n>>> DECISIÓN: {'ADOPTAR modelo aprendido' if adopted else 'MANTENER heurístico'}")
    if adopted and low_ret:
        print("⚠️ Retención baja: la ventaja in-sample crece más rápido que la out-of-sample.")
        print("   El modelo gana fuera de muestra, pero vigila que no se degrade al reentrenar.")

    # --- modelo final sobre todos los datos ---
    X_all = build_matrix(df, sport_groups, ver_dummies)
    final = make_lr().fit(X_all, y_all)

    # calibración final cross-fiteada (nunca calibrar y evaluar sobre lo mismo):
    # predicciones out-of-fold de la logística -> ajuste raw_prob -> prob_calibrada
    min_class = int(min(np.bincount(y_all)))
    cv = max(2, min(5, min_class))
    p_oof = cross_val_predict(make_lr(), X_all, y_all,
                              cv=cv, method="predict_proba")[:, 1]
    final_method = "isotonic" if n >= ISOTONIC_MIN else "sigmoid"
    grid = np.linspace(0.0, 1.0, CAL_TABLE_POINTS)
    if final_method == "isotonic":
        iso = IsotonicRegression(y_min=0.0, y_max=1.0, out_of_bounds="clip").fit(p_oof, y_all)
        cal_y = iso.predict(grid)
    else:
        logit = np.log(clipped(p_oof) / (1 - clipped(p_oof)))
        platt = LogisticRegression(max_iter=2000).fit(logit.reshape(-1, 1), y_all)
        grid_logit = np.log(clipped(grid) / (1 - clipped(grid)))
        cal_y = platt.predict_proba(grid_logit.reshape(-1, 1))[:, 1]
    cal_y = np.maximum.accumulate(np.clip(cal_y, 0.0, 1.0))  # fuerza monotonía

    nf, ns = len(FEATURES), len(sport_groups)
    beta_final, b_final = unscale(final)  # de vuelta al espacio crudo que usa Node
    coef = dict(zip(FEATURES, [float(c) for c in beta_final[:nf]]))
    sport_coef = dict(zip(sport_groups, [float(c) for c in beta_final[nf:nf + ns]]))

    abs_sum = sum(abs(v) for v in coef.values()) or 1.0
    print("\nCoeficientes β (log-odds) y peso normalizado equivalente:")
    print(f"  {'intercepto':<14}{b_final:>8.3f}")
    heur_w = dict(zip(HEUR_FEATURES, HEUR_WEIGHTS))
    for f in FEATURES:
        ref = f"(heurístico {heur_w[f]:.0%})" if f in heur_w else "(nueva: no está en el heurístico)"
        print(f"  {f:<14}{coef[f]:>8.3f}   peso {abs(coef[f]) / abs_sum:.0%}  {ref}")
    if sport_coef:
        print("  dummies deporte: " + ", ".join(f"{k}={v:+.3f}" for k, v in sport_coef.items()))

    model = {
        "trained_at": datetime.now(timezone.utc).isoformat(),
        "n_samples": n,
        # versión(es) de features con las que se entrenó: el modelo solo es
        # aplicable a picks calculados con esa misma versión
        "score_versions": sorted(int(v) for v in df["score_version"].unique()),
        "calibration_method": final_method,
        "adopted": adopted,
        "features": FEATURES,
        "intercept": float(b_final),
        "coef": coef,
        "sport_coef": sport_coef,
        "calibration": {"x": [round(float(v), 6) for v in grid],
                        "y": [round(float(v), 6) for v in cal_y]},
        "oos_metrics": {
            "n": int(len(Y)),
            "heuristic": {"brier": oos["heuristic"][0], "log_loss": oos["heuristic"][1]},
            "raw": {"brier": oos["raw"][0], "log_loss": oos["raw"][1]},
            "calibrated": {"brier": oos["calibrated"][0], "log_loss": oos["calibrated"][1]},
            "retention": {"brier": ret_b if ret_b != float("inf") else None,
                          "log_loss": ret_l if ret_l != float("inf") else None},
            "retention_low": bool(low_ret),
            "fold_wins": {"brier": int(wins_b), "log_loss": int(wins_l), "n_folds": int(n_folds)},
        },
    }
    out = ROOT / ("model.json" if adopted else "model_candidate.json")
    out.write_text(json.dumps(model, indent=1), encoding="utf-8")
    print(f"\nModelo exportado a {out.name}" + ("" if adopted else " (NO adoptado: no reemplaza a model.json)"))
    if adopted:
        print("Reinicia el bot para que src/model.js lo cargue. MODEL_MODE controla el despliegue (shadow -> learned).")


if __name__ == "__main__":
    main()
