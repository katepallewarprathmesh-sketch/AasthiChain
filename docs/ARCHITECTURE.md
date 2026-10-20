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
| `docs/` | [Deployment](docs/DEPLOYMENT.md) · [Work orders](docs/WORK_ORDERS.md) · [Demo walkthrough](docs/DEMO.md) |
| `SECURITY.md` | What is in scope, what is openly simulated, and how to report a flaw privately. |

This is **four independent Go modules** plus a Vite frontend and a Node API, so a root-level
`go build ./...` cannot work. CI builds each module from its own directory.

---

## Configuration

Everything has a safe default; nothing below is required to boot except where marked.

| Variable | Default | Purpose |
|---|---|---|
| `UMI_GATEWAY_URL` | *(none)* | **Required.** Where the app finds the Go rail. |
| `DATABASE_URL` | *(none)* | Postgres (the project uses Neon) for the ledger and rail state. Absent, both run in memory and reset on restart. Setup: [`docs/NEON.md`](docs/NEON.md). |
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

Full table, deployment topology and failure modes: [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).
Pointing the stack at your own Neon database, and exactly which data does and does not land there: [`docs/NEON.md`](docs/NEON.md).

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

