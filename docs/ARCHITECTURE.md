# Architecture and internals

This is the detail the README deliberately leaves out: where each rule lives, what the
repository contains, and every configuration switch. Read the README first for what the
platform does.

---

## How the layers divide

### The design rule

Every rule about money lives in one place: the settlement core, beside the ledger it protects. The
layers in front of it carry requests and identity and nothing else. **If a rule about money can be
found anywhere but the core, that is a bug.**

Concretely: the settlement core is Go, the web app and its API edge are JavaScript, and the edge
forwards settlement calls without deciding anything about them. The edge owns the property register,
KYC and the UPI payment lifecycle; it does not own balances, positions or the chain.

### The five layers

| Layer | Responsibility | Lives in |
|---|---|---|
| **Experience** | what each role can see and do, and the public pages anyone may read | `frontend/src` |
| **Access** | establishes who is calling, decides what that caller may touch, and keeps the listing register | `frontend/api/index.js`, `server.js` |
| **Settlement** | holds the cash leg and the ownership leg, and moves them as one | `drunix-gateway/umi.go` |
| **Work** | escrows a fee against a deliverable, releases it only against anchored evidence | `drunix-gateway/work*.go` |
| **Record** | the append-only history every other layer answers to | `drunix-gateway/chain.go` |

The experience and the settlement core deploy independently, so either can be replaced, or fail,
without the other. When the core cannot be reached the app reports *unknown*; it never reports a
settlement surface as healthy because it could not ask.

### Authorisation

Entitlement is decided in front of the router rather than route by route, so a new surface is covered
the day it ships:

- an unidentified caller is refused with 401, a stranger with 403;
- a supervisor (regulator or admin) may act for someone else where that is the role's job;
- attribution always comes from the authenticated caller, never from a field in the request body;
- reads are scoped as tightly as writes, including diagnostics, receipts and reconciliation views.

Each rule ships with a suite asserting the refused action changed no state.

### The record

Blocks are hash-linked and written to durable storage **before** in-memory state is updated, so
nothing can be true in the app and missing from the history. A block's transactions are frozen at
commit: contents can never drift from the merkle root they were hashed with, in memory or after a
reload.

If a stored chain fails verification on restore, the rail seals itself and serves read-only rather
than extending history it cannot vouch for. The way back is a supervisor-only repair that records, on
the chain, every height and hash it dropped and who authorised it.

### Two API implementations

`frontend/api/index.js` is the serverless handler production serves. `mock-api-server.js` is an
Express rig used for local payment testing and as a fixture by several suites. **They implement the
same surface and must be patched together**. A fix applied to one is live in exactly one
environment.

---

---

### Proof of backing

Tokenised assets fail when issuance outruns the thing behind it. A registrar (or a supervisor)
records a statement for one asset: how many units exist, what they are valued at, the method used,
a hash of the evidence, and how often the statement must be refreshed (90 days by default, one hour
minimum, one year maximum). Issuance is then checked against that figure: anything that would push
the book past the attested units is refused, and the refusal is committed as a block so the gate
itself can be audited.

Four points the layer is careful about:

- An asset with no statement behaves exactly as it did before. The gate binds only where someone
  has given it something to bind to.
- Blocking is never reversing. Nothing is burned or unwound; an asset that is already over-issued
  is reported as such rather than quietly corrected.
- A statement that is past its refresh date stops authorising issuance. Stale evidence is evidence
  about the past.
- The attestor cannot be the beneficiary, and the rail says plainly that it checks arithmetic, not
  reality. A false statement here produces a precise, well-evidenced, false number.

Statements are replaced rather than edited, and both the statement and its withdrawal are replayed
from the chain at startup.

### Agent identity

A software actor on the rail acts under a pseudonym rather than under its principal's name. The
principal is split across named custodians with Shamir's secret sharing, and recovering it takes a
threshold of them: a request with a stated trigger, then one approval per custodian, each of which
is a block. Fewer than the threshold recover nothing, which is a property of the arithmetic rather
than a promise.

