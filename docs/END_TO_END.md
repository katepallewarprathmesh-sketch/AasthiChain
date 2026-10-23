# End to end, or not shipped

A feature counts as end to end here when all five of these are true:

1. **A person can reach it.** There is a screen, and a route to that screen
   that does not require knowing a URL or holding a key.
2. **The rail owns the logic.** The API layers stay proxies; no business rule
   lives in JavaScript.
3. **It writes to the chain.** Every state transition lands as a typed block,
   so the ledger explains what happened without consulting a Go map.
4. **It is covered.** An integration suite drives the real path, including at
   least one refusal, not only the happy case.
5. **It declares its own boundary.** A simulated leg says so on the surface a
   user reads, not only in a comment.

The fifth is the one that keeps the other four honest. Several features here
are deliberately simulated because the real version needs a licence this
deployment does not hold. Those can still be end to end *within the declared
boundary*: what they must never do is imply the boundary is somewhere else.

## Status today

### Complete: reachable, railed, blocked, chained, covered

| Feature | Screen | Notes |
| --- | --- | --- |
| Tokenisation and listings | `/marketplace`, `/property/:id` | |
| Atomic DvP settlement | `/umi` | The core path, with the cash leg |
| Wallets and e-rupee balances | `/wallet`, `/digital-rupee` | Caps and reserves enforced on the rail |
| Secondary market and baskets | `/market`, `/umi` | |
| Servicing and income | `/dashboard` | |
| Ledger explorer | `/ledger` | Every block type rendered with a label |
| Cross-ledger transfer | `/umi` | Lock, commit, abort, with custody counts |
| Cross-border funding | `/cross-border` | Quote, payment, off-ramp, rupee credit |
| Carbon credits and retirement | `/umi` | Second asset class on one rail |
| Corridors | `/umi` | Refusals name the missing licence |
| AML screening | `/umi` | Velocity cap, Travel Rule threshold |
| Private data collections | `/umi` | Hash on the chain, value by role |
| Work desk escrow | `/umi` | Released against an anchored deliverable |
| Throughput and latency | `/umi` | Measured from served traffic, with the lock named |
| Document anchoring and verification | `/verify` | Digest only, retrieval refused by design |
| Audience analytics | `/admin/insights` | Added 23 Oct, with its limits printed |

### Built and tested, but a person cannot reach it

**None, as of 23 October 2026.** The four that were unreachable now have
screens:

| Feature | Screen | What it shows |
| --- | --- | --- |
| Key register | `/keys` | Generate a key in the browser, prove possession against a server challenge, watch the entropy screen pass it or refuse it. Includes a deliberate weak key, the small integer 4, one of the values recovered from the eMudhra CAs. |
| Signed feeds | `/feeds` | Every reading, its signing key, its age, and which of the five refusal states it is in. |
| Backing attestations | `/feeds` | Coverage, attestor, as-of date, and whether issuance is still allowed. |
| Agent passports | `/proof`, passports tab | Opaque agent identifier, custodians, and the threshold needed before the principal can be named. |

**A correction to the first version of this audit.** It listed eight
unreachable features. Four of them (credentials, attestations, mandates and
the proposing agent) were already reachable through `/proof` and `/cbdc`; the
audit grep looked for one call style and missed a helper that used another.
The real number was four. The method has been replaced with
`tests/reachability.test.mjs`, which searches for the rail path itself rather
than for a particular way of calling it, and which fails if any mounted
module has no screen.

### Chain-first gaps (AMA items 8 and 20)

Listings, documents, work orders and the marketplace keep their state in Go
maps and write blocks *about* that state. The CBDC layer is the counter
example: there the money itself is on the ledger. Making the older modules
chain-first is the real version of criterion 3 above, and it is the largest
single piece of unfinished architecture.

### Blocked by something outside the code

These cannot be completed by writing more software. The blocker is named so
nobody mistakes them for unfinished work.

| Feature | Blocker |
| --- | --- |
| Real e-rupee settlement | Access to CBDC rails is restricted to RBI pilot participants |
| Cross-border payment rail | No PA-CB licence; the off-ramp leg is simulated |
| Card scheme corridor | No scheme membership; interchange and chargeback described, not implemented |
| Paying a seller in tokens | Prohibited under FEMA for Indian immovable property. Not a gap, a rule |
| Real Fabric network | `DRUNIX_MODE=real` and `-tags real` exist; no network is deployed |
| Public chain **settlement** | Mirroring is done and works; settling title on a public chain is not a software gap. Indian immovable property cannot be transferred by a blockchain entry, so the public leg stays a mirror by design |

## What this standard implies going forward

For every new feature, in the same change: rail logic, typed blocks, a screen
reachable from `Explore`, a suite with a refusal case, and a visible statement
of what is simulated. A feature that lands without the screen is not half
done, it is **not done**, and it will not be counted as shipped.

The backlog this creates, in the order that serves the rubric best:

1. **Key register UI.** Security sits inside the 25% technical band and this
   is the best security work in the repo.
2. **Oracle feeds UI.** Staleness and quorum refusals are visually legible and
   make the point about honest data.
3. **Backing attestations UI.** Directly answers "is this token backed".
4. **Agent passports, mandates and the proposing agent.** One screen can carry
   all three, since they are one story about bounded agent authority.
5. **Chain-first migration** for listings, documents and work orders.
