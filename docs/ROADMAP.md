# What to build next

Written 19 October 2026, against `774261e` plus the proof-page fixes.

This is a working plan, not a wish list. Everything here is sized, ordered and justified by
something the codebase actually lacks. Items already shipped live in `docs/BACKLOG.md` under the
closed table; deferred audit findings stay there too. If an item below turns out to be wrong when
it is picked up, the right move is to say so and drop it, not to build it anyway.

## The one sentence version

The settlement core is strong and the story above it is now complete (asset, attestor, credential,
token, and conditional payment on a verified result). The two real weaknesses are **operational
credibility** (one untested module, no linting, hand-maintained duplicate APIs) and **the first
ninety seconds of a stranger's visit** (no screenshots, no hosted walkthrough, demo data with junk
in it). Those should be fixed before any new feature.

---

## P0 · Correctness and credibility

### 1. Close the conditional settlement loop on the cash leg
The work desk now pays on a verified result. The DvP cash leg still cannot: it settles atomically
or fails, with nothing in between. The missing shape is cash locked at settlement and released
when a named condition is met, where the condition is the presentation of a valid credential and
the party allowed to assert it may be an agent under a mandate. This is the piece that makes the
three layers (credential, mandate, escrow) one mechanism rather than three demos.

Done looks like: a `UMI_CONDITION_*` block family, the reconciliation check proving conservation
while cash sits conditional, a timeout that cannot strand money, and a failure test for every way
the condition can fail to arrive.

### 2. Test the untested module
`api-gateway` has no tests at all (`docs/BACKLOG.md` D1). It is the only Go module in that state.
Either cover it or delete it: an untested module in a repository that advertises its test counts
is worse than no module.

### 3. One API implementation, not two
`frontend/api/index.js` and `mock-api-server.js` are maintained by hand in parallel (D5). They
have already drifted once. Extract the shared handlers so the test rig and production cannot
diverge silently.

### 4. Lint
No ESLint config exists (D2). The result is inconsistent style and a class of bug (unused state,
missing dependency arrays, shadowed variables) that nothing currently catches. Add a config and
wire it into CI as a non-blocking job first, then make it blocking once the backlog is clear.

---

## P1 · Reproducibility

### 5. A compose file for the whole app
Three processes have to be started in the right order by hand (D4). One compose file, one command,
documented ports. This is the single biggest reduction in "I cloned it and nothing happened".

### 6. A seed that is not embarrassing
Three probe listings and two broken pincodes are still in the demo data (D6), the attestor record
reads "100% withdrawn (8 of 8)" because the test suite withdraws everything it issues, and demo
wallets accumulate state across runs. A deterministic, curated seed with a reset command would fix
all three. Nobody should see a 100% withdrawal rate on the page that argues attestors matter.

### 7. Rotate the two credentials still listed as unrotated
D7. A demo key in a public repository is a small risk and a large credibility cost.

---

## P2 · First impression

### 8. Screenshots and a recorded walkthrough
The README describes screens nobody can see without running the stack. Real screenshots of the
ledger explorer, the settlement rail and the proof chain, plus a two-minute recording of the demo
script, would do more for a visitor than any new feature on this list.

### 9. A hosted read-only instance that stays seeded
The public deployment loses its interesting state. A nightly reseed, or a read-only snapshot
instance, means the links in the README show something instead of an empty rail.

### 10. Interface consistency, done carefully
The signed-in screens are visibly older than the landing page. The first attempt at this (a
component library across three pages at once) was reverted because it changed too much at once.
The right version is: one page, behind a flag, reviewed on the running site, then the next. Start
with the ledger explorer, which is the page a sceptic opens first.

---

## P3 · Depth, once the above is done

### 11. A second interop route
One hash-locked transfer pattern is thin cover against the fragmentation criticism. A
notary-attested route alongside it would show the asset model is transport independent.

### 12. Attestor accountability with teeth
The record publishes an attestor's history and states plainly that no penalty is enforced. The
honest next step is a staking or bonding model where a withdrawal has a cost, or a clear written
argument for why that belongs to the legal layer and not the rail.

### 13. Make the agent path demonstrable end to end
An agent can now hold a mandate, deliver work under it and be paid on verification. Nothing in the
repository drives that sequence automatically. A scripted agent (clearly labelled as a script, not
an autonomous system) that runs the whole loop would make the most topical part of the project
visible in thirty seconds.

### 14. Pagination in the interface, not just the API
List reads are bounded server side. The pages still render everything they receive. For a demo
dataset that is fine; it would not survive a real one.

---

## Deliberately not doing

- **More asset classes.** Five shallow ones would add surface and no credibility.
- **A token, a chain or a listing of any kind.** The project's argument is that settlement is the
  interesting part.
- **Claiming any real integration.** The rail is a simulation of the UMI pattern, the Fabric fork
  is a fork, the talent provider is a pattern not a vendor. That stays true in every surface.
