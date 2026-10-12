<div align="center">

# AasthiChain

### Own premium Indian real estate from ₹500

**Fractional property tokens on an append-only record · UPI money leg · atomic delivery-versus-payment**

[![Live](https://img.shields.io/badge/live-aasthi--chain.vercel.app-1E3A5F?style=flat-square)](https://aasthi-chain.vercel.app)
[![Settlement](https://img.shields.io/badge/settlement-atomic%20DvP-1E3A5F?style=flat-square)](#the-settlement-rails)
[![Ledger](https://img.shields.io/badge/ledger-append--only-8A8375?style=flat-square)](#what-is-guaranteed)
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
| **Independently verified** | a Registrar — never the owner — validates title before any token is minted |
| **Auditable** | every state change is written to an append-only record you can replay |

> **Honest scoping.** The settlement rail is a faithful **simulation**. There is no public UMI API
> and no live NPCI credential available outside a bank partnership — real access is the SEBI
> Regulatory Sandbox. Every simulated surface is labelled as such in the UI and in the API
> responses. What is real: the ledger, the atomicity, the verification rules and the guardrails.

---

## What you can do

### Buy a fraction

Browse the marketplace, open a property, buy from ₹500. Payment and ownership settle together: a
buyer who cannot pay gets nothing, and the seller keeps every token. Before the money moves, the
app quietly asks the rail whether the trade would settle, so a shortfall is shown as a sentence
rather than discovered as a failure afterwards.

### Check that a listing is real

Every property page carries a verification panel that answers, in plain language:

- was the title validated by a registrar, and **who** — the owner validating their own listing is
  refused outright
- is the deed fingerprinted, and does it collide with any other listing
- does the ledger still replay cleanly from the beginning

You can prove your own copy of the deed matches the one on the ledger without uploading anything:
hash the file locally and paste the result.

### Ask the assistant

A question box on the site answers questions about how any of this works and what is currently
listed — what a token costs, which property is cheapest, what a registrar validation means. It is
given the same public listing information a visitor can already see, and nothing else: asked who
holds what, it refuses and points at the public ledger view. Asked about a property that does not
exist, it says so instead of inventing one. It can answer, and that is all it can do — it has no
way to move a token, a rupee or a document. Where it is not configured, it is simply absent, not a
button that fails.

### Hold many properties as one unit

A **basket** is a single tradeable unit backed by a fixed recipe of several properties — two tokens
of one, one of another. Creating a unit moves the underlying tokens into custody, which is what
makes the unit redeemable rather than notional, and the backing is shown per asset. Units can be
sold for cash, transferred, or redeemed back into the real underlying tokens. A basket that is not
fully backed is never allowed to look healthy.

### Earn rent, split fairly

Rent and coupons are paid straight into holders' wallets. The split can follow a snapshot of who
holds what today, or **how long each holder actually held** — so someone who bought yesterday does
not collect a full quarter's rent, and someone who sold mid-quarter still earns for the days they
held.

### See the whole history

Ownership is kept as a journal of changes, not just a current balance, so the register can be
replayed for any window. The ledger explorer shows every block; the investor dashboard shows
holdings, income and settlement history in one place.

---

## The settlement rails

### UMI — the Demat 2.0 cash leg

In September 2026 SEBI and RBI launched **Demat 2.0**: bonds issued as native tokens on the
depositories' permissioned DLT, with the **cash leg settled in wholesale CBDC (e₹-W)** through the
Unified Market Interface — ₹1,025 crore issued by REC, L&T and IIFL. AasthiChain already had both
ends. This is the middle.

- **Atomic DvP.** Both legs move or neither does; a failure leaves no half-settled state behind.
- **Central bank money is conserved.** Wallet balances always reconcile against lifetime funding —
  the rail can neither create money nor destroy it.
- **Programmable servicing.** Rent and coupons are paid pro-rata on the due date, with no registrar
  file exchange.
- **Safe retries.** A repeated settlement request returns the original outcome instead of settling
  twice, and a failure stays a failure.
- **Standards trace.** Every instruction carries the message family a real securities-settlement
  rail would emit, so the trail is one a depository would recognise.

Settlement refusals are always specific — which side was short, and by how much — never a generic
error.

### Money leg — UPI Collect

A payment is a lifecycle, not a single hop: requested, approved, released, reconciled — and every
amount is held as an exact figure rather than a rounded one, so no rupee is ever lost to arithmetic.
The round-trip runs against a real payment provider's test environment, which means signed requests
and callbacks the provider itself validates, not ones we grade ourselves. Each payment is
risk-screened before approval, and the screen explains its reasoning rather than returning a score.
No real money moves.

---

## What is guaranteed

**The record is append-only and survives restart.** An entry is written down durably before the
change it describes is treated as real, so nothing can be true in the app but missing from the
history. Once written, an entry is never erased, and every entry is sealed against the one before
it — so a history that has been altered announces itself instead of passing quietly.

**Supply is scarce.** Tokens cannot exceed the authorised supply of a property, and an owner's
unsold stock is never counted as allocated.

**Holder identity is private.** A visitor sees how many people hold a property and in what
proportions, under anonymous labels. Real names need a session, so the marketplace stays open to
browse without leaking a cap table.

**Approval is independent.** Title validation is restricted to a Registrar, and refused when the
validating identity is the one that registered the property.

**Your things answer only to you.** Being signed in is not the same as being entitled: your wallet,
your payments, your holdings, your documents and your notifications are yours, and a stranger is
refused even when they know the reference. A regulator can look where that is genuinely the
regulator's job, and nowhere else.

**A reference is not a key.** A bank reference shared on a receipt proves the payment happened. It
does not reveal who else was involved, and it does not open a door to anything further.

**A pause means paused.** When a supervisor halts trading in a property, the halt is written down
before the answer comes back, so it is still in force on the next request and after a restart, and
it applies to every route that could move those tokens rather than the most obvious one — a longer
way round is not a way round. The same authority can lift it, which returns the property to exactly
the state it was in beforehand; both the halt and the lift are part of the permanent record.

**Nothing gets to the record around the rules.** Every change to ownership has to pass the same
approvals whichever way it is attempted, so there is no quieter path to the same result.

**A refusal is never a dead end.** If the record ever stops verifying, the platform stops rather
than building on history it cannot vouch for — and there is a supervised way back that writes down
exactly what was set aside, why, and on whose authority. It has been used once, and the record of it
is still there to read.

---

## Signing in

**Public to browse, signed in to act.** The marketplace, the ledger explorer, the calculators and
the articles are open to anyone, including search engines. Anything that touches money or a holding
asks you to sign in first.

**You act as yourself.** You can act for any identity that is genuinely yours; you can never be
taken for someone else on your say-so, and supervisory roles — registrar, regulator — are never
handed out on request. If a session cannot be proven, the answer is no.

**Whoever runs the deployment can walk through all four roles.** Holding the deployment's own key
puts a role picker back in the header, so an owner, a registrar, an investor and a regulator can be
tried one after another against the same data — which is the only honest way to show that each one
is refused the things it should be. The key proves who is at the keyboard; it is not a role in
itself, and on its own, with nobody signed in behind it, it can look but never act.

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

---

## For developers

How it fits together, how to run it, and every configuration switch:
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) and [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).

---

<details>
<summary><b>What is live vs simulated</b> — click to expand</summary>

**Live and real:** the ownership rules and their duplicate-deed guard, the append-only record,
atomic settlement and its rollback, safe retries under concurrency, conservation of money,
independent title validation, verified sign-in, the supervisory halt and the way back from it, and
durable storage. The assistant is live, and its limits — public data only, no ability to act — are
enforced on the server rather than requested of the model.

**Simulated, and labelled as such:** the national payments rail (no live credentials exist outside
a bank partnership), the wholesale CBDC wallets (e₹-W is an RBI pilot, not a public API), the UMI
rail itself (real access is the SEBI Regulatory Sandbox), government-issued KYC (onboarding needs
entity registration, an official domain, India-hosted servers and a ministry review), the
land-record lookup, and the public-chain escrow experiment.

**The payment round-trip is genuinely real** as far as it goes: the provider's test environment
accepts our signed requests, and tampered amounts and bad signatures are rejected by them, not by
us. Only the settlement behind it is simulated.

</details>

<details>
<summary><b>Regulatory context</b> — click to expand</summary>

The **Asset Tokenisation (Regulation) Bill 2026** is a pending Private Member's Bill, not law. It
proposes KYC/AML obligations, a registered custodian, registrar validation and a regulator freeze
power. AasthiChain maps to all four: a Registrar org validates title, a Regulator org can freeze, the
cap table is auditable end to end, and the payment path enforces a KYC gate.

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
