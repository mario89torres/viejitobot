"""Extender la cobertura de features de mercado: ¿gana su sitio cada una?

CONTEXTO. El primer contraste con datos frescos (2026-08-22) mostro que el
modelo con features de mercado EMPATABA donde tenia informacion (N=111,
-0.0001) y perdia fuerte donde NO la tenia (N=23, -0.0297). Esa bolsa sin flag
paso del 6.5% del entrenamiento al 15.1% de la ventana. Este experimento prueba
si cubrirla ayuda.

METODO, igual que el que valido las features de mercado:
  - walk-forward temporal (nunca particion aleatoria: seria fuga)
  - la metrica que DECIDE es sobre origin='picks', no el agregado: el 95% del
    pool son rechazados y el agregado mide sobre todo distinguir "rechazado
    tipico" de "pick tipico", que es trivial y no vale dinero
  - CONTROL DE RUIDO: una feature aleatoria. Si el ruido "mejora" tanto como las
    features reales, lo que se mide es capacidad extra del modelo, no
    informacion. Sin este control se concluiria que funciona.

Las features YA EN PRODUCCION (is_under, is_over, linea...) las escribe
scripts/export-dataset.js desde marketFeatures() de src/model.js, y Python no
las recalcula: una sola fuente hace imposible el train/serve skew.

Las CANDIDATAS de este experimento se derivan aqui abajo, en Python, y es
correcto porque son candidatas: este script mide, nunca sirve inferencia. La
regla de una sola fuente protege lo que produccion USA; implementar una
candidata en Node antes de saber si sirve es el orden inverso.

RESULTADO (2026-08-22, N_oos=549 picks): NINGUNA se gana el sitio.
Corrido dos veces — una con las columnas derivadas en Node y otra con las
derivadas aqui — y coincide. Los deltas sobre la base fueron:
   + handicap     +0.0000 / +0.0001
   + ganador_alt  +0.0003 / +0.0005
   + doble        -0.0014 / -0.0010
   + TODO         -0.0010 / -0.0011
   CONTROL ruido  -0.0004 / -0.0015   <- ojo a esto
El control de RUIDO se movio -0.0004 -> -0.0015 entre ejecuciones. O sea que la
inestabilidad de una feature ALEATORIA es MAYOR que el efecto de cualquier
candidata: estan por debajo del suelo de ruido del metodo. Detalle de la primera
corrida:
   actual (mercado base)   d_Brier +0.0023   3/4 folds
   + handicap              d_Brier +0.0023   3/4      delta +0.0000
   + ganador_alt           d_Brier +0.0026   3/4      delta +0.0003
   + doble                 d_Brier +0.0009   2/4      delta -0.0014
   + TODO                  d_Brier +0.0013   3/4      delta -0.0010
   CONTROL: ruido          d_Brier +0.0018   3/4      delta -0.0004
Los deltas de las candidatas son del tamano que mueve el RUIDO. Anadir todas
juntas empeora. La hipotesis de que cubrir la bolsa sin flag arreglaria el
fallo con datos frescos queda descartada.
"""
import sys, unicodedata, warnings
warnings.filterwarnings("ignore")
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
from pathlib import Path
import numpy as np, pandas as pd
from sklearn.calibration import CalibratedClassifierCV
from sklearn.linear_model import LogisticRegressionCV
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler
from sklearn.metrics import brier_score_loss, log_loss

ROOT = Path("C:/Users/Invitadow/playdoit-monitor")
HEUR = ["f_prob_justa", "f_avance", "f_situacion", "f_linea"]
HW = np.array([0.4375, 0.375, 0.0, 0.1875])
BASE = HEUR + ["f_apertura"]
MKT = ["is_under", "is_over", "is_btts", "is_ganador", "is_dnb", "linea"]
CLIP = (0.001, 0.999)

VARIANTES = [
    ("actual (mercado base)",      MKT),
    ("+ handicap",                 MKT + ["is_handicap", "hcp_line"]),
    ("+ ganador_alt",              MKT + ["is_ganador_alt"]),
    ("+ doble",                    MKT + ["is_doble"]),
    ("+ TODO",                     MKT + ["is_ganador_alt", "is_doble", "is_handicap", "hcp_line"]),
    ("CONTROL: + ruido",           MKT + ["_ruido"]),
]


def met(y, p):
    return brier_score_loss(y, p), log_loss(y, np.clip(p, *CLIP), labels=[0, 1])


def lr():
    return make_pipeline(
        StandardScaler(),
        LogisticRegressionCV(Cs=np.logspace(-3, 2, 12), cv=4, max_iter=5000,
                             scoring="neg_log_loss"))


# Las features CANDIDATAS se derivan AQUI, no en Node, y es seguro precisamente
# porque son candidatas: este script nunca sirve inferencia, solo mide. La regla
# de una sola fuente (marketFeatures en src/model.js) aplica a lo que PRODUCCION
# usa; meter una candidata alli antes de saber si sirve es al reves. Si alguna
# ganara su sitio, se implementa en Node y se reexporta el dataset — que es
# exactamente lo que se hizo, y se revirtio, el 2026-08-22.
def _deacc(x):
    # NFD + quitar marcas combinantes, igual que deaccModel() en src/model.js.
    # OJO: encode("ascii","ignore") NO sirve — BORRA la letra acentuada en vez de
    # convertirla ("Handicap" con tilde -> "Hndicap"), y entonces is_handicap
    # sale 0 siempre y el experimento mide una feature vacia sin avisar.
    if not isinstance(x, str):
        return ""
    return "".join(c for c in unicodedata.normalize("NFD", x)
                   if not unicodedata.combining(c)).lower()


