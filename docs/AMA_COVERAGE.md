# AMA keywords: what is actually covered

An audit against the keyword list, checked against the code rather than from
memory. Status is one of **done**, **partial** or **not started**, and
"partial" always says what is missing. Nine of twenty-one are done, seven are
partial, five have not been started.

| # | Keyword | Status | Where it lives | What is missing |
| --- | --- | --- | --- | --- |
| 1 | CBDC | done | `cbdc.go`, `/umi/cbdc/*`, `docs/CBDC.md` | Retail and wholesale segments, issue, transfer, redeem, conserved supply. |
| 2 | eKYC | partial | KYC tiers in `cbdc.go`, verified-identity flags across the rail, credentials in `credentials.go` | There is no identity verification flow: tiers are asserted at account opening, not earned by verifying a document or a one-time code. No Aadhaar-style or video path, and no re-KYC expiry. |
| 3 | Better offline protocol | done | `IssueOffline` / `RedeemOffline`, `tests/cbdc.test.mjs` | Reserved value, signed voucher, bounded exposure, deterministic double-spend detection. Noted limit: symmetric signing, where production needs per-device keys. |
| 4a | Programmable CBDC | done | `Grant` / `Spend`, `ProgramCondition` | Expiry, merchant category, named merchants, geography, all enforced on the rail with refusals committed. |
| 4b | Interoperability of CBDC with other systems | not started | - | e₹ against UPI, against a tokenised deposit, against another CBDC. Planned as phase 3 in `docs/CBDC.md`. |
| 5 | Anti money laundering | partial | `screenLocked` in `cbdc.go`, `fraud.go`, `riskmodel.go` | Screening and a reporting threshold exist. No sanctions or PEP list, no counterparty network view, no suspicious transaction report artefact, no case management for a flagged payment. |
| 6 | Law of the land | partial | Disclaimers throughout, FEMA and nationality refusals in `crossborder.go`, PA-CB and finality notes in `docs/CBDC.md` | The statutory basis is described in prose but not modelled: no designation state, no per-jurisdiction rule set that a transaction is actually tested against. |
| 7 | Risk management | done | `fraud.go` rules, the trained model, KYC caps, offline caps, supply conservation, backing gate | Decisions stay with the published rules; the model is advisory. |
| 8 | Blockchain as the main hero | partial | `cbdc.go` puts the money itself on the ledger; grants, vouchers, conditions and refusals are all blocks | Large parts of the system still treat the chain as a record: listings, documents, work orders and the marketplace keep their state in Go maps and write blocks about it. Making those state transitions chain-first is the real version of this item. |
| 9 | Speed of the transaction | partial | `throughput.go` measures settlements per second and latency percentiles on demand, with the serialising lock named | The number is measured but not published anywhere a reader lands, and there is no measurement of the CBDC paths specifically. |
| 10 | Smooth end-user experience (flight cancelled, insurer refunds) | partial | The mechanism is built and tested: `OpenCondition`, `SubmitEvent`, automatic refund with no claim | There is no screen. A person cannot see a locked condition or a refund arriving; it exists only over the API. |
| 11 | Contracts that release on time when rules are fulfilled | done | `OpenCondition` / `SubmitEvent` / `SweepConditions`, plus the escrow in `work.go` and outcome settlement | Release is automatic on attestation and refund is automatic at the deadline. |
| 12 | Off chain to on chain | partial | Document and deed hashes anchored, the ledger head anchored to Solana, attested events bringing outside facts in | No general oracle: each bridge is hand-wired, and there is no signed-feed abstraction with its own trust and staleness rules. |
| 13 | KYC plus ML together | partial | The AML check reports rules and model side by side on every movement | KYC tier is not an input to the model, and the model was not trained on identity features at all. |
| 14a | Cross-border: bank to bank | not started | `crossborder.go` covers a stablecoin corridor only | Correspondent-style bank-to-bank leg with its own reporting. |
| 14b | Cross-border: card network rails | not started | - | Visa and Mastercard operate their own rails and licensing; modelled as a distinct corridor in phase 2. |
| 14c | Cross-border: PA-CB licensing | partial | `docs/CBDC.md` records the Payment Aggregator Directions of September 2025, the net-worth test and the ₹25 lakh per-transaction ceiling | Nothing in the code enforces a corridor's licence state or the per-transaction cap. |
| 14d | Both legs on the same chain, or not | not started | - | The settlement difference between one ledger and two is the interesting case and is unbuilt: atomic where both legs are on-chain, windowed reconciliation where they are not. |
| 15 | NPCI NIPL peer-to-peer | not started | - | The India-Nepal UPI to NPI model: direct P2P across two domestic schemes, with its own caps. |
| 16 | Retail to merchant | done | Grant spending pays a merchant account directly; offline redemption pays a shop | Merchant category and identity are first-class in the spend path. |
| 17 | China, Canada, Singapore precedents | not started | Only the India-Singapore digital assets pact is noted in `docs/CBDC.md` | No research pass on mBridge, Project Jasper or Project Ubin, and no design conclusions drawn from them. |
| 18 | Blockchain has no time constraints, an FMI does | done | `Finality.SettlementWindow`, the finality section of `docs/CBDC.md` | A provisional leg names the window that closes it instead of reporting the ledger entry as settled. |
| 19 | Technical and financial finality | done | `Finality` on every movement, tested in `cbdc_test.go` | Recorded as two separate fields that are never collapsed into one. |
| 20 | Put as many functions as possible on the blockchain | partial | The CBDC layer moved money, conditions, grants and refusals on-chain | Same gap as item 8: the older modules still write about their state rather than keeping it on the chain. |
| 21 | Any suitable language, not only Go | answered | See below | No change needed yet; the reasoning is recorded so it can be revisited per component. |

