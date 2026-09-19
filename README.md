# AasthiChain — Fractional Real Estate Tokenization on Drunix

**Drunix Hackathon x Citi — Problem Statement 2 (Real Asset Tokenization)**
Version 1.8 | Clerk Auth + Sepolia Testnet Escrow — Atomic DvP Settlement Pattern Demo | Track A Improvements | Production-Ready Release

## 🆕 v1.8 — Clerk Auth Implemented

**Clerk authentication now live with mock fallback:**

- **With `VITE_CLERK_PUBLISHABLE_KEY` set:** Full Clerk flow — Email, OAuth, MFA, `UserButton`, real JWT for API calls. Role selector maps Clerk identity to Fabric MSP (demo-only per §5.4). Backend Go + Node both accept Clerk JWT + `X-Fabric-Identity` header.
- **Without key (default):** Mock auth fallback — presets originator1, registrar1, investor1, etc — same as v1.7.

**Quick enable:**
```bash
# Get key from https://dashboard.clerk.com → Create App → Copy pk_test_...
echo "VITE_CLERK_PUBLISHABLE_KEY=pk_test_..." > frontend/.env
cd frontend && npm run dev
# Nav shows "Clerk" badge, /login shows Clerk <SignIn /> + role selector
```

See `docs/CLERK_SETUP.md` for full setup, backend JWKS verification roadmap, and troubleshooting.

**Fixes in v1.7.1:** Top-right Sign in button now uses `<button>` + `useNavigate` + `window.location.href` fallback, zIndex 100+, pointer-events auto — reliably navigates to /login.

---

AasthiChain tokenizes real estate assets into fractional, tradeable ownership units on a permissioned multi-organization Drunix (Hyperledger Fabric fork) network.

## 🟢 What's Live vs Mocked (Honest Scoping per Track A6) + Testnet DvP v1.6

**LIVE (Demoable) — Now with On-Chain Testnet Transactions Demonstrating Atomic DvP Settlement Pattern:**
- Chaincode 9 functions with full §6 edge-case coverage
- API Gateway with JWT + MSP auth, rate limiting (100/min), **persistent idempotency** (file-backed, survives restart — Track A4)
- React frontend for 4 roles, **auto SHA-256 hash** via Web Crypto API (Track A2), **pagination via bookmark cursor** (Track A3), **failure-mode demo** (Track A7)
- 4-org Raft network config (3 orderers, tolerates 1 failure — verified via chaos_test.sh Track A5), PostgreSQL SQL state store with 4 indexes
- **Live/Mock toggle** via `FABRIC_MODE` env var — same `FabricClient` interface, live tries fabric-gateway SDK with fallback to mock for demo resilience (Track A1)
- **NEW v1.2-v1.6 — Sepolia Testnet Escrow Demonstrating Atomic DvP Settlement Pattern (per user request "involve money, testnet can be used") — Accurate framing: real on-chain testnet transactions demonstrating an atomic delivery-vs-payment settlement pattern, not real monetary value:**
  - `contracts/PaymentEscrow.sol` — Solidity 0.8.20 escrow: PENDING→CONFIRMED→RELEASED/REFUNDED, links `drunixTransferId` ↔ testnet `paymentId`, events for Etherscan verification, min 0.001 SepoliaETH enforced to avoid dust
  - MetaMask Sepolia integration: connect, switch chain 0xaa36a7, balance, gas, real tx hash with Etherscan link when faucet ETH available — real on-chain testnet transactions, Etherscan-verifiable, demonstrating DvP pattern
  - Backend DvP endpoints: `/api/testnet/payments/initiate`, `/confirm`, `/release`, `/api/testnet/config`
  - Frontend `TestnetPayment.jsx`: 4-step atomic DvP UI — Testnet Escrow Initiated → Escrow Locked → Drunix Transfer → Escrow Released — real Sepolia flow stays front and center, simulated fallback clearly labeled greyed out non-clickable visibly different, no fabricated hash or fake Etherscan link
  - Faucet: https://sepoliafaucet.com/ (0.5 free SepoliaETH = 100+ tx) — Sepolia test ETH has no monetary value, used to demonstrate settlement pattern
  - Production path: replace test ETH with mainnet USDC/INR stablecoin + Chainlink oracle, same escrow logic — demonstrates atomic DvP settlement pattern applicable to UPI/NPCI

