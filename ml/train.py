"""
Trains the AasthiChain fraud model and exports it for in-process serving.

MODEL: logistic regression is the shipped model. A gradient-boosted tree is
trained alongside purely as a comparison and its metrics are reported, but it
is not served by default. The reasons are recorded in ml/README.md; in short,
LR gives an exact additive explanation (contribution = feature_value x
coefficient) and exports to 22 floats that Go and JS evaluate identically,
which for a regulated payments decision outweighs a few points of recall. The
GBT artifact is still written so the trade-off stays measurable rather than
asserted, and the serving code in both languages can load either.

SPLIT: by PAYER, 60/20/20. Rows within one payer's episode are strongly
correlated — a random row split puts a payer's early payments in train and
their later ones in test, which leaks their behaviour across the boundary and
inflates every metric.

THRESHOLD: selected on the VALIDATION split, never on test. Choosing the
operating point on the same data used to report performance is how offline
fraud metrics end up optimistic.

METRIC: best recall subject to precision >= 0.90, on validation. Accuracy is
never used: at a ~4.6% base rate, approving everything scores 95.4%.

No network calls. Fixed seeds. Reproducible from the committed generator.

Outputs:
    ml/model/fraud_model.json      shipped LR model (served)
    ml/model/gbt_comparison.json   GBT, for comparison and optional serving
    ml/model/golden_vectors.json   held-out inputs + exact sklearn outputs
    ml/model/metrics.json          full evaluation for the report
"""

import json
import os

import numpy as np
import pandas as pd
from sklearn.ensemble import GradientBoostingClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import (average_precision_score, brier_score_loss,
                             confusion_matrix, f1_score,
                             precision_recall_curve, precision_score,
                             recall_score, roc_auc_score)
from sklearn.preprocessing import StandardScaler

from features import FEATURE_NAMES

DATA = "data/synthetic_upi_payments.csv"
OUT_DIR = "model"
SEED = 20260930
MIN_PRECISION = 0.90
MODEL_NAME = "aasthichain-fraud-lr-v3"
SCHEMA_VERSION = 3


def split_by_payer(df, seed=SEED):
    """60/20/20 by payer id, so no payer appears in two splits."""
    payers = np.array(sorted(df["payer_id"].unique()))
    rng = np.random.RandomState(seed)
    rng.shuffle(payers)
    n = len(payers)
    tr = set(payers[: int(n * 0.60)])
    va = set(payers[int(n * 0.60): int(n * 0.80)])
    te = set(payers[int(n * 0.80):])
    assert not (tr & va) and not (tr & te) and not (va & te)
    return (df[df.payer_id.isin(tr)], df[df.payer_id.isin(va)],
            df[df.payer_id.isin(te)])


def pick_threshold(y, p, floor=MIN_PRECISION):
    """Best recall subject to precision >= floor.

    If the floor is unreachable at any threshold, fall back to the best-F1
    point and SAY SO, rather than silently returning 0.5. An earlier version
    returned 0.5 on failure, which on a 0.3% base rate produced a 7% precision
    operating point that looked like a model failure when it was really a
    threshold-selection failure.

    Returns (threshold, recall, floor_met).
    """
    prec, rec, thr = precision_recall_curve(y, p)
    best_t, best_r = None, -1.0
    for pr, rc, t in zip(prec[:-1], rec[:-1], thr):
        if pr >= floor and rc > best_r:
            best_t, best_r = float(t), float(rc)
    if best_t is not None:
        return best_t, best_r, True
    f1s = 2 * prec[:-1] * rec[:-1] / np.clip(prec[:-1] + rec[:-1], 1e-12, None)
    i = int(np.argmax(f1s))
    return float(thr[i]), float(rec[i]), False


