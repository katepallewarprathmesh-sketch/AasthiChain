# The card rail: interchange and disputes

Implemented in `drunix-gateway/cardscheme.go`, served at `/umi/cards/*`, shown
at `/cards`, tested by `drunix-gateway/cardscheme_test.go` and
`tests/cards.test.mjs`.

## Why this is its own rail

Every other corridor in this system moves an amount and settles it. A card
does neither cleanly, and the two reasons are the whole content of this
module.

**The merchant does not receive what the cardholder paid.** The issuing bank,
the network and the acquirer take their cut before settlement, and in India
some of those cuts are set by law rather than negotiated. A rail that reports
"₹10,000 settled" without saying who took what out of it has modelled a
transfer, not a card.

**An approval is not a payment.** It is a guarantee that can be reversed for
120 days, and for 540 days on delivery grounds, by a party who was never in
the transaction. That reversibility is the practical reason card money and
ledger money behave differently, and it is the thing a buyer paying for
property most needs to understand.

## What is real and what is not

Real: the arithmetic, the statutory caps, the network deadlines, the case fees
and the liability rules. Each cites its source in the response, not in a
footnote.

Not real: the connection. This deployment holds no card scheme membership and
no PCI DSS attestation, so nothing is authorised with a network, nothing is
presented into clearing, and no money moves on this desk. The corridor
catalogue already refuses `CARD-SCHEME` for exactly this reason, and that
refusal has not been weakened.

## The economics

| Instrument | Rate | Ceiling | Authority |
| --- | --- | --- | --- |
| RuPay debit | nil | none | Payment and Settlement Systems Act 2007, section 10A; notification S.O. 5067(E) of 14 September 2026 |
| Other debit, small merchant | 0.40% POS and online, 0.30% QR | ₹200 | RBI circular DPSS.CO.PD.No.1633/02.14.003/2017-18, 6 December 2017 |
| Other debit | 0.90% POS and online, 0.80% QR | ₹1,000 | the same circular |
| Credit | 2.00% declared default | none | no regulatory cap; priced between merchant, acquirer and network, usually 150 to 250 bps |
| Credit, cross-border | 2.50% declared default | none | no regulatory cap |

A small merchant is one whose turnover in the preceding financial year did not
exceed ₹20 lakh.

**The split.** Interchange goes to the issuer, the scheme fee to the network,
and the acquirer keeps the residual. The modelled shares are 1.50% interchange
and 0.15% scheme on credit, and 0.15% and 0.02% on debit, following the
proportion in the NPCI circular operative since October 2022, which puts
RuPay credit on UPI at roughly 1.5% issuer against 0.5% network and acquirer.

**The invariant.** Interchange plus scheme fee plus acquirer margin equals the
merchant discount rate to the paise, with the rounding residual landing on the
acquirer rather than disappearing. Everything is integer paise. A fee model
that does not balance produces a settlement file a merchant cannot reconcile,
which is the specific failure this guards against.

**What the ceiling does.** On a large debit transaction the per-transaction
ceiling bites long before the percentage does. When it does, the issuer and
the network are paid first and the acquirer absorbs the shortfall, which can
leave the acquirer with nothing. That is why small-merchant debit acceptance
is sold as a loss leader rather than a product, and the model reproduces it
rather than distributing the shortfall evenly.

**GST.** 18% on the merchant discount rate, charged on top of it. Showing GST
inside the three-way split is a common way to mis-state the cost, so it is
reported separately.

**Cross-border.** The network adds an international service assessment and the
issuer adds a currency markup, commonly 3.5% on an Indian card. Both are
billed to the cardholder and neither appears in the merchant's settlement, so
on a cross-border card payment the cardholder loses more than the merchant
does. The model reports both sides.

## The dispute ladder

| Stage | Visa | Mastercard |
| --- | --- | --- |
| Cardholder files | 120 days, up to 540 on delivery grounds | 120 days, up to 540 on 4853 |
| Merchant answers | dispute response, 30 days | second presentment, 45 days |
| Pre-arbitration | 30 days | 45 days |
| Arbitration filed | 10 days | 45 days |
| Case fee, paid by the loser | USD 600 | USD 575 |

Visa allocates fraud and authorisation disputes on its own network data with
no separate response stage, so the acquirer's challenge is itself a
pre-arbitration attempt. Mastercard keeps the linear ladder, and codes 4808,
4870 and 4871 skip pre-arbitration entirely.

**Reason codes modelled:** Visa 10.4, 11.3, 12.5 and 13.1; Mastercard 4837,
4853, 4808 and 4870. Each carries the evidence that answers it. A code from
the wrong network is refused rather than coerced.

**The liability shift.** 3-D Secure moves liability for a *fraud* ground to
the issuer, so an authenticated transaction cannot be charged back to the
merchant on 10.4 or 4837 at all. It does nothing for a goods-not-received
ground, which is the dispute merchants actually lose. The model enforces both
halves of that, because a system that treats 3-D Secure as blanket protection
teaches the wrong lesson.

**Missing the clock.** A response filed after the window closes is not
considered and the chargeback stands. This is modelled as an outcome rather
than an error, because missing the deadline loses more cases than losing on
the evidence does.

## Blocks

`UMI_CARD_PRESENTED`, `UMI_CARD_DISPUTED`, `UMI_CARD_REPRESENTED`,
`UMI_CARD_ESCALATED`, `UMI_CARD_RESOLVED` and `UMI_CARD_REFUSED`. Every rung,
including the refusals, is committed and labelled in the ledger explorer, so
the ladder is auditable rather than reconstructable from logs.

## Endpoints

| Route | What it does |
| --- | --- |
| `GET /umi/cards/posture` | every rate, deadline, case fee and reason code, published up front |
| `POST /umi/cards/price` | the split for one payment |
| `POST /umi/cards` | present an authorised payment |
| `GET /umi/cards` | presented payments and their disputes |
| `GET /umi/cards/{id}` | one payment with its full history |
| `POST /umi/cards/{id}/chargeback` | the issuer files |
| `POST /umi/cards/{id}/represent` | the merchant answers |
| `POST /umi/cards/{id}/prearbitrate` | the issuer comes back |
| `POST /umi/cards/{id}/arbitrate` | the network rules, the loser pays |

Pricing and posture are public. A merchant who cannot see the fee schedule
before accepting a card is in no position to price anything.
