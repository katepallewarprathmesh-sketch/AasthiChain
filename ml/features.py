"""
Feature definition — the single source of truth.

Every feature here must be computable at scoring time from what the API
actually holds when a collect request arrives:

    PaymentInput    amountINR, payerVpa, payeeVpa, createdAt
    HistorySummary  txnCount10m, txnCount24h, totalINR24h, recentINR[:10],
                    accountAgeMin, kycVerified

Nothing else is allowed in. A feature the server cannot compute at runtime is
a feature that cannot be served, however predictive it looks offline.

The same ordering is exported to ml/model/fraud_model.json and re-implemented
in Go (drunix-gateway/model.go) and JS. The golden-vector test pins all three
to identical output.
"""

import math

# Order matters: the exported weight vector is aligned to this list.
FEATURE_NAMES = [
    "log_amount",
    "amount_in_structuring_band",
    "recent_in_structuring_band",
    "recent_amount_cv",
    "txn_count_10m",
    "txn_count_24h",
    "log_total_24h",
    "amount_vs_recent_mean",
    "log_account_age_min",
    "kyc_unverified",
    "is_night",
    "risky_vpa_fragment",
    # --- interaction terms -------------------------------------------------
    # A plain linear model scored ROC-AUC 0.955 / recall 0.57 against a
    # gradient-boosted tree's 0.981 / 0.86 on the same split. That gap is
    # non-linearity, and most of it is one distinction: an honest busy payer
    # and an account takeover both show high velocity. What separates them is
    # whether the amounts are ESCALATING. These terms hand the linear model
    # exactly that, keeping the model additive and therefore exactly
    # decomposable into per-term contributions.
    "velocity_x_escalation",
    "burstiness",
    "new_account_x_amount",
    "structuring_x_tightness",
]

# Structuring band: amounts parked just under the ₹50,000 reporting line.
STRUCTURING_FLOOR = 45000.0
STRUCTURING_CEIL = 50000.0

RISKY_VPA_FRAGMENTS = ["fraud", "scam", "thief", "steal", "phish", "xxx", "darkweb"]


def _cv(values):
    """Coefficient of variation. Structuring produces a tight cluster of
    near-identical amounts, so low spread on a busy account is itself a signal."""
    vals = [v for v in values if v is not None]
    if len(vals) < 2:
        return 0.0
    mean = sum(vals) / len(vals)
    if mean <= 0:
        return 0.0
    var = sum((v - mean) ** 2 for v in vals) / len(vals)
    return math.sqrt(var) / mean


def extract(amount_inr, payer_vpa, recent_inr, txn_count_10m, txn_count_24h,
            total_inr_24h, account_age_min, kyc_verified, hour_of_day):
    """Returns the feature vector in FEATURE_NAMES order.

    Pure arithmetic on primitives — deliberately trivial to port to Go and JS.
    """
    recent = list(recent_inr or [])[:10]
    recent_mean = (sum(recent) / len(recent)) if recent else 0.0
    vpa = (payer_vpa or "").lower()

    return [
        math.log1p(max(0.0, amount_inr)),
        1.0 if STRUCTURING_FLOOR < amount_inr <= STRUCTURING_CEIL else 0.0,
        float(sum(1 for a in recent if STRUCTURING_FLOOR < a <= STRUCTURING_CEIL)),
        _cv(recent),
        float(txn_count_10m),
        float(txn_count_24h),
        math.log1p(max(0.0, total_inr_24h)),
        (amount_inr / recent_mean) if recent_mean > 0 else 1.0,
        math.log1p(max(0, account_age_min)),
        0.0 if kyc_verified else 1.0,
        1.0 if 0 <= hour_of_day < 5 else 0.0,
        1.0 if any(f in vpa for f in RISKY_VPA_FRAGMENTS) else 0.0,
        # velocity_x_escalation: bursting AND ramping up, the takeover pattern.
        float(txn_count_10m) * (amount_inr / recent_mean if recent_mean > 0 else 1.0),
        # burstiness: share of the day's activity compressed into 10 minutes.
        float(txn_count_10m) / (float(txn_count_24h) + 1.0),
        # new_account_x_amount: a big payment is only alarming on a fresh account.
        (1.0 if account_age_min < 1440 else 0.0) * math.log1p(max(0.0, amount_inr)),
        # structuring_x_tightness: several near-threshold amounts that are also
        # near-identical. Repetition plus tightness is the AML signature;
        # either alone is common in honest activity.
        float(sum(1 for a in recent if STRUCTURING_FLOOR < a <= STRUCTURING_CEIL)) * (1.0 - min(1.0, _cv(recent))),
    ]
