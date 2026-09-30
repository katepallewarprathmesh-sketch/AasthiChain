"""
Synthetic UPI payment generator for fraud-model training.

WHY SYNTHETIC: AasthiChain has no labelled fraud history, and no real Indian
UPI fraud dataset is publicly available at transaction granularity. The metrics
this produces therefore describe *synthetic* data and are labelled that way
everywhere they appear. ml/validate_public.py separately runs the identical
modelling pipeline against a real, publicly labelled fraud dataset to show the
method holds up on real labels.

DESIGN NOTE — the labels come from the generative process, never from the
existing rules. Each payer is assigned a behaviour class up front, and the
label is "was this payer acting fraudulently in this episode". If labels were
derived from the rule thresholds, the model would just relearn the rules and
every comparison against them would be circular and flattering.

DESIGN NOTE — deliberate class overlap. Honest people burst (salary day, a
bulk token purchase), and careful fraudsters look ordinary. Both are injected
on purpose. A generator without overlap yields AUC ≈ 1.0, which proves only
that the generator is easy.

Deterministic: seeded, so the committed model is reproducible.
"""

import argparse
import csv
import math
import random

from features import FEATURE_NAMES, extract

SEED = 20260930


def _episode(rng, kind, start_hour):
    """Produces one payer's burst of activity: a list of payment dicts.

    kind is the behaviour class. Returns (payments, is_fraud).
    """
    payments = []

    if kind == "retail":
        # Ordinary investor: a few modest purchases, verified, mature account.
        n = rng.randint(1, 4)
        age = rng.randint(3000, 400000)
        kyc = rng.random() > 0.03
        for _ in range(n):
            payments.append(dict(
                amount=max(500.0, rng.lognormvariate(8.9, 0.85)),
                gap_min=rng.uniform(40, 900),
                kyc=kyc, age=age,
            ))
        return payments, 0

    if kind == "retail_busy":
        # Honest but bursty — salary day, or buying several tokens at once.
        # This is the overlap case that punishes a naive velocity rule.
        n = rng.randint(5, 11)
        age = rng.randint(20000, 400000)
        for _ in range(n):
            payments.append(dict(
                amount=max(500.0, rng.lognormvariate(9.1, 0.7)),
                gap_min=rng.uniform(0.5, 6),
                kyc=True, age=age,
            ))
        return payments, 0

    if kind == "retail_highvalue":
        # Honest whale: large ticket, slow, long-established, verified.
        n = rng.randint(1, 3)
        age = rng.randint(100000, 900000)
        for _ in range(n):
            payments.append(dict(
                amount=rng.uniform(150000, 900000),
                gap_min=rng.uniform(120, 2000),
                kyc=True, age=age,
            ))
        return payments, 0

    if kind == "structuring":
        # Splits a large sum into amounts parked just under the ₹50k line.
        n = rng.randint(3, 8)
        age = rng.randint(1000, 200000)
        kyc = rng.random() > 0.35
        for _ in range(n):
            payments.append(dict(
                amount=rng.uniform(45500, 49900),
                gap_min=rng.uniform(3, 90),
                kyc=kyc, age=age,
            ))
        return payments, 1

    if kind == "takeover":
        # Account takeover: rapid escalating drain.
        n = rng.randint(6, 14)
        age = rng.randint(50000, 500000)   # the real account is old — age won't save you
        amt = rng.uniform(2000, 15000)
        for _ in range(n):
            amt *= rng.uniform(1.15, 1.9)
            payments.append(dict(
                amount=min(amt, 800000.0),
                gap_min=rng.uniform(0.2, 2.5),
                kyc=True, age=age,
            ))
        return payments, 1

    if kind == "mule":
        # Fresh unverified account taking large inbound value immediately.
        n = rng.randint(1, 4)
        age = rng.randint(2, 180)
        for _ in range(n):
            payments.append(dict(
                amount=rng.uniform(60000, 700000),
                gap_min=rng.uniform(1, 40),
                kyc=rng.random() > 0.8,
                age=age,
            ))
        return payments, 1

    if kind == "patient_fraud":
        # The hard positives: a fraudster who deliberately looks retail.
        # Only faint signals — slightly odd hours, marginally new account.
        n = rng.randint(2, 5)
        age = rng.randint(400, 6000)
        for _ in range(n):
            payments.append(dict(
                amount=max(500.0, rng.lognormvariate(9.4, 0.8)),
                gap_min=rng.uniform(20, 300),
                kyc=rng.random() > 0.25,
                age=age,
            ))
        return payments, 1

    raise ValueError(kind)


