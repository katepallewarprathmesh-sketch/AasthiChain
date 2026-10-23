# Chain-first state: the ledger as the state, not the commentary

Implemented in `drunix-gateway/chainstate.go`, served at `/umi/chainstate/*`,
shown at `/chainstate`, tested by `drunix-gateway/chainstate_test.go` and
`tests/chainstate.test.mjs`.

## The problem this addresses

The AMA audit recorded the same gap twice, as items 8 and 20: large parts of
this system wrote blocks *about* things that actually lived in a Go map. That
is a log, not a ledger, and from the outside the two are indistinguishable.

The offer book was the clearest case. A holder could list tokens, the listing
could be taken or withdrawn, and the ledger recorded none of it except the
settlement itself. Two consequences followed:

1. **The map was the truth.** The map and the blocks could disagree and
   nobody would find out. A reviewer reading the chain had no way to tell
   whether it was the system's state or a stream the system happened to emit.
2. **The state could not survive the process.** Restart the rail and the book
   was empty, even though every listing was supposedly recorded.

## What chain-first means here

A module is chain-first when its in-memory state is a **projection**: a pure
function of the committed blocks, rebuildable by replaying them, and provably
equal to what the module is serving.

Three things make that real rather than aspirational.

**The blocks have to carry enough.** Listing, taking and withdrawing an offer
now each commit a block carrying every field the book needs:
`UMI_OFFER_LISTED`, `UMI_OFFER_TAKEN`, `UMI_OFFER_CANCELLED`. Where a field
genuinely cannot live on the chain, the projection names it rather than
implying there is nothing missing.

**The replay has to be independent.** `ProjectOffers`, `ProjectDocuments` and
`ProjectWork` read the chain and nothing else. They never consult the live
module, which is what makes the comparison meaningful.

**The comparison has to be able to fail.** `/umi/chainstate/verify` rebuilds
each module and checks it against what the rail is serving, reporting each
disagreement with the entity, the field, and both values. A Go test reaches
past the rail, changes a served offer without writing a block, and asserts
that the check catches it. A verification that cannot fail proves nothing.

## Recovery

The rail calls `RestoreOffers` at boot. A restarted process rebuilds the book
from the ledger instead of starting empty while the blocks that created it sit
there unread, and the identifier sequence is advanced past anything restored
so a recovered book cannot reissue an id the chain already used.

On a rail that has not restarted the healthy answer is zero restored, because
the book already is the projection.

## What this does not claim

**The maps have not gone away.** They remain as caches of the projection,
because the read path should not walk the whole chain on every request. What
changed is which one is authoritative: the projection is derived from blocks,
the served state is checked against it, and a divergence is a reported failure
rather than something quietly absorbed.

**Three modules are covered**, not the whole rail. Offers, documents and work
orders. Modules outside that set still hold state the chain does not fully
carry, and `/umi/chainstate` says so rather than listing them as passing.

**Some fields are not on the chain and should not be.** The document register
projects the CID, the hash and the status, but the file bytes live in the pin
store and are addressed by the CID on the block. Putting them on the ledger
would be a mistake, not an improvement.

## Endpoints

| Route | What it does |
| --- | --- |
| `GET /umi/chainstate` | every module's state rebuilt from blocks |
| `GET /umi/chainstate/verify` | does the ledger agree with what is being served |
| `GET /umi/chainstate/{module}` | one projection: `offers`, `documents` or `work` |
| `POST /umi/chainstate/restore` | rebuild the live offer book from the ledger |

Reads are public. A claim that a ledger is the source of truth is only worth
something if an outsider can run the comparison themselves.
