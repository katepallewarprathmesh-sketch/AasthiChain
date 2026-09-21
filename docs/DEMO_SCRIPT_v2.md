# AasthiChain Demo Script v2 — NPCI UPI Rail + Drunix Atomic DvP (Primary) + Sepolia Secondary

**Duration: 5-6 minutes | Fabric Mode: Toggle live/mock | Key message: Tokenized real-asset ownership on Drunix + payment settlement modeled on NPCI's UPI/IMPS rails as core narrative, with honest LIVE vs MOCKED scoping**

## 0:00-0:30 — Setup & Framing (Track A6: What's Real vs Mocked BEFORE Judge Asks)

> "AasthiChain tokenizes real estate into fractional tokens on a permissioned 4-org Drunix network with **payment settlement modeled on NPCI's UPI Collect (P2M) + IMPS UTR rails** — INR leg, not testnet ETH — demonstrating atomic delivery-vs-payment. Before we dive in — here's what's live and what's deliberately mocked per spec non-goals §1.2:
> 
> **LIVE:** Chaincode 9 functions with full edge-case coverage (216+ tests), API gateway with JWT + MSP + rate limiting + persistent idempotency (file-backed, survives restart), React frontend for 4 roles, Raft 3-node orderer, PostgreSQL SQL state store with 4 indexes, **payment-gateway/ module** with UPI-style IDs (UPI Txn ID, RRN, UTR), VPA validation, idempotency, atomic DvP calling TransferTokens.
> 
> **MOCKED (pluggable):** KYC (DigiLocker stub — interface ready for licensed provider), land registry (DILRMP stub — hash anchored on-chain), **NPCI UPI rail — simulation, not live NPCI integration, since sandbox credentials weren't available for hackathon** — inspired by upi-mock-engine deterministic simulator, PPRO docs confirm 'Sandbox Not Available from UPI', no Drunix Hackathon-published NPCI sandbox found. Sepolia PaymentEscrow.sol now secondary experimental / bonus cross-chain pattern.
> 
> **Toggle:** `FABRIC_MODE=live|mock` env var — same FabricClient interface. Live tries fabric-gateway SDK, falls back to mock if peer unreachable, so demo never breaks. Module split chaincode/ vs api-gateway/ avoids protobuf conflict.
> 
> **Payments framing (accurate):** Primary DvP is UPI Collect P2M (payee originator@aasthichain requests ₹2.5L from payer investor@aasthichain via NPCI switch → payer approves in UPI app → IMPS UTR → Drunix TransferTokens → RELEASED). INR amounts stored as paise int64 to avoid float. If Drunix fails, REFUNDED — atomic. Secondary Sepolia escrow kept as optional 'cross-chain settlement pattern' behind Advanced toggle — worth mentioning as bonus future extensibility (could bridge to tokenized deposits/stablecoin)."

This framing reads as maturity, not weakness, and directly maps to Citi problem statement "Build the Future of Payments in India" — we show payments, not just tokenization.

## 0:30-1:30 — Admin Flow (Originator + Registrar) + Track A2

**Login as originator1 / Originator**
- Show RegisterProperty form
- **Track A2 Demo:** Upload legal doc PDF → auto-compute SHA-256 via `crypto.subtle.digest` → hash auto-filled. Explain: "File stays off-chain, only hash anchored. In prod, file → IPFS, hash → ledger. Tamper detection via periodic re-hash per §6.4"
- Submit → assetId returned, status DRAFT, PENDING validation
- Note: hash collision flagged via `hash~docHash~assetId` index but allowed per spec