def evaluate(name, split, y, p, thr):
    pred = (p >= thr).astype(int)
    tn, fp, fn, tp = confusion_matrix(y, pred, labels=[0, 1]).ravel()
    return {
        "model": name,
        "split": split,
        "n": int(len(y)),
        "positives": int(y.sum()),
        "threshold": round(float(thr), 6),
        "precision": round(float(precision_score(y, pred, zero_division=0)), 4),
        "recall": round(float(recall_score(y, pred, zero_division=0)), 4),
        "f1": round(float(f1_score(y, pred, zero_division=0)), 4),
        "roc_auc": round(float(roc_auc_score(y, p)), 4),
        "pr_auc": round(float(average_precision_score(y, p)), 4),
        "brier": round(float(brier_score_loss(y, p)), 5),
        "false_positive_rate": round(float(fp / (fp + tn)) if (fp + tn) else 0.0, 5),
        "confusion": {"tn": int(tn), "fp": int(fp), "fn": int(fn), "tp": int(tp)},
    }


def rules_baseline(df):
    """The hand-tuned rules on the same features, so the model is compared
    against what it replaces. Mirrors drunix-gateway/fraud.go weights."""
    s = np.zeros(len(df))
    amt = np.expm1(df["log_amount"].values)
    s += np.where(amt > 200000, 30, np.where(amt > 50000, 15, 0))
    s += np.where(df["recent_in_structuring_band"].values
                  + df["amount_in_structuring_band"].values >= 3, 40, 0)
    s += np.where(df["txn_count_10m"].values >= 5, 70,
                  np.where(df["txn_count_10m"].values >= 3, 40, 0))
    s += np.where(np.expm1(df["log_total_24h"].values) + amt > 500000, 20, 0)
    s += df["risky_vpa_fragment"].values * 40
    s += df["kyc_unverified"].values * 25
    s += np.where((np.expm1(df["log_account_age_min"].values) < 1440) & (amt > 100000), 20, 0)
    s += np.where((df["is_night"].values == 1) & (amt > 50000), 10, 0)
    return np.clip(s, 0, 100) / 100.0


