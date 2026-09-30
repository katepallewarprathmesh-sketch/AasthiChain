# UMI pattern conformance checklist

An open, testable checklist for tokenised delivery-versus-payment, derived **only** from
publicly published descriptions of SEBI's Demat 2.0 pilot and the RBI's Unified Market
Interface.

Anyone may copy this checklist and the accompanying test suites. The goal is that
"we follow the Demat 2.0 pattern" becomes a claim a reviewer can run, rather than a
sentence on a slide.

**AasthiChain is not connected to, approved by, or in a pilot with RBI, SEBI, NPCI,
NSDL or CDSL.** This document describes a simulation of a published pattern.

---

## How to run it

```bash
# Go reference implementation
cd payment-gateway && go test ./settlement/ -v

# JavaScript mirror, live over HTTP
node mock-api-server.js
curl -s localhost:8080/api/umi/conformance | python3 -m json.tool
```

Both suites must pass. They test the same behaviours in two languages so that neither
implementation can quietly drift from the pattern.

---

## The checklist

### C1 — The rail never claims to be real

Every capability response and every settlement receipt must report `simulated: true`,
`centralBankMoney: false`, and `regulatoryStatus: SIMULATED_NOT_CONNECTED`, unless the
implementation genuinely holds a connection to central bank money.

Rationale: the single largest risk in this space is a demo being mistaken for regulated
infrastructure. The honesty flag is therefore a *tested invariant*, not documentation.

**AasthiChain: PASS** — enforced at the serialisation choke point in both
`payment-gateway/settlement/rail.go` (`AssertSimulated`) and
`frontend/api/lib/umi_sim.js` (`decorate`).

---

### C2 — Reserving the cash leg moves no money

Before the two legs are matched, the payer's funds must be *held*, not *moved*. Balance
must be unchanged; only the held amount rises; the payee must not be credited.

Rationale: this is what makes the later commit atomic — the funds are proven to exist
and cannot be spent elsewhere, so settlement cannot fail for insufficiency.

**AasthiChain: PASS**

---

### C3 — Both legs commit together, with linked references

A settlement receipt must carry both the security-leg reference (the ledger transaction
id) and the cash-leg reference. One without the other is not delivery-versus-payment.

Rationale: SEBI's stated benefit is the removal of the gap between the bond moving and
the money moving. An implementation that cannot tie the two references together has not
removed that gap; it has only hidden it.

**AasthiChain: PASS**

---

### C4 — A settled reservation cannot be replayed

Re-submitting a settled lock must fail with an explicit "already consumed" error and
must not move money a second time.

**AasthiChain: PASS**

---

### C5 — A mismatched security leg aborts with no money moved

If the security leg names different counterparties, a different token count, or has no
ledger reference, settlement must be refused. Balances must be untouched, and the
reservation must survive so the caller can retry or unwind deliberately.

Rationale: a rail that settles cash against an unverified security leg is a payment
system with extra steps.

**AasthiChain: PASS**

---

### C6 — Wallets cannot be oversubscribed

Concurrent reservations against one wallet must respect available balance
(balance minus existing holds), not gross balance.

**AasthiChain: PASS**

---

### C7 — Corporate actions pay everybody or nobody

Automated servicing — coupon, rent, yield, redemption — must be all-or-nothing across
all holders, must be computed in the smallest currency unit (paise), and must conserve
value exactly: the sum credited must equal the amount debited.

Rationale: SEBI describes interest and redemption reaching holder wallets automatically
on the due date. A partial distribution is worse than no distribution, because it
creates a reconciliation problem that the pattern exists to remove.

**AasthiChain: PASS**

---

### C8 — Invalid amounts are rejected before any state changes

Zero, negative, and non-integer amounts must be rejected without creating a hold or a
ledger entry.

**AasthiChain: PASS**

---

### C9 — Unknown participants cannot transact

Every party to a trade must have a registered wallet. No implicit account creation
during a settlement.

**AasthiChain: PASS** (Go suite)

---

### C10 — Money is never represented as a floating-point number

All amounts are integers in paise, end to end.

**AasthiChain: PASS** — `int64` in Go, `Number.isInteger` guards in JavaScript.

---

## Deliberately out of scope

These cannot be claimed by any independent implementation, and an honest conformance
report should say so explicitly rather than omit them:

| Property | Why it is out of scope |
|---|---|
| Real wholesale CBDC (e₹) | Requires a wallet at a participating bank under RBI's pilot |
| Depository ownership of the ledger | The Demat 2.0 ledger is owned by NSDL and CDSL |
| Statutory investor protections | Attach to the legal instrument, not to the software |
| Connection to UMI | Not an open API; participation limited to supervised institutions |
| Regulatory approval or sandbox admission | Granted by a regulator, never self-asserted |

---

## Applying the pattern to real estate

Demat 2.0 covers corporate bonds. Real-estate fractional ownership in India sits under a
different regime: since the **SEBI (REIT) (Amendment) Regulations, 2024**, fractional
ownership platforms must register as **SM REITs** — scheme asset value ₹25–500 crore,
pooling from ₹50 crore, minimum 200 investors, **minimum ₹10 lakh per investor**,
investment manager net worth ₹20 crore, units listed, and at least 95% of assets
completed and rent-generating.

Consequently:

- The **₹500** figure in AasthiChain demonstrates divisibility. It is **not** a lawful
  retail minimum for a real offering today.
- The issuer in this simulation is modelled as an **SPV under an SM REIT scheme**, which
  is the structure the regulations actually contemplate.
- Redemption is modelled as **trustee-gated**, mirroring the debenture-trustee role that
  Demat 2.0 leaves unchanged.

---

## Source material

- SEBI press release and FAQs on the Demat 2.0 pilot, 10 September 2026 —
  <https://taxguru.in/sebi/demat-2-0-tokenised-corporate-bonds-pilot-faqs-sebi.html>
- Bloomberg Global Regulatory Brief, September 2026 —
  <https://www.bloomberg.com/professional/insights/regulation/september-2026-global-regulatory-brief-token-securities-stablecoins-and-tokenized-bonds/>
- UMI mechanics and the certificate-of-deposit pilot —
  <https://www.indoneo.com/capital/india-digital-rupee-bonds-demat-2-0-settlement/>
- Phase roadmap (RFQ secondary trading, retail access) —
  <https://www.medianama.com/2026/09/223-sebis-demat-2-0-tokenised-corporate-bonds/>
- SM REIT framework —
  <https://www.livemint.com/money/sebi-notifies-small-and-medium-reits-11709999868347.html>
