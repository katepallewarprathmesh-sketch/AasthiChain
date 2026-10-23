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

These are the real failures against the team's standard. Each one has rail
code, chain blocks and a passing suite, and **no screen at all**.

| Feature | Rail | What is missing |
| --- | --- | --- |
| Key register | `/umi/keys/*` | No UI. Registration, weak-key screening and the retroactive-void state are invisible to a user. This is the strongest security story in the repo and it cannot be demonstrated without curl. |
| Signed oracle feeds | `/umi/oracle/*` | No UI. Publishers, quorum, staleness and the five refusal states are unreachable. |
| Backing attestations | `/umi/backing/*` | No UI. Issuance is refused past the attested figure, and nothing shows that. |
| Agent passports | `/umi/agents/*` | No UI. Pseudonymous actors with threshold recovery of the principal. |
| Mandates | `/umi/mandates/*` | No UI. Bounded agent authority with spend counted on the ledger. |
| Proposing agent | `/umi/agent/*` | No UI. Drafts actions for a person to approve. |
| Credentials | `/umi/credentials/*` | No UI. Ed25519 signed, hash anchored. |
| Attestations | `/umi/attestations/*` | No UI. Downstream exposure view exists only as JSON. |

Eight features. The pattern is consistent: the hard part was built and the
last mile was not. Against a rubric that gives 15% to usability and clarity
in a live demo, an unreachable feature scores as if it does not exist.

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
| Public chain settlement | `PropertyToken.sol` passes 66 checks, never deployed to a public testnet; the public leg is a mirror by design |
| Solana anchoring | Code proven correct; the devnet key holds 0 SOL and the faucet is rate limited per IP |

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