The limits are stated in the API responses, not only here. Every share lives in this one process,
so the protocol is real and the distribution is simulated; real custody means one share per
organisation. The pseudonym is re-identifiable by design, so it remains personal data. A revoked
agent stops acting, but who was accountable for what it already did stays recoverable, and an
identification request that nobody completes lapses and is recorded as an unanswered ask.

Design note, including why the alternative architectures were not chosen:
[`AGENT_IDENTITY.md`](AGENT_IDENTITY.md).

### Cross-border funding

A buyer outside India cannot be let in by a payment rail alone. A foreign national of non-Indian
origin resident outside India cannot acquire Indian immovable property at all, and for a buyer who
can, the consideration has to arrive in rupees through banking channels: cryptocurrency and digital
tokens are not a permitted method. This layer therefore models the one structure that survives both
facts. A stablecoin is received and converted outside India, and the buyer's rupee wallet is
credited only against a provider attestation carrying a bank advice reference and a purpose code.

Eligibility is screened before a quote exists, Travel Rule records are mandatory above the
threshold, the quote carries an expiry, and the destination of the transfer is the off-ramp rather
than the seller. Refusals are committed as blocks for the same reason the other gates commit them.
Nothing is connected to a chain: a transfer reference is recorded, not verified, and the rate is
configured rather than quoted.

Design note, including the research behind it and a separate assessment of token-sale fundraising:
[`CROSS_BORDER.md`](CROSS_BORDER.md).

### Public-chain anchoring

The head of the permissioned ledger is published to a public Solana cluster as a memo carrying the
chain id, block height, block hash and transaction root, and nothing else. Verification reads the
transaction back, finds the local block at that height and compares the hashes, reporting a
mismatch rather than swallowing it.

There is no SDK underneath this: base58, the compact-u16 wire prefix, the legacy message layout and
ed25519 signing are implemented in the module, which means the encodings are unit tested against
known vectors without a network or a key. Reads are live and free; writing needs a funded key and
is off until it has one. Supervisors only, because a fee is spent and publication cannot be undone.

Runbook and the limits of the claim: [`ANCHORING.md`](ANCHORING.md).

### A restricted token on the EVM

Anchoring proves a block happened. It does not let a holder prove a position, so there is also a
token contract: an ERC-20 base carrying the ERC-7943 restriction interface, arranged the way
ERC-3643 arranges a permissioned security token, with the balances in the token, eligibility in an
identity registry, the rules of the offering in a compliance contract, and the issuer and regulator
powers behind agent roles.

Two choices are worth stating because they were close. ERC-1400 was not used: its one real
advantage is partitions, which a single property's fractional interest does not need, and the
family never left Draft. ERC-3643's own identity half was not used either, because this system
already has decentralised identifiers, signed credentials, KYC tiers and a key register, and a
second identity system that has to agree with the first is a defect waiting for a date. ERC-7943 is
identity-agnostic on purpose, which is the right seam when the identity layer already exists.

Every ordinary movement passes through one internal gate, so a restriction cannot be avoided by
using an approval instead of a transfer, and minting faces the same eligibility check as a
purchase. The forced transfer that an estate or a court order needs is restricted to an agent and
still refuses to place tokens with somebody who may not hold them.

This leg is a mirror. Settlement, the cash leg and conservation stay on the permissioned rail,
because finality on a public chain follows rules a regulator does not set. The contract carries the
rail's asset id and records which rail position it is mirroring, so a reader can tell whether the
mirror is current instead of assuming it.

### The keys that sign

A signature is only worth the key behind it, and the industry spent October 2026 relearning that
when eight certificate authority private keys turned out to be recoverable from their own public
certificates. So the keys here are registered rather than assumed: a key is screened before it
enters service, registration needs a signed challenge so the holder proves possession, duplicates
are refused, and the register itself is on the ledger, which means a revocation is a recorded event
rather than an email.

The screen rejects small scalars, repeated-byte seeds, known low-order points and reuse. It is
worth being precise about what passing means: it means no known-bad pattern was found, not that the
key was generated well. Entropy cannot be proved after the fact, and every verdict says so.

