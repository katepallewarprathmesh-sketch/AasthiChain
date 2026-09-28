# Programmable Ownership on AasthiChain Drunix

Beyond tokenization: ownership itself becomes programmable. Every primitive below
settles as a block on the same hash-chained Drunix ledger, so investors, asset
owners and financial participants share one trusted transaction layer.

## The suite (all live, all ledger-committed)

| Primitive | What it does | Ledger block |
|---|---|---|
| **Automated rental distribution** | Owner/Regulator credits rent pro-rata to every holder in one call (`POST /api/properties/:id/yield/distribute`). Shares are computed from the live holder list and credited to wallets instantly. | `YIELD_DISTRIBUTED` |
| **Token-weighted governance** | Owner/Regulator creates proposals (`POST /api/properties/:id/governance`); holders vote with their tokens (`POST /api/governance/:assetId/:govId/vote`). 20% quorum auto-resolves YES>NO. | `GOVERNANCE_RESOLVED` |
| **Lending against fractions** | Pledge up to 50% of a holding (`POST /api/credit/pledge`) for an instant INR credit line at 50% LTV. Pledged tokens are locked (transfers/swaps reject). Repay with 1% fee (`POST /api/credit/repay`) to unlock. | `COLLATERAL_PLEDGED` / `LOAN_REPAID` |
| **Multi-property atomic swaps** | `POST /api/swap` exchanges tokens across two properties between two parties. Both legs settle together or not at all (checked against lock-aware balances). | `ATOMIC_SWAP` |
| **Continuous NAV** | `GET /api/portfolio/:identityId/nav` marks the portfolio to last trade price: assets + earned yield − outstanding debt. | read model over the ledger |
| **Dynamic ownership** | Phases (`primary` to `secondary`), live cap table, secondary transfers, swaps and credit all mutate ownership in real time, every change committed and verifiable. | all of the above |

UI: property page has a "Programmable ownership" panel (distribute yield, create
proposals, vote, borrow, repay). Wallet shows Portfolio NAV, active loans with
one-tap repay, and the multi-property swap form.

## Credit model (v1, honest labels)

- Collateral cap: 50% of holding; loan = 50% LTV of token value; 1% fee on repay.
- Locks are enforced in `/api/transfers` and `/api/swap` (`ERR_TOKENS_LOCKED`).
- The INR credit line is a **clearly-labeled simulation**. Production wiring is
  the funds leg: a banking partner or CBDC wallet credit on pledge, exactly the
  money-leg pattern below.

## UMI alignment (why this matters beyond a prototype)

SEBI's **Demat 2.0** pilot (launched Sept 2026) issues corporate bonds natively
on DLT with atomic settlement, the money leg in **RBI's wholesale CBDC via the
Unified Market Interface (UMI)**, and smart-contract asset servicing (interest,
redemption). REC, L&T and IIFL issued the first 1,025 crore of tokenized bonds.

AasthiChain implements the same architectural pattern for real estate:

| Demat 2.0 / UMI concept | AasthiChain equivalent (today) |
|---|---|
| Asset as token on shared DLT | Property fractions on the hash-chained Drunix ledger |
| Atomic DvP | `aasthi.dvp-v1`: `TOKEN_TRANSFERRED` + `ESCROW_RELEASED` pair |
| Programmable asset servicing | `aasthi.servicing-v1`: automated yield distribution |
| Shared trusted layer across participants | 5-org permissioned network, public verify API |
| CBDC money leg (via UMI) | UPI/PayU rail today; CBDC wallet credit is the same bridge slot |

**Contribution path** (bigger than a prototype): UMI itself is RBI/SEBI-depository
infrastructure; participation happens by (1) building regulated applications on
the pattern and joining regulatory sandbox cohorts, (2) integrating as a market
participant through depositories' pilot programs, (3) contributing open DLT
tooling and standards. AasthiChain's open verify API, parity-tested Go ledger
kernel, and honest-simulation rails are a ready portfolio for exactly those
programs: we demonstrate the real-estate instance of what UMI standardized for
bonds, and every servicing primitive maps 1:1 to the published pilot features.
