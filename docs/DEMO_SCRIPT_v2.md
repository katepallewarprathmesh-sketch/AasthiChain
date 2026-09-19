# AasthiChain Demo Script v2 — After Track A Improvements (Production-Ready)

**Duration: 5 minutes | Fabric Mode: Toggle live/mock | Key message: Honest scoping = engineering maturity**

## 0:00-0:15 — Setup & Framing (Track A6: What's Real vs Mocked BEFORE Judge Asks)

> "AasthiChain tokenizes real estate into fractional tokens on a permissioned 4-org Drunix network. Before we dive in — here's what's live and what's deliberately mocked per spec non-goals §1.2, so we're transparent:
> 
> **LIVE:** Chaincode 9 functions with full edge-case coverage, API gateway with JWT + MSP + rate limiting + persistent idempotency (file-backed, survives restart), React frontend for 4 roles, Raft 3-node orderer, PostgreSQL SQL state store with 4 indexes.
> 
> **MOCKED (pluggable):** KYC (DigiLocker stub — interface ready for licensed provider), payment settlement (UPI mock — token transfer only after confirmation per spec), land registry (DILRMP stub — hash anchored on-chain).
> 
> **Toggle:** `FABRIC_MODE=live|mock` env var — same FabricClient interface. Live tries fabric-gateway SDK, falls back to mock if peer unreachable, so demo never breaks on stage. Module split chaincode/ vs api-gateway/ avoids protobuf conflict."

This framing reads as maturity, not weakness.

## 0:15-1:30 — Admin Flow (Originator + Registrar) + Track A2

**Login as originator1 / Originator**
- Show RegisterProperty form
- **Track A2 Demo:** Upload legal doc PDF → auto-compute SHA-256 via `crypto.subtle.digest` in browser → hash auto-filled (no manual 64-char paste). Explain: "File stays off-chain, only hash anchored. In prod, file → IPFS, hash → ledger. Tamper detection via periodic re-hash per §6.4"
- Submit → assetId returned, status DRAFT, PENDING validation
- Note: hash collision flagged via `hash~docHash~assetId` index but allowed per spec

**Switch to registrar1 / Registrar**
- ValidateProperty: VALIDATED
- Explain endorsement: `AND('OriginatorMSP.peer','RegistrarMSP.peer')` prevents unilateral minting — dual signatures required at network level, plus chaincode MSP check defense-in-depth

**MintPropertyTokens**
- Enter totalTokens 10000 for ₹50L property = ₹500/token, integer-only no decimals
- Show idempotency key: `X-Idempotency-Key: mint-PROP-...` — persisted to `./data/idempotency.json` per Track A4, survives gateway restart, prevents double-mint
- Success: TokenBalance(owner=Originator, balance=totalTokens) created, status TOKENIZED
- Mention: overflow cap 10M, already-tokenized check

## 1:30-3:00 — Investor Flow + Track A7 Failure Mode

**Login as investor1 / Investor**
- Wallet: show holdings via `idx_balance_owner` (fast, no ledger scan), portfolio value sum(tokenPrice*balance), cap table
- Note FabricMode badge: shows "live" or "mock" from `/health`

**TransferTokens**
- Send 500 tokens to investor2 → success TXN ID, block committed with instant finality
- Explain: payment assumed off-chain per spec, token transfer triggered after `POST /payments/confirm` mock

**Track A7 — Live Failure Mode Demo (The Credibility Moment)**
> "Now let's show it correctly rejects invalid transactions — this is more important than happy path."

- Click "Insufficient Balance" → tries to transfer 999999999 tokens when you have 50 → `ERR_INSUFFICIENT_BALANCE: have 50 need 999999999` — no partial transfer, atomic rejection
- Click "Self Transfer" → fromId == toId → `ERR_INVALID_TRANSFER: self-transfer not allowed`
- Click "Unverified KYC" → toId = random unverified → `ERR_KYC_NOT_VERIFIED`
- Click "Zero Amount" → amount 0 → `ERR_INVALID_AMOUNT`
- Explain: All §6.2 edge cases validated at chaincode boundary, plus Fabric MVCC auto-rejects concurrent double-spend at commit time — caller must retry. This is not custom locking.