Revocation distinguishes a compromise from a retirement, because only the first makes earlier
signatures worthless.

Key handling end to end: [`KEYS.md`](KEYS.md).

### CBDC settlement layer

`cbdc.go` holds the money itself: accounts in integer paise across a retail and a wholesale
segment, issuance and redemption restricted to the central bank role, and KYC tiers that cap
balances and payment sizes on the retail side. `Conservation()` proves issued equals held plus
redeemed and is served publicly.

Three mechanisms sit on top. `Grant` and `Spend` implement purpose-bound money against the
parameters the regulator lists (expiry, merchant category, named merchants, geography), and a
failed condition commits a `UMI_CBDC_REFUSED` block rather than returning quietly.
`IssueOffline` and `RedeemOffline` implement the offline path: value is reserved out of the online
balance, the voucher carries an HMAC the accepting device can check without connectivity, and the
nonce index turns a double spend into a deterministic refusal. `OpenCondition`, `SubmitEvent` and
`SweepConditions` hold money against an attested event, release it to the payee when the named
attestor reports the event, and return it to the payer at the deadline.

Every movement carries a `Finality` record with the technical and financial parts kept separate,
and an `AMLCheck` built from the rules and the trained model in the risk layer. Routes live under
`/umi/cbdc/*`; the layer is additive and unmounts cleanly when the rail or chain is absent.

Design note, the regulator's published pilot behaviour and the phases still to come:
[`CBDC.md`](CBDC.md).

### Cross-border corridors

`corridors.go` carries five rails as separate corridors, each with its own licence requirement,
ceilings, purpose codes and settlement model. `Check` runs the gate without moving anything;
`Send` applies it and then branches on the settlement model.

Atomic corridors move money in a single CBDC transfer and are financially final immediately.
Hash time-locked corridors move it into a per-corridor suspense account, record the hash and the
timeout, and release only against a preimage that is verified rather than trusted; `Sweep` refunds
an expired lock. Deferred corridors also park the money in suspense and stay provisional until
`ConfirmLeg` records the far institution's confirmation. Suspense is an ordinary account on this
ledger, so the CBDC conservation invariant still holds at every step.

Routes live under `/umi/corridors/*`. Corridor parameters, the precedents they follow and the
limits of the claim: [`CORRIDORS.md`](CORRIDORS.md).

### Payment risk: rules and a trained model

`fraud.go` is the rule engine: `ScorePayment` is a pure function over the payment and the payer's
recent history, returning a score, a band, a decision and the weighted factors behind it. It is
hand-written and deterministic, and it is what gates settlement.

`riskmodel.go` is the trained one. A logistic regression over ten features, fitted by
`cmd/trainrisk` on a seeded synthetic dataset, with coefficients, feature standardisation and
held-out metrics committed as `riskmodel.json` and embedded with `go:embed`. Inference is a dot
product and returns the contributions that produced the score. `ExtractRiskFeatures` is shared by
the trainer and the server so training and production cannot disagree about what a feature means.

`AssessPayment` runs both and reports them side by side with an agreement label
(`AGREE_CLEAN`, `AGREE_RISKY`, `RULES_ONLY`, `MODEL_ONLY`); the decision field is always the rules'
decision. `POST /fraud/assess` serves it, `GET /fraud/model` publishes the card, and the existing
`POST /fraud/score` is unchanged.

Model card, generator description and measured numbers: [`RISK_MODEL.md`](RISK_MODEL.md).

## Repository layout

