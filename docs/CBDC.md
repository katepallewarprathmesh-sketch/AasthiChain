# CBDC settlement layer: design and plan

This is the design note for the work that follows the AMA keywords, and the
honest map of what is built, what is next, and what this project cannot do.

## The premise shift

Until now the chain in this repository was a settlement record sitting beside
the money: tokens moved on the ledger, rupees moved in a wallet table. The AMA
direction reverses that. The chain becomes the place the money itself lives, in
the form the regulator is actually piloting: central bank digital currency,
with the programmability, the offline path and the finality guarantees that go
with it.

So the hero is the chain, and the test of every feature below is simple: does
this function run on the ledger, or is the ledger only taking notes about it.

## What the regulator is actually doing (October 2026)

Design against the real pilot, not an imagined one.

- e₹ runs in two segments: **e₹-R** retail (about 10 million users, roughly
  ₹772 crore in circulation at 31 March 2026, down from ₹1,016 crore the year
  before) and **e₹-W** wholesale (16 participants, used for government
  securities, call money and tokenised certificates of deposit).
- **Programmability** is live and is the direction of travel: the sponsor binds
  funds by purpose, with parameters the RBI names explicitly as expiry date,
  geo-location, merchant category code and merchant VPA. Through 2025-26 food
  subsidy was credited as programmable e₹ in Gujarat, Puducherry and
  Chandigarh, spendable only at fair price shops.
- **Offline** is being tested over NFC and Bluetooth for small values, to work
  where UPI cannot.
- **Cross-border** CBDC pilots, bilateral and multilateral, are committed for
  2026-27, along with a CBDC and Asset Tokenisation sandbox. There is a digital
  assets pact with the Monetary Authority of Singapore.
- UMI, this project's subject, is the RBI's tokenisation platform and settles
  in wholesale CBDC. That is the join: tokenised asset on one side, central
  bank money on the other, both on the ledger.

On the cross-border side the rules are equally concrete. UPI acceptance is live
in nine countries, and the India-Nepal UPI to NPI link went live on 6 June 2026
as a genuine peer-to-peer corridor, with a per-transaction cap of ₹15,000 and
₹1 lakh a month. Aggregating cross-border payments needs a PA-CB authorisation
under the Payment Aggregator Directions of 15 September 2025: ₹15 crore net
worth at application rising to ₹25 crore, FIU-India registration, a per
transaction ceiling of ₹25 lakh, and an import collection account at an AD
bank. Nineteen entities held the licence at January 2026. Card networks run
their own rails and their own licences, which is a different corridor with
different economics, and NIPL provides scheme rules and interoperability but
replaces none of FEMA, the PA-CB obligations, AD bank reporting, sanctions
screening or the partner country's licensing.

## The two finalities

This distinction drives much of the design and is the one most often blurred.

**Technical finality** is a property of the ledger: the block is committed, the
hash chain extends past it, and no participant can replace it. On this chain
that happens in milliseconds, continuously, with no cut-off time.

**Financial finality** is a property of the law: the moment a transfer becomes
irrevocable and unconditional against third parties, including an insolvency
administrator. In India that comes from the Payment and Settlement Systems Act
and the designation of the system, not from the hash.

The two are not the same thing, and the gap between them is where most
settlement risk lives. A payment can be technically final and financially
provisional (anything settled over a commercial bank rail before its clearing
window closes), and the reverse is possible as well.

Central bank money closes the gap, which is the actual argument for CBDC in a
settlement system: a leg paid in e₹ is final when the block commits, because
the money is a claim on the central bank and there is no further settlement
step to wait for. A leg paid over a bank rail is not, and must say so.

So every transfer in this layer carries both, separately, and never reports one
as the other. Where the gap exists, the layer names the window that closes it.

The related point from the AMA: a financial market infrastructure has time
constraints (operating hours, clearing windows, cut-offs, value dates) and a
blockchain does not. A 24x7 ledger settling against a rail that closes at 18:00
is a 24x7 ledger with an 18:00 settlement. The layer models the window
explicitly rather than pretending it is gone.

## Phases

**Phase 1 (built now): the CBDC core.**
- e₹-R and e₹-W wallets, issued by the central bank role, redeemed back to it.
  Supply is conserved on issue, transfer, spend and redemption.
- Programmable grants with the RBI's own parameters: expiry, merchant category,
  named merchants, geography, purpose. A spend that violates one is refused and
  the refusal is committed to the chain.
- An offline protocol: value reserved online, signed vouchers spendable without
  connectivity, double spend caught deterministically on reconnection, and a
  small-value cap, because offline money that cannot be checked in real time
  has to be bounded.
- Conditional transfers: money locked by a rule and released automatically when
  an attested event satisfies it (the flight-cancellation refund), or returned
  when the deadline passes with no event.
- Both finalities recorded on every movement, with the bank-rail window named
  where financial finality is still pending.
- AML and KYC tiers enforced at the point of movement, reusing the published
  rules and the trained model from the risk layer.

**Phase 2: cross-border corridors.** The existing cross-border module gets the
corridor cases the AMA listed: bank to bank, card network rails, PA-CB
aggregation, a NIPL-style peer-to-peer link, and the case that matters most for
a ledger, whether both legs sit on the same chain or on two chains that must be
reconciled. Each corridor carries its own licence requirement, caps and
reporting, and refuses what the law of the land does not allow.

**Phase 3: interoperability.** e₹ against UPI, against a tokenised deposit, and
against another CBDC, with atomic exchange where both legs are on the ledger
and an explicit settlement window where one is not.

**Phase 4: speed and experience.** Published latency measurements on the real
path rather than adjectives, and the consumer surfaces where this is visible:
a refund that arrives before the passenger has left the airport.

The experience half of phase 4 is shipped. The digital rupee screen shows the
conservation check, both kinds of finality, purpose-bound money and every
condition with the party trusted to release it, and it can act as well as
report: issue and redeem, transfer, lock money against an event, attest one,
bind money to a purpose and try a spend that breaks the rule, carry value
offline and redeem it, check a corridor before sending and then send across
it, claim a hash-locked transfer or confirm a foreign leg. Reading needs no
account; every action is recorded against a named participant, and a refusal
is shown exactly as the rail worded it, including which authorisation was
missing. The latency half is still unpublished.

Every page on the site, this one included, is listed with a sentence of
explanation in the directory at `/explore`, so nothing is reachable only by
knowing its URL and the navigation bar can stay short.

## What this is not

This is a simulation of the regulator's design, built in the open against
published pilot behaviour. It issues no central bank money, holds no settlement
account, is designated under no statute, and nothing in it is a legal opinion.
It is a demonstration of how the mechanics can work, with the limits written
down where they bind.
