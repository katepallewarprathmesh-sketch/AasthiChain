# Backlog

One list, so nothing quietly falls off. It holds two kinds of item: themes drawn from
current public writing on tokenisation infrastructure that the project has decided are
worth acting on, and open findings from the repository audit. Anything already built is
listed only as a pointer, not re-described.

Each item says what it is, why it is here, and what "done" would look like. Where a claim
would be hard to substantiate, that is stated rather than hidden.

## Built

| Theme | Where it landed |
| --- | --- |
| Decentralised identity: a claim that can be checked without trusting the issuer's API | Verifiable credentials, signed and anchored. See `docs/CREDENTIALS_PLAN.md`. |
| Agentic transacting: an agent needs delegated authority, not a shared password | Mandates: bounded actions, a spending limit the rail counts itself, hard expiry, immediate revocation, every use attributed on the ledger. |
| Attestation is where the risk sits, not minting | The attestation layer: who vouched, what for, which holders and trades rest on it, and a ledger notice naming the exposure when it is withdrawn. |
| Consortium networks are decided by governance, not cryptography | `docs/GOVERNANCE.md`: eligibility, fees, conflict of interest, exit and representation, each answered as the code actually stands. |
| Bounded reads (was audit item D3) | Every list route now has a default page size and a stated ceiling, so a caller cannot ask the rail to copy an entire collection into one response. Measured figures are in `docs/PERFORMANCE.md`. |

Both are simulations of the surrounding authority, not integrations. The signatures, the
anchors and the refusals are real; the registrar and the agent are demo identities.

## Next

### 1. Conditional release of a settled leg

Programmable settlement is the part of "tokenisation is not digitisation" the codebase has
not touched. Today a DvP either settles atomically or fails. The missing shape is a leg
that settles into a condition: cash is locked, the securities leg moves, and the cash
releases only when a named condition is satisfied or an expiry returns it.

It composes with what now exists: the condition can be the presentation of a valid
credential, and the party allowed to assert it can be an agent acting under a mandate.

Done looks like: a `UMI_CONDITION_*` block family, an escrow state the reconciliation
check already in the suite can prove is conserved, a timeout path that cannot strand
money, and a failure test for every way the condition can fail to arrive.

Partly delivered. The work desk now settles this way: acceptance criteria are fixed when
the engagement opens, the fee is escrowed, release needs every required check recorded as
passed by a named verifier, and a dispute window with a clock decides the rest. What is
still open is the same shape on the DvP cash leg itself, where the condition would be a
presented credential rather than a recorded check.

### 2. Interoperability beyond a single hash-lock

The interop module demonstrates one hash-locked transfer pattern. The repeated outside
criticism of tokenisation platforms is fragmentation, and one pattern is thin cover.
Worth adding: a second, differently shaped route (for example a notary-attested transfer
alongside the hash-locked one) so the asset model is visibly transport independent, and a
plain statement of which parts are simulated at each hop.

Do not describe this as a production integration with any named framework. Describe the
pattern.

### 3. Say what the system does, not what it contains

The work desk and the settlement views are described in terms of their mechanics. The
framing that travels further is the outcome: what a participant got, not which module ran.
This is a documentation and copy change, not a rebuild, and it must not inflate anything:
an outcome claim is only allowed where the ledger can evidence it.

### 4. Infrastructure framing

The asset-specific parts of this codebase are a thin layer over a shared core: issuance,
custody, settlement, servicing, reconciliation, identity. That is true here and it is
worth making visible in the architecture document, because the same core already carries
property, carbon credits and work orders. No code change is implied; an honest diagram is.

## Open audit findings

| Id | Finding | Done looks like |
| --- | --- | --- |
| D1 | `api-gateway` has no tests | A test file for its routing and error paths, counted in the census. |
| D2 | No ESLint configuration | A config the existing code actually passes, wired into the sweep. |
| D4 | No compose file for the app itself | One file that brings up the app and the rail together, or a clear statement that `make dev` is the supported path. Do not add infrastructure for appearance. |
| D5 | Two hand-maintained API implementations | Either a shared contract test both must pass, or a documented statement of which is authoritative. |
| D6 | Junk demo listings in the seeded data | Remove the probe listings; fix the two with wrong city and pincode pairings. |
| D7 | Two credentials were exposed and are not rotated | Rotate them. This one is on the operator, not the code. |

## Not doing

Adding more shallow asset classes. Breadth without depth is the criticism the project is
trying to avoid, and the existing three already carry the infrastructure argument.
