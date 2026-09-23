# AasthiChain — Own Premium Real Estate from ₹500

**Fractional real estate + secure UPI payments + instant blockchain ownership**

> Tokenized real-asset ownership on **NPCI Drunix** + payment settlement on NPCI's UPI/IMPS rails

Live: [aasthi-chain.vercel.app](https://aasthi-chain.vercel.app)

### NPCI Drunix Tokenization

- Ledger: Drunix-compatible Fabric chaincode in Go (`chaincode/`) — properties, fractional token balances, KYC, transfers
- Settlement: UPI Collect escrow → payment CONFIRMED (bank UTR) → Drunix token transfer → escrow RELEASED — atomic DvP (`drunixTransferId` on every payment)
- Persistence: production state in Postgres / GitHub-backed real DB (`frontend/api/lib/db_real.js`), shared across serverless instances
- UPI rail: NPCI UPI Collect simulation with RRN/UTR, idempotency, webhooks + UTR reconciliation — real via Setu/ICICI by flipping `NPCI_MODE=real` (`payment-gateway/real_npcibank.go`)

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

**Demo Access — Works LIVE + Local, No Verification, <2s:**
- **LIVE:** https://aasthi-chain.vercel.app — verified 200 OK + /api/health OK — `aasthichain.vercel.app` (no hyphen) returns 404, correct is `aasthi-chain.vercel.app` (with hyphen)
- **Quick Demo Presets (instant mock JWT, no Clerk, no email):** On landing page `/` you see 4 cards — Owner `originator1`, Registrar `registrar1`, Investor `investor1`, Regulator `regulator1` — click any → mock JWT stored → `/marketplace` in <1s — works on LIVE Vercel + local `npm run dev` — no network call
- **Clerk Auth (optional):** Sign in top-right corner — Google/Email via Clerk — after Clerk sign-in you can still switch roles via ROLE dropdown in nav — one auth for all
- Both paths work on deployed site: demo presets reachable from landing without Clerk, and Clerk sign-in also available — no friction for judges

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
- VPA `investor@aasthichain`, `originator@aasthichain` — regex `^[a-z0-9._-]{2,64}@[a-z0-9]{2,64}$`
- IDs: `NPCI-XXXXXXXXXXXX`, `AASTYYYYMMDDXXXXXXXX`, RRN 12-digit `418...`, UTR `IMPS418...+4-digit`
- Flow: `PENDING (5min) → CONFIRMED (KYC+balance) → RELEASED (after TransferTokens) / REFUNDED`
- Paise int64 to avoid float, X-Idempotency-Key, webhook callback simulation
- Why Collect P2M not Intent? Seller requests, buyer approves — merchant collect + UTR reconciliation
- Simulation honesty: No live NPCI sandbox — PPRO "Sandbox Not Available from UPI", API Setu sandbox-only per Jan 2022 note, direct NPCI requires bank partnership. Inspired by `upi-mock-engine`. UI badge `SIMULATION — No live NPCI` — honest labeling per Track A6. **Real path:** Direct access via NPCI-certified switch Setu (Pine Labs) — certified as UPI switch with direct NPCI systems access — or PSP Bank ICICI/Decentro/Razorpay. Same state machine PENDING→CONFIRMED→RELEASED, same RRN/UTR, 1-line toggle NPCI_MODE=real + SETU_API_KEY. See `/api/npci/real-config` and `docs/NPCI_REAL_API_INTEGRATION.md` + `payment-gateway/real_npcibank.go`
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

### Production Roadmap (Not Built — Roadmap Only)

Secondary market order-matching, custodian org (demat), DILRMP integration, DigiLocker KYC, real UPI AutoCollect (ICICI/Yes Bank), channel-per-asset-class, SPV legal wrapper (token = beneficial interest in SPV per Registration Act 1908 + Bill 2026), rental income via UPI

### SPV Note

Real platforms use SPV per property — tokens = beneficial interest in SPV that holds legal title. Not built for hackathon — documented as Phase-2 legal structure.

---

**One auth for all + instant demo — Sign in top-right (Clerk) or use demo preset (originator1/registrar1/investor1/regulator1) for instant access, no verification needed — works LIVE https://aasthi-chain.vercel.app + local — Explore Properties → Buy Tokens via UPI → Own instantly**
