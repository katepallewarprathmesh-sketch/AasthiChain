# Pitch Deck Outline — AasthiChain v2.0 NPCI

## Slide 1: Title
- AasthiChain — Tokenized real-asset ownership on Drunix + payment settlement modeled on NPCI's UPI/IMPS rails
- Team: katepallewarprathmesh-sketch — Drunix x Citi — Real Asset Tokenization + Build the Future of Payments in India
- Version v2.0 NPCI — Primary: UPI Collect P2M + IMPS UTR (INR) simulation — Secondary: Sepolia PaymentEscrow.sol experimental

## Slide 2: Problem — Illiquid assets + Payments half missing
- ₹50L+ ticket excludes retail, illiquid 3-6 months, paperwork, no cap table, no fractional
- Most tokenization demos ignore payments — Citi problem statement says "Build the Future of Payments in India" — needs NPCI rails
- Regulatory: Asset Tokenisation Bill 2026 pending — KYC/AML, custodian, freeze powers — need awareness

## Slide 3: Solution — Drunix + UPI Collect + Atomic DvP
- Tokenize property into fixed-supply integer tokens (10000 tokens = ₹50L, 1 token = ₹500)
- Permissioned 4-org Drunix — no single party controls ledger — dual endorsement AND(Originator, Registrar)
- Primary payment: UPI Collect P2M — payee originator@aasthichain requests ₹2.5L from payer investor@aasthichain via NPCI switch → payer approves in UPI app → IMPS UTR → Drunix TransferTokens → RELEASED — atomic DvP — INR paise int64
- Why Collect P2M not Intent? Seller requests, buyer approves — merchant collect pattern, seller control + UPI mandate, IMPS UTR reconciliation
- Secondary experimental: Sepolia PaymentEscrow.sol cross-chain pattern bonus — behind Advanced toggle — future bridge to tokenized deposits/stablecoin

## Slide 4: Network Topology + Payment Gateway Module
- 4 Orgs: Originator, Registrar, Investor, Regulator — Raft 3-node orderer — Postgres SQL state — 4 indexes — chaos_test.sh
- Endorsement: Mint AND(Originator, Registrar), Transfer Investor + KYC + payment CONFIRMED, Regulator observer + freeze + UTR audit
- payment-gateway/ module: gateway.go (Collect, Approve, Release, Refund, VPA regex, RRN/UTR generation, idempotency, KYC, balance) + gateway_test.go 8 tests + gateway.test.js + Vercel mock frontend/api/index.js with 6 NPCI endpoints + 6 failure-demo scenarios

## Slide 5: Architecture HLD — Primary UPI, Secondary Sepolia
- React (Landing intro + Marketplace + PropertyDetail with NPCIPayment.jsx primary + TestnetPayment.jsx secondary toggle + Wallet with UPI + Sepolia tabs) → Go API Gateway + payment-gateway/ + Vercel serverless (mock Fabric + NPCI UPI simulation primary + Sepolia secondary) → Fabric SDK → 4 peers + Raft → Chaincode 9 funcs + Postgres SQL 4 indexes → Drunix ledger + payment-gateway (UPI Collect + IMPS UTR primary, atomic DvP via TransferTokens) + PaymentEscrow.sol secondary experimental
- Primary flow: /api/npci/collect (P2M, VPA, amountINR, idempotency → PENDING + UPI Txn ID + RRN + UTR) → /api/npci/payments/:id/approve (KYC+balance → CONFIRMED + webhook) → TransferTokens → /api/npci/payments/:id/release (drunixTransferId → RELEASED + IMPS UTR credit) → if fail → /refund → REFUNDED — atomic
- Secondary: Sepolia initiatePayment → locks test ETH → TransferTokens → confirmDrunixTransfer → releasePayment → test ETH to originator → refund if fails — behind Advanced toggle — production path mainnet USDC/INR + Chainlink
- Production path primary: real UPI AutoCollect API (ICICI, Yes Bank) + webhook NPCI→callback → confirm Drunix → release → UPI→IMPS settlement, UTR from bank, RRN reconciliation — same state machine, drop-in

## Slide 6: Data Model + IDs
- PropertyAsset, TokenBalance, TransferRecord, KYCRecord
- NPCI Payment: paymentId NPCI-..., upiTxnId AAST..., rrn 418..., utr IMPS418..., assetId, tokenAmount, amountINR, amountINRPaise, payerVpa investor@aasthichain, payeeVpa originator@aasthichain, status PENDING→RELEASED, createdAt, expiresAt+5min, drunixTransferId TXN-..., idempotencyKey, isSimulation true
- Token price = valuation/totalTokens, Value = balance*tokenPrice, Portfolio = sum, Amount paise = INR*100 int64 no float