def main():
    df = pd.read_csv(DATA)
    train, val, test = split_by_payer(df)

    Xtr, ytr = train[FEATURE_NAMES].values, train["label"].values
    Xva, yva = val[FEATURE_NAMES].values, val["label"].values
    Xte, yte = test[FEATURE_NAMES].values, test["label"].values

    print(f"\nrows {len(df):,} | payers {df.payer_id.nunique():,} "
          f"| fraud rate {df.label.mean():.2%}")
    print(f"split by payer -> train {len(train):,} ({ytr.mean():.2%})  "
          f"val {len(val):,} ({yva.mean():.2%})  test {len(test):,} ({yte.mean():.2%})\n")

    # ---------------- logistic regression (shipped) ----------------
    scaler = StandardScaler().fit(Xtr)
    # class_weight balanced: at a ~4.6% base rate an unweighted fit is heavily
    # biased toward predicting "legitimate" for everything.
    lr = LogisticRegression(max_iter=5000, class_weight="balanced", C=1.0,
                            solver="lbfgs", random_state=SEED)
    lr.fit(scaler.transform(Xtr), ytr)

    p_lr_va = lr.predict_proba(scaler.transform(Xva))[:, 1]
    p_lr_te = lr.predict_proba(scaler.transform(Xte))[:, 1]
    thr_lr, rec_va, floor_met_lr = pick_threshold(yva, p_lr_va)

    # ---------------- gradient boosting (comparison) ----------------
    gb = GradientBoostingClassifier(random_state=SEED, n_estimators=200, max_depth=3)
    gb.fit(Xtr, ytr)
    p_gb_va = gb.predict_proba(Xva)[:, 1]
    p_gb_te = gb.predict_proba(Xte)[:, 1]
    thr_gb, _, _ = pick_threshold(yva, p_gb_va)

    # ---------------- rules baseline ----------------
    p_ru_va, p_ru_te = rules_baseline(val), rules_baseline(test)
    thr_ru, _, _ = pick_threshold(yva, p_ru_va)

    results = {
        "validation": [
            evaluate("rules-v1 (replaced)", "validation", yva, p_ru_va, thr_ru),
            evaluate("logistic-regression (SHIPPED)", "validation", yva, p_lr_va, thr_lr),
            evaluate("gradient-boosting (comparison)", "validation", yva, p_gb_va, thr_gb),
        ],
        "test": [
            evaluate("rules-v1 (replaced)", "test", yte, p_ru_te, thr_ru),
            evaluate("logistic-regression (SHIPPED)", "test", yte, p_lr_te, thr_lr),
            evaluate("gradient-boosting (comparison)", "test", yte, p_gb_te, thr_gb),
        ],
    }

    for split in ("validation", "test"):
        print(f"--- {split} (threshold chosen on validation) ---")
        print(f"{'model':<34}{'prec':>7}{'rec':>7}{'F1':>7}{'ROC':>8}{'PR-AUC':>9}")
        for r in results[split]:
            print(f"{r['model']:<34}{r['precision']:>7}{r['recall']:>7}"
                  f"{r['f1']:>7}{r['roc_auc']:>8}{r['pr_auc']:>9}")
        print()

    # ---------------- export LR -----------------------------------
    # Fold the scaler into the coefficients so serving needs no scaler and the
    # contribution identity the brief asks for holds on RAW feature values:
    #     z = sum_i coef_i * x_i + intercept
    #     contribution_i = coef_i * x_i
    coef = lr.coef_[0] / scaler.scale_
    intercept = float(lr.intercept_[0] - np.sum(lr.coef_[0] * scaler.mean_ / scaler.scale_))

    def lr_raw(x):
        return float(np.dot(coef, x) + intercept)

    # Verify the folded form reproduces sklearn exactly before shipping it.
    mine = np.array([lr_raw(x) for x in Xte])
    theirs = lr.decision_function(scaler.transform(Xte))
    err = float(np.max(np.abs(mine - theirs)))
    print(f"export check (LR): max |folded - sklearn| over {len(Xte):,} rows = {err:.3e}")
    assert err < 1e-9, f"folded coefficients do not reproduce sklearn ({err})"

    os.makedirs(OUT_DIR, exist_ok=True)
    model = {
        "schema_version": SCHEMA_VERSION,
        "name": MODEL_NAME,
        "kind": "logistic_regression",
        "explainer": "contribution_i = feature_value_i * coefficient_i; sum + intercept = logit",
        "trained_on": "synthetic UPI-shaped payment episodes (ml/generate_dataset.py)",
        "data_caveat": (
            "Trained and evaluated on SYNTHETIC data. These metrics describe "
            "synthetic behaviour, not observed UPI fraud. The external PaySim "
            "benchmark is also synthetic and is mobile-money, not UPI. Real "
            "production performance requires labelled real UPI data."),
        "features": FEATURE_NAMES,
        "coefficients": [float(c) for c in coef],
        "intercept": intercept,
        "threshold_block": round(float(thr_lr), 6),
        "threshold_review": round(float(thr_lr) * 0.4, 6),
        "threshold_selected_on": "validation split",
        "precision_floor": MIN_PRECISION,
        "precision_floor_met": bool(floor_met_lr),
        "seed": SEED,
        "rows_trained": int(len(train)),
        "fraud_rate": round(float(df.label.mean()), 5),
        "metrics": {"validation": results["validation"][1], "test": results["test"][1]},
    }
    with open(f"{OUT_DIR}/fraud_model.json", "w") as fh:
        json.dump(model, fh, indent=2)

    # ---------------- export GBT (comparison / optional) -----------
    trees = []
    for est in gb.estimators_[:, 0]:
        t = est.tree_
        trees.append({"feature": [int(f) for f in t.feature],
                      "threshold": [float(v) for v in t.threshold],
                      "left": [int(v) for v in t.children_left],
                      "right": [int(v) for v in t.children_right],
                      "value": [float(v) for v in t.value[:, 0, 0]]})
    gbt = {
        "schema_version": SCHEMA_VERSION,
        "name": "aasthichain-fraud-gbt-v3",
        "kind": "gradient_boosted_trees",
        "explainer": "decision-path attribution; contributions sum to raw - explain_base",
        "comparison_dtype": "float32",
        "comparison_note": ("Narrow feature values to float32 before comparing "
                            "against a threshold, matching sklearn's internal "
                            "cast. Go: float64(float32(x)). JS: Math.fround(x)."),
        "features": FEATURE_NAMES,
        "base_value": float(gb._raw_predict_init(Xte[:1])[0, 0]),
        "learning_rate": float(gb.learning_rate),
        "n_trees": len(trees),
        "threshold_block": round(float(thr_gb), 6),
        "threshold_review": round(float(thr_gb) * 0.4, 6),
        "threshold_selected_on": "validation split",
        "data_caveat": model["data_caveat"],
        "metrics": {"validation": results["validation"][2], "test": results["test"][2]},
        "trees": trees,
    }
    gbt["explain_base"] = gbt["base_value"] + gbt["learning_rate"] * sum(t["value"][0] for t in trees)
    with open(f"{OUT_DIR}/gbt_comparison.json", "w") as fh:
        json.dump(gbt, fh)

    # ---------------- golden vectors -------------------------------
    rng = np.random.RandomState(7)
    sel = rng.choice(len(Xte), 200, replace=False)
    golden = []
    for i in sel:
        x = Xte[i]
        golden.append({
            "features": [float(v) for v in x],
            "expected_logit": lr_raw(x),
            "expected_probability": float(1.0 / (1.0 + np.exp(-lr_raw(x)))),
            "expected_contributions": [float(coef[j] * x[j]) for j in range(len(coef))],
        })
    with open(f"{OUT_DIR}/golden_vectors.json", "w") as fh:
        json.dump({"model": MODEL_NAME, "schema_version": SCHEMA_VERSION,
                   "tolerance": 1e-9,
                   "note": ("Produced by scikit-learn at training time. Go and JS "
                            "must reproduce every logit, probability and "
                            "per-feature contribution to 1e-9."),
                   "vectors": golden}, fh)

    with open(f"{OUT_DIR}/metrics.json", "w") as fh:
        json.dump({"rows": int(len(df)), "payers": int(df.payer_id.nunique()),
                   "fraud_rate": float(df.label.mean()),
                   "split": {"train": int(len(train)), "validation": int(len(val)),
                             "test": int(len(test)), "by": "payer_id"},
                   "min_precision": MIN_PRECISION,
                   "threshold_selected_on": "validation",
                   "results": results,
                   "coefficients": dict(zip(FEATURE_NAMES, [float(c) for c in coef])),
                   "intercept": intercept,
                   "class_distribution": {
                       "train": {"n": int(len(ytr)), "positives": int(ytr.sum())},
                       "validation": {"n": int(len(yva)), "positives": int(yva.sum())},
                       "test": {"n": int(len(yte)), "positives": int(yte.sum())}}},
                  fh, indent=2)

    # Go cannot go:embed across module boundaries; the module keeps its own copy.
    go_dir = "../drunix-gateway/fraudmodel"
    os.makedirs(go_dir, exist_ok=True)
    for fn in ("fraud_model.json", "golden_vectors.json"):
        with open(f"{OUT_DIR}/{fn}") as a, open(f"{go_dir}/{fn}", "w") as b:
            b.write(a.read())

    size = os.path.getsize(f"{OUT_DIR}/fraud_model.json") / 1024
    print(f"\nexported {OUT_DIR}/fraud_model.json  ({len(coef)} coefficients, {size:.0f} KB)")
    print(f"exported {OUT_DIR}/gbt_comparison.json ({len(trees)} trees)")
    print(f"exported {OUT_DIR}/golden_vectors.json (200 vectors)")
    print(f"\nthreshold {thr_lr:.6f} chosen on validation — recall {rec_va:.3f}, "
          f"precision floor {MIN_PRECISION} {'met' if floor_met_lr else 'NOT met (best-F1 fallback)'}")

    print("\nstrongest coefficients (per unit of raw feature):")
    for n, c in sorted(zip(FEATURE_NAMES, coef), key=lambda kv: -abs(kv[1]))[:10]:
        print(f"  {n:<30}{c:+.5f}")


if __name__ == "__main__":
    main()
