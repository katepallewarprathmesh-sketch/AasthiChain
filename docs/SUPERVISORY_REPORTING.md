# Supervisory reporting

**Status: simulated. Nothing in this document has been filed with, seen by, or approved by SEBI, RBI, NPCI, NSDL or CDSL.**

## Why this exists

A regulator does not publish an API you can connect to. There is no endpoint at SEBI or RBI that a startup can dial, and there should not be — participation in market infrastructure is limited to supervised institutions that have passed fit-and-proper tests.

Supervision runs the other way round. The supervised entity produces evidence in a defined shape, and the regulator consumes it. So the useful question is not "how do we connect to the regulator" but "can we produce what a regulator consumes, and does it survive inspection".

This surface answers the second question. It is the part that can be built honestly today, and it is the part a sandbox application is actually judged on.

## What is produced

| Report | Endpoint | What it proves |
|---|---|---|
| Unit holder register | `GET /api/regulator/cap-table` | Who holds what; whether the register reconciles with issued tokens; how concentrated the book is |
| Audit export | `GET /api/regulator/audit-export` | Every movement, hash-chained so tampering is detectable |
| Audit verification | `POST /api/regulator/audit-verify` | Independent re-derivation of that chain |
| Suspicious activity | `GET /api/regulator/alerts` | Six rules over live state, each alert carrying its evidence |
| SM REIT gap analysis | `GET /api/regulator/scheme-report` | Distance between this platform and SEBI Chapter VIB |
| Action log | `GET /api/regulator/actions` | Every freeze and unfreeze, with reason and named actor |
| Capabilities | `GET /api/regulator/capabilities` | What is modelled, and plainly what is not |

`GET /api/regulator/capabilities` is public. Everything else requires the `Regulator` role and returns `403 ERR_NOT_A_REGULATOR` otherwise — these reports expose every holder's position across the whole book.

## Design decisions worth defending

### The cap table replays; it does not relabel

`?asOf=<ISO timestamp>` rolls holdings backwards through every transfer recorded after the cutoff. The response reports `asOfMode: REPLAYED_TO_CUTOFF` and how many transfers were rewound.

A historical cap table you cannot re-derive is not evidence, it is an assertion. Any system that answers "as of last Tuesday" by relabelling today's balances will be caught the first time someone checks.

### The audit export is tamper-evident, and its signature is honestly weak

Each record is hashed with SHA-512, and each hash folds in the previous one:

```
recordHash = SHA512(canonical(record))
chainHash  = SHA512(previousChainHash + recordHash)
```

Edit one row and every hash after it changes. Delete one and the chain breaks at that point. `POST /api/regulator/audit-verify` re-derives the whole thing from the document alone and reports the exact row that failed.

The chain head is then signed with HMAC-SHA512 — and the response says exactly what that is worth:

```json
"keyCustody": "DEMO_KEY_IN_PROCESS_NOT_AN_HSM",
"legalWeight": "NONE — demo key held in process memory, not an HSM or a registered signing certificate"
```

The integrity chain is real cryptography. The signature proves only that this server produced the document. Claiming more would be the exact failure mode this whole surface exists to avoid.

The UI exposes a **"Tamper with a row, then verify"** button that edits a record in the browser before sending it. It is there so the check can be seen failing, not just passing.

### The gap analysis is allowed to fail

`GET /api/regulator/scheme-report` measures a scheme against SEBI (REIT) Regulations 2014, Chapter VIB. On the seeded demo it returns:

> This scheme would not be registrable as an SM REIT today: 3 requirement(s) fail and 6 are not modelled by the platform at all.

Failures on the demo data include:

| Requirement | Source | Observed |
|---|---|---|
| Scheme asset value ₹50 cr–₹500 cr | Reg. 26T | ₹0.75 crore — below the floor by ₹49.25 crore |
| At least 200 unrelated investors | Reg. 26U | 2 holders |
| Minimum ₹10 lakh per investor | Reg. 26U(2) | Smallest holding ₹5.00 lakh; token price ₹500 |

Six further requirements return `NOT_MODELLED` rather than a fake pass — rent rolls, leverage, manager net worth, co-investment, listing and SPV structure. Each states what it would take to model.

A compliance report that always returns PASS is theatre. This one is designed to be quotable against us.

### A freeze without a reason is refused

Both `POST /api/regulator/freeze` and the older `POST /api/properties/:id/freeze` now write to the same append-only, hash-linked action log, and both reject the call with `ERR_REASON_REQUIRED` if no written reason is supplied. The actor is taken from the authenticated identity, never from the request body.

A status change nobody can account for afterwards is not a supervisory act. `POST /api/regulator/unfreeze` restores the previous status and is refused with `409 ERR_NOT_FROZEN` if the asset was not frozen.

### The six alert rules

| Rule | Trigger | Severity |
|---|---|---|
| SAR-01 | Payment blocked or flagged by the fraud engine | High |
| SAR-02 | Holder above 25% of issued tokens (the issuer's unsold inventory is excluded) | Medium |
| SAR-03 | More than 5 transfers by one party in 24 hours | Medium |
| SAR-04 | Tokens held by a party without verified KYC | High |
| SAR-05 | Three or more payments between ₹40,000 and ₹50,000 by one payer | Medium |
| SAR-06 | Any movement recorded against a frozen asset | High |

Each alert carries the subject, the evidence that triggered it, and a recommended action, so a reviewer can argue with the rule rather than accept its verdict. Dispositions — `UNDER_REVIEW`, `CLEARED`, `ESCALATED` — persist across reads.

SAR-05's band is anchored to the ₹50,000 threshold at which Indian financial institutions face additional identification duties; clustering just underneath it is the classic structuring signature.

## Running the checks

```bash
node mock-api-server.js &
node scripts/supervision-smoke.mjs
```

54 assertions covering access control, reconciliation, point-in-time replay, chain verification, tamper detection on both edited and deleted rows, CSV disclosure footers, true positives and true negatives on the alert rules, mandatory-reason enforcement, and the gap analysis failing where it should. The suite runs in CI on every push.

The tamper cases are the ones to read first — `S6` edits a record and deletes another, and requires both to be caught.

## What this is not

- Not a filing. There is no submission, transmission or lodgement of any kind.
- Not an approval. No regulator has acknowledged this platform's existence.
- Not a legally recognised signature. The key is a process-local demo secret.
- Not a substitute for registration. AasthiChain holds no SEBI registration and is not an SM REIT.

## The honest route to an actual regulator

SEBI runs two separate tracks, and the distinction matters:

- **Innovation Sandbox** — offline, works against market data from exchanges and depositories, and is **open to entities that are not SEBI-registered**, including individuals. This is the door an unregistered team can walk through.
- **Regulatory Sandbox** — live testing with case-specific relaxations, but **open only to SEBI-registered intermediaries**. Reaching it requires a registered partner. This is precisely how Demat 2.0 itself is being run.

The reporting surface in this document is what an application to either would point at.

## References

- SEBI (Real Estate Investment Trusts) (Amendment) Regulations 2024 — Chapter VIB, Small and Medium REITs
- SEBI Innovation Sandbox and Regulatory Sandbox frameworks
- `docs/UMI_ALIGNMENT_PLAN.md` — how the settlement rail relates to RBI's Unified Market Interface
- `docs/UMI_PATTERN_CONFORMANCE.md` — the settlement conformance checklist