## Slide 7: Sequence Flows — Tokenization + UPI Collect DvP
- Tokenization: Register (DRAFT) → Validate (off-chain doc review) → Mint (dual endorsement) → TokenBalance
- UPI Collect DvP: Collect Initiated (payee requests via NPCI switch, PENDING + UPI Txn ID + RRN + UTR + expiry 5min) → Payer Approves in UPI app (KYC+balance → CONFIRMED + webhook) → Drunix Transfer (TransferTokens → TXN-...) → Settlement Released (IMPS UTR credited → RELEASED) / Refunded (if Drunix fails → REFUNDED) — atomic, no partial
- Sepolia secondary: initiatePayment → locks test ETH → PaymentInitiated → TransferTokens → confirmDrunixTransfer → releasePayment → test ETH to originator → refund if fails — behind Advanced toggle

## Slide 8: Edge Cases + Payment Failure Modes (10 total) + Tests
- Chaincode: insufficient balance, self-transfer, KYC unverified, zero amount, double-spend MVCC, frozen asset, integer-only, hash collision flag, clock skew block timestamp
- Payments: insufficient funds (poor@aasthichain ₹1 → ₹50k), KYC unverified (unverified_user per Bill 2026), timeout (5 min UPI window), declined (user declined in UPI app), invalid VPA (regex), duplicate idempotency (X-Idempotency-Key → same paymentId)
- Tests: chaincode 216+ tests + payment-gateway 8 tests (success→transfer, timeout→refund, duplicate idempotency, KYC rejection, insufficient funds, invalid VPA, zero amount, UPI ID formats) — JS gateway.test.js + Go gateway_test.go

## Slide 9: Demo — Live (5-6 min) — Primary UPI, Secondary Sepolia
- Admin: Register → Validate (mention Bill 2026) → Mint + dual endorsement + idempotency persisted
- Investor: Wallet holdings + portfolio + Marketplace → PropertyDetail → Buy 500 tokens → ₹2,50,000 → Initiate UPI Collect (payerVpa investor@aasthichain, payeeVpa originator@aasthichain, amount ₹2,50,000 = 500*₹500, paise 25000000) → PENDING + UPI Txn ID AAST... + RRN 418... + UTR IMPS... + expiry timer 5:00 → Approve in UPI app (KYC VERIFIED + balance sufficient) → CONFIRMED → webhook → TransferTokens → TXN-... → RELEASED → IMPS UTR credited → atomic DvP — show UTR linked to TXN — INR not ETH
- Failure modes: 6 payment + 4 chaincode = 10 total demoable — insufficient funds, KYC unverified per Bill 2026, timeout, declined, invalid VPA, duplicate idempotency
- Secondary toggle: Show Advanced / Experimental — Sepolia cross-chain settlement pattern — MetaMask Sepolia, balance, faucet help, pay SepoliaETH min 0.001, 4-step DvP with Etherscan — bonus future extensibility
- Regulator: Audit all properties, freeze asset (Bill 2026 freeze powers), view KYC, TransferRecord + NPCI payments list with RRN/UTR reconciliation, bookmark pagination Load More total 25 seeded, chaos_test.sh Raft tolerates 1 failure

## Slide 10: Drunix Advantage + Why UPI Collect P2M
- SQL state store vs LevelDB/CouchDB: O(log n) queries via 4 indexes, no full scans, read-replica for regulator
- Permissioned: regulator observer non-endorsing, privacy no PII on-chain, freeze powers
- UPI Collect P2M vs Intent: Seller requests payment, buyer approves — merchant collect pattern, seller control + UPI mandate, settlement via IMPS gives UTR for reconciliation (NPCI pattern) — Intent would be buyer-initiated direct pay — less control for seller — high-value real estate needs collect with approval + audit
- Honest simulation: No live NPCI sandbox credentials — PPRO "Sandbox Not Available from UPI", no Drunix Hackathon-published NPCI sandbox found — built clearly-labeled internal simulation inspired by upi-mock-engine deterministic simulator — same flow Collect→PENDING→AUTHORIZE→CONFIRMED→SUCCESS with RRN, UPI Txn ID, UTR, expiry, idempotency — UI badge "SIMULATION — No live NPCI", no fabricated success

## Slide 11: Production Readiness (§9) + LIVE vs MOCKED + Bill 2026
- Security: HSM signing, input validation at chaincode boundary, endorsement hardening, rate limiting, audit logging, KYC gate at payment approval per Bill 2026
- Scalability: private data collections, read-replica for regulator
- Operational: Prometheus/Grafana, ledger snapshotting, cert rotation, blue-green chaincode upgrade
- Legal: NOT substitute for Registration Act 1908, reflection layer via SPV per property beneficial interest, IFSCA/SEBI sandbox, DigiLocker KYC pluggable, SPV legal wrapper, Bill 2026 awareness — KYC/AML, registered custodian, regulator freeze — addressed via RegistrarMSP validation, RegulatorMSP freeze, cap table auditable idx_balance_asset, transfer history idx_transfer_asset_time, payment rail KYC gate
- LIVE: Chaincode 9 funcs 216+ tests, API gateway JWT+MSP+rate limit+idempotency, React 4 roles, Raft 3, SQL 4 indexes, payment-gateway module, Drunix transfer, atomic DvP
- MOCKED (pluggable): KYC DigiLocker stub, DILRMP hash, NPCI UPI simulation (no live credentials) — simulation clearly labeled, Sepolia secondary experimental cross-chain pattern bonus