| Path | What it is |
|---|---|
| `drunix-gateway/` | **Go settlement core.** UMI/ASI rail, e₹-W wallets, DvP, work escrow, the chain. Port 21100. |
| `frontend/src/` | React 19 + Vite app: marketplace, ledger explorer, dashboards, calculators, explainers. |
| `frontend/api/index.js` | Vercel serverless API edge; property register, auth, KYC, payments, rail proxy. |
| `server.js` | Local/Render Node server: same surface as the serverless edge, plus SSE and static `dist`. |
| `mock-api-server.js` | Express rig for PayU round-trip testing; a fixture for several suites. |
| `chaincode/` | Hyperledger Fabric chaincode (Go) for the Fabric deployment path. |
| `api-gateway/`, `payment-gateway/` | Go services for the Fabric path and the payment leg. |
| `contracts/` | Solidity escrow experiment (public-chain, simulated). |
| `tests/` | 79 `.mjs` end-to-end suites, driven by `regression.sh`. |
| `scripts/`, `Makefile`, `regression.sh` | Dev bootstrap, common tasks, the full sweep. |
| `docs/` | [Work orders](WORK_ORDERS.md) · [The ledger](DRUNIX.md) · [Settlement](CBDC.md) |
| `SECURITY.md` | What is in scope, what is openly simulated, and how to report a flaw privately. |

This is **four independent Go modules** plus a Vite frontend and a Node API, so a root-level
`go build ./...` cannot work. CI builds each module from its own directory.

---

## Configuration

Everything has a safe default; nothing below is required to boot except where marked.

| Variable | Default | Purpose |
|---|---|---|
| `UMI_GATEWAY_URL` | *(none)* | **Required.** Where the app finds the Go rail. |
| `DATABASE_URL` | *(none)* | Postgres (the project uses Neon) for the ledger and rail state. Absent, both run in memory and reset on restart. |
| `DEMO_AUTH` | off | Enables `/api/auth/login` with the demo identities. Without it, login is 404. |
| `PORT` | `8080` / `21100` | App and rail ports. |
| `ADMIN_DASHBOARD_KEY` | *(none)* | Unlocks admin insights and the role switcher. Needed by the full suite. |
| `UMI_PROXY_SECRET` | *(none)* | Shared secret binding identity headers to a trusted proxy. **Set on both hosts or neither.** |
| `GROQ_API_KEY` | *(none)* | Enables the assistant. Absent, it is cleanly absent, not a button that fails. |
| `UMI_SEED_DEMO` | on | Seeds demo wallets/ISINs on an empty rail. Set `false` for a bare ledger. |
| `WORK_PROVIDER_URL` / `_KEY` | *(none)* | Talent provider adapter. Absent, work orders are marked `simulation`. |
| `UMI_SEED_CARBON_ASSET` | `CARB-NSK-AGROFOREST-2024` | Asset id for the seeded carbon credits. Registered as asset class `CARBON`; the registry behind it is simulated. |
| `EVENT_STREAM_BROKERS` | *(none)* | Kafka-protocol brokers for the settlement event stream (Kafka, Redpanda, WarpStream, MSK, Confluent). Absent, events are derived and counted locally. |
| `EVENT_STREAM_USERNAME` / `_PASSWORD` / `_TLS` | *(none)* | SASL PLAIN credentials and TLS for a hosted broker. |


---

## API

Public reads need no session. Anything touching money or a holding needs a bearer token.

```bash
TOKEN=$(curl -s -X POST localhost:8080/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"identityId":"investor1","role":"Investor"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')

curl -H "Authorization: Bearer $TOKEN" localhost:8080/api/properties
```

| Endpoint | Purpose |
|---|---|
| `GET /api/properties` · `/:id` | the register; `POST` to list, `/validate` as registrar, `/mint` as owner |
| `POST /api/transfers` | move tokens between holders |
| `GET /api/chain` · `/api/chain/verify` | the ledger, and whether it still replays cleanly |
| `GET /api/umi/config` | rail capabilities and the `UMI_*` block types it commits |
| `GET /api/umi/wallets` · `POST /api/umi/dvp` | e₹-W balances; atomic delivery-versus-payment |
| `POST /api/npci/collect` → `/approve` → `/release` | the UPI payment lifecycle |
| `POST /api/ai/chat` | the assistant: public listing data only, cannot act |

The rail's own surface (`/umi/dvp`, `/umi/wallets`, `/umi/servicing`, `/umi/reconciliation`,
`/umi/isin`, `/drunix/chain`) is reachable directly on `:21100` in development.

