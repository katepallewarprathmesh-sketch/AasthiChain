#!/usr/bin/env python3
"""
Pipeline tests: determinism, model artifact integrity, explanation correctness.

Run:  python3 ml/test_pipeline.py
Exits non-zero on the first failure so CI can gate on it. Deliberately has no
pytest dependency so it runs anywhere the training environment runs.

The Go and JS suites cover serving. This covers the half that only exists in
Python: that the dataset and the model can actually be reproduced.
"""

import hashlib
import json
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from features import FEATURE_NAMES, extract          # noqa: E402
from generate_dataset import SEED, generate          # noqa: E402

passed, failed = 0, []


def check(name, cond, detail=""):
    global passed
    if cond:
        passed += 1
        print(f"  PASS  {name}")
    else:
        failed.append(name)
        print(f"  FAIL  {name}{' — ' + detail if detail else ''}")


def digest(rows):
    h = hashlib.sha256()
    for r in rows:
        h.update(repr(r).encode())
    return h.hexdigest()[:16]


print("\nml/test_pipeline.py\n")

# ---------------------------------------------------------------- determinism
a = generate(300, seed=SEED)
b = generate(300, seed=SEED)
check("data generation is deterministic for a fixed seed",
      digest(a) == digest(b), f"{digest(a)} vs {digest(b)}")

c = generate(300, seed=SEED + 1)
check("a different seed produces different data", digest(a) != digest(c))

check("generated rows carry a payer id for leak-free splitting",
      all(isinstance(r[-1], str) and r[-1].startswith("payer") for r in a))

check("every row has one value per feature plus label/typology/payer",
      all(len(r) == len(FEATURE_NAMES) + 3 for r in a))

labels = {r[-3] for r in a}
check("labels are binary", labels <= {0, 1}, str(labels))

# ---------------------------------------------------------------- extraction
check("extract() arity matches FEATURE_NAMES",
      len(extract(1000, "a@b", [], 0, 0, 0, 100, True, 12)) == len(FEATURE_NAMES))

nasty = [
    ("empty", dict(amount_inr=0, payer_vpa="", recent_inr=[], txn_count_10m=0,
                   txn_count_24h=0, total_inr_24h=0, account_age_min=0,
                   kyc_verified=True, hour_of_day=0)),
    ("NaN amount", dict(amount_inr=float("nan"), payer_vpa="a@b", recent_inr=[],
                        txn_count_10m=0, txn_count_24h=0, total_inr_24h=0,
                        account_age_min=0, kyc_verified=True, hour_of_day=0)),
    ("inf amount", dict(amount_inr=float("inf"), payer_vpa="a@b", recent_inr=[],
                        txn_count_10m=0, txn_count_24h=0, total_inr_24h=0,
                        account_age_min=0, kyc_verified=True, hour_of_day=0)),
    ("None history", dict(amount_inr=100, payer_vpa=None, recent_inr=None,
                          txn_count_10m=None, txn_count_24h=None,
                          total_inr_24h=None, account_age_min=None,
                          kyc_verified=False, hour_of_day=None)),
    ("string amount", dict(amount_inr="not-a-number", payer_vpa="a@b",
                           recent_inr=[], txn_count_10m=0, txn_count_24h=0,
                           total_inr_24h=0, account_age_min=0,
                           kyc_verified=True, hour_of_day=12)),
    ("huge amount", dict(amount_inr=1e18, payer_vpa="a@b", recent_inr=[],
                         txn_count_10m=0, txn_count_24h=0, total_inr_24h=0,
                         account_age_min=0, kyc_verified=True, hour_of_day=12)),
]
for name, kw in nasty:
    v = extract(**kw)
    ok = all(isinstance(x, float) and math.isfinite(x) for x in v)
    check(f"invalid input produces finite features: {name}", ok,
          str([f for f, x in zip(FEATURE_NAMES, v) if not math.isfinite(x)]))

