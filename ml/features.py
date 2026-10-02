"""
Feature definition — single source of truth for Python, Go and JavaScript.

HARD CONSTRAINT: every feature must be computable at scoring time from what the
API actually holds when a collect request arrives. A feature that looks
predictive offline but cannot be computed in the request path is useless.

Available today:
    PaymentInput    amountINR, payerId, payerVpa, payeeVpa, createdAt, txnType
    HistorySummary  txnCount10m, txnCount24h, totalINR24h, recentINR[:10],
                    accountAgeMin, kycVerified,
                    + additive fields for this model:
                      distinctPayees24h, payeeSeenBefore, payeeFanIn24h,
                      balanceBeforeINR

DELIBERATELY ABSENT: device id, IP address and user-agent. The brief lists
device/IP change features "if available in our existing schema". They are not
in the schema — grep finds no such field on any payment record — so they are
not synthesised here. Inventing them would train the model on a signal the
server can never supply.

The exported model pins this ordering. Go (drunix-gateway/model.go) and JS
(lib/fraud-model.js) reimplement it, and the golden-vector tests fail if any of
the three drifts.
"""

import math

# Order is load-bearing: the exported coefficient vector is aligned to this list.
FEATURE_NAMES = [
    # --- amount -----------------------------------------------------------
    "log_amount",
    "amount_in_structuring_band",
    "balance_ratio",
    # --- structuring ------------------------------------------------------
    "recent_in_structuring_band",
    "recent_amount_cv",
    "structuring_x_tightness",
    # --- velocity / rolling windows --------------------------------------
    "txn_count_10m",
    "txn_count_24h",
    "log_total_24h",
    "amount_vs_recent_mean",
    "burstiness",
    "velocity_x_escalation",
    # --- counterparty behaviour ------------------------------------------
    "beneficiary_is_new",
    "distinct_payees_24h",
    "payee_fan_in_24h",
    # --- account standing -------------------------------------------------
    "log_account_age_min",
    "kyc_unverified",
    "new_account_x_amount",
    # --- temporal ---------------------------------------------------------
    "is_night",
    "is_weekend",
    # --- categorical ------------------------------------------------------
    "is_transfer_type",
    "risky_vpa_fragment",
    "handle_mimic",
]

# Amounts parked just under the ₹50,000 reporting line.
STRUCTURING_FLOOR = 45000.0
STRUCTURING_CEIL = 50000.0
NEW_ACCOUNT_MIN = 1440  # 24h
BALANCE_RATIO_CAP = 20.0

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


def _handle_mimic(payer_vpa, payee_vpa):
    """1.0 when the two handles share a local part but differ overall."""
    if not payer_vpa or not payee_vpa or payer_vpa == payee_vpa:
        return 0.0
    a = payer_vpa.split("@")[0]
    b = payee_vpa.split("@")[0]
    return 1.0 if a and a == b else 0.0


def _safe(v, default=0.0):
    """Missing or non-finite inputs collapse to a defined value.

    A fraud scorer must never throw on a malformed payment: refusing to score
    is indistinguishable from scoring zero to the caller, but one of them takes
    the payment path down. Invalid input is treated as absent, not as fatal.
    """
    try:
        f = float(v)
    except (TypeError, ValueError):
        return default
    if math.isnan(f) or math.isinf(f):
        return default
    return f


def extract(amount_inr, payer_vpa, recent_inr, txn_count_10m, txn_count_24h,
            total_inr_24h, account_age_min, kyc_verified, hour_of_day,
            day_of_week=2, beneficiary_is_new=0, distinct_payees_24h=0,
            payee_fan_in_24h=0, balance_before_inr=0.0, txn_type="COLLECT",
            payee_vpa=""):
    """Returns the feature vector in FEATURE_NAMES order.

    Pure arithmetic on primitives, deliberately trivial to port. Every argument
    is defensively coerced: see _safe.
    """
    amount_inr = max(0.0, _safe(amount_inr))
    recent = [_safe(a) for a in (recent_inr or [])][:10]
    recent_mean = (sum(recent) / len(recent)) if recent else 0.0
    ratio = (amount_inr / recent_mean) if recent_mean > 0 else 1.0

    c10 = _safe(txn_count_10m)
    c24 = _safe(txn_count_24h)
    total24 = max(0.0, _safe(total_inr_24h))
    age = max(0.0, _safe(account_age_min))
    bal = max(0.0, _safe(balance_before_inr))
    hour = int(_safe(hour_of_day, 12))
    dow = int(_safe(day_of_week, 2))

    struct_count = float(sum(1 for a in recent
                             if STRUCTURING_FLOOR < a <= STRUCTURING_CEIL))
    cv = _cv(recent)
    vpa = str(payer_vpa or "").lower()

    return [
        # amount
        math.log1p(amount_inr),
        1.0 if STRUCTURING_FLOOR < amount_inr <= STRUCTURING_CEIL else 0.0,
        # How much of the available balance this payment consumes; draining an
        # account looks different from spending from it.
        #
        # A balance of 0 means UNKNOWN, not "empty account". Dividing by it
        # yielded the amount itself (a ratio of 47000 for a 47k payment), which
        # is far outside anything seen in training and made a missing balance
        # the loudest term in the explanation. Unknown now contributes nothing,
        # and the ratio is clipped so one odd input cannot dominate the score.
        0.0 if bal <= 0 else min(amount_inr / bal, BALANCE_RATIO_CAP),
        # structuring
        struct_count,
        cv,
        # repetition AND tightness together: either alone is common in honest
        # activity, the combination is the AML signature
        struct_count * (1.0 - min(1.0, cv)),
        # velocity
        c10,
        c24,
        math.log1p(total24),
        ratio,
        c10 / (c24 + 1.0),
        # bursting AND ramping up: separates an account takeover from an
        # honest payer having a busy afternoon
        c10 * ratio,
        # counterparty
        1.0 if beneficiary_is_new else 0.0,
        _safe(distinct_payees_24h),      # fan-out from this payer
        _safe(payee_fan_in_24h),         # fan-in to this beneficiary (mule signal)
        # account standing
        math.log1p(age),
        0.0 if kyc_verified else 1.0,
        (1.0 if age < NEW_ACCOUNT_MIN else 0.0) * math.log1p(amount_inr),
        # temporal
        1.0 if 0 <= hour < 5 else 0.0,
        1.0 if dow in (5, 6) else 0.0,   # 0=Mon .. 6=Sun
        # categorical
        1.0 if str(txn_type).upper() in ("TRANSFER", "CASH_OUT") else 0.0,
        1.0 if any(f in vpa for f in RISKY_VPA_FRAGMENTS) else 0.0,
        # Lookalike handle: payer and payee share a local part on different
        # banks (ravi@okhdfcbank paying ravi@okaxis). Carried over from the
        # rules engine, which scored it 15/100 -- it was the one signal the
        # first model revision dropped.
        _handle_mimic(vpa, str(payee_vpa or "").lower()),
    ]


assert len(extract(1000, "a@b", [], 0, 0, 0, 100, True, 12)) == len(FEATURE_NAMES), \
    "extract() arity must match FEATURE_NAMES"
assert _handle_mimic("ravi@okhdfcbank", "ravi@okaxis") == 1.0
assert _handle_mimic("ravi@okhdfcbank", "ravi@okhdfcbank") == 0.0
assert _handle_mimic("ravi@okhdfcbank", "seller@okaxis") == 0.0
