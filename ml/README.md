# The fraud model

*Lives next to the code it documents; this project keeps no docs/ folder.*

The landing page used to call this an "AI fraud shield". It was a hand-tuned
weighted rules function — the code said so honestly (`aasthichain-rules-v1
(ML-pluggable)`), but the marketing copy did not. This document describes what
now actually runs.

**What changed:** decisions come from a gradient-boosted tree ensemble trained
with scikit-learn on 143,367 labelled payments. It is served in-process in both
Go and JavaScript, with no Python at runtime and no inference server.

---

## 1. Results

Held-out test set, 35,842 payments, 3.19% fraud base rate. The operating point
is *best recall at ≥90% precision* — accuracy is not reported because at a 3%
base rate, approving everything scores 96.8%.

| Model | ROC-AUC | PR-AUC | Precision | Recall | FPR |
|---|---|---|---|---|---|
| `rules-v1` (what this replaces) | 0.7902 | 0.4073 | 0.929 | **0.274** | 0.00069 |
| Logistic regression (rejected) | 0.9587 | 0.7647 | 0.900 | 0.480 | 0.00176 |
| **Gradient boosting (shipped)** | **0.9791** | **0.8691** | 0.901 | **0.862** | 0.00314 |

The rules caught **27%** of fraud. The model catches **86%** at comparable
precision. PR-AUC — the metric that matters on imbalanced data — more than
doubles.

### Why not the linear model

This pipeline was built around logistic regression first, because a linear
model is exactly decomposable and trivial to port. It scored 48% recall against
the tree's 86%. Adding interaction terms (`velocity_x_escalation`,
`burstiness`, `new_account_x_amount`, `structuring_x_tightness`) closed almost
none of the gap.

Shipping the linear model anyway would have meant missing roughly twice as much
fraud for the convenience of the implementer. The two properties the linear
model was wanted for are instead solved directly, below.

---

## 2. Validation on real fraud data

The shipped model is trained on synthetic data, because no labelled Indian UPI
fraud data exists publicly at transaction granularity. The obvious objection is
that the result might be an artefact of a generator written to be learnable.

