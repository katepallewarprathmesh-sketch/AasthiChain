# UMI + Demat 2.0 alignment plan for AasthiChain

Status: research and plan. Nothing in this document is a claim that AasthiChain is
connected to, approved by, or affiliated with RBI, SEBI, NPCI, NSDL or CDSL.

Last checked: 30 September 2026.

---

## 1. What UMI actually is

**Unified Market Interface (UMI)** is market infrastructure conceptualised and built by the
**Reserve Bank of India**. It tokenises financial assets and settles the money leg in
**wholesale CBDC (e₹)**, so the asset and the cash move together in one atomic transaction.

RBI Governor Sanjay Malhotra announced the concept at Global Fintech Fest 2025, positioning
it as the third "U" after UPI (payments) and ULI (lending).
<https://timesofindia.indiatimes.com/business/india-business/u-factor-after-upi-uli-rbi-eyes-umi-for-markets/articleshow/124403323.cms>

What it has actually done so far:

| Milestone | Detail |
|---|---|
| First pilot | Tokenised **certificates of deposit** — approximately 248 transactions worth ₹17,000 crore, roughly two-thirds in the secondary market (RBI ED P. Vasudevan) |
| Demat 2.0 | Launched 10 September 2026 by RBI + SEBI at Global Fintech Fest, Mumbai |
| Asset in scope | **Corporate bonds only** |
| Ledger | Private permissioned DLT **owned by the depositories** (NSDL and CDSL) |
| Money leg | Wholesale CBDC e₹ wallet at a participating bank, bridged by **UMI** |
| Issued so far | REC ₹500 cr, L&T ₹500 cr, IIFL ₹25 cr = **₹1,025 crore** |
| Legal position | Same ISIN, same rating, same debenture trustee, same investor rights — only the record-keeping layer changed |
| Governing frame | Run **under SEBI's Regulatory Sandbox**, relaxations limited to the pilot's scope and period |

Sources:
- SEBI FAQs and press release summary — <https://taxguru.in/sebi/demat-2-0-tokenised-corporate-bonds-pilot-faqs-sebi.html>
- Bloomberg regulatory brief — <https://www.bloomberg.com/professional/insights/regulation/september-2026-global-regulatory-brief-token-securities-stablecoins-and-tokenized-bonds/>
- UMI mechanics and CD pilot numbers — <https://www.indoneo.com/capital/india-digital-rupee-bonds-demat-2-0-settlement/>
- Medianama phase breakdown — <https://www.medianama.com/2026/09/223-sebis-demat-2-0-tokenised-corporate-bonds/>

### The published phase roadmap

- **Stage I (now):** primary issuance of tokenised corporate bonds, atomic DvP via UMI.
- **Stage II:** secondary trading through **existing RFQ platforms** and OTC reporting
  platforms linked to the DLT — explicitly **no new tokenised exchange** — plus
  **retail investor access**. Until then, peer-to-peer demat-to-demat transfer through
  depositories is contemplated.
- **Stage III:** controlled access widened to other regulated entities (credit rating
  agencies, depository participants), more instruments, more corporate actions.

This roadmap is the single most useful thing in the whole announcement for us, because
it tells us exactly which surfaces will need software.

---

## 2. Can AasthiChain "connect to UMI" today?

**No — and any claim otherwise would be false.** Three hard gates:

1. **UMI is not an open API.** There is no public specification, developer portal,
   sandbox key or documented endpoint. Onboarding is described as: participants such as
   **banks, brokers and custodians** join after meeting regulatory and KYC requirements,
   with the ledger run by **authorised nodes under RBI oversight**.
   <https://bfsi.economictimes.indiatimes.com/articles/rbi-unified-markets-interface-revolutionizing-financial-markets-with-umi/124562008>
2. **The asset class is wrong.** Demat 2.0 covers corporate bonds. RBI has said UMI
   "could extend beyond financial instruments to include tokenised real-world assets,
   **subject to regulatory approvals**" — that is a future possibility, not an open door.
3. **Real estate fractional ownership in India is already regulated elsewhere.** Since the
   **SEBI (REIT) (Amendment) Regulations, 2024**, fractional ownership platforms must
   register as **SM REITs**: scheme asset value ₹25–500 crore, pooling ₹50 crore+, minimum
   **200 investors**, **minimum ₹10 lakh per investor**, investment manager net worth
   ₹20 crore, units listed, and at least 95% of assets completed and rent-generating.
   <https://www.livemint.com/money/sebi-notifies-small-and-medium-reits-11709999868347.html>

**Direct consequence for our product story:** the ₹500 minimum is a **demo-only
illustration of divisibility**. Under current Indian law, a real retail fractional
real-estate unit is ₹10 lakh via an SM REIT. We must keep saying this plainly.

---

## 3. So where is the genuine contribution opportunity?

The opportunity is **not** "plug AasthiChain into UMI". It is: **be the reference
open-source implementation of the layers that Stage II and Stage III will need**, and
enter through the doors that are actually open to an independent team.