**Switch to registrar1 / Registrar**
- ValidateProperty: VALIDATED
- Explain endorsement: `AND('OriginatorMSP.peer','RegistrarMSP.peer')` prevents unilateral minting — dual signatures required at network level, plus chaincode MSP check defense-in-depth
- **Regulatory awareness:** Mention Asset Tokenisation (Regulation) Bill, 2026 — pending Private Member's Bill, not yet law — proposes KYC/AML for token holders, registered custodian for property SPV, registrar validation, regulator freeze powers. AasthiChain addresses: RegistrarMSP validates title + KYC (DigiLocker mock), RegulatorMSP can freeze asset (FreezeAsset), cap table auditable via idx_balance_asset, transfer history via idx_transfer_asset_time. Payment rail adds KYC gate at approval — unverified payer → FAILED_KYC_NOT_VERIFIED → REFUNDED.

**MintPropertyTokens**
- Enter totalTokens 10000 for ₹50L property = ₹500/token, integer-only no decimals
- Show idempotency key: `X-Idempotency-Key: mint-PROP-...` — persisted to `./data/idempotency.json` per Track A4, survives gateway restart, prevents double-mint
- Success: TokenBalance(owner=Originator, balance=totalTokens) created, status TOKENIZED
- Mention: overflow cap 10M, already-tokenized check

## 1:30-3:00 — Investor Flow + NPCI UPI Collect Primary + Track A7 Failure Mode

**Login as investor1 / Investor**
- Wallet: show holdings via `idx_balance_owner` (fast, no ledger scan), portfolio value sum(tokenPrice*balance), cap table
- Note FabricMode badge: shows "live" or "mock" from `/health`

**PRIMARY PAYMENT DEMO — UPI Collect (P2M) + IMPS UTR — INR leg**
> "This is the payments half of the challenge — most demos only show tokens moving. We show INR moving via NPCI-style rail + atomic DvP."

- Go to Property Detail → Buy Tokens → Enter 500 tokens → ₹2,50,000
- **Initiate UPI Collect:** Show payerVpa `investor@aasthichain`, payeeVpa `originator@aasthichain`, note "Payment for 500 tokens of PROP-..."
- Click "Initiate UPI Collect — Request ₹2,50,000 from investor"
- Explain: Payee (originator@aasthichain) requests money from payer (investor@aasthichain) via NPCI switch — UPI Collect P2M pattern. Why Collect not Intent? Real estate: seller requests payment, buyer approves — matches merchant collect flow. Settlement via IMPS gives UTR for reconciliation (NPCI pattern). IDs: PaymentID NPCI-XXXXXXXXXXXX, UPI Txn ID AASTYYYYMMDDXXXXXXXX, RRN 12-digit 418..., UTR IMPS+RRN+4-digit.
- Show PENDING state + expiry timer 5:00 countdown (UPI window)
- **Approve in UPI App:** Click "✓ Approve in UPI app — Pay ₹2,50,000"
- Explain checks: KYC (DigiLocker mock — investor1 VERIFIED), balance (mock UPI account — investor@aasthichain has ₹1L, sufficient), VPA regex `^[a-z0-9._-]{2,64}@[a-z]{2,64}$`
- Status → CONFIRMED → backend calls TransferTokens chaincode → 500 tokens move originator→investor → TXN-... created
- Then RELEASED → IMPS UTR credited to payee — atomic DvP complete. Show UTR linked to Drunix TXN.
- Explain atomicity: If Drunix transfer fails, payment REFUNDED — money and tokens move together or both refunded. Same state machine as Solidity escrow (PENDING→CONFIRMED→RELEASED/REFUNDED) but INR, not ETH.
- Explain money leg: Amount stored as paise int64 (250000*100 = 25000000 paise) to avoid float — critical for INR.

**Track A7 — Live Failure Mode Demo for Payments (Credibility Moment)**
> "Now let's show it correctly rejects invalid UPI collects — more important than happy path."

- Click "Insufficient Funds (UPI)" → payerVpa poor@aasthichain has ₹1, request ₹50k → `FAILED_INSUFFICIENT_FUNDS: have ₹1.00 need ₹50,000` → REFUNDED — no token move
- Click "KYC Not Verified" → payer unverified_user not VERIFIED → `FAILED_KYC_NOT_VERIFIED: payer unverified_user KYC not verified — KYC gate per Asset Tokenisation Bill 2026` → no DvP
- Click "Collect Timeout" → 5 min UPI window elapsed → EXPIRED → REFUNDED
- Click "Invalid VPA" → malformed handle@psp blocked via regex
- Click "Duplicate Idempotency" → same X-Idempotency-Key returns same paymentId, no double-charge — file-backed idempotency per Track A4
- Explain: All payment edge cases validated, plus Fabric MVCC auto-rejects concurrent double-spend at commit time.

