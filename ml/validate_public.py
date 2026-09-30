"""
Sanity check: does the modelling approach hold up on REAL labelled fraud?

The shipped model is trained on synthetic UPI episodes, because no labelled
Indian UPI fraud data exists publicly at transaction granularity. That is a
real limitation, and the obvious question is whether the whole approach is an
artefact of a generator that was written to be learnable.

This script answers that by running the SAME pipeline — same feature family,
same model class, same precision-floor protocol — against a real, publicly
labelled dataset of 1,048,575 card transactions with 6,006 confirmed frauds
(0.57% base rate).

WHAT TRANSFERS AND WHAT DOES NOT. The dataset has cardholder ids and
timestamps, so the behavioural half of the feature set is reproducible exactly:
velocity, 24h exposure, amount escalation, spend dispersion, burstiness,
night-time, account age. It has no KYC status and no VPA, so those three
features are dropped here. The claim being tested is therefore "the behavioural
feature family plus a boosted tree separates real fraud", not "the shipped
model works on cards".

SPLIT. Chronological, not random: train on the earlier period, test on the
later one. A random split over transactions would let the model see a card's
future, which is exactly the leak that makes offline fraud metrics lie.

The dataset is ~270 MB and is NOT committed. It downloads to /tmp on demand.

Usage:  python3 ml/validate_public.py
"""

import io
import os
import sys
import zipfile

import numpy as np
import pandas as pd
from sklearn.ensemble import GradientBoostingClassifier
from sklearn.metrics import (average_precision_score, confusion_matrix,
                             precision_recall_curve, roc_auc_score)

URL = ("https://huggingface.co/datasets/santosh3110/credit_card_fraud_transactions"
       "/resolve/main/credit_card_fraud_transactions.zip")
CACHE = "/tmp/ccdata/credit_card_fraud_transactions.csv"
SEED = 20260930
MIN_PRECISION = 0.90

BEHAVIOURAL_FEATURES = [
    "log_amount",
    "recent_amount_cv",
    "txn_count_10m",
    "txn_count_24h",
    "log_total_24h",
    "amount_vs_recent_mean",
    "log_account_age_min",
    "is_night",
    "velocity_x_escalation",
    "burstiness",
]


def fetch():
    if os.path.exists(CACHE):
        return CACHE
    import urllib.request
    print(f"downloading {URL} ...")
    raw = urllib.request.urlopen(URL, timeout=600).read()
    os.makedirs("/tmp/ccdata", exist_ok=True)
    with zipfile.ZipFile(io.BytesIO(raw)) as z:
        z.extractall("/tmp/ccdata")
    return CACHE


def build_features(df):
    """Per-card rolling history, mirroring what the AasthiChain server computes
    per payer at scoring time."""
    df = df.sort_values(["cc_num", "ts"]).reset_index(drop=True)
    out = []

    for _, g in df.groupby("cc_num", sort=False):
        g = g.set_index("ts")
        amt = g["amt"]

        # Rolling windows are closed on the left so a transaction never counts
        # itself — the server sees history BEFORE the payment it is scoring.
        c10 = amt.rolling("10min", closed="left").count().fillna(0.0)
        c24 = amt.rolling("24h", closed="left").count().fillna(0.0)
        s24 = amt.rolling("24h", closed="left").sum().fillna(0.0)
        m10 = amt.rolling("24h", closed="left").mean()
        sd10 = amt.rolling("24h", closed="left").std()

        age_min = (g.index - g.index[0]).total_seconds() / 60.0
        hour = g.index.hour

        mean_safe = m10.where(m10 > 0)
        ratio = (amt / mean_safe).fillna(1.0)
        cv = (sd10 / mean_safe).fillna(0.0)

        f = pd.DataFrame({
            "log_amount": np.log1p(amt.clip(lower=0)),
            "recent_amount_cv": cv,
            "txn_count_10m": c10,
            "txn_count_24h": c24,
            "log_total_24h": np.log1p(s24.clip(lower=0)),
            "amount_vs_recent_mean": ratio,
            "log_account_age_min": np.log1p(np.maximum(age_min, 0)),
            "is_night": ((hour >= 0) & (hour < 5)).astype(float),
            "label": g["is_fraud"].values,
            "ts": g.index,
        }, index=g.index)
        f["velocity_x_escalation"] = f["txn_count_10m"] * f["amount_vs_recent_mean"]
        f["burstiness"] = f["txn_count_10m"] / (f["txn_count_24h"] + 1.0)
        out.append(f)

    return pd.concat(out, ignore_index=True).replace([np.inf, -np.inf], 0.0)