def derivar(d):
    mkt = d["market"].fillna("").map(lambda v: _deacc(v))
    es_hcp = mkt.str.contains("handicap", regex=False)
    linea = mkt.str.extract(r"([+-]\s*\d+(?:\.\d+)?)\s*$")[0].str.replace(r"\s+", "", regex=True)
    d["is_handicap"] = es_hcp.astype(int)
    d["hcp_line"] = (pd.to_numeric(linea, errors="coerce").fillna(0) * es_hcp).clip(-6.5, 6.5)
    # Anclados al principio: sin ancla, "ganador" se traga "Primer set - ganador 1",
    # que es otra apuesta. "Prorroga - 1x2" tampoco entra.
    d["is_ganador_alt"] = (mkt.str.match(r"^ganador") | mkt.str.match(r"^1x2")).astype(int)
    d["is_doble"] = mkt.str.contains("doble oportunidad", regex=False).astype(int)
    return d


todas = sorted(set(sum([v for _, v in VARIANTES], [])) - {"_ruido"})
df = derivar(pd.read_csv(ROOT / "dataset.csv"))
df = df.dropna(subset=BASE + todas + ["y"])
df = df[df["score_version"] == 2].sort_values("ts").reset_index(drop=True)
# El ruido se fija UNA vez y es el mismo en todos los folds: si cambiara por
# fold, el control medaria otra cosa.
df["_ruido"] = np.random.default_rng(7).normal(size=len(df))

c = df["sport"].value_counts()
keep = sorted(c[c >= 50].index.tolist())
df["sport_grp"] = df["sport"].where(df["sport"].isin(keep), "otros")
groups = sorted(df["sport_grp"].unique().tolist())
df["heur"] = df[HEUR].to_numpy(float) @ HW

n = len(df)
edges = np.linspace(0, n, 6, dtype=int)
print(f"dataset v2: {n} filas   picks: {(df['origin']=='picks').sum()}   "
      f"rechazados: {(df['origin']=='rejected').sum()}\n")
print("                          ---- picks EMITIDOS (lo que decide) ----")
print("  variante                 d_Brier    d_logloss   folds    N_oos")


def evaluar(extra):
    feats = BASE + extra
    Y, H, C, P = [], [], [], []
    fold_b = 0
    for i in range(1, 5):
        tr, te = df.iloc[:edges[i]], df.iloc[edges[i]:edges[i + 1]]
        y_tr = tr["y"].to_numpy(int)

        def mat(d):
            X = d[feats].to_numpy(float)
            D = np.zeros((len(d), len(groups)))
            for j, g in enumerate(groups):
                D[:, j] = (d["sport_grp"] == g).to_numpy(float)
            return np.hstack([X, D])

        method = "isotonic" if len(tr) >= 2000 else "sigmoid"
        cal = CalibratedClassifierCV(lr(), method=method,
                                     cv=max(2, min(5, int(min(np.bincount(y_tr))))))
        cal.fit(mat(tr), y_tr)
        p = cal.predict_proba(mat(te))[:, 1]
        pk = (te["origin"] == "picks").to_numpy()
        yv, hv = te["y"].to_numpy(int), te["heur"].to_numpy()
        # Un fold sin picks evaluables NO cuenta como victoria.
        if pk.sum() >= 20 and len(np.unique(yv[pk])) > 1:
            if met(yv[pk], hv[pk])[0] - met(yv[pk], p[pk])[0] > 0:
                fold_b += 1
        Y.append(yv); H.append(hv); C.append(p); P.append(pk)

    Y, H, C, P = map(np.concatenate, (Y, H, C, P))
    yp, hp, cp = Y[P], H[P], C[P]
    bh, lh = met(yp, hp)
    bc, lc = met(yp, cp)
    return bh - bc, lh - lc, fold_b, P.sum()


res = {}
for nombre, extra in VARIANTES:
    db, dl, folds, noos = evaluar(extra)
    res[nombre] = (db, dl, folds)
    marca = "  <-" if db > 0 and folds >= 3 else ""
    print(f"  {nombre:<24} {db:+.4f}    {dl:+.4f}     {folds}/4    {noos:5d}{marca}")

print("\nLectura: una variante solo se gana el sitio si mejora sobre 'actual' Y")
print("el CONTROL de ruido NO mejora. Si el ruido sube parecido, lo que se mide")
print("es capacidad extra del modelo, no informacion nueva.")
base_b = res["actual (mercado base)"][0]
ctrl_b = res["CONTROL: + ruido"][0]
print(f"\n  base  {base_b:+.4f}      control ruido {ctrl_b:+.4f}  "
      f"(delta ruido sobre base: {ctrl_b - base_b:+.4f})")
for nombre, (db, dl, folds) in res.items():
    if nombre.startswith(("actual", "CONTROL")):
        continue
    delta = db - base_b
    veredicto = "GANA" if delta > abs(ctrl_b - base_b) and db > 0 else "no supera al ruido"
    print(f"  {nombre:<20} delta sobre base {delta:+.4f}   {veredicto}")
