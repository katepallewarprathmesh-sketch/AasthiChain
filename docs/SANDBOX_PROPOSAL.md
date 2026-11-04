# Fractional property settlement with a wholesale cash leg

**DRAFT. Not submitted, not approved, not under review.**

A cohort-scoped test of whether registrar-verified fractional property can settle against a wholesale central bank money leg at retail ticket sizes, with multilateral netting, without creating a settlement-risk window and without any participant funding a gross position.

Applicant: AasthiChain (Rudraksha Aasthi). Regulatory sandbox cohort submission, draft.

<!-- Generated from frontend/src/lib/sandboxProposal.js by scripts/build-sandbox-doc.mjs.
     Edit the data file, not this document. tests/sandbox.test.mjs fails if they disagree. -->

A sandbox exists to create regulatory clarity, not to demonstrate that software runs. The four
sections below are the four things that carry the weight: the specific friction, a scope small
enough that reversing it is uninteresting, the failure modes stated before anyone asks, and what
will have been learned either way.

## 1. The friction

Indian property is indivisible in practice, slow to transfer, and expensive to verify. The smallest credible exposure to institutional-grade real estate is a ten lakh rupee SM REIT unit; below that, a household’s only options are unregulated or illiquid.

- Land and property disputes are roughly two thirds of civil litigation, and a title dispute runs for about two decades.
  <br><sub>Samiullah v. State of Bihar, 2025 INSC 1292</sub>
- The regulated floor for a fractional real-estate unit is ten lakh rupees, in schemes of fifty to five hundred crore with at least two hundred unitholders.
  <br><sub>SEBI SM REIT framework</sub>
- Verification is repeated per venue. A buyer who has already been checked by one platform is checked again by the next, because nothing a holder carries can be verified by a second venue.
  <br><sub>Observed in the design of every platform surveyed, including our own before this build</sub>

**Why this cohort, now.** The cash leg is the part that has not been solved. A depository can issue a token today; what stalls is settling it against money, because atomic delivery versus payment is gross settlement and gross settlement demands funded cash for every leg. India can sequence this differently from markets that shipped the asset leg first and left settlement to participants.

## 2. Scope, and how it is contained

One city, one asset class, registrar-verified titles only, hard caps on value and participants, and a single switch that ends it.

| Bound | Limit |
| --- | --- |
| Geography | One metropolitan area, one state registrar |
| Asset class | Completed, revenue-generating commercial property only. No under-construction, no land parcels |
| Title | Only titles carrying a registrar-signed credential anchored on the ledger. No self-declared ownership |
| Participants | Capped cohort, KYC-complete, resident Indian investors only for the first phase |
| Ticket size | Floor of five hundred rupees, per-participant cap for the cohort duration |
| Scheme value | A single capped pool, well below the SM REIT floor, so nothing here competes with a regulated product |
| Cash leg | Wholesale central bank money within the cohort. No retail custody of client funds by the platform |
| Duration | One cohort period, with a stated end date rather than a renewal assumption |

**Reversibility.** The asset leg and the cash leg are separate modules behind one settlement call. Disabling the cash rail stops all settlement immediately and leaves every position readable and transferable through the ordinary registrar process. No participant depends on us remaining operational to prove what they hold: credentials are verifiable offline and positions are anchored on an append-only ledger.

## 3. Failure modes, stated before being asked

Each row names what goes wrong, what it looks like from outside, and what is already built. The
rows marked **open** are not handled. They are listed because an application claiming everything
is handled is the one a reader stops believing.

### The issuer becomes insolvent (open)

**Symptom.** Holders own tokens in an entity that cannot operate the asset or distribute income.

**Today.** NOT IMPLEMENTED. Recourse is recorded as absent rather than implied. No waterfall, no indemnity, no insurer, no reserve is encoded today, and the attestation endpoint says so in the response rather than in a footnote.

<sub>`drunix-gateway/attestation.go` · `tests/attestation.test.mjs`</sub>

### An attestation turns out to be wrong or is withdrawn

**Symptom.** Tokens exist against backing that is no longer evidenced.

**Today.** Withdrawing a backing attestation blocks further issuance against that asset immediately, and the refusal is recorded on the ledger rather than handled quietly.

<sub>`drunix-gateway/backing.go` · `tests/backing.test.mjs`</sub>

### The cash leg does not complete