## The honest summary

The CBDC half of the list is largely built. The cross-border half is mostly
not: four of its five items have no code behind them, and the one that does is
a stablecoin corridor rather than any of the rails named. The two items most
visible to a person watching a demo, a screen for the refund experience and a
published speed number, are both still only backend facts.

## Why not Solidity, and why not Python

A fair question, and the answer is different for each.

**Solidity.** Solidity is the language of the EVM, and the EVM is only worth
paying for when the thing being built needs a public permissionless chain with
untrusted participants. The system here is a market infrastructure: the
participants are a registrar, an issuer, a regulator and identified investors,
settlement is in central bank money, and the rules are regulatory rather than
economic. Putting that on an EVM would mean paying gas per settlement, holding
a key for each participant, exposing an order book to the public mempool, and
accepting an execution environment where reversing a mistake needs a migration.
The regulator's own wholesale pilots do not run on public EVMs either.

Where a public chain genuinely helps, the project already uses one rather than
pretending a private ledger is the same thing: the head of the chain is
anchored to Solana, with the transaction encoding written by hand and
verification open to anyone. That buys the one property a permissioned ledger
cannot give itself, which is proof it was not rewritten. There is also a
read-only EVM mirror on Sepolia for document anchors.

So the honest position is: Solidity is the right tool when the trust model is
"nobody", and the wrong tool when the trust model is "a regulator and named
institutions". Writing a contract in it to look blockchain-native would be the
same mistake as calling a rule sheet AI.

If you want it anyway, the defensible version is narrow: a small Solidity
contract on a testnet that holds the anchor digests and the condition rules,
so an outside party can verify a release without trusting this rail. That is a
day of work and I can do it, but it should be built because it adds
verifiability, not because the word is expected.

**Python.** Python is the right language for training and nothing in this
repository argues otherwise. The reason the trainer is in Go is narrower than
a preference: training and inference must compute features identically, and
the cheapest guarantee of that is one function called by both. A Python
trainer would need the feature extractor reimplemented, which is the single
most common way a model silently stops working in production.

That reasoning stops holding the moment the model stops being a logistic
regression. Gradient boosting, sequence models over payment history, or
anything needing scikit-learn, PyTorch or pandas should be trained in Python,
exported (ONNX or plain weights), and run in Go behind the same interface,
with a conformance test asserting the two implementations of the feature
vector agree row for row. That is the point at which the language should
change, and it is a real one, not a concession.
