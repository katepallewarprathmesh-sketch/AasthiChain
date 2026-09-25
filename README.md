# AasthiChain — Own Premium Real Estate from ₹500

**Fractional real estate + secure UPI payments + instant blockchain ownership**

> Tokenized real-asset ownership on **NPCI Drunix** + payment settlement on NPCI's UPI/IMPS rails

Live: [aasthi-chain.vercel.app](https://aasthi-chain.vercel.app)

### NPCI Drunix Tokenization

- Ledger: Drunix-compatible Fabric chaincode in Go (`chaincode/`) — properties, fractional token balances, KYC, transfers, `SettleDvP` (atomic delivery-versus-payment with UTR proof) + `SettlementRecorded` chaincode events. **Duplicate deeds rejected on-chain**: `ERR_DUPLICATE_PROPERTY` if a documentHash is already registered — each document tokenizes exactly once
- Drunix Gateway (Golang): `drunix-gateway/` — Drunix transaction lifecycle (PROPOSED → ENDORSED → COMMITTED, deterministic txIDs, read/write sets, chaincode events) + explainable AI fraud engine (`fraud.go`, ML-pluggable): 11 weighted signals, BLOCK ≥70 / REVIEW ≥40, re-screened at approve. `go test ./...` green. Run: `cd drunix-gateway && go run ./cmd/gateway` (:21100). Real network: `go build -tags real`
- Settlement: UPI Collect escrow → payment CONFIRMED (bank UTR) → Drunix token transfer → escrow RELEASED — atomic DvP (`drunixTransferId` on every payment)
- Persistence: production state in Postgres / GitHub-backed real DB (`frontend/api/lib/db_real.js`), shared across serverless instances
- Identity & org schema (Neon): `user, account, session, organization, member, invitation, verification, jwt, project_config` — implemented in code (`frontend/api/lib/authstore.js`, Postgres + in-memory dual mode) with tables live in Neon; full lifecycle APIs: login→session→logout, JWKS (Ed25519), OTP-style verification, org→invite→accept→members
- UPI rail: NPCI UPI Collect simulation with RRN/UTR, idempotency, webhooks + UTR reconciliation — real via Setu/ICICI by flipping `NPCI_MODE=real` (`payment-gateway/real_npcibank.go`)
- **PayU test-mode UPI** ("feels like real UPI"): real PSP round-trip on `https://test.payu.in/_payment` — SHA-512 request signing, reverse-hash callback verification, `mihpayid`/`bank_ref_num` references, `verify_payment` reconciliation; settlement stays simulated (test VPAs `test@payu` succeeds, `fail@payu` declines — no NPCI, no real money). Enable: `NPCI_MODE=payu` + `PAYU_MERCHANT_KEY` + `PAYU_SALT` (free test keys from PayU Dashboard → Test Mode, no KYC). Go: `payment-gateway/real_payubank.go` (6 tests), JS mirror in both servers + `PayUCheckout.jsx` auto-submit flow

### Ownership & Data Integrity (recent hardening)

- **One deed, one tokenization** — duplicate registration (same document hash, or same title+city+pincode) returns `409 ERR_DUPLICATE_PROPERTY` at API *and* chaincode layers
- **Owner-only listing** — properties can only be listed by the **Property Owner (Originator)** role; tokens mint 100% to the lister by design, so an Investor can never end up "owning" a property it merely created. Investors buy tokens *from* the owner
- **Real token availability** — `GET /api/properties/:id` returns `availableTokens` / `soldTokens`; the buy UI caps purchases at actual availability (Max preset, "Only N left"), and the server re-checks balance on transfer (`ERR_INSUFFICIENT_BALANCE`)
- **Fraud-gated collect** — every UPI collect is risk-screened before approval; velocity burst (≥8 txns/10 min) → `403 FAILED_FRAUD_BLOCKED`; blocked attempts never feed velocity counters

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
- **Scarce by design** — you can only buy tokens that actually exist; sold-out supply is visible, never oversold
- **No duplicate deeds** — the same property document can never be tokenized twice

### How It Works — 4 Roles

1. **Owner** lists property with documents → hash anchored → **all tokens mint to the owner** (listing is gated to this role)
2. **Registrar** validates title → approves
3. **You** browse → see live availability → pay via UPI → own tokens instantly
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
- **Payments:** UPI Collect primary (INR) — mock rail by default, PayU test-mode PSP option, Sepolia escrow secondary experimental
- **Identity data:** Neon Postgres schema — user/account/session/organization/member/invitation/verification/jwt/project_config

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
- `/api/auth/login` POST — JWT + MSP (+ session row in Neon schema)
- `/api/auth/session` GET · `/api/auth/logout` POST — session lookup / revoke
- `/api/auth/jwks` GET — Ed25519 signing keys (JWKS, RFC 7517)
- `/api/auth/verification` POST + `/verify` — OTP-style verification (value never returned to client)
- `/api/orgs` POST/GET · `/api/orgs/:id/members` GET · `/api/orgs/:id/invitations` POST/GET · `/api/invitations/accept` POST — organizations
- `/api/auth/schema` GET — traceability: schema entities ↔ code
- `/api/npci/collect` POST — Initiate UPI Collect (fraud-screened: BLOCK ≥70 → 403; returns `payuCheckout` form when PayU rail active)
- `/api/npci/payu/callback` POST — PayU surl/furl (reverse-hash verified, amount-reconciled, idempotent)
- `/api/npci/payments/:id/approve` POST — Approve → CONFIRMED (re-screened)
- `/api/npci/payments/:id/release` POST — Release → RELEASED + UTR
- `/api/npci/payments/:id/refund` POST — Refund → REFUNDED
- `/api/npci/payments` GET — List with RRN/UTR
- `/api/transfers` POST — TransferTokens (availability-checked)
- `/api/properties` POST — Register (409 `ERR_DUPLICATE_PROPERTY` on repeat)
- `/api/properties/:id` GET — detail incl. `availableTokens` / `soldTokens`
- `/api/balances/wallet/:ownerId` GET — Portfolio (fixed v2.1 wallet 500)
- `/api/transfers/history?bookmark` GET — Pagination bookmark pattern
- `/api/drunix/ledger` GET — Drunix settlement trail (7 stages, PROPOSED→COMMITTED)
- `/api/fraud/config` GET · `/api/openfinance/capabilities` GET — fraud engine + Open Finance exposure
- `/api/health` GET — v2.6: mode, `drunixGateway` (golang), `fraudEngine`

**LIVE vs MOCKED (Track A6):**
- LIVE: Chaincode 9 funcs + duplicate-deed guard, JWT+MSP+session rows (Neon), Raft 3, SQL 4 indexes, payment-gateway, atomic DvP, fraud gates, 216+ tests + 8 payment tests
- MOCKED (pluggable): KYC DigiLocker stub, DILRMP hash, NPCI UPI simulation (no live credentials), Sepolia secondary experimental

**Regulatory — Bill 2026:**
- Asset Tokenisation (Regulation) Bill 2026 — pending Private Member's Bill, not law — proposes KYC/AML, registered custodian, registrar validation, regulator freeze
- AasthiChain addresses: RegistrarMSP validates + KYC mock, Regulator freeze, cap table auditable, payment KYC gate `FAILED_KYC_NOT_VERIFIED→REFUNDED`

**Track A:**
- A1 Live/Mock toggle FABRIC_MODE, A2 auto SHA-256 hash, A3 pagination bookmark, A4 idempotency file-backed, A5 chaos_test.sh Raft, A6 demo script + honest scoping, A7 failure-mode demo 4 chaincode + 6 payments = 10 total

**Testing:**
```bash
cd chaincode && go test -v
cd drunix-gateway && go test ./...
cd payment-gateway && go test -v && node gateway.test.js   # incl. 6 PayU tests — suite green
cd frontend && npm run build
```

**Try the PayU test UPI locally:**
```bash
cp .env.payu.example .env.payu   # then paste your Test key/salt from PayU Dashboard (Test Mode → Key Salt)
set -a && source .env.payu && set +a
node mock-api-server.js          # collect returns payuCheckout → auto-submits to https://test.payu.in/_payment
# set PUBLIC_BASE_URL (or PAYU_SURL/PAYU_FURL) so PayU can reach the callback on deployed URLs
```

**Verified against the real PayU test gateway:** signed forms from our collect endpoint are accepted by
`test.payu.in/_payment` (302 into a payment session / checkout page) with Test key+salt; tampered amounts and
garbage hashes are rejected by PayU server-side. Client ID/Secret from the dashboard are for the Payment Links
API & Split Payments — not required for this merchant-hosted UPI Collect flow. `.env.payu` is gitignored — never commit credentials.

</details>

### Production Roadmap (Not Built — Roadmap Only)

Secondary market order-matching, custodian org (demat), DILRMP integration, DigiLocker KYC, real UPI AutoCollect (ICICI/Yes Bank), channel-per-asset-class, SPV legal wrapper (token = beneficial interest in SPV per Registration Act 1908 + Bill 2026), rental income via UPI

### SPV Note

Real platforms use SPV per property — tokens = beneficial interest in SPV that holds legal title. Not built for hackathon — documented as Phase-2 legal structure.

---