**Symptom.** Ownership moves and money does not, or the reverse.

**Today.** Settlement locks both legs and commits them in one block. There is no observable state in which one leg moved. A netting batch keeps the same promise across every leg in it: all of them settle or none do.

<sub>`drunix-gateway/netting.go` · `tests/netting.test.mjs`</sub>

### A participant cannot fund their obligation

**Symptom.** A settlement fails late, after others have relied on it.

**Today.** Funding is checked before anything locks, the shortfall is named in the refusal, and a netting batch reports every participant’s net position before it is settled rather than discovering the gap mid-batch.

<sub>`drunix-gateway/netting.go` · `tests/netting.test.mjs`</sub>

### A credential is revoked after a counterparty has relied on it

**Symptom.** A second venue accepts a holder on evidence that is no longer valid.

**Today.** Revocation is published as a whole status list with the ledger height it was read at, so a verifier polls one cacheable document. A presentation bundle verifies offline; only revocation needs a network, and that is stated inside the bundle.

<sub>`drunix-gateway/portability.go` · `tests/credentialportability.test.mjs`</sub>

### An automated agent acts beyond its authority (open)

**Symptom.** Value moves under a delegation the principal did not intend.

**Today.** Agents hold explicit mandates with caps and expiry, and withdrawals are enforced against them. One gap remains and is not hidden: a principal cannot currently revoke their own agent without a supervisor, which is the wrong asymmetry for the fastest response to a compromise.

<sub>`drunix-gateway/mandates.go` · `tests/mandates.test.mjs`</sub>

### A signing key is weak or compromised

**Symptom.** A signature that should be unforgeable is forged.

**Today.** Keys are screened on registration for the entropy failures that have broken real certificate authorities, and possession is proved against a server-issued challenge rather than asserted.

<sub>`drunix-gateway/keyregistry.go` · `tests/operatorkeyscope.test.mjs`</sub>

### The durable record falls behind the ledger

**Symptom.** A restart loses state that participants were told was final.

**Today.** Money-moving requests are refused while committed blocks are still unpersisted, and the distance behind is published rather than inferred. Reads stay available, because going dark is a worse answer than a slightly stale one.

<sub>`drunix-gateway/umi_server.go` · `tests/sealedrail.test.mjs`</sub>

### The platform is used to move value across a border outside banking channels

**Symptom.** An on-ramp or off-ramp operating without authorisation, which is what enforcement actions in this sector are actually about.

**Today.** The cross-border leg converts outside India through a named third-party provider, credits rupees only against a bank advice reference and an RBI purpose code, and never pays a seller in tokens. A test holds the public copy to that description so it cannot drift into an advertisement.

<sub>`drunix-gateway/crossborder.go` · `tests/rampclaims.test.mjs`</sub>

### A payment is fraudulent or structured to evade a threshold

**Symptom.** Settlement completes on money that should have been stopped.

**Today.** Payments are scored before settlement, velocity is counted per payer over a window, and transfers above the information threshold carry originator and beneficiary records.

<sub>`drunix-gateway/fraud.go` · `tests/aml.test.mjs`</sub>

## 4. What the cohort would establish

**The question.** Can registrar-verified fractional property settle against a wholesale central bank money leg at retail ticket sizes, under multilateral netting, while conserving both cash and ownership exactly and without any participant funding a gross position?

**Measured by:**

- Netting efficiency achieved on real cohort flow: gross obligations against cash actually moved, per session.
- Peak funding a participant needed under netting, against what gross settlement would have demanded of the same participant.
- Settlement failures, with the cause of each, and whether any produced a partial state.
- Time from registrar credential issuance to a second party verifying it without contacting us.
- Conservation checks: cash and tokens before and after every batch, reconciled against the ledger replay.

**A negative result is still a result.** If netting at these ticket sizes saves little, or if conservation cannot be shown under concurrent load, that is a finding worth the cohort. It would say the cash leg should stay gross and that the complexity of netting is not earned at this scale, which is useful to anyone else about to build it.

## What is not being claimed

- No licence, authorisation or registration is claimed or implied by this document.
- No live connectivity to RBI, NPCI or any state registrar exists today. Every rail named here is a simulation unless a cohort provides the real one.
- The signing keys in the current build derive from a seed published in the repository, so signatures prove integrity and not authority until a cohort key is issued.

