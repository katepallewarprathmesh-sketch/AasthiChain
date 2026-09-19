# Pitch Deck Outline — AasthiChain

## Slide 1: Title
- AasthiChain — Fractional Real Estate Tokenization on Drunix
- Team: katepallewarprathmesh-sketch
- Hackathon: Drunix x Citi — Problem Statement 2

## Slide 2: Problem
- ₹50L+ ticket size excludes retail investors
- Illiquid, 3-6 month settlement
- Paperwork, title fraud risk
- No transparent cap table

## Slide 3: Solution
- Tokenize property into fixed-supply fungible tokens (e.g., 10000 tokens = ₹50L, 1 token = ₹500)
- Permissioned multi-org Drunix network — no single party controls ledger
- Instant finality, immutable audit trail

## Slide 4: Network Topology (Diagram)
- 4 Orgs: Originator, Registrar, Investor, Regulator
- Raft 3-node orderer
- PostgreSQL SQL state store (Drunix advantage)
- Endorsement policies: Mint = AND(Originator, Registrar), Transfer = Investor only

## Slide 5: Architecture HLD
- React -> Go API Gateway (JWT, KYC mock, rate limit) -> Fabric Gateway SDK -> Peers -> Chaincode (property.go, token.go, kyc.go) -> SQL state
- Composite keys: balance~assetId~ownerId
- Indexes: idx_balance_owner, idx_balance_asset, idx_property_status, idx_transfer_asset_time

## Slide 6: Data Model
- PropertyAsset, TokenBalance, TransferRecord, KYCRecord JSON examples
- Show token price calculation

## Slide 7: Sequence Flows
- Tokenization: Register (DRAFT) -> Validate (off-chain doc review) -> Mint (dual endorsement) -> TokenBalance
- Transfer: KYC check -> balance check -> atomic transfer -> TransferRecord -> block commit

## Slide 8: Edge Cases (Your Moat)
- Table from spec §6: insufficient balance, self-transfer, KYC unverified, zero amount, double-spend via MVCC, frozen asset, network partition atomicity, integer-only tokens, hash collision flag, clock skew via block timestamp

## Slide 9: Demo (Live)
- Admin: Register -> Validate -> Mint
- Investor: Wallet -> Transfer -> History
- Regulator: Audit, Freeze

## Slide 10: Drunix Advantage
- SQL state store vs LevelDB/CouchDB: O(log n) queries, no full scans, read-replica for regulator
- Permissioned: regulator as non-endorsing observer, privacy (no PII on-chain)

## Slide 11: Production Readiness (§9)
- Security: HSM signing, input validation at chaincode boundary, endorsement hardening, rate limiting, audit logging
- Scalability: private data collections, read-replica
- Operational: Prometheus/Grafana, ledger snapshotting, cert rotation, blue-green chaincode upgrade
- Legal: NOT substitute for Registration Act 1908, reflection layer, IFSCA/SEBI sandbox, DigiLocker KYC needed

## Slide 12: Testing
- Unit tests: all functions + edge cases
- Integration: docker-compose multi-org flows
- Negative: unauthorized MSP, double-spend, invalid KYC
- Load: k6 hitting API gateway for 50 TPS target

## Slide 13: Roadmap
- Phase 1 (Hackathon): working slice, mocked KYC/payment
- Phase 2: Custodian org (demat model), DILRMP integration, HSM wallet, private data collections
- Phase 3: Secondary market order-matching, fiat on/off-ramp, title-insurance org as second validator

## Slide 14: Team & Ask
- Honest scoping > overclaim
- Repo URL, demo video, live URL
- Thank you

## Appendix: Non-Goals (Be upfront)
- No real land registry integration — stubbed
- No real KYC provider — mocked with pluggable interface
- No order-matching engine — direct peer transfer only
- No fiat settlement — off-chain assumed
- Legal enforceability explicitly called out as limitation
