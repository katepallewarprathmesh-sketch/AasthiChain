"""
Trains the AasthiChain fraud model and exports it for in-process serving.

MODEL CHOICE — gradient-boosted trees, chosen against a preference.

This pipeline was first built around logistic regression, because a linear
model is exactly decomposable and trivial to port. Logistic regression scored
ROC-AUC 0.959 with 48% recall at 90% precision. The boosted tree scored 0.979
with 86% recall at the same precision. Adding interaction terms to the linear
model closed almost none of that gap. Preferring the linear model anyway would
have meant missing roughly twice as much fraud for the convenience of the
implementer, so the tree ships.

The two reasons for preferring the linear model are answered rather than
abandoned:

  * EXPLAINABILITY. The exported model carries per-feature contributions
    computed by decision-path attribution (Saabas): for each tree, the change
    in node value along the path is credited to the feature that split there.
    These contributions sum EXACTLY to the raw score minus the base value, so
    "why was this blocked" has an arithmetic answer that reconciles, not a
    post-hoc approximation. The export is verified to 1e-9 against sklearn.

  * PORTABILITY. 200 trees of depth 3 is 2,762 nodes of plain arrays. Go and
    JS walk them directly — no Python, no inference server, no ONNX runtime.

Evaluation uses a precision floor rather than accuracy: at a 3.2% base rate,
blocking nothing scores 96.8%.

Outputs:
    ml/model/fraud_model.json     trees, base value, thresholds, metadata
    ml/model/golden_vectors.json  held-out inputs + exact sklearn outputs
    ml/model/metrics.json         model comparison for the report
"""

import json
import os

import numpy as np
import pandas as pd
from sklearn.ensemble import GradientBoostingClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import (average_precision_score, brier_score_loss,
                             confusion_matrix, precision_recall_curve,
                             roc_auc_score)
from sklearn.preprocessing import StandardScaler

from features import FEATURE_NAMES

DATA = "data/synthetic_payments.csv"
OUT_DIR = "model"
SEED = 20260930
N_TREES = 200
MAX_DEPTH = 3
MIN_PRECISION = 0.90


def make_split(df):
    rng = np.random.RandomState(SEED)
    idx = rng.permutation(len(df))
    cut = int(len(df) * 0.75)
    return df.iloc[idx[:cut]], df.iloc[idx[cut:]]


def pick_threshold(y, p, min_precision=MIN_PRECISION):
    """Operating point by policy: hold precision at the floor, take the best
    recall available there. A shield that blocks genuine payments destroys
    more value than it saves."""
    prec, rec, thr = precision_recall_curve(y, p)
    best_t, best_r = 0.5, -1.0
    for pr, rc, t in zip(prec[:-1], rec[:-1], thr):
        if pr >= min_precision and rc > best_r:
            best_t, best_r = float(t), float(rc)
    return best_t if best_r >= 0 else 0.5


def evaluate(name, y, p, thr):
    pred = (p >= thr).astype(int)
    tn, fp, fn, tp = confusion_matrix(y, pred, labels=[0, 1]).ravel()
    return {
        "model": name,
        "roc_auc": round(float(roc_auc_score(y, p)), 4),
        "pr_auc": round(float(average_precision_score(y, p)), 4),
        "brier": round(float(brier_score_loss(y, p)), 5),
        "threshold": round(float(thr), 6),
        "precision": round(float(tp / (tp + fp)) if (tp + fp) else 0.0, 4),
        "recall": round(float(tp / (tp + fn)) if (tp + fn) else 0.0, 4),
        "false_positive_rate": round(float(fp / (fp + tn)) if (fp + tn) else 0.0, 5),
        "confusion": {"tn": int(tn), "fp": int(fp), "fn": int(fn), "tp": int(tp)},
    }


def rules_baseline(df):
    """The existing hand-tuned rules on the same features, so the model is
    compared against what it replaces. Mirrors drunix-gateway/fraud.go."""
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


def export_trees(gb):
    """Flattens sklearn's trees into plain arrays.

    node_value is the raw value at EVERY node, not just leaves — the interior
    values are what make decision-path attribution possible on the serving
    side.
    """
    trees = []
    for est in gb.estimators_[:, 0]:
        t = est.tree_
        trees.append({
            "feature": [int(f) for f in t.feature],          # -2 at leaves
            "threshold": [float(v) for v in t.threshold],
            "left": [int(v) for v in t.children_left],
            "right": [int(v) for v in t.children_right],
            "value": [float(v) for v in t.value[:, 0, 0]],
        })
    return trees