Ranked by realism for us right now:

| # | Path | Open to us? | Effort | What it gets us |
|---|---|---|---|---|
| 1 | **Open-source "UMI-pattern" reference adapter + conformance tests** published on GitHub | Yes, today | Low | Credibility, citable artefact, the thing every other path asks to see |
| 2 | **RBI HaRBInger global hackathon** (5th edition expected around Oct–Nov 2026; the 4th ran Oct 2025 → finale Apr 2026, ₹40 lakh winner, ₹5 lakh prototype stipend, open to individuals 18+) | Yes, when announced | Medium | Direct RBI/RBIH mentorship and visibility |
| 3 | **SEBI Innovation Sandbox** — explicitly for fintech firms and entities **not regulated by SEBI, including individuals**; offline testing on market data from exchanges/depositories/QRTAs; up to 24 months | Yes, with an application | Medium | Test against realistic depository data, formal record of engagement |
| 4 | **Responding to SEBI/RBI consultation papers** on tokenisation, SM REIT servicing, Demat 2.0 Stage II | Yes, free | Low | Named public-record contribution to the framework itself |
| 5 | **RBI Regulatory Sandbox** (now theme-neutral, on-tap; entity with ₹10 lakh net worth, fit-and-proper) | Needs a registered entity | High | Live testing under RBI supervision |
| 6 | **Vendor/middleware to a regulated participant** — depository, investment manager of an SM REIT, debenture trustee, RTA, or a participating bank | Needs a partner | High | The only realistic route to actual UMI adjacency |
| 7 | **IFSCA / GIFT City sandbox** for tokenised RWA | Needs entity | High | Friendlier regime for tokenised real assets |

Note the middleware gap that commentators have already flagged: depositories "will need
tools that connect global custody systems to the UMI, and compliance workflows that map
activation requirements onto existing onboarding."
<https://www.indoneo.com/capital/india-digital-rupee-bonds-demat-2-0-settlement/>

That sentence is our product thesis in one line.

---

## 4. What we build in AasthiChain

Principle: **AasthiChain becomes a faithful, honest, offline simulator of the Demat 2.0 /
UMI settlement pattern, applied to SM-REIT-shaped real-estate units** — with a clean
adapter boundary so that a regulated partner could swap the simulator for a real
connection without rewriting the product.

### 4.0 Phase 0 — recover work we already wrote (half a day)

Three commits built exactly the right primitives and were discarded when we reset to
`503d188`. They are still in the reflog:

```text
b92549d  feat: make depository endorsement opt-in
1b14cfd  feat: add RFQ servicing and redemption API flows
7710253  fix: gate RFQ creation by active phase
```

Recover with `git cherry-pick b92549d 1b14cfd 7710253` (verify each against the current
tree first). This restores depository endorsement, RFQ servicing/redemption and phase
gating, which map one-to-one onto Demat 2.0 Stage II.

### 4.1 The settlement adapter boundary (the core of the work)

Today the money leg is hard-wired to UPI/PayU simulation. Introduce one interface with
three implementations:

```text
payment-gateway/settlement/
  rail.go            // SettlementRail interface
  rail_upi.go        // existing UPI Collect simulation      (default)
  rail_payu.go       // existing PayU test mode
  rail_umi_sim.go    // NEW: UMI-pattern wholesale CBDC simulator
```

Interface shape (mirrors the published UMI flow, not an invented one):

```go
type SettlementRail interface {
    Name() string                    // "UPI_SIM" | "PAYU_TEST" | "UMI_SIM"
    Reserve(ctx, DvPRequest) (Lock, error)      // cash leg locked
    AtomicSettle(ctx, Lock, TokenLeg) (Receipt, error) // both legs or neither
    Unwind(ctx, Lock, reason string) error
    Capabilities() Capabilities      // atomic bool, centralBankMoney bool, simulated bool
}
```

Every response keeps the existing invariants: `settlementRail` and `simulated: true`
must be present on every payment and DvP response. `UMI_SIM` additionally returns
`centralBankMoney: false` and `regulatoryStatus: "SIMULATED_NOT_CONNECTED"`.

### 4.2 New API surface (additive, nothing removed)

Built in `mock-api-server.js` and mirrored in `frontend/api/index.js`, matching the
existing 71-endpoint style:

| Endpoint | Purpose |
|---|---|
| `POST /api/umi/wallet` | Open a simulated wholesale e₹ wallet for a participant |
| `GET /api/umi/wallet/:participantId` | Balance, holds, participant class |
| `POST /api/umi/dvp` | Atomic DvP: security leg + cash leg, both or neither |
| `GET /api/umi/dvp/:id` | Phase trace: `RESERVED → MATCHED → SETTLED` / `UNWOUND` |
| `POST /api/umi/corporate-action` | Smart-contract servicing: rent/yield, redemption |
| `GET /api/umi/conformance` | Self-test report against our published checklist |
| `GET /api/umi/capabilities` | What is real, what is simulated, what is roadmap |