## 3:00-4:00 — Regulator Audit + Track A3 Pagination + A5 Chaos

**Login as regulator1 / Regulator**
- Show all properties, cap table per asset via `idx_balance_asset` (SELECT * WHERE assetId=?)
- Show transfer history — **Track A3 Pagination Demo:**
  - Total 25 seeded transfers, pageSize 10, bookmark cursor pattern (Fabric native `GetStateByRangeWithPagination`, not naive LIMIT/OFFSET)
  - Click "Load More" → uses bookmark from last TransferID, shows next page
  - Explain: `idx_transfer_asset_time` on (assetId, txTimestamp) for fast audit, regulator is non-endorsing observer for transfers
  - Also show NPCI payments list: GET /api/npci/payments → all UPI collects with RRN, UTR, status — regulator can reconcile UTRs
- Demo FreezeAsset emergency: freeze a property → status FROZEN → subsequent transfers blocked with `ERR_ASSET_FROZEN` — maps to Asset Tokenisation Bill 2026 regulator freeze powers

**Track A5 — Chaos Check (Mention, don't live-kill unless rehearsed)**
> "We have a 3-node Raft orderer tolerating 1 failure per §8. In rehearsal we killed orderer2 via `docker stop orderer2.aasthichain` and confirmed network still commits — script in `network/scripts/chaos_test.sh`. We won't kill it live now to avoid risk, but it's verified."

- Show system health: Raft 3 nodes, p95 <3s, ≥50 TPS, Postgres read-replica for audit queries

## 4:00-4:50 — Architecture & Production Readiness + Track B/C Roadmap + Payments Narrative

**HLD Diagram:**
React → Go API Gateway (JWT, KYC mock, rate limit 100/min, persistent idempotency, FabricClient interface, payment-gateway/ module) → Fabric Gateway SDK (live) or Mock (fallback) → 4 org peers + Raft orderer → Chaincode (property.go, token.go, kyc.go) → PostgreSQL SQL state with 4 indexes
Payment path: React → /api/npci/collect (VPA, amountINR, idempotency) → NPCI switch mock → /api/npci/payments/{id}/approve (KYC+balance) → TransferTokens → /api/npci/payments/{id}/release (UTR)

**Why UPI Collect P2M (not Intent) + Why Drunix:**
- UPI Collect: Seller requests payment, buyer approves — matches merchant collect, gives seller control + UPI mandate, settlement via IMPS gives UTR for reconciliation (NPCI pattern). UPI Intent would be buyer-initiated direct pay — less control for seller. For real estate high-value, collect with approval is more auditable.
- Drunix: SQL state store vs LevelDB/CouchDB: O(log n) queries via indexes, no full scans, read-replica for regulator

**NPCI Rail — Simulation Honesty:**
- No live NPCI sandbox credentials available for hackathon — searched NPCI developer hub, Drunix Hackathon docs, PPRO confirms "Sandbox Not Available from UPI", no published mock API from organizers. So we built clearly-labeled internal simulation inspired by upi-mock-engine (Haskell deterministic UPI switch simulator) — same flow: Collect Initiated → PENDING → AUTHORIZE → CONFIRMED → RECONCILE → SUCCESS, with RRN, UPI Txn ID, events. UI shows "SIMULATION — No live NPCI" badge, no fabricated NPCI success.

**Production Readiness §9 — What's Done vs Roadmap:**
- **Done:** Chaincode validates at boundary, rate limiting, audit logging, idempotency persistence, pagination, live/mock toggle, auto-hash, failure-mode demo (chaincode + payments), payment-gateway module with 8 tests (successful payment→transfer, timeout→refund, duplicate idempotency, KYC rejection, insufficient funds, invalid VPA, zero amount, UPI ID formats), UPI Collect primary rail with INR
- **Track B — Roadmap Only:** Secondary market order-matching, custodian org (demat model), revaluation governance, DILRMP integration, DigiLocker KYC, real UPI AutoCollect API integration (ICICI, Yes Bank), channel-per-asset-class, SPV legal wrapper per Registration Act 1908
- **Track C — Post-hackathon hardening:** HSM-backed signing, endorsement hardening AND(Registrar, TitleInsuranceOrg), private data collections, threat model, pen test, Prometheus/Grafana, ledger snapshots, cert rotation, blue-green chaincode upgrade

**SPV Legal Structure + Bill 2026 (Judge Q&A Prep):**
> "Real fractional platforms in India don't put raw land title on-chain. Each property is under an SPV — a legal entity holding registered title — and tokens represent beneficial interest in that SPV. This reconciles on-chain tokens with Registration Act, 1908. We don't build SPV for hackathon, but that's our Phase-2 legal structure. Additionally, India's Asset Tokenisation (Regulation) Bill, 2026 — a pending Private Member's Bill, not yet law — proposes KYC/AML for token holders, registered custodian for property SPV, registrar validation, and regulator freeze powers. AasthiChain addresses: RegistrarMSP validates title + KYC (DigiLocker mock), RegulatorMSP can freeze asset (FreezeAsset), cap table auditable via idx_balance_asset, transfer history via idx_transfer_asset_time, payment rail adds KYC gate at approval — unverified payer → FAILED_KYC_NOT_VERIFIED → REFUNDED. Shows regulatory awareness, not hand-wave."

**Secondary Experimental — Sepolia (Bonus):**
> "We kept PaymentEscrow.sol and TestnetPayment.jsx as secondary experimental toggle — Advanced / Experimental — cross-chain settlement pattern demo, worth mentioning as bonus future extensibility: could bridge to tokenized deposits or stablecoin rails later, same escrow state machine PENDING→CONFIRMED→RELEASED/REFUNDED. Not primary DvP. Real Sepolia flow when faucet available — actual MetaMask signing, Etherscan-verifiable — but Sepolia test ETH has no monetary value. Production path same escrow logic with mainnet USDC/INR + Chainlink oracle."

## 4:50-5:30 — Limitations & Ask

- Openly flagged: NOT substitute for Registration Act, KYC/payment mocked (NPCI simulation, no live credentials), custodian Phase-2, SPV Phase-2, payment rail simulation honest
- Repo URL, live URL, demo video
- Thank you

## Backup If Live Demo Fails

- Frontend runs in mock mode even if gateway offline (fallback)
- Show `chaincode_test.go` unit tests (216+ tests)
- Show `payment-gateway/gateway_test.go` — 8 tests: successful payment→transfer, timeout→refund, duplicate idempotency, KYC rejection, insufficient funds, invalid VPA, zero amount, UPI ID formats
- Show `fabric/` factory with live/mock toggle code
- Show `store/idempotency.go` file persistence
- Show `docs/DEMO_SCRIPT_v2.md` framing of real vs mocked, NPCI simulation honesty

## Key Metrics to Quote

- Latency <3s p95, 50 TPS on 4-org network, Raft tolerates 1 failure
- 10M token cap, integer-only, 4 SQL indexes
- 25 seeded transfers for pagination demo, bookmark cursor pattern
- Idempotency persisted to file, survives restart
- 4 chaincode failure modes + 6 payment failure modes demoable live (10 total)
- Payment-gateway: 8 tests, INR paise int64, VPA regex, RRN 12-digit, UTR IMPS+RRN, expiry 5 min, idempotency X-Idempotency-Key
- Primary rail: UPI Collect P2M + IMPS UTR (INR) — simulation, no live NPCI — secondary: Sepolia PaymentEscrow.sol experimental
