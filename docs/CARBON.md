# P2: carbon credits as a second asset class

## The claim this is built to support

The settlement core never knew what a property was.

That is not a slogan, it is a property of the code as written. `assetId` is an
opaque string everywhere in the rail. There is no `assetClass` field. DvP moves
`tokens` between holders and paise between wallets; the atomic swap has no
opinion about what the tokens represent. `pilotISINFor(assetID)` is
`sha256("aasthi-pilot-isin|" + assetID)`, which works on any string.

So adding a second asset class should be a registry entry, not a rewrite. This
document is the plan for proving that, and for being honest about the one place
where carbon genuinely does need new code.

## Why carbon, and why not five asset classes

Tokenised real estate settled in central-bank money is the core bet. A second
class is worth adding only if it tests something the first one does not.

Carbon does. Property tokens live forever and change hands. A carbon credit has
a terminal state: it is **retired**, permanently consumed against someone's
emissions, and must never trade again. That is a lifecycle the rail has never
had to model, and getting it wrong is the single best-known failure mode in
carbon markets: **double counting**, where the same tonne is claimed twice.

Five shallow asset classes would demonstrate nothing except a dropdown. One
class with a real terminal state and a real conservation invariant is worth
more.

## What is additive and what is new

**Additive, no behaviour change:**

- `assetClass` defaults to `PROPERTY`. An asset with no profile registered is a
  property, exactly as today. Every existing test, seed and settlement path is
  untouched.
- The DvP path, the cash leg, ISIN assignment, reconciliation and the ISO 20022
  trace are not modified. Carbon settles through the same atomic swap.

**Genuinely new:**

- An asset profile registry: class plus the metadata a credit needs (project,
  vintage, methodology, serial range).
- Retirement, which is the only operation property does not have.
- A conservation invariant extended to cover retired supply.

## The invariant

Today the securities leg is conserved when:

    outstanding <= authorised

where `outstanding` is the sum of all positive holder positions.

Retirement removes tokens from circulation without destroying the record of
them. A retired credit is debited from its holder and credited to nobody. So
outstanding falls, and the check above would still pass while quietly losing
track of where the tokens went.

The invariant therefore becomes:

    outstanding + retired <= authorised

This is the part worth looking at closely. It is what makes double counting
detectable rather than merely discouraged: the retired tally is permanent, the
tokens are gone from the book, and the sum cannot exceed what was ever issued.
A credit that was retired cannot be settled again because there is no position
left to move, and cannot be quietly re-issued because `authorised` is pinned.

## Retirement semantics

- Only an asset whose class is `CARBON` can be retired. Retiring a property is
  refused; it is not a meaningful operation and silently allowing it would make
  the invariant meaningless.
- Retirement is irreversible. There is no un-retire route, by design.
- Each retirement commits a `UMI_CARBON_RETIRED` block carrying the holder, the
  quantity, the beneficiary the retirement is claimed for, and the reason.
- The block is the certificate. "Prove this tonne was retired" is answered by a
  block height, not by our word.

## Honesty

A real carbon credit is issued and retired in an independent registry, and the
registry is the authority on whether a serial is live or retired. **We are not
connected to one.** Nothing in this feature talks to an external registry, and
the serial numbers are ours.

So the carbon registry appears on `/trust` as an eleventh simulated boundary,
in the same words as every other one, and the UI says the same. Specifically we
do not claim conformance with any particular standard's methodology, and we do
not name a registry operator as a partner, because none of them is one.

What is real: the lifecycle, the conservation arithmetic, the irreversibility,
and the block that proves it.

## Surface

Go, in the rail, as with everything else:

    POST /umi/assets                 register a profile (class + metadata)
    GET  /umi/assets                 list profiles
    GET  /umi/assets/{assetId}       one profile
    POST /umi/carbon/retire          retire credits, commits a block
    GET  /umi/carbon/retirements     the retirement register

The JS tier stays a pure proxy with no carbon logic, as with UMI.

## Seed

One carbon asset end to end, so the demo shows a real settlement and a real
retirement rather than an empty table:

- A project asset with a vintage and a serial range, issued to the originator.
- A DvP of credits to an investor through the existing atomic swap, proving the
  core did not need to change.
- A retirement by that investor, proving the terminal state and the invariant.

## Test plan

Each of these must be watched failing before it is trusted.

1. An asset with no profile is `PROPERTY`, and every existing path behaves
   identically. This is the additive guarantee.
2. Carbon settles through the unmodified DvP path.
3. Retiring more than a holder owns is refused.
4. Retiring a `PROPERTY` asset is refused.
5. After retirement the holder's position is reduced and the tokens cannot be
   settled again.
6. `outstanding + retired` never exceeds `authorised`, including after a
   settlement followed by a retirement.
7. Retirement is recorded in a block, and the block is retrievable.
8. Restart durability: retired totals survive a restore, otherwise a restart
   would silently re-authorise retired supply. This is the double-count hole
   that matters most.
