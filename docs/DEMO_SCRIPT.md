# AasthiChain Demo Script — 5 Minute Pitch

## Pre-demo Setup (1 min before)
- `docker-compose up -d` (or show MockFabricClient seed data)
- API gateway running on :8080, frontend on :5173
- 4 browser tabs logged in as different roles (use preset buttons)

## Flow

### 0:00-0:30 — Problem & Solution
- Real estate in India: illiquid, high ticket size, paperwork heavy
- AasthiChain: fractional ownership tokens on permissioned Drunix network
- 4 orgs: Originator (lists), Registrar (validates title), Investor (buys), Regulator (audit)
- Not replacing Registration Act, 1908 — reflection layer, honest scoping

### 0:30-1:30 — Admin Flow (Originator + Registrar)
- Login as originator1 / Originator
- Show RegisterProperty: title, location, valuation, documentHash (SHA-256 of off-chain legal docs)
- Explain: composite key `balance~assetId~ownerId`, SQL indexes avoid ledger scans
- Switch to registrar1 / Registrar
- ValidateProperty: VALIDATED
- MintPropertyTokens: 10000 tokens for ₹50L property = ₹500/token
- Highlight endorsement policy: `AND('OriginatorMSP.peer','RegistrarMSP.peer')` prevents unilateral minting

### 1:30-3:00 — Investor Flow
- Login as investor1 / Investor
- Wallet: show holdings, portfolio value, cap table
- TransferTokens: send 500 tokens to investor2
- Explain edge cases handled:
  - ERR_INSUFFICIENT_BALANCE — no partial
  - ERR_INVALID_TRANSFER — self-transfer blocked
  - ERR_KYC_NOT_VERIFIED — receiver must be verified
  - ERR_ASSET_FROZEN — frozen asset blocks
  - MVCC — double-spend auto-rejected at commit time
  - Integer-only tokens — no float bugs
- Show TransferRecord immutable audit trail
- Show token price calculation

### 3:00-4:00 — Regulator Audit
- Login as regulator1 / Regulator
- Show all properties, cap table per asset via idx_balance_asset
- Show transfer history via idx_transfer_asset_time
- Demo FreezeAsset emergency action
- Show system health: Raft 3 nodes, p95 <3s, ≥50 TPS

### 4:00-4:45 — Architecture & Production Readiness
- HLD: React -> Go API Gateway (JWT + KYC + Rate Limit) -> Fabric Gateway API -> 4 org peers + Raft orderer -> Chaincode -> PostgreSQL SQL state
- Security: chaincode validates at boundary, HSM signing in prod (not plaintext keys), endorsement hardening (add title-insurance org)
- Scalability: private data collections per property, read-replica for audit queries
- Testing: unit tests for all edge cases, integration tests with docker-compose, negative tests

### 4:45-5:00 — Limitations & Ask
- Openly flagged: not substitute for Registration Act, KYC/payment mocked, custodian phase 2
- Judges respect honest scoping
- Future: DILRMP integration, DigiLocker KYC, secondary market order book, custodian org (demat model)

## Backup: If live demo fails
- Show chaincode unit tests: `cd chaincode && go test -v`
- Show API gateway mock state dump
- Show frontend code with composite key comments
- Show network/docker-compose.yaml with SQL state config

## Key Metrics to Quote
- Latency <3s p95
- 50 TPS on 4-org network
- Raft tolerates 1 failure
- 10M token cap, integer-only
- 4 SQL indexes for fast queries
