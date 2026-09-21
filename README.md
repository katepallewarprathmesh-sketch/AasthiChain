# AasthiChain — Own Premium Real Estate from ₹500

**Fractional real estate + secure UPI payments + instant blockchain ownership**

> Tokenized real-asset ownership on Drunix + payment settlement modeled on NPCI's UPI/IMPS rails

Live: [aasthichain.vercel.app](https://aasthichain.vercel.app) · Demo video in `docs/` · Pitch deck `PITCH_DECK.html`

---

### The Problem

Premium property costs ₹75L+ — out of reach. Selling takes months, paperwork is messy, you can't own 0.1% of a villa. No transparency, no liquidity, and payments are separate from ownership.

### What We Built

AasthiChain converts each verified property into fixed tokens — like shares. A ₹75L villa → 15,000 tokens at ₹500 each. Buy 100 tokens for ₹50k, own fractional. Pay via UPI, get instant ownership, trade anytime.

- **₹500 start**, not ₹75L
- **UPI payment** — same as any UPI, secure, instant
- **Atomic** — money and tokens move together or both refunded
- **Verified** — Registrar checks title before tokenization
- **Tradable** — secondary transfers instantly

### How It Works — 4 Roles

1. **Owner** lists property with documents → hash anchored
2. **Registrar** validates title → approves
3. **You** browse → pay via UPI → own tokens instantly
4. **Regulator** audits, can freeze if needed

### Quick Start

```bash
# Frontend only (mock mode, no Go/Docker needed)
cd frontend && npm install && npm run dev  # :5173

# With network (optional)
cd network && docker-compose up -d && ./scripts/create-channel.sh
cd api-gateway && FABRIC_MODE=mock go run main.go  # :8080
```

Login presets: `originator1 / registrar1 / investor1 / regulator1` — or sign in from top-right (one auth for all).

### Payments — Simple

1. Click **Buy Tokens** → choose amount in ₹
2. Pay via UPI — your ID to verified owner
3. Tokens transferred instantly on blockchain
4. Done — see in My Portfolio

No partial failures: if payment fails, no tokens move. If tokens fail, payment refunded.

### Tech — Simple View

- **Frontend:** React, Vite, Clerk auth, UPI payment UI
- **Backend:** Vercel serverless mock + Go API gateway (optional live)
- **Blockchain:** Drunix Fabric — 4 orgs, Raft orderer, property & token chaincode
- **Payments:** UPI Collect primary (INR), Sepolia escrow secondary experimental

**Build:** 113 modules, 397KB

### For Judges & Developers — Technical Details

<details>
<summary>Click to expand — Architecture, LIVE vs MOCKED, Payments deep-dive, Tests</summary>

#### Architecture

```
React (Landing + Marketplace + PropertyDetail + Wallet + Admin + Regulator)
  ↓ REST + JWT + rate limit + idempotency
Go API Gateway (Auth, KYC mock, FabricClient interface, payment-gateway module)
  ↓ Fabric Gateway SDK (live) or Mock fallback
4 org peers + Raft 3 orderers + PostgreSQL SQL state store
  ↓
Chaincode (property.go, token.go, kyc.go) — 9 funcs
  ↓
payment-gateway/ — UPI Collect P2M + IMPS UTR primary + PaymentEscrow.sol secondary
```

**Primary Rail — UPI Collect P2M + IMPS UTR (INR):**
- VPA `investor@aasthichain`, `originator@aasthichain` — regex `^[a-z0-9._-]{2,64}@[a-z]{2,64}$`
- IDs: `NPCI-XXXXXXXXXXXX`, `AASTYYYYMMDDXXXXXXXX`, RRN 12-digit `418...`, UTR `IMPS418...+4-digit`
- Flow: `PENDING (5min) → CONFIRMED (KYC+balance) → RELEASED (after TransferTokens) / REFUNDED`
- Paise int64 to avoid float, X-Idempotency-Key, webhook callback simulation
- Why Collect P2M not Intent? Seller requests, buyer approves — merchant collect + UTR reconciliation
- Simulation honesty: No live NPCI sandbox — PPRO "Sandbox Not Available from UPI", no Drunix hackathon sandbox found. Inspired by `upi-mock-engine`. UI badge `SIMULATION — No live NPCI`
- Tests: 8 tests — success→transfer, timeout→refund, duplicate idempotency, KYC rejection, insufficient funds, invalid VPA, zero amount, ID formats

**Secondary Rail — Sepolia:**
- `PaymentEscrow.sol` experimental cross-chain pattern behind Advanced toggle — bonus future extensibility to tokenized deposits/stablecoin
- Not primary DvP

**Chaincode:**
- 9 funcs, AND endorsement for mint, integer-only tokens, overflow cap 10M, composite key `balance~assetId~ownerId`, 4 SQL indexes `idx_property_status, idx_balance_owner, idx_balance_asset, idx_transfer_asset_time`, MVCC double-spend protection, 216+ tests

**API Contracts (key):**
- `/api/npci/collect` POST — Initiate UPI Collect
- `/api/npci/payments/:id/approve` POST — Approve → CONFIRMED
- `/api/npci/payments/:id/release` POST — Release → RELEASED + UTR
- `/api/npci/payments/:id/refund` POST — Refund → REFUNDED
- `/api/npci/payments` GET — List with RRN/UTR
- `/api/transfers` POST — TransferTokens
- `/api/balances/wallet/:ownerId` GET — Portfolio (fixed v2.1 wallet 500)
- `/api/transfers/history?bookmark` GET — Pagination bookmark pattern

**LIVE vs MOCKED (Track A6):**
- LIVE: Chaincode 9 funcs, JWT+MSP, Raft 3, SQL 4 indexes, payment-gateway, atomic DvP, 216+ tests + 8 payment tests
- MOCKED (pluggable): KYC DigiLocker stub, DILRMP hash, NPCI UPI simulation (no live credentials), Sepolia secondary experimental

**Regulatory — Bill 2026:**
- Asset Tokenisation (Regulation) Bill 2026 — pending Private Member's Bill, not law — proposes KYC/AML, registered custodian, registrar validation, regulator freeze
- AasthiChain addresses: RegistrarMSP validates + KYC mock, Regulator freeze, cap table auditable, payment KYC gate `FAILED_KYC_NOT_VERIFIED→REFUNDED`

**Track A:**
- A1 Live/Mock toggle FABRIC_MODE, A2 auto SHA-256 hash, A3 pagination bookmark, A4 idempotency file-backed, A5 chaos_test.sh Raft, A6 demo script + honest scoping, A7 failure-mode demo 4 chaincode + 6 payments = 10 total

**Testing:**
```bash
cd chaincode && go test -v
cd payment-gateway && go test -v && node gateway.test.js
cd frontend && npm run build
```

</details>

### Docs

- `docs/DEMO_SCRIPT_v2.md` — 5-6 min pitch with NPCI primary + honest scoping
- `PITCH_DECK.html` — slides
- `TRACK_A_IMPLEMENTATION.md` — Track A details
- `payment-gateway/README.md` — payments module

### Production Roadmap (Not Built — Roadmap Only)

Secondary market order-matching, custodian org (demat), DILRMP integration, DigiLocker KYC, real UPI AutoCollect (ICICI/Yes Bank), channel-per-asset-class, SPV legal wrapper (token = beneficial interest in SPV per Registration Act 1908 + Bill 2026), rental income via UPI

### SPV Note

Real platforms use SPV per property — tokens = beneficial interest in SPV that holds legal title. Not built for hackathon — documented as Phase-2 legal structure.

---

**One auth for all — sign in top-right corner → Explore Properties → Buy Tokens via UPI → Own instantly**
