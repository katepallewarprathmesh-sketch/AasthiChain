<div align="center">

# AasthiChain

### Own premium Indian real estate from ₹500

**Fractional property tokens on an append-only ledger · atomic delivery-versus-payment · UPI money leg**

[![CI](https://github.com/katepallewarprathmesh-sketch/AasthiChain/actions/workflows/ci.yml/badge.svg)](https://github.com/katepallewarprathmesh-sketch/AasthiChain/actions/workflows/ci.yml)
[![Live](https://img.shields.io/badge/live-aasthi--chain.vercel.app-1E3A5F?style=flat-square)](https://aasthi-chain.vercel.app)
[![Go](https://img.shields.io/badge/Go-1.25-00ADD8?style=flat-square)](https://go.dev)
[![License](https://img.shields.io/badge/license-MIT-555?style=flat-square)](LICENSE)

[Live site](https://aasthi-chain.vercel.app) · [Ledger explorer](https://aasthi-chain.vercel.app/ledger) · [Settlement rail](https://aasthi-chain.vercel.app/umi) · [Calculators](https://aasthi-chain.vercel.app/tools) · [Learn](https://aasthi-chain.vercel.app/learn)

</div>

---

A premium flat costs ₹75 lakh and you cannot buy 0.1% of it. AasthiChain converts a registrar-verified
property into a fixed number of tokens — a ₹75 L villa becomes **15,000 tokens at ₹500** — and settles
the money leg and the ownership leg as one atomic operation. Both move, or neither does.

**Stack:** Go settlement core (`drunix-gateway`) · Node/Express + Vercel serverless API edge · React 19 + Vite frontend · Hyperledger Fabric chaincode.

> **Honest scoping.** The settlement rail is a faithful **simulation**. There is no public UMI API and
> no live NPCI credential outside a bank partnership — real access is the SEBI Regulatory Sandbox.
> Every simulated surface is labelled as such in the UI and in API responses. What is real: the
> ledger, the atomicity, the verification rules and the guardrails. The exact line between the two
> is itemised at the end of this file.

**Contents** — [Quick start](#quick-start) · [Architecture](#architecture) · [Repository layout](#repository-layout) · [Configuration](#configuration) · [API](#api) · [Testing](#testing) · [What you can do](#what-you-can-do) · [Settlement rails](#settlement-rails) · [Guarantees](#guarantees) · [Contributing](#contributing)

---

## Quick start

**Prerequisites:** Go 1.25+, Node 20+, and `python3` (the regression script uses it to parse JSON).

```bash
git clone https://github.com/katepallewarprathmesh-sketch/AasthiChain.git
cd AasthiChain
npm install
(cd frontend && npm install && npm run build)
```

Start the Go settlement rail on `:21100` — it seeds demo wallets, ISINs and positions on first boot:

```bash
cd drunix-gateway && go run ./cmd/gateway     # listens on :21100
```

In a second terminal, start the app on `:8080`:

```bash
DEMO_AUTH=true UMI_GATEWAY_URL=http://localhost:21100 node server.js
```

Open **http://localhost:8080** and sign in as `investor1` (role `Investor`). Other demo identities:
`originator1` (Originator), `registrar1` (Registrar), `investor2`, `regulator1` (Regulator).

Verify both halves are up:

```bash
curl localhost:21100/health          # rail: build, features, channel
curl localhost:8080/api/health       # app
curl localhost:8080/api/umi/config   # app → rail round-trip; lists UMI_* block types
```

> `UMI_GATEWAY_URL` is **required**, not optional. Without it the rail surface answers `503
> ERR_UMI_RAIL_UNAVAILABLE` even though the rail is running locally.

For frontend work, `cd frontend && npm run dev` gives Vite with hot reload on `:5173`, proxying the
API to `:8080`. `make umi` and `make frontend` wrap the two long commands above.

---

## Architecture

<div align="center">

<img src="docs/architecture.png" alt="AasthiChain architecture: owners, registrars, investors and regulators work through a web experience; an access layer establishes who is calling and what they may touch; a settlement core moves the cash leg and the ownership leg as one atomic exchange; and every state change is written to an append-only record that the whole system answers to." width="100%">

</div>

<sub>Vector source: [`docs/architecture.svg`](docs/architecture.svg) — edit the SVG, then re-export the PNG (command in [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md)).</sub>

### The design rule

Every rule about money lives in one place — the settlement core, beside the ledger it protects. The
layers in front of it carry requests and identity and nothing else. **If a rule about money can be
found anywhere but the core, that is a bug.**

Concretely: the settlement core is Go, the web app and its API edge are JavaScript, and the edge
forwards settlement calls without deciding anything about them. The edge owns the property register,
KYC and the UPI payment lifecycle; it does not own balances, positions or the chain.

### The five layers

| Layer | Responsibility | Lives in |
|---|---|---|
| **Experience** | what each role can see and do, and the public pages anyone may read | `frontend/src` |
| **Access** | establishes who is calling, and decides what that caller may touch | `frontend/api/index.js`, `server.js` |
| **Settlement** | holds the cash leg and the ownership leg, and moves them as one | `drunix-gateway/umi.go` |
| **Work** | escrows a fee against a deliverable, releases it only against anchored evidence | `drunix-gateway/work*.go` |
| **Record** | the append-only history every other layer answers to | `drunix-gateway/chain.go` |

The experience and the settlement core deploy independently, so either can be replaced — or fail —
without the other. When the core cannot be reached the app reports *unknown*; it never reports a
settlement surface as healthy because it could not ask.

### Authorisation

Entitlement is decided in front of the router rather than route by route, so a new surface is covered
the day it ships:

- an unidentified caller is refused with 401, a stranger with 403;
- a supervisor — regulator or admin — may act for someone else where that is the role's job;
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
same surface and must be patched together** — a fix applied to one is live in exactly one
environment.

---

## Repository layout

| Path | What it is |
|---|---|
| `drunix-gateway/` | **Go settlement core.** UMI/ASI rail, e₹-W wallets, DvP, work escrow, the chain. Port 21100. |
| `frontend/src/` | React 19 + Vite app — marketplace, ledger explorer, dashboards, calculators, explainers. |
| `frontend/api/index.js` | Vercel serverless API edge; property register, auth, KYC, payments, rail proxy. |
| `server.js` | Local/Render Node server — same surface as the serverless edge, plus SSE and static `dist`. |
| `mock-api-server.js` | Express rig for PayU round-trip testing; a fixture for several suites. |
| `chaincode/` | Hyperledger Fabric chaincode (Go) for the Fabric deployment path. |
| `api-gateway/`, `payment-gateway/` | Go services for the Fabric path and the payment leg. |
| `contracts/` | Solidity escrow experiment (public-chain, simulated). |
| `tests/` | 58 `.mjs` end-to-end suites, driven by `regression.sh`. |
| `scripts/`, `Makefile`, `regression.sh` | Dev bootstrap, common tasks, the full sweep. |
| `docs/` | [Deployment](docs/DEPLOYMENT.md) · [Work orders](docs/WORK_ORDERS.md) · [Demo walkthrough](docs/DEMO.md) |

This is **four independent Go modules** plus a Vite frontend and a Node API — a root-level
`go build ./...` cannot work. CI builds each module from its own directory.

---

## Configuration

Everything has a safe default; nothing below is required to boot except where marked.

| Variable | Default | Purpose |
|---|---|---|
| `UMI_GATEWAY_URL` | *(none)* | **Required.** Where the app finds the Go rail. |
| `DEMO_AUTH` | off | Enables `/api/auth/login` with the demo identities. Without it, login is 404. |
| `PORT` | `8080` / `21100` | App and rail ports. |
| `ADMIN_DASHBOARD_KEY` | *(none)* | Unlocks admin insights and the role switcher. Needed by the full suite. |
| `UMI_PROXY_SECRET` | *(none)* | Shared secret binding identity headers to a trusted proxy. **Set on both hosts or neither.** |
| `GROQ_API_KEY` | *(none)* | Enables the assistant. Absent, it is cleanly absent — not a button that fails. |
| `UMI_SEED_DEMO` | on | Seeds demo wallets/ISINs on an empty rail. Set `false` for a bare ledger. |
| `WORK_PROVIDER_URL` / `_KEY` | *(none)* | Rezoomex adapter. Absent, work orders are marked `simulation`. |

Full table, deployment topology and failure modes: [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).

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
| `POST /api/ai/chat` | the assistant — public listing data only, cannot act |

The rail's own surface (`/umi/dvp`, `/umi/wallets`, `/umi/servicing`, `/umi/reconciliation`,
`/umi/isin`, `/drunix/chain`) is reachable directly on `:21100` in development.

---

## Testing

```bash
npm test                  # regression.sh — 103 checks across 58 suites (needs both servers up)
make umi-test             # go vet + go test -race ./... in the settlement core
cd frontend && npm run smoke
```

The full sweep expects the app started with `ADMIN_DASHBOARD_KEY` set, and starts the PayU rig on
`:8099` itself — several suites fail standalone because they depend on it:

```bash
DEMO_AUTH=true ADMIN_DASHBOARD_KEY=devkey UMI_GATEWAY_URL=http://localhost:21100 node server.js
```

A mass failure is almost always a dead rail rather than a bug — check `curl localhost:21100/health`
first. CI runs each Go module separately, builds the frontend, and enforces `gofmt`.

---

## What you can do

**Buy a fraction.** Browse the marketplace, open a property, buy from ₹500. Payment and ownership
settle together: a buyer who cannot pay gets nothing and the seller keeps every token. Before money
moves, the app asks the rail whether the trade *would* settle, so a shortfall is a sentence rather
than a failure discovered afterwards.

**Check that a listing is real.** Every property page answers, in plain language: was title validated
by a registrar, and *who* — an owner validating their own listing is refused outright; is the deed
fingerprinted, and does it collide with another listing; does the ledger still replay cleanly. You
can prove your own copy of a deed matches the ledger without uploading anything — hash it locally and
paste the result.

**Ask the assistant.** A question box answers how things work and what is listed. It gets the same
public listing data a visitor can already see and nothing else: asked who holds what, it refuses and
points at the public ledger. Asked about a property that does not exist, it says so. It has no way to
move a token, a rupee or a document.

**Hold many properties as one unit.** A *basket* is a single tradeable unit backed by a fixed recipe
of several properties. Creating one moves the underlying tokens into custody, which is what makes the
unit redeemable rather than notional. A basket that is not fully backed is never allowed to look
healthy.

**Earn rent, split fairly.** Rent and coupons are paid straight into holders' wallets. The split can
follow a snapshot of who holds what today, or **how long each holder actually held** — so someone who
bought yesterday does not collect a full quarter's rent.

**See the whole history.** Ownership is a journal of changes, not just a balance, so the register can
be replayed for any window.

---

## Settlement rails

### ASI — the Aasthi Settlement Interface

In September 2026 SEBI and RBI launched **Demat 2.0**: bonds issued as native tokens on the
depositories' permissioned DLT, with the **cash leg settled in wholesale CBDC (e₹-W)** through the
Unified Market Interface — ₹1,025 crore issued by REC, L&T and IIFL. AasthiChain already had both
ends. This is the middle.

**ASI is our own rail, built to that pattern** — not a connection to the real UMI, which is reachable
only through a bank partnership or the SEBI sandbox. What follows is implemented here, end to end,
and can be run and audited from this repository.

- **Atomic DvP.** Both legs move or neither does; a failure leaves no half-settled state.
- **Central bank money is conserved.** Balances always reconcile against lifetime funding — the rail
  can neither create money nor destroy it.
- **Programmable servicing.** Rent and coupons paid pro-rata on the due date, no registrar file
  exchange.
- **Safe retries.** A repeated settlement request returns the original outcome instead of settling
  twice, and a failure stays a failure.
- **Standards trace.** Every instruction carries the ISO 20022 message family a real
  securities-settlement rail would emit.

Refusals are always specific — which side was short, and by how much — never a generic error.

### Work orders — upkeep paid on delivery

A tokenised building still has to be inspected, repaired and revalued, and that cost used to sit
outside the model: off-ledger, on trust, against an invoice nobody could audit. The fee is
**reserved** on the funder's e₹-W wallet when the order is funded — reserved money cannot be spent on
anything else, including a settlement — and moves to the worker in the same locked step that anchors
the deliverable's SHA-256 to the ledger. There is no state in which someone has been paid and no
evidence exists.

Only the funder pays out, only the assigned worker can deliver, and a dispute freezes the escrow
rather than deciding anything. The talent boundary is an adapter for **Rezoomex**, the Pune gig-work
platform whose own premise is that pay follows task completion. Design notes:
[`docs/WORK_ORDERS.md`](docs/WORK_ORDERS.md).

### Money leg — UPI Collect

A payment is a lifecycle, not a hop: requested, approved, released, reconciled — every amount held as
an exact figure, so no rupee is lost to arithmetic. The round-trip runs against a real provider's
test environment, so signed requests and callbacks are validated by the provider rather than graded
by us. Each payment is risk-screened before approval, and the screen explains its reasoning rather
than returning a score. No real money moves.

---

## Guarantees

**The record is append-only and survives restart.** An entry is written durably before the change it
describes is treated as real. Once written it is never erased, and each entry is sealed against the
one before it — so an altered history announces itself instead of passing quietly.

**Supply is scarce.** Tokens cannot exceed a property's authorised supply, and an owner's unsold
stock is never counted as allocated.

**Holder identity is private.** A visitor sees how many people hold a property and in what
proportions, under anonymous labels. Real names need a session, so the marketplace stays open to
browse without leaking a cap table.

**Approval is independent.** Title validation is restricted to a Registrar, and refused when the
validating identity registered the property.

**Your things answer only to you.** Being signed in is not being entitled: your wallet, payments,
holdings, documents and notifications are yours, and a stranger is refused even knowing the
reference. A regulator can look where that is genuinely the regulator's job, and nowhere else.

**A reference is not a key.** A bank reference on a receipt proves the payment happened. It reveals
nothing about who else was involved.

**A pause means paused.** A supervisor's halt is written down before the answer comes back, so it
survives a restart and applies to every route that could move those tokens — a longer way round is
not a way round. The same authority can lift it; both halt and lift are permanent record.

**Nothing reaches the record around the rules.** Every ownership change passes the same approvals
whichever way it is attempted.

**A refusal is never a dead end.** If the record stops verifying, the platform stops rather than
building on history it cannot vouch for — and there is a supervised way back that writes down what
was set aside, why, and on whose authority. It has been used once, and the record of it is still
there to read.

---

## Free tools and explainers

Single-purpose calculators, each a public page that stands on its own. All INR, Indian tax and
stamp-duty rules, no sign-up.

| Tool | What it answers |
|---|---|
| [Rental yield](https://aasthi-chain.vercel.app/tools/rental-yield-calculator) | gross vs net yield after maintenance, tax and vacancy |
| [Fractional investment](https://aasthi-chain.vercel.app/tools/fractional-investment-calculator) | what ₹X buys, and what it returns |
| [Stamp duty & registration](https://aasthi-chain.vercel.app/tools/stamp-duty-calculator) | state-wise duty on `max(price, circle rate)`, 1% TDS above ₹50 L |
| [Home loan EMI](https://aasthi-chain.vercel.app/tools/home-loan-emi-calculator) | EMI, amortisation, s.24(b) and 80C relief |
| [Rent vs buy](https://aasthi-chain.vercel.app/tools/rent-vs-buy-calculator) | the year the two curves cross |
| [Capital gains tax](https://aasthi-chain.vercel.app/tools/capital-gains-tax-calculator) | LTCG/STCG, the 23 Jul 2024 regime change, s.54 / 54EC / 54F |

Explainers: [Demat 2.0](https://aasthi-chain.vercel.app/learn/what-is-demat-2) ·
[Unified Market Interface](https://aasthi-chain.vercel.app/learn/what-is-umi) ·
[Atomic DvP](https://aasthi-chain.vercel.app/learn/what-is-atomic-dvp)

---

## Contributing

Issues and pull requests are welcome.

1. Fork, branch from `main`.
2. Keep money rules in the Go core — see [the design rule](#the-design-rule). A rule added to the JS
   edge will be asked to move.
3. Run `npm test` (103 checks) and `make umi-test` before opening a PR, and run `gofmt` — CI enforces
   it.
4. If you touch `frontend/api/index.js`, check whether `mock-api-server.js` needs the same change.
5. New behaviour ships with a test that fails without it.

Commit messages are plain language describing the *why*, not a changelog of the diff.

Found a security flaw? Please report it privately — see [`SECURITY.md`](SECURITY.md).

---

<details>
<summary><b>What is live vs simulated</b> — click to expand</summary>

**Live and real:** the ownership rules and their duplicate-deed guard, the append-only record, atomic
settlement and its rollback, safe retries under concurrency, conservation of money, independent title
validation, verified sign-in, the supervisory halt and the way back from it, and durable storage. The
assistant is live, and its limits — public data only, no ability to act — are enforced on the server
rather than requested of the model.

**Simulated, and labelled as such:** the national payments rail (no live credentials exist outside a
bank partnership), the wholesale CBDC wallets (e₹-W is an RBI pilot, not a public API), the UMI rail
itself (real access is the SEBI Regulatory Sandbox), government-issued KYC, the land-record lookup,
and the public-chain escrow experiment.

**The payment round-trip is genuinely real** as far as it goes: the provider's test environment
accepts our signed requests, and tampered amounts and bad signatures are rejected by them, not by us.
Only the settlement behind it is simulated.

</details>

<details>
<summary><b>Regulatory context</b> — click to expand</summary>

The **Asset Tokenisation (Regulation) Bill 2026** is a pending Private Member's Bill, not law. It
proposes KYC/AML obligations, a registered custodian, registrar validation and a regulator freeze
power. AasthiChain maps to all four: a Registrar org validates title, a Regulator org can freeze, the
cap table is auditable end to end, and the payment path enforces a KYC gate.

**SPV structure.** Real platforms wrap each property in a special-purpose vehicle, so a token is a
beneficial interest in the SPV holding legal title (Registration Act 1908 + the 2026 Bill). That is a
legal structure, not a code change, and is documented as Phase 2 rather than built.

</details>

---

## Support

The in-app [Support page](https://aasthi-chain.vercel.app/support) carries UPI and GitHub Sponsors
links. These are **donations to the project, not investments** — they buy no tokens and no stake.

<div align="center">

**[aasthi-chain.vercel.app](https://aasthi-chain.vercel.app)** · [MIT licensed](LICENSE)

</div>
