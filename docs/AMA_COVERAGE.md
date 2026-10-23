# AMA keywords: what is actually covered

An audit against the keyword list, checked against the code rather than from
memory. Status is one of **done**, **partial** or **not started**, and
"partial" always says what is missing. The keyword list splits into 27 rows
because several keywords carry more than one item: 23 are done, 3 are partial,
and 1 was a question rather than a feature.

| # | Keyword | Status | Where it lives | What is missing |
| --- | --- | --- | --- | --- |
| 1 | CBDC | done | `cbdc.go`, `/umi/cbdc/*`, `docs/CBDC.md` | Retail and wholesale segments, issue, transfer, redeem, conserved supply. |
| 2 | eKYC | done | `kyc.go`, `/umi/kyc/*`, `docs/KYC.md`, tiers in `cbdc.go` | Five identification routes with the ceilings each one carries, video identification enforced against all four of its conditions, offline file freshness, periodic updation by risk band, and a wallet tier written by the verification rather than asserted. Aadhaar numbers are refused outright, not stored. The external steps (UIDAI call, registry upload, the video session itself) are simulated and say so. |
| 3 | Better offline protocol | done | `IssueOffline` / `RedeemOffline`, `tests/cbdc.test.mjs` | Reserved value, signed voucher, bounded exposure, deterministic double-spend detection. Noted limit: symmetric signing, where production needs per-device keys. |
| 4a | Programmable CBDC | done | `Grant` / `Spend`, `ProgramCondition` | Expiry, merchant category, named merchants, geography, all enforced on the rail with refusals committed. |
| 4b | Interoperability of CBDC with other systems | done | `cbdcinterop.go`, `/umi/cbdc/interop/*`, the matrix in `docs/CBDC.md`, plus `corridors.go` for the foreign leg | e₹ to a bank account over the retail scheme (ledger leg final, bank leg provisional, money visibly in suspense), two-way conversion with a tokenised deposit in one operation, and the foreign CBDC case handled by the corridor layer. Pulling from a bank account is declared unsupported with the reason. Far legs are simulated and say so. |
| 5 | Anti money laundering | done | `aml.go`, `/umi/aml/*`, `docs/AML.md`, plus `screenLocked` in `cbdc.go`, `fraud.go`, `riskmodel.go` | Sanctions and PEP screening against a named list with transliteration-tolerant matching, two published thresholds, case management with attributed clearance, and a suspicious transaction report artefact hashed onto the ledger. The shipped list is synthetic and says so; there is still no customer risk rating, no typology library and no counterparty network view. |
| 6 | Law of the land | done | `jurisdiction.go`, `/umi/jurisdictions/*`, the rule-set section on `/crossborder`, `jurisdiction_test.go`, `tests/jurisdiction.test.mjs` | Each jurisdiction carries a designation state (DESIGNATED, OBSERVED, SUSPENDED) and a rule set declared as data. Eight rules cite their instrument: FEMA (Non-debt Instruments) Rules 2019 on acquisition eligibility, restricted nationalities, agricultural land and the consideration channel; sections 269ST and 194-IA of the Income-tax Act; the five-year lease route; and RERA 2016 section 3. A cross-border quote is now evaluated against that rule set rather than against a hardcoded Go switch, every applicable rule runs so a caller sees the whole regime rather than the first obstacle, and an undeclared jurisdiction refuses instead of defaulting to permitted. Evaluations and refusals are committed as blocks. Simplified where it says so: stamp duty is a single rate per state with no slabs or buyer-category rebates, and the RERA check reads a declared flag rather than any state register. |
| 7 | Risk management | done | `fraud.go` rules, the trained model, KYC caps, offline caps, supply conservation, backing gate | Decisions stay with the published rules; the model is advisory. |
| 8 | Blockchain as the main hero | partial | `cbdc.go` puts the money itself on the ledger; grants, vouchers, conditions and refusals are all blocks | Large parts of the system still treat the chain as a record: listings, documents, work orders and the marketplace keep their state in Go maps and write blocks about it. Making those state transitions chain-first is the real version of this item. |
| 9 | Speed of the transaction | done | `throughput.go` and `/umi/throughput` for DvP; `pathspeed.go` and `/umi/pathspeed` for the CBDC, corridor and conversion paths; the live panel on the settlement page; figures in `README.md` and `docs/THROUGHPUT.md` | Every money path is now timed where the work happens, with completions and refusals counted apart, lock wait reported beside the latency, and the work each path does stated next to its figure. A path with no traffic reports nothing rather than zero. The two-core caveat is attached to every published number. |
| 10 | Smooth end-user experience (flight cancelled, insurer refunds) | done | `OpenCondition`, `SubmitEvent`, automatic refund with no claim, shown on the digital rupee page at `/cbdc` | A person can now see money locked against a named event, who is trusted to attest it, the deadline, and the refund once it releases. The page also opens conditions, attests events, issues and spends purpose-bound money, carries value offline and sends across a corridor, so the behaviour can be tried rather than read about. |
| 11 | Contracts that release on time when rules are fulfilled | done | `OpenCondition` / `SubmitEvent` / `SweepConditions`, plus the escrow in `work.go` and outcome settlement | Release is automatic on attestation and refund is automatic at the deadline. |
| 12 | Off chain to on chain | done | A signed-feed registry at `/umi/oracle/*`: every feed declares its publishers, the age at which it stops being usable, its quorum and its tolerated spread; every reading is Ed25519 signed under a key already in the key register, with nonce and monotonic timestamp checks. Stale, short of quorum or published under a compromised key means no value, not a last value. The cross-border rate is the first consumer and declares its provenance either way. See `docs/ORACLE.md`. | Trusted publishers named by the operator, not a permissionless staked network; no real rate is published to this deployment. |
| 13 | KYC plus ML together | done | The AML check reports rules and model side by side on every movement, and the model now takes four identity inputs: tier strength, whether the route was face-to-face equivalent, how long the identity has been held, and the amount against the tier's per-payment ceiling. `drunix-gateway/kyc.go` supplies them from the desk's own records | **Closed 22 October 2026.** The gap was worse than the row said. Screening did not merely leave the tier out of the model: it built the model input with `KYCVerified: true` and a fixed account age for every payer, so the single identity feature was a constant, and nothing in the output revealed it. Identity now comes from the KYC desk, an unknown holder reads as unknown rather than verified, and a lapsed verification scores as no tier rather than a weaker one. The features were checked by ablation rather than assumed: refitting on the same rows with the four identity features blanked gives AUC 0.862 against 0.866, which is noise, but precision at the operating threshold falls from 0.629 to 0.561. So they earn their place by flagging fewer ordinary payments, not by ranking better. Both numbers come from synthetic data, and identity only pays off because the generator now contains a mule archetype that behaviour alone cannot see. That archetype was added deliberately and is disclosed in `docs/RISK_MODEL.md`. |
| 14a | Cross-border: bank to bank | done | `corridors.go`, corridor `BANK-CORRESPONDENT` | Authorised dealer status required, purpose codes enforced, provisional until the far leg confirms, three-to-five-day window named. |
| 14b | Cross-border: card network rails | done | corridor `CARD-SCHEME`, `cardscheme.go`, `/umi/cards/*`, the `/cards` screen, `cardscheme_test.go`, `tests/cards.test.mjs`, `docs/CARDS.md` | Both halves that make a card rail different are now implemented rather than described. The economics: interchange, scheme fee and acquirer margin split to the paise under the RBI debit caps of 0.40% and 0.90% with their per-transaction ceilings, RuPay debit charge-free under section 10A of the Payment and Settlement Systems Act, credit uncapped and declared as a commercial default, GST charged on top of the fee rather than out of it, and the cross-border case where the issuer's currency markup billed to the cardholder exceeds everything the merchant loses. The dispute ladder: presentment, chargeback, merchant response, pre-arbitration and arbitration, on each network's own clock, with the 120 and 540 day filing windows, the USD 600 and USD 575 case fees, and the 3-D Secure liability shift that protects a merchant against a fraud ground and does nothing against goods not received. Simulated and says so: no scheme membership, no PCI DSS attestation, nothing authorised or cleared, no money moved. |
| 14c | Cross-border: PA-CB licensing | done | corridor `PACB-ECOM`, licence gate in `corridors.go` | The authorisation and intelligence unit registration are required, the ₹25 lakh ceiling is enforced, and a refusal names what is missing. |
| 14d | Both legs on the same chain, or not | done | corridors `MULTI-CBDC-PVP` and `HTLC-LINKED` | Atomic in one block where both legs are here; hash time-locked with a verified preimage and a working refund path where they are not. |
| 15 | NPCI NIPL peer-to-peer | done | corridor `NIPL-P2P-NP` | Direct scheme-to-scheme person-to-person link with the published ₹15,000 per transfer and ₹1,00,000 monthly ceilings, and merchant purposes refused. |
| 16 | Retail to merchant | done | Grant spending pays a merchant account directly; offline redemption pays a shop | Merchant category and identity are first-class in the spend path. |
| 17 | China, Canada, Singapore precedents | done | `docs/CORRIDORS.md`, the two on-ledger corridors | mBridge (one platform, atomic PvP, seconds instead of days) and Jasper-Ubin (two platforms joined by hash time-locked contracts) were read, and each produced a corridor rather than a citation. |
| 18 | Blockchain has no time constraints, an FMI does | done | `Finality.SettlementWindow`, the finality section of `docs/CBDC.md` | A provisional leg names the window that closes it instead of reporting the ledger entry as settled. |
| 19 | Technical and financial finality | done | `Finality` on every movement, tested in `cbdc_test.go` | Recorded as two separate fields that are never collapsed into one. |
| 20 | Put as many functions as possible on the blockchain | partial | The CBDC layer moved money, conditions, grants and refusals on-chain | Same gap as item 8: the older modules still write about their state rather than keeping it on the chain. |
| 21 | Any suitable language, not only Go | answered | See below | No change needed yet; the reasoning is recorded so it can be revisited per component. |
| 26 | Key compromise: could an eMudhra happen here | done | `keyregistry.go`, `/umi/keys/*`, `docs/KEYS.md` | Added 22 October 2026, the day after the eMudhra intermediate CA incident. Signing keys are screened before use against the failure family those keys fell into (small integers in both byte orders, repeated bytes, low-order points, guessable seeds), proof of possession is required, duplicates are refused, every registration, refusal, revocation and audit run is written to the chain, and a key can be revoked in one act with the reason deciding whether past signatures stand. Keys already in service can be re-screened on demand, which is the answer to the eighteen months those keys went unexamined. The screen states in writing that it cannot prove good entropy. Open: no scheduled audit, no single rotate operation, no hardware-backed keys, and the rail's own issuer key is reported but not yet registered. |
| 27 | Solidity and EVM contracts for the token itself | partial | `contracts/PropertyToken.sol`: an ERC-20 token with the ERC-7943 (uRWA) restriction interface, arranged the way ERC-3643 arranges one (token, identity registry, modular compliance, agent roles). 66 checks in `tests/propertytoken.test.mjs` drive a deployed copy on a local chain. Not yet deployed to a public testnet, and the rail does not yet write to it automatically | **Built 22 October 2026.** The three open questions are now answered. *Which standard:* ERC-20 for compatibility plus ERC-7943, which reached Final in May 2026 and fixes `canTransact`, `canTransfer`, `getFrozenTokens`, `setFrozenTokens` and `forcedTransfer` without prescribing an identity system. ERC-1400 was rejected because its one real advantage is partitions, which a single-property fractional interest does not use, and the family never left Draft. Full ERC-3643 with ONCHAINID was rejected because it would stand up a second identity system beside the DIDs, credentials, KYC tiers and key register this project already runs, and two identity systems that must agree eventually do not. *Record or mirror:* a mirror. The rail stays authoritative; the contract carries the rail asset id and emits `Mirrored` so a reader can tell whether the mirror is current rather than assuming it. *How restrictions survive:* every ordinary movement passes through one internal gate, so `transferFrom` and approvals cannot route around the eligibility check; `forcedTransfer` is agent-only and still refuses to place tokens with an ineligible holder. The honest risk stands and is not solved by any of this: a position on a public chain is final under that chain's rules, which the regulator does not set. That is why the public leg mirrors rather than settles. |

## The honest summary

The CBDC half and the cross-border half are both built now, and every keyword
raised has code behind it. What is left is depth rather than absence. Speed is
now measured per path rather than only for DvP, so the remaining partials are
led by the older modules that still keep their state in Go maps while writing
blocks about it (items 8 and 20), which is the one that would take real work.

Two rows were added on 22 October 2026. Item 26 came from an incident rather
than a question: eight certificate authority private keys turned out to be
small integers, so the same question was asked of this rail and the answer
was uncomfortable enough to fix the same day. Item 27 is a requirement rather
than a gap being excused: the tokens are real positions in the Go ledger and
a public contract lets a holder prove one without asking us. That contract now
exists, as a mirror of the rail rather than a replacement for it, and the
section below on why not Solidity has been kept because its reasoning is why
the public leg mirrors instead of settles.

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
