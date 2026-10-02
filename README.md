# AasthiChain

## Own a fraction of real estate, starting from ₹500

AasthiChain is made for fractional property ownership. Explore tokenized properties, simulate a UPI purchase, and track your ownership and transactions in a portfolio.

**Live app:** [aasthi-chain.vercel.app](https://aasthi-chain.vercel.app)

---

## Try it in under two minutes

1. Open the [live app](https://aasthi-chain.vercel.app).
2. Select **Try Investor Demo** on the landing page.
3. Open a property from **Explore Properties**.
4. Choose a token amount and continue through the **UPI Simulation**.
5. Open **My Portfolio** to see the simulated ownership record.

No signup, email verification, or real bank account is required for the demo presets.

### Demo roles

| Role | What it demonstrates | Preset |
|---|---|---|
| Investor | Explore properties, simulate a purchase, view a portfolio | `investor1` |
| Property Owner | Register and manage a property | `originator1` |
| Registrar | Review and approve property verification | `registrar1` |
| Regulator | Inspect activity and exercise controls | `regulator1` |

The roles use the existing application flows and mock identities. They do not represent production credentials.

---

## How AasthiChain works

### 1. A property is registered

A property owner submits property information and a document hash.

### 2. The property is reviewed

The Registrar role can review and approve the property before tokens are created.

### 3. The property becomes fractional

An approved property is represented by a fixed number of digital tokens. In the demo, the token price is commonly ₹500, depending on the property's valuation and supply.

### 4. An investor simulates a purchase

The buyer selects tokens, reviews the amount, and uses the simulated UPI approval flow.

### 5. Ownership is recorded

The payment and token-transfer state are recorded together in the demo ledger. The investor can then see the position in **My Portfolio**.

---

## What you can explore

### Marketplace

Browse properties and see:

- Location
- Property value
- Token price
- Total supply
- Available tokens
- Current phase and status

### Property detail

Review the property's value, token supply, available balance, fractional-ownership explanation, purchase flow, and transaction actions.

### Portfolio

View:

- Total portfolio value
- Properties held
- Tokens owned
- Position values
- Token transfers
- Yield and lending demo features where available

### Ledger Explorer

Open the ledger view to inspect simulated transaction blocks, transaction states, and audit information.

### Settlement transparency

The `/settlement` page explains, in plain language, how money and ownership move together —
and exactly where the simulation ends. It is driven entirely by live API responses, so it
cannot drift from the code:

- What the settlement rail claims about itself (`GET /api/umi/capabilities`)
- A conformance self-test that runs on every request (`GET /api/umi/conformance`)
- A one-click delivery-versus-payment you can watch: reserve, settle, replay-blocked

AasthiChain simulates the settlement pattern published for SEBI's **Demat 2.0** pilot, which
settles through the RBI's **Unified Market Interface**. It is **not connected to** RBI, SEBI,
NPCI, NSDL or CDSL, and every response carries `simulated: true` and `centralBankMoney: false`.

See `docs/UMI_PATTERN_CONFORMANCE.md` for the full checklist and
`docs/UMI_ALIGNMENT_PLAN.md` for how the project intends to contribute to the ecosystem.

### A note on the ₹500 figure

₹500 demonstrates how finely a property can be divided on a ledger. It is not a lawful retail
minimum. Real fractional real-estate investment in India is regulated under the SEBI **SM REIT**
framework, where the current minimum is **₹10 lakh** per investor.

### RFQ secondary-market demo

The `/rfq` page contains the additive RFQ module. RFQs are available when an asset is explicitly placed in `PHASE_2_RFQ`.

---

## Payment and identity honesty

The default payment flow is a **UPI simulation**. It creates payment identifiers and follows the intended state flow:

```text
PENDING → CONFIRMED → RELEASED
                    ↘ REFUNDED
```

The default flow does not connect to NPCI and does not move money. PayU test mode is also a test integration; it should not be confused with live settlement.

Identity, KYC, land-record verification, and depository integrations are represented by mock components unless separately configured with production infrastructure.

The Support page is separate from the product flow. Support links are donations and are not investments.

---

## Technology, for technical readers

AasthiChain keeps the user experience simple while demonstrating a permissioned-ledger architecture:

```text
Investor / Owner / Registrar / Regulator
                    |
             React frontend
                    |
        Vercel mock API or Go API
                    |
       Drunix / Hyperledger-style ledger
                    |
       Property, token, KYC and payment state
```

The repository contains:

- React and Vite frontend
- Vercel serverless mock API
- Go API gateway
- Go property, token, KYC and settlement chaincode
- Drunix-style Lite Peer and Committing Peer simulation
- UPI and PayU payment-gateway simulations
- Fabric-oriented network configuration
- Admin and regulator workflows

### Permissioned participants

- **Property Owner:** lists a property and receives the initial token supply.
- **Registrar:** validates property information.
- **Investor:** purchases or receives tokens.
- **Regulator:** reviews activity and can apply controls.
- **Depository and Trustee:** additive integration points for register, reconciliation, and SPV-level approvals.

### Technical features implemented

- Property registration and validation
- Token minting and balances
- Transfers with balance checks
- Duplicate deed protection
- Payment and token settlement records
- Idempotency and webhook handling
- Hash-chained ledger
- MVCC-style transaction checks in the Drunix simulation
- SPV and beneficial-interest certificate data structures
- Optional DepositoryMSP endorsement
- Phased rollout controls
- RFQ chaincode and mock API primitives
- Yield scheduling and paise-safe allocation utilities
- Trustee-gated redemption primitives

---

## Repository layout

```text
chaincode/          Go property, token and KYC chaincode
api-gateway/        Go API gateway and Fabric client abstraction
drunix-gateway/     Drunix transaction lifecycle simulation
payment-gateway/    UPI, PayU and settlement-gateway code
frontend/           React + Vite application
network/            Permissioned-network configuration and scripts
contracts/          Experimental payment escrow contract
data/               Local data
```

---

## Run locally

### Frontend only

```bash
cd frontend
npm install
npm run dev
```

Open [http://localhost:5173](http://localhost:5173).

### Go components

Each Go component has its own module:

```bash
cd chaincode && go test ./...
cd ../drunix-gateway && go test ./...
cd ../payment-gateway && go test ./...
cd ../api-gateway && go test ./...
```

### Optional network setup

The network configuration and scripts are under `network/`. A local Docker environment is required for the optional network path.

---

## Test and build commands

```bash
# Chaincode
cd chaincode && go test ./...

# Drunix gateway
cd drunix-gateway && go test ./...

# Payment gateway
cd payment-gateway && go test ./...
node gateway.test.js

# Frontend
cd frontend && npm ci && npm run build
```

The CI workflow should run each Go module from its own directory rather than using a root `go test ./...` command, because the repository contains separate Go modules.

---

## Current status

| Area | Status |
|---|---|
| Property and token flows | Implemented in demo paths |
| UPI payment | Simulated by default |
| PayU | Test-mode integration, simulated settlement |
| Drunix/Fabric network | Architecture and simulation included |
| Production depository connection | Roadmap |
| Production KYC and DILRMP | Roadmap / mock integration |
| Wholesale CBDC / UMI connection | Mock abstraction only |
| Securities offering or investment advice | Not provided |

AasthiChain is a technical product demonstration. Consult a qualified lawyer and regulated financial professionals before designing or operating any real offering.