`ml/validate_public.py` answers that by running the same feature family, the
same model class and the same precision-floor protocol against a **real**
public dataset: 1,048,575 card transactions, 6,006 confirmed frauds, 0.57% base
rate, 943 cardholders, chronologically split (train on the earlier period, test
on the later — a random split would let the model see a card's future).

| Model | ROC-AUC | PR-AUC | Precision | Recall |
|---|---|---|---|---|
| Threshold rules | 0.8397 | 0.1211 | 0.279 | **cannot reach 90% precision at any threshold** |
| Gradient boosting, same class | **0.9846** | **0.7562** | 0.900 | **0.561** |

Ten of the sixteen features transfer (the behavioural ones: velocity, exposure,
escalation, dispersion, burstiness, night, account age). KYC status, VPA
patterns and the structuring features have no equivalent in card data and are
dropped there. So the claim this supports is *"the behavioural feature family
plus a boosted tree separates real fraud"* — not *"the shipped model works on
cards"*. Its weights are discarded.

---

## 3. Honest limitations

- **The shipped model is trained on synthetic data.** Its headline metrics
  describe synthetic behaviour. They are not evidence about fraud on
  AasthiChain, which has had none to learn from. Every API response carrying a
  model decision includes `dataCaveat` saying so.
- **The generator encodes assumptions** about what fraud looks like
  (structuring near ₹50,000, takeover escalation, mule accounts). A typology it
  does not contain is a typology the model has not learned.
- **Deliberate overlap was injected** — honest people burst on salary day,
  patient fraudsters look retail — precisely so the metrics are not flattering.
  A generator without overlap yields AUC ≈ 1.0 and proves only that the
  generator is easy.
- **No feedback loop.** The model does not learn from analyst decisions. Doing
  that properly needs outcome labels this system does not yet collect.
- **The model does not see the graph.** Mule networks are a fan-in pattern
  across accounts; every feature here is single-payer. This is the largest gap.

---

## 4. Explainability

Every decision decomposes into exact per-feature contributions, computed by
decision-path attribution: for each tree, the change in node value across a
split is credited to the feature that split there.

```
raw_score = explain_base + Σ contributions
```

This holds **exactly** — verified to 8.88e-15 across 2,000 rows at training
time, and asserted in `TestContributionsReconcile`. An explanation that does
not reconcile with the score that was acted on is decoration, so the property
is tested rather than assumed.

The baseline is `explain_base`, not the raw init, because path deltas telescope
to `(leaf − root)`, which folds every tree's root value into the baseline.

Example API response:

```json
{
  "decision": "REVIEW", "score": 63, "engine": "model",
  "model": "aasthichain-fraud-gbt-v2",
  "factors": [
    { "code": "VELOCITY_X_ESCALATION", "note": "burst activity with escalating amounts (index 41.2)", "weight": 210 },
    { "code": "LOG_ACCOUNT_AGE_MIN",   "note": "account age 340 minutes",                              "weight": 118 }
  ]
}
```

`weight` is the feature's log-odds contribution ×100.

---

## 5. Model decides, policy overrides

The model makes the statistical call. Two rules remain, and they are policy
positions rather than scoring:

- an unverified-KYC payer is never auto-approved;
- a phishing-style VPA is never auto-approved.

These are marked `POLICY_*` in the factor list and carry weight `0`, so an
analyst can always see which part of a decision was learned and which was
mandated. A compliance requirement should not be something a model can
outvote because the statistics happened to look calm.

---

## 6. Serving, and why it is the same model in three languages

The model is trained in Python and served in Go (`drunix-gateway/model.go`) and
JavaScript (`lib/fraud-model.js`). Three implementations of the same arithmetic
will drift unless something forces them not to.

**200 golden vectors** — held-out inputs with the probability *and* every
per-feature contribution as computed by scikit-learn — are committed. Go's
`TestGoldenVectors` and `scripts/fraud-model-parity.mjs` both assert agreement
to `1e-9`. Current worst deviations:

| Implementation | Worst probability diff | Worst contribution diff |
|---|---|---|
| Go | 1.73e-18 | 0 |
| JavaScript | 8.67e-19 | 0 |

That is the difference between "we ported the model" as a claim and as a fact.
A port that is 99.9% right is a different model that usually agrees.

### The float32 detail

scikit-learn casts feature values to **float32** inside tree prediction, then
compares them against a float64 threshold. Comparing in float64 instead flips
any row whose value sits within a float32 ulp of a split point — 2 rows in
2,000 during development, each wrong by ~0.74 in raw score.

Both ports narrow before comparing: Go `float64(float32(x))`, JS
`Math.fround(x)`. `TestFloat32Narrowing` guards against someone simplifying it
away, because the failure is rare enough to survive casual testing.

### Failure behaviour

If the model file is missing or corrupt, scoring falls back to the legacy rules
and marks the response `engine: "rules-fallback"` with the reason. A fraud
engine that silently becomes a no-op is worse than one that is loudly degraded.

---

## 7. Reproducing

```bash
cd ml
python3 generate_dataset.py          # 143,367 payments, seeded
python3 train.py                     # trains, verifies export, writes model + golden vectors
python3 validate_public.py           # real-data sanity check (~270 MB download, not committed)
```

`train.py` refuses to export unless the exported model reproduces sklearn's
`decision_function` exactly over all 35,842 test rows, and unless contributions
reconcile to the score. Both are assertions, not warnings.

Everything is seeded (`SEED = 20260930`), so the committed model is
reproducible from the committed code.

### Files

| Path | What |
|---|---|
| `ml/features.py` | Feature definitions — the single source of truth |
| `ml/generate_dataset.py` | Synthetic generator with injected typologies |
| `ml/train.py` | Training, evaluation, export, self-verification |
| `ml/validate_public.py` | Real-dataset sanity check |
| `ml/model/fraud_model.json` | Shipped model, 200 trees / 2,762 nodes / 132 KB |
| `ml/model/golden_vectors.json` | 200 sklearn outputs pinning the ports |
| `drunix-gateway/model.go` | Go scorer |
| `lib/fraud-model.js` | JS scorer |
| `scripts/fraud-model-parity.mjs` | JS-vs-sklearn parity check (CI) |

Training data is **not** committed — it regenerates deterministically.