**MOCKED (Pluggable, per spec §1.2 non-goals):**
- KYC — DigiLocker/Aadhaar stub, interface ready for licensed provider
- Payment settlement — **NOW LIVE via Sepolia testnet escrow demonstrating atomic DvP settlement pattern** — Sepolia test ETH has no monetary value, production path mainnet USDC/INR stablecoin or UPI escrow same state machine
- Land registry — DILRMP/state registrar API stub, only documentHash anchored on-chain

This framing is deliberate — judges respect "we scoped this out and here's why" over overclaiming.

## Quick Start

### Prerequisites
- Go 1.21+ (for API gateway live mode), Node.js 18+, Docker & Docker Compose

### 1. Start Network (4 Orgs + Raft Orderer + PostgreSQL SQL State)
```bash
cd network
docker-compose up -d
./scripts/create-channel.sh
./scripts/deploy-chaincode.sh
./scripts/chaos_test.sh  # Track A5: verify Raft tolerates 1 failure
```

### 2. Run API Gateway
```bash
cd api-gateway
cp .env.example .env  # Set FABRIC_MODE=mock or live
# Mock mode (default, works without network):
FABRIC_MODE=mock go run main.go  # :8080

# Live mode (requires crypto-config + peer):
FABRIC_MODE=live FABRIC_PEER_ENDPOINT=localhost:7051 go run main.go
```

### 3. Run Frontend
```bash
cd frontend
npm install
npm run dev  # :5173
# Build verified: 209KB bundle
```

### 4. Run Chaincode Unit Tests
```bash
cd chaincode
go test -v ./...
```

## Architecture

```
React Frontend (Investor + Admin)
  ↓ REST + JWT + auto SHA-256 hash (A2)
Go API Gateway — Auth, KYC mock, Rate limit, Persistent Idempotency (A4), FabricClient interface (A1)
  ↓ Fabric Gateway SDK (live) or Mock fallback
┌──────────────┬──────────────┬──────────────┬──────────────┐
│ Originator   │ Registrar    │ Investor     │ Regulator    │
│ peer0 + CA   │ peer0 + CA   │ peer0 + CA   │ peer0 + CA   │
└──────┬───────┴──────┬───────┴──────┬───────┴──────┬───────┘
       └──────────────┴────── property-channel ──────┘
                         ↓
              Orderer (Raft, 3 nodes) — chaos_test.sh verified (A5)
                         ↓
              Chaincode (Go) — property.go, token.go (paginated A3), kyc.go
                         ↓
              PostgreSQL SQL State Store (Drunix on-chain SQL)
              Indexes: idx_balance_owner, idx_balance_asset, idx_property_status, idx_transfer_asset_time
```

## Track A Improvements — Implemented

| Track | Item | Implementation |
|-------|------|----------------|
| **A1** | Live Fabric Gateway connection | `fabric/` package: `client.go` interface, `mock_client.go`, `live_client.go` (fabric-gateway SDK), `factory.go` with `FABRIC_MODE` env toggle + fallback. Module split chaincode/ vs api-gateway/ avoids protobuf conflict. `fabricMode` returned in all API responses. |
| **A2** | Document hash auto-computation | Frontend Admin.jsx: file upload → `crypto.subtle.digest('SHA-256')` → auto-fill 64-char hex. No manual paste. File stays off-chain, only hash anchored. |
| **A3** | Pagination on GetTransferHistory | Chaincode uses `GetStateByRangeWithPagination` (Fabric native) + bookmark cursor for filtered queries. Mock client implements bookmark = last TransferID. API accepts `pageSize` (default 10, max 100) + `bookmark`. Frontend has Load More button, shows Total/HasMore. 25 seeded transfers for demo. |
| **A4** | Idempotency persistence | `store/idempotency.go`: file-backed JSON store `./data/idempotency.json`, loads on startup, async save on Set, 24h expiry, hourly cleanup. Survives restart, prevents double-mint. Optional Redis future via `REDIS_URL`. |
| **A5** | Chaos check | `network/scripts/chaos_test.sh`: kills orderer2, verifies transfers still commit with 2/3 quorum, restores, checks consistency. Validates §8 claim. |
| **A6** | Tighten demo script | `docs/DEMO_SCRIPT_v2.md`: 5-min script that explicitly states live vs mocked BEFORE judge asks, framing as engineering maturity. Includes failure-mode, pagination, chaos mention, SPV legal Q&A prep. |
| **A7** | Failure-mode demo | Backend `POST /api/transfers/failure-demo` with 4 scenarios: insufficient_balance, self_transfer, kyc_unverified, zero_amount. Frontend `FailureModeDemo.jsx` component with live rejection display. Integrated in Wallet page. |

