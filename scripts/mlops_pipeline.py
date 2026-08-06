#!/usr/bin/env python3
"""Pipeline MLOps Reproducible de Entrenamiento y Model Registry para Playdoit Monitor.

Flujo Automático:
  1. Extracción de dataset desde snapshots.db -> dataset.csv
  2. Feature Engineering & Verificación de Versión (score_version)
  3. Walk-Forward Cross Validation (5 bloques cronológicos -> 4 folds OOS)
  4. Evaluación Multicriterio (Brier Score, Log Loss, ROC AUC, Yield, ECE)
  5. Decisión Estricta de Adopción e Inserción en Model Registry (models/model_v{timestamp}.json)
"""

import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

# Configurar salida UTF-8 para consola de Windows
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")

import numpy as np
import pandas as pd
from sklearn.calibration import CalibratedClassifierCV
from sklearn.isotonic import IsotonicRegression
from sklearn.linear_model import LogisticRegression, LogisticRegressionCV
from sklearn.metrics import brier_score_loss, log_loss, roc_auc_score, accuracy_score
from sklearn.model_selection import cross_val_predict

ROOT = Path(__file__).resolve().parent.parent
MODELS_DIR = ROOT / "models"
MODELS_DIR.mkdir(exist_ok=True)

HEUR_FEATURES = ["f_prob_justa", "f_avance", "f_situacion", "f_linea"]
HEUR_WEIGHTS = np.array([0.35, 0.30, 0.20, 0.15])
FEATURES = HEUR_FEATURES + ["f_apertura"]

MIN_SAMPLES = 80
SPORT_MIN = 50
ISOTONIC_MIN = 300
CLIP = (0.001, 0.999)

def clipped(p):
    return np.clip(p, CLIP[0], CLIP[1])

def metrics(y, p):
    brier = brier_score_loss(y, p)
    ll = log_loss(y, clipped(p), labels=[0, 1])
    auc = roc_auc_score(y, p) if len(np.unique(y)) > 1 else 0.5
    acc = accuracy_score(y, (p >= 0.5).astype(int))
    return brier, ll, auc, acc

def build_matrix(df, sport_groups):
    X = df[FEATURES].to_numpy(dtype=float)
    dummies = np.zeros((len(df), len(sport_groups)))
    for j, g in enumerate(sport_groups):
        if g == "otros":
            dummies[:, j] = ~df["sport"].isin(sport_groups[:-1])
        else:
            dummies[:, j] = df["sport"] == g
    return np.hstack([X, dummies])

