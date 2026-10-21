# Cross-border corridors

Five ways money leaves the country, modelled separately because they are
separate things: different authorisations, different ceilings, different
amounts of time during which somebody is exposed.

## The corridors

| Corridor | Settlement | Needs | Ceiling | Window |
| --- | --- | --- | --- | --- |
| Scheme to scheme, person to person (India to Nepal) | deferred | scheme membership, sponsorship by an authorised dealer bank | ₹15,000 per transfer, ₹1,00,000 a month | the two schemes settle on their own cycles |
| Payment aggregator, cross border | deferred | a cross-border aggregator authorisation, intelligence unit registration | ₹25,00,000 per transaction | funds pass through a collection account at an authorised dealer bank |
| Bank to bank through correspondents | deferred | authorised dealer bank status | none fixed | three to five business days through the chain |
| Card network rail | scheme window | scheme membership, card data security certification | none fixed | authorised instantly, cleared later, reversible by chargeback |
| Multi-CBDC, both legs here | atomic | nothing beyond participation | none fixed | none |
| Two ledgers, hash time-locked | atomic across two chains | nothing beyond participation | none fixed | until the secret appears or the lock times out |

The numbers come from the public rules: the India to Nepal link that went live
in June 2026 carries ₹15,000 per transfer and ₹1 lakh a month; the Payment
Aggregator Directions of September 2025 set the aggregator's authorisation,
its net worth test and a ₹25 lakh per-transaction ceiling.

## The question that actually matters

Whether both legs sit on the same ledger.

**They do.** Then settlement is atomic: one movement, one block, and no
interval in which one side has paid and the other has not. This is what
mBridge demonstrated by putting several central banks' money on one platform
and settling foreign exchange in seconds rather than the three to five days a
correspondent chain takes. Here that is the multi-CBDC corridor, and it is the
only one where the ledger removes the risk instead of recording it.

**They do not.** Then there is a real gap and it has to be closed by something.
Two honest ways exist and both are implemented:

- **A hash time-locked transfer**, after Jasper-Ubin, which joined a Corda
  network in Canada and a Quorum network in Singapore with no shared platform
  and no trusted intermediary. The payer locks value against the hash of a
  secret. Revealing the secret to claim on one ledger reveals it on the other,
  so either both legs complete or neither does. If the secret never appears,
  the timeout returns the money. The refund path is implemented and tested,
  because it is the half that demonstrations skip.
- **A confirmation from the far institution.** The money leaves the payer into
  corridor suspense, the transfer is reported as provisional with the window
  named, and only a confirmation of the far leg makes it final. Nobody is
  credited in between.

## What is enforced before anything moves

- **Licence.** A corridor whose authorisation this deployment does not hold
  refuses and names it. Declared licences come from `CORRIDOR_LICENCES`, and
  declaring one here grants nothing anywhere else.
- **Ceilings.** Per transaction and, where the corridor has one, per payer per
  thirty days.
- **Purpose.** Each corridor carries a specific set of purposes, so a merchant
  payment cannot ride a person-to-person link.
- **Travel Rule.** Above roughly USD 1,000 the originator and the beneficiary
  must both be named, or the payment does not travel.
- **Reporting.** Above ₹10,00,000 a transfer is flagged reportable regardless
  of how it scored.

Every refusal is committed to the chain with the rule that caused it. A gate
whose operation cannot be audited is indistinguishable from no gate.

## Limits

This holds no authorisation, no correspondent relationship and no scheme
membership, and it moves simulated central bank money only. Nothing here is a
legal opinion, and a corridor working in this repository says nothing about
whether it would be permitted in practice.