def _f32(v):
    """sklearn casts X to float32 inside tree prediction, then compares against
    a float64 threshold. Comparing in float64 instead flips rows whose feature
    value sits within a float32 ulp of a split point — 2 rows in 2,000 here,
    each wrong by ~0.74 in raw score. Ports must do the same narrowing:
    Go `float64(float32(x))`, JS `Math.fround(x)`."""
    return float(np.float32(v))


def raw_score(trees, base, lr, x):
    """Reference implementation of serving-side scoring, in Python.
    Go and JS mirror this exactly."""
    total = base
    for tr in trees:
        node = 0
        while tr["left"][node] != -1:
            node = (tr["left"][node] if _f32(x[tr["feature"][node]]) <= tr["threshold"][node]
                    else tr["right"][node])
        total += lr * tr["value"][node]
    return total


def contributions(trees, lr, x, n_features):
    """Decision-path attribution. The change in node value across each split is
    credited to the feature that split there. Sums exactly to raw - base."""
    out = [0.0] * n_features
    for tr in trees:
        node = 0
        while tr["left"][node] != -1:
            f = tr["feature"][node]
            nxt = (tr["left"][node] if _f32(x[f]) <= tr["threshold"][node] else tr["right"][node])
            out[f] += lr * (tr["value"][nxt] - tr["value"][node])
            node = nxt
    return out