## Slide 12: Testing + Metrics
- Unit: chaincode all funcs + edge cases 216+ tests, payment-gateway 8 tests (success→transfer, timeout→refund, duplicate idempotency, KYC rejection, insufficient funds, invalid VPA, zero amount, UPI ID formats) — Go + JS
- Integration: docker-compose multi-org flows, NPCI collect→approve→TransferTokens→release atomic DvP
- Negative: unauthorized MSP, double-spend MVCC, invalid KYC, insufficient funds UPI, invalid VPA, timeout, declined, duplicate idempotency
- Load: k6 50 TPS target, p95 <3s, Raft tolerates 1 failure chaos_test.sh
- Metrics: 15000 tokens minted, 25 transfers seeded pagination, 100/min rate limit, 413KB bundle 112KB gz 113 modules, payment-gateway 8 tests, INR paise int64 no float, VPA regex, RRN 12-digit, UTR IMPS+RRN, expiry 5 min, idempotency X-Idempotency-Key, 10 failure modes demoable, Primary UPI simulation + Secondary Sepolia experimental, Landing intro + one easy auth top corner

## Slide 13: Roadmap — Payments Focus
- Phase1 Hackathon Slice Done v2.0 NPCI: Working slice, mocked KYC (DigiLocker stub) + payment primary UPI Collect simulation (INR) + secondary Sepolia experimental, honest scoping > overclaim, wallet + property detail with primary UPI + secondary toggle, failure-mode demos 10 total, payment-gateway module with 8 tests, landing intro + one easy auth top corner
- Phase2: Custodian org demat model, DILRMP integration, HSM wallet, private data collections, real DigiLocker/Aadhaar KYC pluggable, real UPI AutoCollect API integration (ICICI, Yes Bank) + webhook + UTR reconciliation, SPV legal wrapper per Registration Act 1908 + Bill 2026 compliance (KYC/AML, registered custodian, regulator freeze), rental income distribution via UPI
- Phase3: Secondary market order-matching, fiat on/off-ramp, title-insurance org as second validator, channel-per-asset-class, tokenized deposits bridge from Sepolia experimental to production (mainnet USDC/INR + Chainlink oracle)

## Slide 14: Team & Ask + Payments Narrative
- Team: katepallewarprathmesh-sketch — solo builder, full stack Drunix + Go + React + Solidity + SQL + NPCI UPI simulation
- Repo: github.com/katepallewarprathmesh-sketch/AasthiChain main v2.0 NPCI — Live Demo: Vercel serverless + frontend dist + mock Fabric + NPCI UPI simulation primary + Sepolia secondary experimental toggle
- Test: payment-gateway/gateway_test.go 8 tests + chaincode_test.go 216+ tests + frontend NPCI flow + gateway.test.js
- Ask: ₹175k budget — Drunix infra docker-compose, Vercel hosting, payment-gateway module free, NPCI simulation free (no sandbox credentials), Sepolia testnet free faucet, mock KYC pluggable — fits. Citi mentors for payments compliance + NPCI API access for Phase2 real UPI Collect + Bill 2026 compliance
- Thank you — AasthiChain v2.0 NPCI — Tokenized real-asset ownership on Drunix + payment settlement modeled on NPCI's UPI/IMPS rails — Registry-office grade, not crypto-trading aesthetic — Confidence from calm precision, not enthusiasm, no confetti per §4.4

## Appendix: Non-Goals + Honest LIVE vs MOCKED (Extended to Payments)
- No real land registry integration — stubbed documentHash anchored only
- No real KYC provider — mocked DigiLocker with pluggable interface + KYC gate at payment approval per Bill 2026
- No order-matching engine — direct peer transfer only per spec
- No fiat settlement live — primary UPI Collect simulation (INR) with honest labeling "SIMULATION — No live NPCI" since sandbox credentials not available for hackathon — PPRO docs confirm "Sandbox Not Available from UPI", no Drunix Hackathon-published NPCI sandbox found, inspired by upi-mock-engine deterministic simulator — same flow Collect→PENDING→AUTHORIZE→CONFIRMED→SUCCESS with RRN, UPI Txn ID, UTR, expiry, idempotency — UI badge "SIMULATION — No live NPCI", no fabricated NPCI success — secondary Sepolia PaymentEscrow.sol experimental cross-chain pattern kept as bonus future extensibility (could bridge to tokenized deposits/stablecoin rails later), same escrow state machine PENDING→CONFIRMED→RELEASED/REFUNDED
- Legal enforceability explicitly called out as limitation — SPV reflection layer — reconciles with Registration Act 1908 + Asset Tokenisation Bill 2026 awareness (pending Private Member's Bill, not yet law) — KYC/AML, registered custodian, regulator freeze — addressed via RegistrarMSP validation, RegulatorMSP freeze, KYC gate at payment approval