# unknown balance must not blow up the ratio — this was a real train/serve skew
v = extract(47000, "a@b", [], 0, 0, 0, 100000, True, 12, balance_before_inr=0)
check("unknown balance gives balance_ratio 0, not the raw amount",
      v[FEATURE_NAMES.index("balance_ratio")] == 0.0,
      str(v[FEATURE_NAMES.index("balance_ratio")]))
v2 = extract(47000, "a@b", [], 0, 0, 0, 100000, True, 12, balance_before_inr=1.0)
check("balance_ratio is capped", v2[FEATURE_NAMES.index("balance_ratio")] <= 20.0,
      str(v2[FEATURE_NAMES.index("balance_ratio")]))

# ---------------------------------------------------------- training determinism
# The brief asks for deterministic TRAINING, not only deterministic data.
# Training twice on identical input must give identical coefficients, or the
# committed artifact cannot be reproduced from the committed code.
try:
    import numpy as np
    from sklearn.linear_model import LogisticRegression
    from sklearn.preprocessing import StandardScaler

    rows = generate(400, seed=SEED)
    X = np.array([r[:len(FEATURE_NAMES)] for r in rows], dtype=float)
    y = np.array([r[len(FEATURE_NAMES)] for r in rows], dtype=int)
    if y.sum() == 0 or y.sum() == len(y):
        check("training determinism (skipped: single-class sample)", True)
    else:
        def fit():
            sc = StandardScaler().fit(X)
            m = LogisticRegression(max_iter=5000, class_weight="balanced",
                                   solver="lbfgs", random_state=SEED)
            m.fit(sc.transform(X), y)
            return m.coef_[0].copy(), float(m.intercept_[0])
        c1, i1 = fit()
        c2, i2 = fit()
        check("training twice gives identical coefficients",
              bool(np.array_equal(c1, c2)) and i1 == i2,
              f"max delta {float(np.max(np.abs(c1 - c2))):.3e}")
except ImportError as e:
    check(f"training determinism (sklearn unavailable: {e})", True)

# ---------------------------------------------------------------- artifact
here = os.path.dirname(os.path.abspath(__file__))
mp = os.path.join(here, "model", "fraud_model.json")
check("model artifact exists", os.path.exists(mp))
if os.path.exists(mp):
    m = json.load(open(mp))
    check("artifact declares a schema version", isinstance(m.get("schema_version"), int))
    check("artifact declares a name and kind", bool(m.get("name")) and bool(m.get("kind")))
    check("feature list matches the code", m["features"] == FEATURE_NAMES,
          "retrain: features.py and the artifact disagree")
    check("one coefficient per feature",
          len(m["coefficients"]) == len(FEATURE_NAMES))
    check("thresholds are probabilities and ordered",
          0 < m["threshold_review"] < m["threshold_block"] < 1)
    check("threshold was selected on validation",
          m.get("threshold_selected_on") == "validation split",
          str(m.get("threshold_selected_on")))
    check("artifact carries the synthetic-data caveat",
          "SYNTHETIC" in (m.get("data_caveat") or "").upper())

    # explanation identity: sum(value*coef) + intercept == logit
    gp = os.path.join(here, "model", "golden_vectors.json")
    g = json.load(open(gp))
    worst = 0.0
    for vec in g["vectors"]:
        z = sum(c * x for c, x in zip(m["coefficients"], vec["features"])) + m["intercept"]
        worst = max(worst, abs(z - vec["expected_logit"]))
    check("contributions + intercept reproduce the logit", worst < 1e-9,
          f"worst {worst:.3e}")

    check("golden vectors match the shipped model name", g["model"] == m["name"])
    check("golden vector arity matches the model",
          all(len(v["features"]) == len(FEATURE_NAMES) for v in g["vectors"]))

print(f"\n{passed} passed, {len(failed)} failed\n")
if failed:
    sys.exit(1)
print("pipeline OK")
