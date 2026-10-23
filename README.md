<div align="center">

# AasthiChain

### Own premium Indian real estate from ₹500

**Fractional property tokens on an append-only ledger · atomic delivery-versus-payment · UPI money leg**

[![CI](https://github.com/katepallewarprathmesh-sketch/AasthiChain/actions/workflows/ci.yml/badge.svg)](https://github.com/katepallewarprathmesh-sketch/AasthiChain/actions/workflows/ci.yml)
[![Live](https://img.shields.io/badge/live-aasthi--chain.vercel.app-1E3A5F?style=flat-square)](https://aasthi-chain.vercel.app)
[![Go](https://img.shields.io/badge/Go-1.25-00ADD8?style=flat-square)](https://go.dev)
[![License](https://img.shields.io/badge/license-Apache%202.0-555?style=flat-square)](LICENSE)

[Live site](https://aasthi-chain.vercel.app) · [Ledger explorer](https://aasthi-chain.vercel.app/ledger) · [Settlement rail](https://aasthi-chain.vercel.app/umi) · [Calculators](https://aasthi-chain.vercel.app/tools) · [Learn](https://aasthi-chain.vercel.app/learn)

</div>

---

A premium flat costs ₹75 lakh and you cannot buy 0.1% of it. AasthiChain converts a registrar-verified
property into a fixed number of tokens (a ₹75 L villa becomes **15,000 tokens at ₹500**) and settles
the money leg and the ownership leg as one atomic operation. Both move, or neither does.

**Stack:** a Go settlement core, a Node API edge, a React frontend, and Hyperledger Fabric chaincode.

> **Honest scoping.** The settlement rail is a faithful **simulation**. There is no public UMI API and
> no live NPCI credential outside a bank partnership; real access is the SEBI Regulatory Sandbox.
> Every simulated surface is labelled as such in the UI and in API responses. What is real: the
> ledger, the atomicity, the verification rules and the guardrails. See
> [What is live vs simulated](#what-is-live-vs-simulated).

## Contents

- [Quick start](#quick-start)
- [How it fits together](#how-it-fits-together)
- [What you can do](#what-you-can-do)
- [Pages](#pages)
- [Settlement rails](#settlement-rails)
- [Features in depth](#features-in-depth)
- [On a real Drunix network](#on-a-real-drunix-network)
- [Guarantees](#guarantees)
- [Testing](#testing)
- [Free tools and explainers](#free-tools-and-explainers)
- [What is live vs simulated](#what-is-live-vs-simulated)
- [Regulatory context](#regulatory-context)
- [Contributing](#contributing)
- [Support](#support)

---

## Quick start

**Prerequisites:** Go 1.25+, Node 20+, and `python3`. No credentials, no Docker, no database.

```bash
git clone https://github.com/katepallewarprathmesh-sketch/AasthiChain.git
cd AasthiChain
make dev
```

The app comes up on **http://localhost:8080**, the settlement core on `:21100`. Sign in as
`investor1` and buy a fraction of something. `make stop` stops what it started, `make help` lists
the rest.

Other demo identities: `originator1`, `registrar1`, `regulator1`, `investor2`.

```bash
curl localhost:8080/api/health       # the app
curl localhost:21100/health          # the settlement core
```

Other ways to run it and every configuration switch: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).
Deployment topology and failure modes: [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).

---

## How it fits together

<div align="center">

<img src="docs/architecture.png" alt="AasthiChain architecture: owners, registrars, investors and regulators work through a web experience; an access layer establishes who is calling, what they may touch, and keeps the listing register, whose addresses are checked against an outside postal directory; a settlement core moves the cash leg and the ownership leg as one atomic exchange; every state change is written to an append-only record that the whole system answers to; and a layer of assurance sits under all of it: a register of the keys that sign, a risk layer that judges a payment before it settles, and copies of the proof on public chains that a holder can check without asking the platform." width="100%">

</div>

<sub>Vector source: [`docs/architecture.svg`](docs/architecture.svg). Edit the SVG, then re-export the PNG (command in [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md)).</sub>

Four kinds of people use it: owners list property, registrars validate title, investors buy and
trade fractions, regulators supervise. Behind them sit four things:

- **An access layer** decides who is calling and what they may touch, and keeps the property register.
- **A settlement core** holds the cash leg and the ownership leg and moves them as one.
- **An append-only record** sits underneath, and every other part answers to it.
- **An assurance layer** under all of it: the keys that sign are registered and revocable, payments
  are judged before they settle, and copies of the proof sit on public chains.

One rule shapes the codebase: **every rule about money lives in the settlement core**, beside the
ledger it protects. Everything in front of it carries requests and identity and nothing else. A
money rule found anywhere else is a bug.

The experience and the settlement core deploy independently. When the core cannot be reached, the
app reports *unknown*; it never reports a settlement surface as healthy because it could not ask.

Repository layout, where each rule lives, and the full configuration table:
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

---

## What you can do

- **Buy a fraction.** Browse the marketplace, open a property, buy from ₹500. Payment and ownership
  settle together: a buyer who cannot pay gets nothing and the seller keeps every token. Before money
  moves, the app asks the rail whether the trade *would* settle, so a shortfall is a sentence rather
  than a failure discovered afterwards.
- **Check that a listing is real.** Every property page shows whether a registrar validated title (and
  *who*; owners validating their own listing are refused), whether the deed fingerprint collides with
  another listing, and whether the ledger still replays cleanly. You can prove your own copy of a deed
  matches the ledger by hashing it locally, with no upload.
- **Ask the assistant.** It answers how things work and what is listed, using only public listing data.
  Asked who holds what, it refuses and points at the public ledger. It cannot move a token, a rupee or
  a document.
- **Hold many properties as one unit.** A *basket* is a tradeable unit backed by a fixed recipe of
  properties. Creating one moves the underlying tokens into custody, which makes it redeemable rather
  than notional.
- **Earn rent, split fairly.** Rent and coupons are paid straight into holders' wallets, split by a
  snapshot of current holdings or by **how long each holder actually held**.
- **Know the address is real.** Pincodes are checked against the national postal directory and the
  result is stored with the listing. If the directory is unreachable, the record says nothing was
  checked rather than inventing a pass. It is a courtesy check, not proof of ownership.
- **Withdraw a listing and have it stay withdrawn.** Withdrawals are recorded and survive restarts.
  Remaining holders are bought out at the listed price first, and the payout is written to the ledger.
- **See the whole history.** Ownership is a journal of changes, so the register can be replayed for any
  window.

---

## Pages

Everything is public to read except the five marked **session**.

| Route | What it is |
|---|---|
| `/` · `/marketplace` · `/property/:id` | landing, the catalogue, and a single listing with its verification panel |
| `/market` | secondary market: holders trading tokens with each other |
| `/umi` | **the settlement rail:** DvP, e₹-W wallets, pilot ISINs, servicing, baskets, the work desk |
| `/ledger` | block explorer: every state change, replayable from the first block |
| `/verify` | hash your own copy of a deed and check it against the ledger, without uploading it |
| `/insights` | platform metrics; operator detail needs the key |
| `/dashboard` · `/wallet` | **session.** holdings, income, settlement history, e₹-W balance |
| `/admin` · `/admin/ops` | **session.** operator queues: what is waiting on a human |
| `/regulator` | **session.** supervisory view: halts, cap tables, reconciliation |
| `/learn` · `/tools` | three explainers and six calculators |
| `/trust` | every external boundary, and whether it is live or modelled locally |
| `/login` · `/about` · `/support` · `/privacy` · `/terms` | sign-in and the ordinary pages |

---

## Settlement rails

### ASI, the Aasthi Settlement Interface

In September 2026 SEBI and RBI launched **Demat 2.0**: bonds issued as native tokens on the
depositories' permissioned DLT, with the cash leg settled in wholesale CBDC (e₹-W) through the
Unified Market Interface. AasthiChain already had both ends; ASI is the middle.

ASI is **our own rail, built to that pattern**, not a connection to the real UMI (reachable only
through a bank partnership or the SEBI sandbox).

- **Atomic DvP.** Both legs move or neither does; a failure leaves no half-settled state.
- **Central bank money is conserved.** Balances always reconcile against lifetime funding.
- **Programmable servicing.** Rent and coupons paid pro-rata on the due date, no registrar file exchange.
- **Safe retries.** A repeated request returns the original outcome instead of settling twice.
- **Standards trace.** Every instruction carries the ISO 20022 message family a real rail would emit.

Refusals are always specific: which side was short, and by how much.

### Money leg: UPI Collect

A payment is a lifecycle (requested, approved, released, reconciled) with every amount held as an
exact figure. The round-trip runs against a real provider's test environment, so signed requests and
callbacks are validated by the provider, not by us. Each payment is risk-screened before approval and
the screen explains its reasoning. No real money moves.

### Work orders: upkeep paid on delivery

Inspection, repair and revaluation fees are **reserved** on the funder's e₹-W wallet when an order is
funded, and move to the worker in the same locked step that anchors the deliverable's SHA-256 to the
ledger. Nobody is paid without evidence. A dispute freezes the escrow rather than deciding anything.
The worker provider is a simulated adapter. Details: [`docs/WORK_ORDERS.md`](docs/WORK_ORDERS.md).

### Anchored on a public blockchain

The head of the permissioned chain is periodically published to a public blockchain as a digest: chain
id, block height, block hash and transaction root. No participant, asset or amount leaves the service.
This part is **not** simulated: network calls are live and anyone can verify with no account. Publishing
costs a fee, so it stays off until a funded key is configured: [`docs/ANCHORING.md`](docs/ANCHORING.md).

---

## Features in depth

Each of these has its own design document. Every one states what is simulated.

| Feature | Summary | Docs |
|---|---|---|
| **Central bank money on the ledger** | Simulated digital rupee issued, moved and redeemed on-chain, with published conservation arithmetic. Supports purpose-bound money, offline vouchers and event-triggered refunds. Distinguishes technical from financial finality. | [`docs/CBDC.md`](docs/CBDC.md) |
| **Cross-border corridors** | Five corridor types modelled on their own terms; payments refused by the corridor that cannot carry them, naming the missing authorisation. Atomic when both legs share a ledger, provisional otherwise. | [`docs/CORRIDORS.md`](docs/CORRIDORS.md) |
| **Paying from outside India** | Stablecoin converted outside India; rupee wallet credited only against an inward-remittance attestation. Eligibility checked before quoting. Simulation only. | [`docs/CROSS_BORDER.md`](docs/CROSS_BORDER.md) |
| **Trained risk model** | A classifier fitted in this repo (AUC 0.866 on held-out data) runs beside the hand-written screening rules, and takes the KYC tier, its route, its age and the ceiling it implies as inputs. Trained on synthetic data and advisory only; the rules decide. | [`docs/RISK_MODEL.md`](docs/RISK_MODEL.md) |
| **Cross-rail payments** | Paying a bank account or QR with CBDC; reports which leg is final, who holds the claim in between (a published suspense account), and whether the total changed. | [`docs/CBDC.md`](docs/CBDC.md) |
| **KYC that produces the tier** | Tier is the output of a verification route, with evidence hashed, expiry and a trail. Aadhaar numbers are rejected outright, never stored. Verification steps are simulated. | [`docs/KYC.md`](docs/KYC.md) |
| **A register of the keys that sign** | Keys are screened before they enter service, registration proves possession, duplicates are refused, and revocation is a recorded event that distinguishes a compromise from a retirement. Passing the screen means no known-bad pattern was found, not that the key was generated well. | [`docs/KEYS.md`](docs/KEYS.md) |
| **A token a holder can check** | A restricted ERC-20 carrying the ERC-7943 interface, arranged the way ERC-3643 arranges a permissioned security token: eligibility, holder caps, lock-ups and freezes are enforced inside the contract rather than around it. It mirrors the rail and never replaces it. Built and tested, not deployed to a public network. | [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) |
| **AI agent that proposes, never acts** | Reads live state and drafts actions (stuck legs, expiring conditions, stale backing) into a queue. A named person approves, facts are re-read at approval time, and the ledger records the approver. | [`docs/AI_AGENT.md`](docs/AI_AGENT.md) |
| **Screening: list, case, report** | Fuzzy name matching against a loaded sanctions/PEP list, with published thresholds, case workflow and a hashed escalation document. The list is synthetic and nothing is filed with any authority. | [`docs/AML.md`](docs/AML.md) |
| **Grounded assistant** | Answers from the project's own docs and live rail state, fetches specific records by reference through ordinary code (no tool access), and says "not documented" when it has no source. Off if no key is configured. | [`docs/AI_AGENT.md`](docs/AI_AGENT.md) |
| **Measured throughput** | About 37,900 ns of engine time per settlement (~26,000/s in a tight loop; p50 0.027 ms, p99 0.131 ms) on a two-core dev box. That is not evidence of scale. Other money paths are timed separately. | [`docs/THROUGHPUT.md`](docs/THROUGHPUT.md) |
| **Measured test coverage** | A tool maps every rail action against the suites: **64% of 100 actions certainly covered**, 16% possible. CI fails if the published figure drifts or coverage falls. | [`docs/TESTING.md`](docs/TESTING.md) |

---

## On a real Drunix network

The settlement core simulates by default, and the hosted demo is simulating. The **chaincode**, though,
has been deployed to and written to a real NPCI Drunix network (NPCI's Hyperledger Fabric fork).

On a two-organisation test network, a property registration submitted through the gateway was endorsed
by both organisations, ordered and committed. The gateway reported the transaction id and block number,
and the committing peer, which runs none of this repository's code, independently reported the same
chain head.

Getting there exposed three defects invisible to single-peer tests: values that differed between
endorsing peers, index entries in a format the state database rejects, and one bug in the test
network's own tooling. Each now has a regression test and a write-up in
[`docs/DRUNIX.md`](docs/DRUNIX.md) and [`docs/REPOSITORY_AUDIT.md`](docs/REPOSITORY_AUDIT.md).

**Claims:** the chaincode and gateway work against Drunix. **Non-claims:** the hosted demo is not
connected to a Drunix network (`/trust` says so), and nothing here is an NPCI endorsement or pilot.

---

## Guarantees

- **Append-only, survives restart.** Entries are written durably before the change they describe is
  treated as real, and each is sealed against the one before it.
- **Scarce supply.** Tokens cannot exceed a property's authorised supply.
- **Issuance cannot outrun stated backing.** Issuing past an accountable party's stated, dated figure is
  refused and recorded. Stale statements authorise nothing. The platform checks the arithmetic, not the
  truth of the statement.
- **Private holders.** Visitors see holder counts and proportions under anonymous labels; names need a session.
- **Independent approval.** Only a Registrar can validate title, and never for a property they registered.
- **Your things answer only to you.** Being signed in is not being entitled. Regulators see only what is
  genuinely their job.
- **A reference is not a key.** A bank reference proves the payment happened and reveals nothing else.
- **A pause means paused.** A supervisor's halt is recorded before the answer returns, survives restart,
  and applies to every route that could move those tokens.
- **Withdrawal does not strand a holder.** Holders are bought out in the same step, and both are permanent record.
- **Nothing bypasses the rules.** Every ownership change passes the same approvals however it is attempted.
- **A weak key never enters service.** Signing keys are screened, possession is proved at registration,
  and a compromised key can be revoked in a way that says earlier signatures no longer count.
- **A refusal is never a dead end.** If the record stops verifying, the platform stops; a supervised
  recovery records what was set aside, why, and on whose authority. It has been used once and the record
  is readable.

---

## Testing

```bash
make dev          # the suites talk to a running stack, so start it first
make test         # the full sweep: 152 checks across 107 suite files
make test-go      # gofmt, vet and race tests across every Go module
make smoke        # every page renders real content
make secret-scan  # refuse tracked files that look like live credentials
```

A mass failure is almost always a dead rail rather than a bug, so check the core is up first. CI runs
the Go modules separately, builds the frontend, and treats formatting as a hard gate.

Exact commands, prerequisites and deliberate gaps: [`docs/TESTING.md`](docs/TESTING.md).
Known weak points: [`docs/REPOSITORY_AUDIT.md`](docs/REPOSITORY_AUDIT.md).

---

## Free tools and explainers

Single-purpose calculators. All INR, Indian tax and stamp-duty rules, no sign-up.

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

## What is live vs simulated

**Live and real:** the ownership rules and duplicate-deed guard, the append-only record, atomic
settlement and rollback, safe retries under concurrency, conservation of money, independent title
validation, verified sign-in, the supervisory halt and the way back from it, durable storage, the
signing-key register and its screen, and public-chain anchor verification. The assistant is live, and
its limits (public data only, no ability to act) are enforced on the server.

**Simulated, and labelled as such:** the national payments rail, the wholesale CBDC wallets (e₹-W is an
RBI pilot, not a public API), the UMI rail itself, government-issued KYC, the land-record lookup,
cross-border corridors, and the public-chain escrow experiment.

**Built but not deployed:** the restricted token contract compiles, deploys to a local chain and is
driven by its own suite, but it is on no public network, so no holder can check a position there yet.

**The payment round-trip is real as far as it goes:** the provider's test environment accepts our signed
requests, and tampered amounts and bad signatures are rejected by them, not by us. Only the settlement
behind it is simulated.

---

## Regulatory context

The **Asset Tokenisation (Regulation) Bill 2026** is a pending Private Member's Bill, not law. It
proposes KYC/AML obligations, a registered custodian, registrar validation and a regulator freeze power.
AasthiChain maps to all four: a Registrar org validates title, a Regulator org can freeze, the cap table
is auditable end to end, and the payment path enforces a KYC gate.

**SPV structure.** Real platforms wrap each property in a special-purpose vehicle, so a token is a
beneficial interest in the SPV holding legal title (Registration Act 1908 + the 2026 Bill). That is a
legal structure, not a code change, and is documented as Phase 2 rather than built.

---

## Contributing

Issues and pull requests are welcome.

1. Fork, branch from `main`.
2. Keep money rules in the settlement core. A rule added to the edge will be asked to move.
3. Run `make test` and `make test-go` before opening a PR. `gofmt` is a hard gate in CI.
4. The API exists in two implementations that must stay in step; see [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).
5. New behaviour ships with a test that fails without it.

Commit messages describe the *why*, not a changelog of the diff. Full guide:
[`CONTRIBUTING.md`](CONTRIBUTING.md). Conduct: [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).

Found a security flaw? Please report it privately: see [`SECURITY.md`](SECURITY.md).

---

## Support

The in-app [Support page](https://aasthi-chain.vercel.app/support) carries UPI and GitHub Sponsors
links. These are **donations to the project, not investments**. They buy no tokens and no stake.

<div align="center">

**[aasthi-chain.vercel.app](https://aasthi-chain.vercel.app)** · [Apache 2.0 licensed](LICENSE)

</div>