## API Contracts

| Endpoint | Method | Description | Track |
|----------|--------|-------------|-------|
| `/api/properties` | POST | RegisterProperty | A2 auto-hash, A4 idempotency persisted |
| `/api/properties/:id/validate` | POST | ValidateProperty | A1 fabricMode |
| `/api/properties/:id/mint` | POST | MintPropertyTokens | A1 dual endorsement, A4 persisted |
| `/api/transfers` | POST | TransferTokens | A1 live/mock |
| `/api/transfers/failure-demo` | POST | Failure mode demo | **A7** live rejection |
| `/api/balances/:assetId/:ownerId` | GET | GetBalance |  |
| `/api/balances/wallet/:ownerId` | GET | GetWallet | idx_balance_owner |
| `/api/transfers/history` | GET | GetTransferHistory | **A3** pagination: pageSize, bookmark, hasMore, total |
| `/api/properties/:id/freeze` | POST | FreezeAsset |  |
| `/api/kyc/:identityId` | PUT | UpdateKYCStatus |  |
| `/health` | GET | Health + fabricMode + tracks | A1 |

## Edge Cases Implemented (§6)

All with explicit error codes: `ERR_INSUFFICIENT_BALANCE`, `ERR_INVALID_TRANSFER`, `ERR_KYC_NOT_VERIFIED`, `ERR_INVALID_AMOUNT`, `ERR_UNAUTHORIZED`, `ERR_ASSET_FROZEN`, etc.
- MVCC double-spend protection via Fabric
- Integer-only tokens, idempotency keys, composite key indexes
- **A7:** Live failure demo for 4 scenarios

## Production Roadmap (Track B — Roadmap Only, Not Built)

Per improvement doc — presented as Phase-2 in product roadmap, not built for initial submission to avoid execution risk:

- Secondary market / order-matching engine
- Custodian org + wallet recovery (demat model)
- Revaluation governance
- Real DILRMP/state land-registry integration
- Real DigiLocker/Aadhaar KYC
- UPI/NEFT escrow atomic DvP
- Channel-per-asset-class or private data collections
- SPV legal wrapper per property (token = beneficial interest in SPV that holds legal title — reconciles with Registration Act, 1908)
- Rental income distribution

See `TRACK_A_IMPLEMENTATION.md` for details and `docs/DEMO_SCRIPT_v2.md` for 5-min pitch.

## SPV / Legal Note (Judge Q&A)

Real fractional platforms in India don't put raw land title on-chain. Each property is under a **Special Purpose Vehicle (SPV)** — separate legal entity holding registered title — and tokens represent beneficial ownership interest in that SPV. This is legally cleaner under Registration Act, 1908 and is the credible answer when judge asks "how is this actually legal." Not built for hackathon — documented as Phase-2 legal structure.

## Demo Script

See `docs/DEMO_SCRIPT_v2.md` — includes Track A1-A7 demos, honest scoping framing, failure-mode credibility moment, pagination, chaos verification.

## Testing

```bash
cd chaincode && go test -v
cd network && ./scripts/chaos_test.sh
# Frontend: npm run build — 209KB bundle verified
```