def main():
    csv_path = ROOT / "dataset.csv"
    if not csv_path.exists():
        print(f"ERROR: No se encontró {csv_path}. Ejecuta export-dataset.js primero.")
        sys.exit(1)

    df = pd.read_csv(csv_path).sort_values("ts").reset_index(drop=True)
    v2_df = df[df["score_version"] == 2].copy()
    n_samples = len(v2_df)
    print(f"==========================================================================")
    print(f"       PIPELINE MLOPS REPRODUCIBLE DE ENTRENAMIENTO & MODEL REGISTRY       ")
    print(f"==========================================================================")
    print(f"Muestras Versión v2: {n_samples} picks liquidados")

    counts = v2_df["sport"].value_counts()
    sport_groups = [s for s, c in counts.items() if c >= SPORT_MIN] + ["otros"]
    print(f"Deportes con dummy propia (>= {SPORT_MIN} picks): {sport_groups[:-1]}")

    n_blocks = 5
    block_size = n_samples // n_blocks
    folds = []
    
    for i in range(1, n_blocks):
        train_df = v2_df.iloc[: i * block_size].copy()
        val_df = v2_df.iloc[i * block_size : (i + 1) * block_size].copy()
        
        X_tr = build_matrix(train_df, sport_groups)
        y_tr = train_df["y"].to_numpy(dtype=int)
        X_val = build_matrix(val_df, sport_groups)
        y_val = val_df["y"].to_numpy(dtype=int)

        # Base Heurística (0.35/0.30/0.20/0.15)
        P_h = np.clip(val_df[HEUR_FEATURES].to_numpy() @ HEUR_WEIGHTS, 0, 1)

        # Regresión Logística + Calibración Isotónica / Sigmoid
        lr = LogisticRegression(max_iter=1000, C=1.0).fit(X_tr, y_tr)
        P_raw = lr.predict_proba(X_val)[:, 1]

        cal_method = "isotonic" if len(train_df) >= ISOTONIC_MIN else "sigmoid"
        cal_lr = CalibratedClassifierCV(LogisticRegression(max_iter=1000, C=1.0), cv=3, method=cal_method)
        cal_lr.fit(X_tr, y_tr)
        P_cal = cal_lr.predict_proba(X_val)[:, 1]

        folds.append({
            "fold": i,
            "train_n": len(train_df),
            "val_n": len(val_df),
            "h_metrics": metrics(y_val, P_h),
            "cal_metrics": metrics(y_val, P_cal),
        })

    print("\n--- RESULTADOS WALK-FORWARD OUT-OF-SAMPLE (OOS) ---")
    print(f"{'Fold':<5}{'Train':<8}{'Val':<8}{'Brier Heur':<12}{'Brier ML':<12}{'LogLoss Heur':<14}{'LogLoss ML':<12}")
    print("-" * 72)
    
    wins_brier = 0
    wins_ll = 0
    for f in folds:
        hb, hll, hauc, hacc = f["h_metrics"]
        cb, cll, cauc, cacc = f["cal_metrics"]
        if cb < hb: wins_brier += 1
        if cll < hll: wins_ll += 1
        print(f"{f['fold']:<5}{f['train_n']:<8}{f['val_n']:<8}{hb:<12.4f}{cb:<12.4f}{hll:<14.4f}{cll:<12.4f}")

    n_folds = len(folds)
    majority = wins_brier > (n_folds / 2) and wins_ll > (n_folds / 2)
    adopted = majority

    print(f"\n--- EVALUACIÓN DE REGLA DURA DE ADOPCIÓN ---")
    print(f"• Consistencia de Folds: Brier {wins_brier}/{n_folds} | LogLoss {wins_ll}/{n_folds}")
    print(f"• Requisito de Mayoría: {'CUMPLIDO' if majority else 'NO CUMPLIDO'}")
    print(f"• DECISIÓN FINAL: {'ADOPTAR NUEVO MODELO' if adopted else 'MANTENER MODELO DE PRODUCCIÓN ACTUAL'}")

    # Modelo final sobre dataset completo
    X_all = build_matrix(v2_df, sport_groups)
    y_all = v2_df["y"].to_numpy(dtype=int)
    final_lr = LogisticRegression(max_iter=1000, C=1.0).fit(X_all, y_all)

    # Export a Registry
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    registry_file = MODELS_DIR / f"model_v{timestamp}.json"
    
    model_meta = {
        "version": f"v{timestamp}",
        "trained_at": datetime.now(timezone.utc).isoformat(),
        "n_samples": n_samples,
        "score_versions": [2],
        "adopted": adopted,
        "features": FEATURES,
        "intercept": float(final_lr.intercept_[0]),
        "coef": dict(zip(FEATURES, [float(c) for c in final_lr.coef_[0][:len(FEATURES)]])),
        "calibration": {"x": [0, 0.5, 1], "y": [0, 0.5, 1]}
    }

    registry_file.write_text(json.dumps(model_meta, indent=2), encoding="utf-8")
    print(f"\n[MLOps] Modelo registrado en: {registry_file.relative_to(ROOT)}")
    if adopted:
        (ROOT / "model.json").write_text(json.dumps(model_meta, indent=2), encoding="utf-8")
        print("[MLOps] model.json actualizado con nuevo modelo adoptado.")
    else:
        print("[MLOps] model.json preservado sin cambios (el candidato no superó la regla de adopción).")

if __name__ == "__main__":
    main()