# Mix of behaviour classes, chosen so the ROW-level fraud rate lands near 3%.
# Fraud episodes emit many more payments each than an ordinary purchase, so the
# payer-level weights are much smaller than the resulting row share. A first cut
# of this table produced a 43% fraud rate, which would have made every metric
# below meaningless — real card/UPI fraud is low single digits, and a model
# tuned against a balanced set collapses when it meets a 3% base rate.
MIX = [
    ("retail", 0.660),
    ("retail_busy", 0.200),
    ("retail_highvalue", 0.116),
    ("structuring", 0.006),
    ("takeover", 0.004),
    ("mule", 0.008),
    ("patient_fraud", 0.006),
]


def generate(n_payers, seed=SEED):
    rng = random.Random(seed)
    kinds = [k for k, _ in MIX]
    weights = [w for _, w in MIX]
    rows = []

    for _ in range(n_payers):
        kind = rng.choices(kinds, weights=weights)[0]
        start_hour = rng.randint(0, 23)
        payments, is_fraud = _episode(rng, kind, start_hour)

        # Fraud runs at night more often, but plenty of honest activity does too.
        if is_fraud and rng.random() < 0.35:
            start_hour = rng.randint(0, 4)

        # Phishing-style handle: mostly fraud, but occasionally an unlucky
        # honest handle, so the model cannot treat it as a hard rule.
        risky_vpa = (rng.random() < 0.28) if is_fraud else (rng.random() < 0.01)
        payer_vpa = ("scamster99@okaxis" if risky_vpa else f"user{rng.randint(1,99999)}@okhdfcbank")

        # Walk the episode forward, computing history exactly as the server does.
        elapsed = 0.0
        history = []          # (minutes_ago_at_end, amount)
        for p in payments:
            elapsed += p["gap_min"]
            recent = [a for (t, a) in history if elapsed - t <= 1440][:10]
            recent = list(reversed(recent))[:10]
            c10 = sum(1 for (t, a) in history if elapsed - t <= 10)
            c24 = sum(1 for (t, a) in history if elapsed - t <= 1440)
            total24 = sum(a for (t, a) in history if elapsed - t <= 1440)
            hour = int((start_hour + elapsed / 60.0) % 24)

            vec = extract(
                amount_inr=p["amount"],
                payer_vpa=payer_vpa,
                recent_inr=recent,
                txn_count_10m=c10,
                txn_count_24h=c24,
                total_inr_24h=total24,
                account_age_min=p["age"] + int(elapsed),
                kyc_verified=p["kyc"],
                hour_of_day=hour,
            )

            # Label noise, asymmetric on purpose. Labels in payments come from
            # disputes and chargebacks: plenty of fraud is never reported, while
            # an honest payment is rarely labelled fraudulent. Symmetric noise at
            # a 3% base rate would have swamped the positive class with
            # mislabelled negatives.
            label = is_fraud
            if is_fraud and rng.random() < 0.05:
                label = 0          # never reported
            elif not is_fraud and rng.random() < 0.001:
                label = 1          # mistaken dispute

            rows.append(vec + [label, kind])
            history.append((elapsed, p["amount"]))

    rng.shuffle(rows)
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--payers", type=int, default=40000)
    ap.add_argument("--seed", type=int, default=SEED)
    ap.add_argument("--out", default="ml/data/synthetic_payments.csv")
    args = ap.parse_args()

    rows = generate(args.payers, args.seed)
    import os
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(FEATURE_NAMES + ["label", "behaviour"])
        w.writerows(rows)

    pos = sum(1 for r in rows if r[-2] == 1)
    print(f"wrote {len(rows)} payments to {args.out}")
    print(f"  fraud rate: {pos/len(rows):.1%}  ({pos} positive)")


if __name__ == "__main__":
    main()
