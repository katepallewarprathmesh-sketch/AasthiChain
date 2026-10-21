# Cross-border funding: what stablecoins can and cannot fix

Design note, written 21 Oct 2026 from current law and current market practice. Read this before
assuming crypto solves the "only Indians can pay" problem, because it does not solve it the way it
first appears to.

## The premise, corrected

The starting thought was reasonable: UPI is domestic and the demo uses fixed test identifiers, so
nobody outside India can fund a purchase. Add crypto, and anybody with a wallet can pay. The second
half does not follow, for two independent reasons, and both have to be said plainly before any code
is written.

**1. The buyer restriction is not a payments restriction.** A foreign national of non-Indian origin
who is resident outside India cannot purchase immovable property in India at all. Not through UPI,
not through a wire, not through a stablecoin. The route open to them is a lease of up to five years
or inheritance. Citizens of eleven named countries (including Pakistan, Bangladesh, China, Iran,
Nepal, Bhutan, Hong Kong, Macau and the DPRK) need prior RBI permission whatever their residence.
So the addressable cross-border buyer is an NRI, an OCI or a PIO, not "anyone with a wallet".

**2. For the buyers who are eligible, the payment channel is prescribed.** Under FEMA the
consideration must come through banking channels: inward remittance, or a debit to an NRE, FCNR(B)
or NRO account, in rupees. Travellers' cheques and foreign currency notes are excluded by name, and
practitioner guidance lists cryptocurrency and digital tokens among the prohibited methods. A
single non-compliant payment leg taints the whole purchase.

Behind that sits the status of crypto in India: legal to buy, hold and sell, not legal tender,
taxed at a flat 30% on transfer with 1% TDS and no loss set-off, and with no recognised FEMA
channel for a resident-to-non-resident transfer of a virtual digital asset. The Enforcement
Directorate pursues exactly this pattern.

## What does work, and is what the industry actually does

Accept the stablecoin **offshore**, off-ramp it there, and remit **fiat into India** through a
regulated provider against the invoice, with the correct purpose code and the bank's advice. The
stablecoin never touches an Indian wallet, and the money that reaches the seller arrives by the one
route FEMA recognises. This is the standard structure for Indian businesses taking stablecoin
payments in 2026, and it is the only shape worth modelling.

The economics are why anybody bothers: a cross-border wire costs roughly 25 to 50 dollars plus half
a percent to two percent in FX, against well under a cent in network fees on an L2, and settles in
minutes rather than days. Compliance does not disappear: the FATF Travel Rule is live in most
jurisdictions, full originator and beneficiary data above about USD 1,000, and the EU applies it
with no threshold at all. In the EU the stablecoin itself must be a MiCA-authorised one, which in
practice means USDC rather than USDT.

## What this repository implements

A **cross-border funding leg**, additive, simulated to exactly the same standard as the rest of the
rail, and deliberately shaped so that the compliant structure is the only path through it:

1. **Quote.** An eligible buyer asks to fund a purchase with a stablecoin. The rail returns an
   indicative rate with an expiry, the amount in stablecoin, and the destination: the off-ramp, not
   the seller.
2. **Eligibility gate, before anything else.** A foreign national of non-Indian origin is refused
   with the reason stated. A restricted nationality is refused. Missing KYC is refused. These are
   refusals, not warnings, and each is committed to the chain.
3. **Travel Rule.** Above the threshold the originator and beneficiary fields are mandatory and the
   quote cannot progress without them.
4. **Payment proof.** The buyer records the transfer reference. The rail records it; it does not
   claim to have verified a chain it is not connected to.
5. **Off-ramp attestation.** A regulated provider attests that the stablecoin was converted outside
   India and INR was remitted through banking channels, carrying the bank advice reference and the
   purpose code. Only this step credits the buyer's rupee wallet.
6. **Settlement** then runs through the existing DvP path, unchanged, in rupees.

The point of the design: **no path exists where a token moves against a crypto payment made
directly to the seller.** The rail refuses to be the thing that breaks FEMA.

## What it does not claim

- No live chain connection, no RPC, no wallet, no custody, no real money. The transfer reference is
  recorded, not verified, and every response says so.
- The exchange rate is indicative and configured, not an oracle. Nothing here is a price feed.
- The off-ramp provider is an interface with a simulated implementation. No provider is integrated
  and none is named.
- The eligibility gate is a model of the rule, not legal advice, and it is coarse: it asks what the
  buyer declares and records the declaration.
- Tax is shown for information (30% on gains, 1% TDS on transfer) and is not computed, withheld or
  filed.

## On MetaDAO, separately

MetaDAO is a Solana launchpad with futarchy governance: a four-day USDC sale at one price for
everyone, ten million tokens to buyers, all proceeds into a treasury that decision markets control,
a monthly founder budget capped at one sixth of the minimum raise, and team tokens that unlock only
at 2x through 32x of the launch price, no sooner than eighteen months out. Its permissionless
sibling, Backable, takes goals from 10,000 to 2,000,000 dollars and requires a verified domain, a
Cayman company formed through its legal tooling, and a disclosure of prior sales and insider
allocations.

Whether it can raise money: demonstrably yes, in aggregate. Across 23 curated sales there were
about 625 million dollars of commitments and roughly 45 million actually accepted.

Whether it fits this project, today: no, and for reasons that are not about the technology.

- **The odds on the open side are brutal.** Of about 90 permissionless launches, 9 met their
  minimum, and of 44 million dollars committed, 568,000 was accepted. The headline numbers belong
  to a handful of names.
- **It sells an ownership coin, not a grant.** The treasury, the right to mint and the project's
  intellectual property pass to an entity governed by traders. That is a reasonable bargain for a
  company. It is a strange one for an Apache-2.0 demo whose whole claim is that its rails are
  honestly labelled simulations.
- **The founder-side legal position is the hard part.** An India-resident founder running an
  offshore token sale, forming a Cayman entity and receiving USDC runs straight into the FEMA and
  VDA issues described above, with none of the clean structure the payments section has.
- **There is nothing to price yet.** No entity, no revenue, no users, and the rails that make the
  product interesting are explicitly simulated. A market asked to value that will value it at
  roughly what it is worth.

A fairer reading of the same research: the parts of MetaDAO worth copying are free. Capped
drawdown, a public minimum, refunds when the minimum is missed, and spending that has to be
proposed in the open are all governance ideas this repository can demonstrate without selling
anything to anyone. If funding is the real goal, grants and a sponsorship page cost nothing and
create no securities question.
