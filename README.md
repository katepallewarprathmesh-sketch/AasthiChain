<div align="center">

# AasthiChain

### Own premium Indian real estate from ₹500

**Fractional property tokens on a hash-chained ledger · UPI money leg · atomic delivery-versus-payment**

[![Live](https://img.shields.io/badge/live-aasthi--chain.vercel.app-1E3A5F?style=flat-square)](https://aasthi-chain.vercel.app)
[![Backend](https://img.shields.io/badge/backend-Go%201.22-00ADD8?style=flat-square&logo=go&logoColor=white)](drunix-gateway/)
[![Frontend](https://img.shields.io/badge/frontend-React%20%2B%20Vite-61DAFB?style=flat-square&logo=react&logoColor=black)](frontend/)
[![License](https://img.shields.io/badge/license-MIT-555?style=flat-square)](LICENSE)

[Live site](https://aasthi-chain.vercel.app) · [Free calculators](https://aasthi-chain.vercel.app/tools) · [Learn](https://aasthi-chain.vercel.app/learn) · [Ledger explorer](https://aasthi-chain.vercel.app/ledger) · [UMI rail](https://aasthi-chain.vercel.app/umi)

</div>

---

## The problem

A premium flat costs ₹75 lakh. You cannot buy 0.1% of it. Selling takes months, the paperwork is
opaque, and the money leg has nothing to do with the ownership record — you pay, then you wait, and
you trust someone to update a register.

## What this is

AasthiChain converts a verified property into a fixed number of tokens. A ₹75 L villa becomes
**15,000 tokens at ₹500**. You buy 100 for ₹50,000 and own that fraction outright. The payment and
the ownership transfer are one atomic operation — both move, or neither does.

|  | |
|---|---|
| **₹500 minimum** | not ₹75 lakh |
| **Atomic settlement** | money and tokens move together, or both roll back |
| **Scarce by design** | you can only buy tokens that exist; sold-out supply is visible, never oversold |
| **One deed, one tokenization** | the same document can never be tokenized twice |
| **Verified** | a Registrar validates title before any token is minted |
| **Auditable** | every state change is a block on a hash-chained, append-only ledger |

> **Honest scoping.** The settlement rail is a faithful **simulation**. There is no public UMI API
> and no live NPCI credential available outside a bank partnership — real access is the SEBI
> Regulatory Sandbox. Every simulated surface is labelled as such in the UI and in the API
> responses. What is real: the chaincode, the ledger, the atomicity, the Go pipeline, the tests.

---

## How it works — four roles

```
  Owner                Registrar              Investor              Regulator
    │                      │                      │                      │
    ├─ lists property      │                      │                      │
    │  + documents         │                      │                      │
    │  → SHA-256 anchored  │                      │                      │
    │                      ├─ validates title     │                      │
    │                      │  → approves          │                      │
    ├─ 100% of tokens ◄────┘                      │                      │
    │  mint to owner                              │                      │
    │                                             ├─ browses, pays UPI   │
    │◄────────── atomic DvP: ₹ ⇄ tokens ─────────►│                      │
    │                                             │  owns fractions      │
    │                                             │                      ├─ audits
    │                                             │                      └─ can freeze
```

Listing is gated to the **Owner** role, so tokens always mint to the party that holds the asset —
an Investor can never end up "owning" a property merely by creating the listing.

---

## Architecture

```
                      React + Vite  (Landing · Marketplace · Dashboard · Wallet · Ledger · UMI · Tools · Learn)
                             │  REST + Clerk JWT + rate limit + idempotency keys
                             ▼
        ┌────────────────────────────────────────────────┐
        │  Node edge  (Vercel serverless / mock-api)      │  ← pure proxy for /api/umi/* and /api/drunix/*
        └────────────────────────┬───────────────────────┘     zero settlement logic lives here
                                 ▼
        ┌────────────────────────────────────────────────┐
        │  Go — drunix-gateway  :21100                    │
        │   • LP/CP 5-phase pipeline  (peer.go)           │
        │   • UMI settlement rail     (umi*.go)           │
        │   • fraud engine, 11 signals (fraud.go)         │
        │   • idempotency store        (idempotency*.go)  │
        │   • durable append-only chain (chain_store.go)  │
        └────────────────────────┬───────────────────────┘
                                 ▼
          Hash-chained ledger (SHA-512, merkle txn root)  →  Postgres / in-memory
          Chaincode (Go): property · token · kyc · SettleDvP
```

**Design rule:** settlement logic is written in **Go**, next to the ledger. The JavaScript layers are
transport only. If a rule about money lives in JavaScript, that is a bug.

---

## The settlement rails

### 1 · Drunix LP/CP pipeline — NPCI's 5-phase transaction flow

The traditional Fabric peer is split into two specialised roles — a **Lite Peer** for endorsement and
a **Committing Peer** for validation and commitment — connected by a shared StateDB and transient
store. Each phase has a guardrail proven by a test, not just implemented.

| Phase | Spec | Implementation | Guardrail proven in tests |
|---|---|---|---|
| **1 Endorsement** | Client → LP: chaincode execution, RW-set generation | `LitePeer.Endorse()` + `simulateChaincode()` + `TransientStore` | double-spend rejected at the LP, **before** ordering |
| **2 Submit** | Client collects endorsements, signs, submits | `Client.Sign()` → `Envelope` (HMAC-SHA512) | forged client signature → rejected |
| **3 Ordering** | Orderer batches txns into blocks | `Orderer` — 3 nodes, Raft-simulated leader rotation, `Cut()`, `PullNext()` | 3 buffered txns land in **one** block; leaders rotate 1→2→3 |
| **4 Validation** | VS policy + signature check, CP MVCC check | `ValidationPool` — 2 stateless VSCC instances, round-robin | same-block **and** cross-block `READ_CONFLICT` both caught |
| **5 Commit** | CP commits block, applies write sets | `ProcessBlock()` — `Ledger.Append` first, `StateDB.Apply` after | ledger carries only the private-data **hash**, never the values |

Private data travels LP → CP through the transient store and is consumed on apply; the signed
proposal and the committed block record only its SHA-512 hash. Endorsement policies are per-function:
mint = `AND(Originator, Registrar)`, freeze = `Regulator`, transfer = `AND(AasthiChain, Investor)`.

### 2 · UMI — RBI Unified Market Interface (Demat 2.0 cash leg)

In September 2026 SEBI and RBI launched **Demat 2.0**: bonds issued as native tokens on the
depositories' permissioned DLT, with the **cash leg settled in wholesale CBDC (e₹-W)** through the
Unified Market Interface — ₹1,025 crore issued by REC, L&T and IIFL. AasthiChain already had both
ends. This is the middle.

- **Atomic DvP** — validate → match → lock both legs → single-mutex commit. Failure rolls back both
  legs; there is no observable state in which one leg moved.
- **Wholesale CBDC wallets in integer paise.** `GET /umi/reconciliation` proves
  `Σ balances == lifetime funding` (`"conserved": true`) — the rail cannot create or destroy central
  bank money. No floats anywhere near money.
- **Instruction lifecycle** `CREATED → MATCHED → LOCKED → SETTLED | FAILED`, with a pilot ISIN
  register (`AASTHI******`).
- **Programmable servicing** — `POST /umi/servicing` pays rent or coupon pro-rata straight into
  holders' CBDC wallets on the due date. No registrar file exchange.
- **ISO 20022 trace** per instruction: `sese.023 → sese.024 → pacs.009 → sese.025 → camt.054`
  (failures end at `sese.024 + camt.019`).
- **Request idempotency** on `POST /umi/dvp`, `/umi/servicing` and `/umi/wallets/{id}/fund` — see below.

Settlement errors are explicit, never generic: `ERR_UMI_INSUFFICIENT_CBDC`,
`ERR_UMI_INSUFFICIENT_SECURITIES`, `ERR_UMI_NOT_PILOT_ELIGIBLE`, `ERR_UMI_NO_WALLET`,
`ERR_UMI_SELF_SETTLEMENT`.

### 3 · Money leg — UPI Collect

- UPI Collect P2M + IMPS UTR, amounts in **paise as `int64`**, state machine
  `PENDING (5 min) → CONFIRMED (KYC + balance) → RELEASED (after transfer) | REFUNDED`.
- **PayU test-mode** gives a real PSP round-trip against `https://test.payu.in/_payment` —
  SHA-512 request signing, reverse-hash callback verification, `mihpayid` / `bank_ref_num`
  references, `verify_payment` reconciliation. Enable with `NPCI_MODE=payu`. Settlement stays
  simulated; no real money moves.
- **Fraud-gated**: every collect is risk-screened by an 11-signal explainable engine before approval.
  `BLOCK ≥ 70` → `403 FAILED_FRAUD_BLOCKED`, `REVIEW ≥ 40`, re-screened at approve. Blocked attempts
  never feed velocity counters.
- Real path is a one-line toggle: `NPCI_MODE=real` + a certified switch (Setu) or PSP bank.

---

## Correctness properties

These are the guarantees worth reviewing, each backed by a test rather than a claim.

#### The ledger is append-only and survives restart

Blocks are written to durable storage (`chain_store.go`, Postgres table `umi_block`) before the
in-memory state is updated. Once committed, a block is never erased — including across process
restarts. Tampering is detectable: each block carries the SHA-512 of its predecessor, and
`/api/chain/verify` walks the whole chain.

#### Settlement is idempotent

Send `Idempotency-Key` (or `X-Idempotency-Key`) on any settlement POST. The key is bound to
`sha256(method + path + body)`:

| Situation | Response |
|---|---|
| First request | processed normally |
| Exact replay | original response, header `Idempotent-Replay: true` |
| Same key, **different** body | `422 ERR_IDEMPOTENCY_KEY_REUSED` |
| Same key, still in flight | `409` |
| Key longer than 255 chars | `400` |

Failures are recorded too, so a retry cannot turn a rejection into a success. Backed by Postgres
`ON CONFLICT DO NOTHING` when `DATABASE_URL` is set, in-memory otherwise, 24-hour TTL.
**Proven under concurrency:** 8 simultaneous duplicate requests produce exactly one settlement, one
debit and one new block.

#### Money is conserved

The stress test fires concurrent settlements against a wallet until it is empty, then asserts
balance `= 0`, reserved `= 0`, `conserved = true` and `chain valid = true`. No double-spend, no
leaked locks.

#### Holder identity is private

Anonymous reads of a property return `Investor A`, `Investor B`, … with `anonymised: true` and a
`holderCount`. Real identities require authentication. The marketplace is publicly browsable without
leaking a cap table.

---

## Authentication

**Sign-in is the only way in.** Earlier builds shipped one-click demo role buttons; those are gone,
and the removal went deeper than the UI:

1. **Entry points removed** — the landing-page role cards and the login-page presets are gated behind
   a build-time flag, so Vite eliminates them from the production bundle entirely.
2. **Existing sessions evicted** — stored demo sessions and expired tokens are purged on load, so
   anyone still carrying one from a previous visit is signed out rather than grandfathered in.
3. **Server-side minting closed** — `POST /api/auth/login` now returns `404` unless `DEMO_AUTH=true`.
   Demo tokens are HMAC-signed (`payload.signature`) with a per-cold-start random secret and verified
   with a timing-safe comparison plus an expiry check, so a token cannot be crafted offline even in
   development mode.

Production uses **Clerk**. Public routes — the marketplace, the ledger explorer, the calculators and
the articles — remain open to visitors and crawlers. Money routes (`/dashboard`, `/wallet`, `/admin`,
`/regulator`) require a session.

> **Operational note:** leave `DEMO_AUTH` **unset** in production. Setting it to `true` re-opens the
> development login endpoint.

**Clerk signatures are verified** against Clerk's published JWKS (RS256, Node's built-in crypto, no
added dependency). `alg: none` and HS256 key-confusion are rejected, as are unknown key IDs, expired
or not-yet-valid tokens, and tokens from another issuer. Key rotation is picked up without a
redeploy: an unrecognised `kid` triggers one forced JWKS refresh. If Clerk is unreachable the cached
keys keep being used, because locking every user out during someone else's incident is worse than
trusting a signing key for an extra hour.

Verification is **opt-in via `CLERK_ISSUER`**. Unset, the API keeps the old decode-only behaviour —
switching this on with the wrong issuer would lock out every real user, so it is a deliberate
configuration step rather than a surprise. **Set `CLERK_ISSUER` to your Clerk Frontend API URL
(`https://<your-instance>.clerk.accounts.dev`, or your production domain) to fail closed on anything
unverifiable.**

---

## Free tools and explainers

Single-purpose calculators, each a public page that stands on its own. All INR, all Indian tax and
stamp-duty rules, no sign-up.

| Tool | What it answers |
|---|---|
| [Rental yield](https://aasthi-chain.vercel.app/tools/rental-yield-calculator) | gross vs net yield after maintenance, tax and vacancy |
| [Fractional investment](https://aasthi-chain.vercel.app/tools/fractional-investment-calculator) | what ₹X buys, and what it returns |
| [Stamp duty & registration](https://aasthi-chain.vercel.app/tools/stamp-duty-calculator) | state-wise duty on `max(price, circle rate)`, capped registration, 1% TDS above ₹50 L |
| [Home loan EMI](https://aasthi-chain.vercel.app/tools/home-loan-emi-calculator) | EMI, amortisation, s.24(b) and 80C relief |
| [Rent vs buy](https://aasthi-chain.vercel.app/tools/rent-vs-buy-calculator) | the year the two curves cross |
| [Capital gains tax](https://aasthi-chain.vercel.app/tools/capital-gains-tax-calculator) | LTCG/STCG, the 23 Jul 2024 regime change, grandfathering, s.54 / 54EC / 54F |

Explainers: [Demat 2.0](https://aasthi-chain.vercel.app/learn/what-is-demat-2) ·
[Unified Market Interface](https://aasthi-chain.vercel.app/learn/what-is-umi) ·
[Atomic DvP](https://aasthi-chain.vercel.app/learn/what-is-atomic-dvp)

The capital-gains rules were verified by reproducing two independently published worked examples to
the paisa, which is also how a 24-month boundary defect and a leap-day `setMonth` overflow were found.

---

## Quick start

```bash
# 1 — frontend only (no Go, no Docker)
cd frontend && npm install && npm run dev        # :5173

# 2 — with the Go settlement rail
cd drunix-gateway && go test ./... && go run ./cmd/gateway   # :21100
UMI_GATEWAY_URL=http://localhost:21100 node mock-api-server.js  # :8080, proxies /api/umi/*

# 3 — everything, including the Fabric network
cd network && docker-compose up -d && ./scripts/create-channel.sh
```

Or `make umi`.

**Seeing "Rail offline" on the deployed site?** Expected. Vercel runs only the Node edge; the Go rail
needs a host. `render.yaml`, `drunix-gateway/Dockerfile` and `fly.toml` are included — deploy it,
then set `UMI_GATEWAY_URL` on Vercel and redeploy. Hosted instances auto-seed demo wallets
(`UMI_SEED_DEMO=false` to disable).

### Environment

| Variable | Where | Purpose |
|---|---|---|
| `VITE_CLERK_PUBLISHABLE_KEY` | Vercel | Clerk auth. Use a `pk_live_` production key. |
| `UMI_GATEWAY_URL` | Vercel | points the proxy at the Go rail |
| `DATABASE_URL` | Render | Postgres — durable blocks and idempotency. Without it, in-memory. |
| `UMI_ENABLED`, `UMI_SEED_DEMO`, `DRUNIX_MODE` | Render | rail configuration |
| `ADMIN_DASHBOARD_KEY` | Vercel only | private `/insights` analytics |
| `CLERK_ISSUER` | Vercel | Clerk Frontend API URL. Set it to enforce JWT signature verification. |
| `DEMO_AUTH` | — | **leave unset in production** |
| `NPCI_MODE`, `PAYU_MERCHANT_KEY`, `PAYU_SALT` | local | `mock` · `payu` · `real` |

`.env.payu` is gitignored. Never commit credentials.

---

## Testing

```bash
cd chaincode        && go test -v          # property, token, KYC, duplicate-deed guard
cd drunix-gateway   && go test ./...       # 62 tests — pipeline, UMI, idempotency, durability
cd payment-gateway  && go test -v && node gateway.test.js   # 43 tests incl. PayU
cd frontend         && npm run build && npm run smoke       # 26 routes render
node tests/clerkjwt.test.mjs                # 21 Clerk JWT cases incl. alg:none and HS256 confusion
node tests/demotoken.test.mjs               # 8 demo-token cases, read from the real source file
node tests/transferhistory.test.mjs         # 11 paging/ordering/privacy checks (servers must be up)
node tests/integrity.test.mjs               # 11 operator integrity verdicts under injected faults
bash regression.sh                          # 44 end-to-end checks
```

The regression suite is the gate: **nothing is pushed before it reports 44/44.**

---

<details>
<summary><b>API reference</b> — click to expand</summary>

### Settlement — Go rail, `:21100`

| Endpoint | Purpose |
|---|---|
| `POST /umi/dvp` | atomic delivery-versus-payment · `{assetId, seller, buyer, tokens, pricePerTokenINR}` |
| `POST /umi/servicing` | pro-rata coupon/rent to CBDC wallets · `{assetId, payer, amountINR}` |
| `POST /umi/wallets/{id}/fund` | fund an e₹-W wallet |
| `GET /umi/reconciliation` | conservation proof — `Σ balances == lifetime funding` |
| `GET /umi/chain` | UMI block trail |
| `GET /umi/participants`, `/umi/isins`, `/umi/instructions` | registry, pilot ISINs, instruction lifecycle |
| `GET /umi/income/{identityId}` | per-investor rental and coupon income history |
| `POST /drunix/pipeline` | full 5-phase run with a per-txn phase trace |
| `GET /drunix/pipeline/stats` | orderer batch/leader state, VS pool, StateDB, chain verification |

All three settlement POSTs accept `Idempotency-Key`.

### Ownership and payments — Node edge

| Endpoint | Purpose |
|---|---|
| `POST /api/properties` | register · `409 ERR_DUPLICATE_PROPERTY` on repeat |
| `GET /api/properties/:id` | detail incl. `availableTokens` / `soldTokens`, holders anonymised when unauthenticated |
| `POST /api/transfers` | transfer tokens, availability re-checked server-side |
| `GET /api/balances/wallet/:ownerId` | portfolio |
| `GET /api/transfers/history?bookmark` | paginated history |
| `POST /api/npci/collect` | initiate UPI Collect, fraud-screened |
| `POST /api/npci/payments/:id/{approve,release,refund}` | payment lifecycle |
| `POST /api/npci/payu/callback` | PayU `surl`/`furl` — reverse-hash verified, amount-reconciled, idempotent |
| `GET /api/chain/verify` | walk and verify the hash chain |
| `GET /api/portfolio/:identityId/nav` | continuous NAV — tokens × price + yield − obligations |

### Programmable ownership

| Endpoint | Purpose |
|---|---|
| `POST /api/properties/:id/yield/distribute` | pro-rata yield → `YIELD_DISTRIBUTED` block |
| `POST /api/properties/:id/governance` + `/vote` | proposals, 1 token = 1 vote, 20% quorum |
| `POST /api/credit/pledge` · `/api/credit/repay` | borrow against fractions, 50% LTV cap, repay ×1.01 |
| `POST /api/swap` | atomic multi-property swap — both sides or neither |

Guardrails surfaced to the UI: `ERR_TOKENS_LOCKED`, `ERR_LTV_LIMIT`, `ERR_NO_VOTING_POWER`,
`ERR_COUNTERPARTY_SHORT`, `ERR_ALREADY_RESOLVED`, `ERR_ALREADY_REPAID`.

### Block types on the chain

`YIELD_DISTRIBUTED` · `GOVERNANCE_RESOLVED` · `LOAN_REPAID` · `ATOMIC_SWAP` ·
`UMI_WALLET_FUNDED` · `UMI_ISIN_ASSIGNED` · `UMI_DVP_SETTLED` · `UMI_DVP_FAILED` ·
`UMI_SERVICING_PAID`

</details>

<details>
<summary><b>What is live vs simulated</b> — click to expand</summary>

**Live and real:** the chaincode and its duplicate-deed guard, the hash-chained append-only ledger,
the Go LP/CP pipeline with Raft-simulated ordering, MVCC conflict detection, the fraud engine,
atomic DvP and its rollback, idempotency under concurrency, conservation of money, Clerk
authentication, Postgres persistence, and the full test suite.

**Simulated, and labelled as such:** the NPCI UPI rail (no live credentials exist outside a bank
partnership — PPRO reports "Sandbox Not Available from UPI"; API Setu is sandbox-only), wholesale
CBDC wallets (e₹-W is an RBI pilot, not a public API), the UMI rail itself (real access is the SEBI
Regulatory Sandbox), DigiLocker KYC (Requester onboarding requires entity registration, an official
domain, a digital signature, India-hosted servers and a 4–8 week MeitY review — explicitly no
temporary test access), the DILRMP land-record hash, and the Sepolia escrow experiment.

**PayU test mode is genuinely real** as far as it goes: signed forms from the collect endpoint are
accepted by `test.payu.in/_payment`, and tampered amounts and garbage hashes are rejected
server-side by PayU. Only the settlement behind it is simulated.

</details>

<details>
<summary><b>Regulatory context</b> — click to expand</summary>

The **Asset Tokenisation (Regulation) Bill 2026** is a pending Private Member's Bill, not law. It
proposes KYC/AML obligations, a registered custodian, registrar validation and a regulator freeze
power. AasthiChain maps to all four: a Registrar org validates title, a Regulator org can freeze, the
cap table is auditable end to end, and the payment path enforces a KYC gate
(`FAILED_KYC_NOT_VERIFIED → REFUNDED`).

**SPV structure.** Real platforms wrap each property in a special-purpose vehicle, so a token is a
beneficial interest in the SPV that holds legal title (Registration Act 1908 + the 2026 Bill). That
is a legal structure, not a code change, and is documented as Phase 2 rather than built.

</details>

---

## Support

The in-app [Support page](https://aasthi-chain.vercel.app/support) carries UPI and GitHub Sponsors
links. These are **donations to the project, not investments** — they buy no tokens and no stake.

<div align="center">

**[aasthi-chain.vercel.app](https://aasthi-chain.vercel.app)** · MIT licensed

</div>
