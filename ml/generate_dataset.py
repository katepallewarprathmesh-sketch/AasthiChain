"""
Seeded synthetic UPI-shaped payment generator.

WHY SYNTHETIC: AasthiChain has no labelled fraud history, and no labelled
Indian UPI fraud dataset exists publicly at transaction granularity. This
dataset is therefore synthetic, and every metric derived from it describes
synthetic behaviour. PaySim (ml/paysim_benchmark.py) is used as an external
labelled benchmark, but PaySim is *also* synthetic and is mobile-money, not
UPI. Neither establishes real-world performance.

LABELS COME FROM THE GENERATIVE PROCESS, never from the existing rule
thresholds. Each payer is assigned a behaviour class up front and the label is
"was this payer acting fraudulently in this episode". Deriving labels from the
rules would make the model relearn the rules and every comparison against them
circular.

DELIBERATE CLASS OVERLAP. Honest people burst (salary day, bulk purchase) and
patient fraudsters look ordinary. Both are injected on purpose. A generator
without overlap yields AUC ~1.0 and proves only that the generator is easy.

SPLIT SAFETY. Each payer appears in exactly one episode and every row carries
its payer_id, so train/validation/test can be split by payer. Splitting by row
would put a payer's early payments in train and later ones in test, leaking
their behaviour across the boundary.

Typologies injected (all documented, all seeded):
  structuring        repeated amounts just under the reporting line
  velocity_burst     many payments in minutes
  account_takeover   escalating drain of an established account
  mule_fan_in        many distinct payers into one fresh beneficiary
  mule_fan_out       one account spraying to many new beneficiaries
  beneficiary_anomaly  sudden large payment to a brand-new counterparty

Deterministic: fixed seed, committed config.
"""

import argparse
import csv
import os
import random

from features import FEATURE_NAMES, extract

SEED = 20260930

# Payer-level mix, tuned so the ROW-level fraud rate lands near 3%. Fraud
# episodes emit more rows each than an ordinary purchase, so these weights are
# much smaller than the resulting row share. An earlier revision produced a 43%
# fraud rate, which makes every metric meaningless: real payment fraud is low
# single digits and a model tuned on a balanced set collapses at a 3% base rate.
MIX = [
    ("retail", 0.600),
    ("retail_busy", 0.180),
    ("retail_highvalue", 0.100),
    ("retail_new_beneficiary", 0.096),
    ("structuring", 0.006),
    ("velocity_burst", 0.004),
    ("account_takeover", 0.004),
    ("mule_fan_in", 0.005),
    ("mule_fan_out", 0.003),
    ("beneficiary_anomaly", 0.002),
]


def _episode(rng, kind):
    """Returns (payments, is_fraud). Each payment is a dict of raw attributes;
    rolling-window features are derived afterwards by walking the episode."""
    def P(**kw):
        base = dict(gap_min=rng.uniform(40, 900), kyc=True,
                    age=rng.randint(3000, 400000), new_payee=0,
                    ttype="COLLECT",
                    # 12% of payments carry no balance snapshot, matching the
                    # server where npciBalances may simply not hold the payer.
                    bal=0.0 if rng.random() < 0.12 else rng.uniform(20000, 900000))
        base.update(kw)      # explicit values win over the defaults
        return base

    if kind == "retail":
        return [P(amount=max(500.0, rng.lognormvariate(8.9, 0.85)),
                  new_payee=1 if rng.random() < 0.25 else 0)
                for _ in range(rng.randint(1, 4))], 0

    if kind == "retail_busy":
        # Honest but bursty. Punishes a naive velocity rule.
        age = rng.randint(20000, 400000)
        return [P(amount=max(500.0, rng.lognormvariate(9.1, 0.7)),
                  gap_min=rng.uniform(0.5, 6), age=age)
                for _ in range(rng.randint(5, 11))], 0

    if kind == "retail_highvalue":
        age = rng.randint(100000, 900000)
        return [P(amount=rng.uniform(150000, 900000), gap_min=rng.uniform(120, 2000),
                  age=age, bal=rng.uniform(800000, 5000000))
                for _ in range(rng.randint(1, 3))], 0

    if kind == "retail_new_beneficiary":
        # Honest payments to counterparties never seen before. Without these the
        # model would treat beneficiary novelty as near-proof of fraud.
        return [P(amount=max(500.0, rng.lognormvariate(9.0, 0.8)), new_payee=1)
                for _ in range(rng.randint(1, 3))], 0

    if kind == "structuring":
        age = rng.randint(1000, 200000)
        kyc = rng.random() > 0.35
        return [P(amount=rng.uniform(45500, 49900), gap_min=rng.uniform(3, 90),
                  kyc=kyc, age=age, new_payee=1 if rng.random() < 0.5 else 0)
                for _ in range(rng.randint(3, 8))], 1

    if kind == "velocity_burst":
        age = rng.randint(2000, 300000)
        return [P(amount=max(500.0, rng.lognormvariate(9.3, 0.9)),
                  gap_min=rng.uniform(0.1, 1.5), age=age, new_payee=1)
                for _ in range(rng.randint(7, 15))], 1

    if kind == "account_takeover":
        # Established account, rapid escalating drain against a fixed balance.
        age = rng.randint(50000, 500000)
        bal = rng.uniform(300000, 2000000)
        amt = rng.uniform(2000, 15000)
        out = []
        for _ in range(rng.randint(6, 14)):
            amt *= rng.uniform(1.15, 1.9)
            out.append(P(amount=min(amt, 800000.0), gap_min=rng.uniform(0.2, 2.5),
                         age=age, bal=bal, new_payee=1, ttype="TRANSFER"))
            bal = max(1000.0, bal - amt)
        return out, 1

    if kind == "mule_fan_in":
        # Fresh unverified beneficiary receiving from many distinct payers.
        # fan_in is attached at walk time.
        age = rng.randint(2, 400)
        return [P(amount=rng.uniform(40000, 500000), gap_min=rng.uniform(1, 25),
                  kyc=rng.random() > 0.8, age=age, new_payee=1, ttype="TRANSFER",
                  bal=rng.uniform(0, 20000), fan_in=rng.randint(8, 30))
                for _ in range(rng.randint(2, 6))], 1

    if kind == "mule_fan_out":
        # One account spraying to many brand-new beneficiaries.
        age = rng.randint(100, 5000)
        return [P(amount=rng.uniform(20000, 200000), gap_min=rng.uniform(0.5, 8),
                  age=age, new_payee=1, ttype="TRANSFER",
                  fan_out_boost=rng.randint(10, 40))
                for _ in range(rng.randint(5, 12))], 1

    if kind == "beneficiary_anomaly":
        # Long-dormant ordinary account, then one large payment to a new payee.
        age = rng.randint(200000, 900000)
        out = [P(amount=max(500.0, rng.lognormvariate(8.6, 0.5)), age=age)
               for _ in range(rng.randint(2, 4))]
        out.append(P(amount=rng.uniform(200000, 900000), age=age, new_payee=1,
                     ttype="TRANSFER", gap_min=rng.uniform(10, 120)))
        return out, 1

    raise ValueError(kind)