`GET /api/umi/capabilities` is deliberately the most important endpoint in the set: it is
the machine-readable version of our honesty policy.

### 4.3 Participant model

Demat 2.0 keeps the existing institutional cast. Mirror it exactly rather than inventing
roles:

- **Depository** (owns the ledger) → we already have `DepositoryMSP` endorsement opt-in.
- **Issuer / SPV** → the SM REIT scheme holding one property.
- **Investment Manager** → lists and services the scheme.
- **Trustee / Debenture Trustee** → gates redemption (already prototyped).
- **Participating Bank** → holds the wholesale e₹ wallet (simulated).
- **RFQ platform** → secondary trading venue (already prototyped).
- **Regulator** → existing regulator role.

### 4.4 Chaincode additions

In `chaincode/`:

- `dvp.go` — extend existing `SettleDvP` with a `settlementRail` discriminator and a
  `CentralBankMoney` flag, emitting `UMISettlementSimulated` events distinctly from
  `SettlementRecorded`.
- `corporate_action.go` — coupon/rent distribution and redemption as scheduled on-ledger
  events, so servicing is triggered by the ledger rather than by an API call.
- Keep `ERR_DUPLICATE_PROPERTY`, balance checks and MVCC guards untouched.

### 4.5 Frontend

- A **Settlement** panel on property detail showing the two legs side by side with the
  current rail and an explicit "simulated, not connected to RBI/SEBI infrastructure" line.
- A `/umi` page that renders `GET /api/umi/capabilities` as a plain-English table:
  what Demat 2.0 does, what we simulate, what we do not do.
- SM REIT honesty banner wherever the ₹500 figure appears: "₹500 is a demonstration of
  divisibility. Under SEBI SM REIT rules the current retail minimum is ₹10 lakh."

### 4.6 The publishable artefact

`docs/UMI_PATTERN_CONFORMANCE.md` — an open checklist derived only from public SEBI/RBI
material, with our pass/fail status for each line:

1. Security exists natively on a permissioned ledger owned by the record-keeper.
2. Cash leg settles in central bank money. *(We simulate; we cannot do this.)*
3. Both legs settle atomically or neither does.
4. Same legal instrument, unchanged investor rights.
5. Asset servicing automated by smart contract to the holder's wallet.
6. Secondary trading through existing venues, not a new exchange.
7. Holder record visible simultaneously to all authorised institutions.
8. No new KYC, no new account for the investor.

Plus a conformance test suite (`payment-gateway/settlement/conformance_test.go`) any
other team can run against their own implementation. **This** is the contribution — a
public, testable, honest reference for the pattern, published before the ecosystem has
one.

---

## 5. Sequencing

| Phase | Work | Duration |
|---|---|---|
| 0 | Recover the three discarded RFQ/depository commits; fix the multi-module Go CI | 1 day |
| 1 | `SettlementRail` interface + refactor UPI/PayU behind it; no behaviour change | 3 days |
| 2 | `rail_umi_sim.go` + `/api/umi/*` endpoints + wallet/DvP/corporate-action model | 1 week |
| 3 | Chaincode `dvp.go` / `corporate_action.go` + tests | 1 week |
| 4 | Frontend Settlement panel, `/umi` page, SM REIT honesty banners | 4 days |
| 5 | Publish `UMI_PATTERN_CONFORMANCE.md` + conformance test suite | 3 days |
| 6 | SEBI Innovation Sandbox application; watch for HaRBInger 5th edition | ongoing |
| 7 | Approach one regulated partner (depository / SM REIT IM / debenture trustee) with the working artefact | after 5 |

---

## 6. Honesty rules (non-negotiable)

- Never state or imply that AasthiChain is connected to, integrated with, approved by, or
  in a pilot with RBI, SEBI, NPCI, NSDL or CDSL.
- Label the UMI rail as `UMI_SIM` everywhere in code, API responses and UI.
- Never imply the e₹ wallet is real central bank money.
- Always keep `settlementRail` and `simulated: true` in every payment and DvP response.
- State the SM REIT ₹10 lakh reality wherever ₹500 appears.
- Cite only public sources; do not paraphrase a public statement into an endorsement.

---

## 7. Recommendation

Do **not** try to connect to UMI. It is not connectable by an independent team, and
attempting to claim it would destroy the credibility the project is trying to build.

Do build the **UMI-pattern adapter and the open conformance suite**. It is achievable with
the code we already have, it converts AasthiChain from "a hackathon prototype" into "the
public reference implementation of India's tokenised-settlement pattern for real assets",
and it is the exact artefact that HaRBInger, the SEBI Innovation Sandbox, and any
depository or SM REIT partner will ask to see first.

The realistic path to touching government infrastructure is: **publish the reference →
win or place in HaRBInger → enter a sandbox → be adopted as a vendor by a regulated
participant.** Each step is genuinely open to us. Step one starts in this repository.