## 3:00-4:00 — Regulator Audit + Track A3 Pagination + A5 Chaos

**Login as regulator1 / Regulator**
- Show all properties, cap table per asset via `idx_balance_asset` (SELECT * WHERE assetId=?)
- Show transfer history — **Track A3 Pagination Demo:**
  - Total 25 seeded transfers, pageSize 10, bookmark cursor pattern (Fabric native `GetStateByRangeWithPagination`, not naive LIMIT/OFFSET)
  - Click "Load More" → uses bookmark from last TransferID, shows next page
  - Explain: `idx_transfer_asset_time` on (assetId, txTimestamp) for fast audit, regulator is non-endorsing observer for transfers
- Demo FreezeAsset emergency: freeze a property → status FROZEN → subsequent transfers blocked with `ERR_ASSET_FROZEN`

**Track A5 — Chaos Check (Mention, don't live-kill unless rehearsed)**
> "We have a 3-node Raft orderer tolerating 1 failure per §8. In rehearsal we killed orderer2 via `docker stop orderer2.aasthichain` and confirmed network still commits — script in `network/scripts/chaos_test.sh`. We won't kill it live now to avoid risk, but it's verified."

- Show system health: Raft 3 nodes, p95 <3s, ≥50 TPS, Postgres read-replica for audit queries

## 4:00-4:45 — Architecture & Production Readiness + Track B/C Roadmap

**HLD Diagram:**
React → Go API Gateway (JWT, KYC mock, rate limit 100/min, persistent idempotency, FabricClient interface) → Fabric Gateway SDK (live) or Mock (fallback) → 4 org peers + Raft orderer → Chaincode (property.go, token.go, kyc.go) → PostgreSQL SQL state with 4 indexes

**Drunix Advantage:**
SQL state store vs LevelDB/CouchDB: O(log n) queries via indexes, no full scans, read-replica for regulator

**Production Readiness §9 — What's Done vs Roadmap:**
- **Done:** Chaincode validates at boundary, rate limiting, audit logging, idempotency persistence, pagination, live/mock toggle, auto-hash, failure-mode demo
- **Track B — Roadmap Only (do not build now, document well):** Secondary market order-matching, custodian org (demat model), revaluation governance, DILRMP integration, DigiLocker KYC, UPI escrow atomic DvP, channel-per-asset-class, SPV legal wrapper
- **Track C — Post-hackathon hardening:** HSM-backed signing, endorsement hardening AND(Registrar, TitleInsuranceOrg), private data collections, threat model, pen test, Prometheus/Grafana, ledger snapshots, cert rotation, blue-green chaincode upgrade

**SPV Legal Structure (Judge Q&A Prep):**
> "Real fractional platforms in India don't put raw land title on-chain. Each property is under an SPV — a legal entity holding registered title — and tokens represent beneficial interest in that SPV. This reconciles on-chain tokens with Registration Act, 1908. We don't build SPV for hackathon, but that's our Phase-2 legal structure — shows we understand constraint, not hand-wave."

## 4:45-5:00 — Limitations & Ask

- Openly flagged: NOT substitute for Registration Act, KYC/payment mocked, custodian Phase-2
- Repo URL, live URL, demo video
- Thank you

## Backup If Live Demo Fails

- Frontend runs in mock mode even if gateway offline (fallback)
- Show `chaincode_test.go` unit tests
- Show `fabric/` factory with live/mock toggle code
- Show `store/idempotency.go` file persistence
- Show `docs/DEMO_SCRIPT_v2.md` framing of real vs mocked

## Key Metrics to Quote

- Latency <3s p95, 50 TPS on 4-org network, Raft tolerates 1 failure
- 10M token cap, integer-only, 4 SQL indexes
- 25 seeded transfers for pagination demo, bookmark cursor pattern
- Idempotency persisted to file, survives restart
- 4 failure modes demoable live