def generate(n_payers, seed=SEED):
    rng = random.Random(seed)
    kinds = [k for k, _ in MIX]
    weights = [w for _, w in MIX]
    rows = []

    for pid in range(n_payers):
        kind = rng.choices(kinds, weights=weights)[0]
        payments, is_fraud = _episode(rng, kind)

        start_hour = rng.randint(0, 23)
        start_dow = rng.randint(0, 6)
        # Fraud skews nocturnal, but plenty of honest activity is too.
        if is_fraud and rng.random() < 0.35:
            start_hour = rng.randint(0, 4)

        # Phishing-style handle: mostly fraud, occasionally an unlucky honest
        # handle, so the model cannot treat it as a hard rule.
        risky = (rng.random() < 0.25) if is_fraud else (rng.random() < 0.01)
        payer_vpa = "scamster99@okaxis" if risky else f"user{rng.randint(1,99999)}@okhdfcbank"

        elapsed = 0.0
        history = []        # (minutes, amount)
        payees_seen = set()
        payee_seq = 0

        for p in payments:
            elapsed += p["gap_min"]
            win24 = [(t, a) for (t, a) in history if elapsed - t <= 1440]
            recent = [a for (_, a) in win24][-10:][::-1]
            c10 = sum(1 for (t, _) in history if elapsed - t <= 10)
            c24 = len(win24)
            total24 = sum(a for (_, a) in win24)
            hour = int((start_hour + elapsed / 60.0) % 24)
            dow = int((start_dow + (start_hour + elapsed / 60.0) // 24) % 7)

            if p["new_payee"]:
                payee_seq += 1
                payee = f"payee{pid}_{payee_seq}"
            else:
                payee = f"payee{pid}_0"
            is_new = 0 if payee in payees_seen else 1
            payees_seen.add(payee)

            fan_out = len(payees_seen) + p.get("fan_out_boost", 0)
            fan_in = p.get("fan_in", rng.randint(0, 3))

            vec = extract(
                amount_inr=p["amount"], payer_vpa=payer_vpa, recent_inr=recent,
                txn_count_10m=c10, txn_count_24h=c24, total_inr_24h=total24,
                account_age_min=p["age"] + int(elapsed), kyc_verified=p["kyc"],
                hour_of_day=hour, day_of_week=dow, beneficiary_is_new=is_new,
                distinct_payees_24h=fan_out, payee_fan_in_24h=fan_in,
                balance_before_inr=p["bal"], txn_type=p["ttype"],
            )

            # Asymmetric label noise. Labels in payments come from disputes:
            # plenty of fraud is never reported, while an honest payment is
            # rarely labelled fraudulent. Symmetric noise at a 3% base rate
            # would swamp the positive class with mislabelled negatives.
            label = is_fraud
            if is_fraud and rng.random() < 0.05:
                label = 0
            elif not is_fraud and rng.random() < 0.001:
                label = 1

            rows.append(vec + [label, kind, f"payer{pid}"])
            history.append((elapsed, p["amount"]))

    rng.shuffle(rows)
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--payers", type=int, default=40000)
    ap.add_argument("--seed", type=int, default=SEED)
    ap.add_argument("--out", default="data/synthetic_upi_payments.csv")
    args = ap.parse_args()

    rows = generate(args.payers, args.seed)
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(FEATURE_NAMES + ["label", "typology", "payer_id"])
        w.writerows(rows)

    pos = sum(1 for r in rows if r[-3] == 1)
    print(f"wrote {len(rows):,} payments from {args.payers:,} payers -> {args.out}")
    print(f"  fraud rate: {pos/len(rows):.2%} ({pos:,} positive)")
    print(f"  seed: {args.seed}")


if __name__ == "__main__":
    main()