def recall_at_precision(y, p, floor=MIN_PRECISION):
    prec, rec, thr = precision_recall_curve(y, p)
    best_t, best_r = 0.5, 0.0
    for pr, rc, t in zip(prec[:-1], rec[:-1], thr):
        if pr >= floor and rc > best_r:
            best_t, best_r = float(t), float(rc)
    return best_r, best_t


def report(name, y, p):
    r, t = recall_at_precision(y, p)
    pred = (p >= t).astype(int)
    tn, fp, fn, tp = confusion_matrix(y, pred, labels=[0, 1]).ravel()
    prec = tp / (tp + fp) if (tp + fp) else 0.0
    print(f"{name:<34}{roc_auc_score(y, p):>9.4f}{average_precision_score(y, p):>9.4f}"
          f"{prec:>8.3f}{r:>8.3f}{fp / (fp + tn) if (fp + tn) else 0:>9.5f}")
    return {"model": name, "roc_auc": round(float(roc_auc_score(y, p)), 4),
            "pr_auc": round(float(average_precision_score(y, p)), 4),
            "precision": round(float(prec), 4), "recall": round(float(r), 4),
            "confusion": {"tn": int(tn), "fp": int(fp), "fn": int(fn), "tp": int(tp)}}


def main():
    path = fetch()
    df = pd.read_csv(path, usecols=["trans_date_trans_time", "cc_num", "amt", "is_fraud"])
    # Format pinned explicitly: verified identical to pandas' inference, but an
    # ambiguous parse would silently scramble the chronological split.
    df["ts"] = pd.to_datetime(df["trans_date_trans_time"], format="%m/%d/%y %H:%M")
    print(f"loaded {len(df):,} real transactions, "
          f"{df.is_fraud.sum():,} frauds ({df.is_fraud.mean():.3%}), "
          f"{df.cc_num.nunique()} cards")

    feats = build_features(df)
    feats = feats.sort_values("ts")

    # Chronological split.
    cut_ts = feats["ts"].quantile(0.70)
    train = feats[feats["ts"] <= cut_ts]
    test = feats[feats["ts"] > cut_ts]
    print(f"train {len(train):,} (to {cut_ts.date()}) | test {len(test):,} "
          f"| test fraud rate {test.label.mean():.3%}\n")

    Xtr, ytr = train[BEHAVIOURAL_FEATURES].values, train["label"].values
    Xte, yte = test[BEHAVIOURAL_FEATURES].values, test["label"].values

    print(f"{'model':<34}{'ROC-AUC':>9}{'PR-AUC':>9}{'prec':>8}{'recall':>8}{'FPR':>9}")

    # Baseline in the spirit of the old rules: flag big, fast or nocturnal.
    amt = np.expm1(test["log_amount"].values)
    rules = (np.where(amt > 500, 0.4, 0.0)
             + np.where(test["txn_count_10m"].values >= 3, 0.4, 0.0)
             + test["is_night"].values * 0.3)
    r_rules = report("threshold rules (baseline)", yte, np.clip(rules, 0, 1))

    gb = GradientBoostingClassifier(random_state=SEED, n_estimators=200, max_depth=3)
    gb.fit(Xtr, ytr)
    r_gb = report("gradient-boosting (same class)", yte, gb.predict_proba(Xte)[:, 1])

    print("\nfeature importance on REAL data:")
    for n, v in sorted(zip(BEHAVIOURAL_FEATURES, gb.feature_importances_),
                       key=lambda kv: -kv[1])[:6]:
        print(f"  {n:<26}{v:.3f}")

    import json
    with open("model/public_validation.json", "w") as fh:
        json.dump({
            "dataset": URL,
            "rows": int(len(df)),
            "frauds": int(df.is_fraud.sum()),
            "fraud_rate": round(float(df.is_fraud.mean()), 5),
            "split": "chronological 70/30",
            "features_used": BEHAVIOURAL_FEATURES,
            "features_dropped": ["kyc_unverified", "risky_vpa_fragment",
                                 "amount_in_structuring_band",
                                 "recent_in_structuring_band",
                                 "structuring_x_tightness", "new_account_x_amount"],
            "note": ("Validates the feature family and model class on real labels. "
                     "This is NOT the shipped model and its weights are discarded."),
            "results": [r_rules, r_gb],
        }, fh, indent=2)
    print("\nwrote model/public_validation.json")


if __name__ == "__main__":
    sys.exit(main())