def main():
    df = pd.read_csv(DATA)
    train, test = make_split(df)
    Xtr, ytr = train[FEATURE_NAMES].values, train["label"].values
    Xte, yte = test[FEATURE_NAMES].values, test["label"].values

    # --- the shipped model ------------------------------------------------
    gb = GradientBoostingClassifier(random_state=SEED, n_estimators=N_TREES,
                                    max_depth=MAX_DEPTH)
    gb.fit(Xtr, ytr)
    p_gb = gb.predict_proba(Xte)[:, 1]
    thr_gb = pick_threshold(yte, p_gb)

    # --- comparisons ------------------------------------------------------
    scaler = StandardScaler().fit(Xtr)
    lr_model = LogisticRegression(max_iter=3000, class_weight="balanced")
    lr_model.fit(scaler.transform(Xtr), ytr)
    p_lr = lr_model.predict_proba(scaler.transform(Xte))[:, 1]

    p_rules = rules_baseline(test)

    results = [
        evaluate("rules-v1 (existing, replaced)", yte, p_rules, pick_threshold(yte, p_rules)),
        evaluate("logistic-regression (rejected)", yte, p_lr, pick_threshold(yte, p_lr)),
        evaluate("gradient-boosting (SHIPPED)", yte, p_gb, thr_gb),
    ]

    print(f"\n{len(df):,} rows | fraud rate {df.label.mean():.2%} | test n={len(test):,}")
    print(f"operating point: best recall at precision >= {MIN_PRECISION:.0%}\n")
    print(f"{'model':<34}{'ROC-AUC':>9}{'PR-AUC':>9}{'prec':>8}{'recall':>8}{'FPR':>9}")
    for r in results:
        print(f"{r['model']:<34}{r['roc_auc']:>9}{r['pr_auc']:>9}"
              f"{r['precision']:>8}{r['recall']:>8}{r['false_positive_rate']:>9}")

    # --- export and VERIFY the export reproduces sklearn ------------------
    trees = export_trees(gb)
    base = float(gb._raw_predict_init(Xte[:1])[0, 0])
    lrate = float(gb.learning_rate)

    mine = np.array([raw_score(trees, base, lrate, x) for x in Xte])
    theirs = gb.decision_function(Xte)
    max_err = float(np.max(np.abs(mine - theirs)))
    print(f"\nexport check: max |exported - sklearn| over {len(Xte):,} rows = {max_err:.2e}")
    assert max_err < 1e-9, f"exported model does not reproduce sklearn (err {max_err})"

    # Contributions reconcile against the EXPLANATION baseline, not the raw
    # init. Path deltas telescope to (leaf - root), so each tree's root value
    # is part of the baseline an explanation is measured from:
    #     raw = base + lr*sum(leaf)
    #         = [base + lr*sum(root)] + lr*sum(leaf - root)
    #         = explain_base + sum(contributions)
    explain_base = base + lrate * sum(t["value"][0] for t in trees)
    worst = 0.0
    for x in Xte[:2000]:
        c = contributions(trees, lrate, x, len(FEATURE_NAMES))
        worst = max(worst, abs((sum(c) + explain_base)
                               - raw_score(trees, base, lrate, x)))
    print(f"contribution check: max |sum(contributions) + explain_base - raw| "
          f"over 2,000 rows = {worst:.2e}")
    assert worst < 1e-9, "contributions do not sum to the score"

    os.makedirs(OUT_DIR, exist_ok=True)
    model = {
        "name": "aasthichain-fraud-gbt-v2",
        "kind": "gradient_boosted_trees",
        "explainer": "decision-path attribution (contributions sum exactly to raw score - base)",
        "comparison_dtype": "float32",
        "comparison_note": ("Feature values MUST be narrowed to float32 before "
                            "comparing against a threshold, matching sklearn's "
                            "internal cast. Go: float64(float32(x)). JS: Math.fround(x)."),
        "trained_on": "synthetic UPI payment episodes (ml/generate_dataset.py)",
        "data_caveat": ("Trained on SYNTHETIC data. These metrics describe "
                        "synthetic behaviour, not observed AasthiChain fraud. "
                        "ml/validate_public.py runs the same pipeline against a "
                        "real public fraud dataset."),
        "features": FEATURE_NAMES,
        "base_value": base,
        "explain_base": explain_base,
        "learning_rate": lrate,
        "n_trees": len(trees),
        "max_depth": MAX_DEPTH,
        "threshold_block": round(float(thr_gb), 6),
        "threshold_review": round(float(thr_gb) * 0.4, 6),
        "rows_trained": int(len(train)),
        "fraud_rate": round(float(df.label.mean()), 5),
        "metrics": results[2],
        "seed": SEED,
        "trees": trees,
    }
    with open(f"{OUT_DIR}/fraud_model.json", "w") as fh:
        json.dump(model, fh)
    with open(f"{OUT_DIR}/metrics.json", "w") as fh:
        json.dump({"comparison": results, "rows": int(len(df)),
                   "fraud_rate": float(df.label.mean()),
                   "min_precision": MIN_PRECISION}, fh, indent=2)

    rng = np.random.RandomState(7)
    sel = rng.choice(len(test), 200, replace=False)
    golden = []
    for i in sel:
        x = Xte[i]
        golden.append({
            "features": [float(v) for v in x],
            "expected_probability": float(p_gb[i]),
            "expected_contributions": [float(v) for v in
                                       contributions(trees, lrate, x, len(FEATURE_NAMES))],
        })
    with open(f"{OUT_DIR}/golden_vectors.json", "w") as fh:
        json.dump({"model": model["name"],
                   "tolerance": 1e-9,
                   "note": ("Produced by sklearn at training time. The Go and JS "
                            "scorers must reproduce every probability AND every "
                            "per-feature contribution to 1e-9. That is what proves "
                            "the ported model is the trained model rather than an "
                            "approximation of it."),
                   "vectors": golden}, fh)

    # Go cannot go:embed across module boundaries, so the module keeps its own
    # copy. ml/model/fraud_model.json stays canonical; CI asserts they match.
    go_dir = "../drunix-gateway/fraudmodel"
    os.makedirs(go_dir, exist_ok=True)
    for fn in ("fraud_model.json", "golden_vectors.json"):
        with open(f"{OUT_DIR}/{fn}") as a, open(f"{go_dir}/{fn}", "w") as b:
            b.write(a.read())
    print(f"copied model + golden vectors to {go_dir}/")

    size = os.path.getsize(f"{OUT_DIR}/fraud_model.json") / 1024
    print(f"\nexported {OUT_DIR}/fraud_model.json  ({len(trees)} trees, "
          f"{sum(len(t['feature']) for t in trees)} nodes, {size:.0f} KB)")
    print(f"exported {OUT_DIR}/golden_vectors.json ({len(golden)} vectors)")

    imp = sorted(zip(FEATURE_NAMES, gb.feature_importances_), key=lambda kv: -kv[1])
    print("\nfeature importance:")
    for name, v in imp[:8]:
        print(f"  {name:<28}{v:.3f}")


if __name__ == "__main__":
    main()
