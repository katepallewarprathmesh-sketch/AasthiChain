# AasthiChain — Fractional Real Estate Tokenization on Drunix

**Drunix Hackathon x Citi — Problem Statement 2 (Real Asset Tokenization)**
Version 1.0 | Status: Implementation Ready

AasthiChain tokenizes real estate assets into fractional, tradeable ownership units on a permissioned multi-organization Drunix (Hyperledger Fabric fork) network.

## Quick Start

### Prerequisites
- Go 1.21+
- Node.js 18+
- Docker & Docker Compose
- (For Fabric) Fabric binaries v2.5+

### 1. Start Network (4 Orgs + Raft Orderer + PostgreSQL SQL State)
```bash
cd network
docker-compose up -d
./scripts/create-channel.sh
./scripts/deploy-chaincode.sh
```

### 2. Run API Gateway
```bash
cd api-gateway
go mod tidy
go run main.go
# Listens on :8080
```

### 3. Run Frontend
```bash
cd frontend
npm install
npm run dev
# Listens on :5173
```

### 4. Run Chaincode Unit Tests
```bash
cd chaincode
go test -v ./...
```

## Architecture

See full spec in `docs/SPEC.md`

- **Chaincode (Go):** `property.go`, `token.go`, `kyc.go` with full edge-case handling (§6)
- **API Gateway (Go):** JWT auth, KYC mock, rate limiting, Fabric Gateway SDK client
- **Frontend (React):** Investor wallet, admin mint flow, transfer, regulator audit view
- **Network:** 4 orgs (Originator, Registrar, Investor, Regulator) + Raft 3-node orderer + PostgreSQL SQL state

## Endorsement Policies

- `MintPropertyTokens`: `AND('OriginatorMSP.peer','RegistrarMSP.peer')`
- `TransferTokens`: `InvestorMSP` sender only, regulator as observer
- `FreezeAsset`: `RegulatorMSP` only

## API Contracts

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/properties` | POST | RegisterProperty |
| `/api/properties/:id/validate` | POST | ValidateProperty |
| `/api/properties/:id/mint` | POST | MintPropertyTokens |
| `/api/transfers` | POST | TransferTokens |
| `/api/balances/:assetId/:ownerId` | GET | GetBalance |
| `/api/properties/:id` | GET | GetPropertyDetails |
| `/api/transfers/history` | GET | GetTransferHistory |
| `/api/properties/:id/freeze` | POST | FreezeAsset |
| `/api/kyc/:identityId` | PUT | UpdateKYCStatus |

## Edge Cases Implemented

All edge cases from spec §6 are implemented with explicit error codes:
- `ERR_INSUFFICIENT_BALANCE`, `ERR_INVALID_TRANSFER`, `ERR_KYC_NOT_VERIFIED`, `ERR_INVALID_AMOUNT`, `ERR_UNAUTHORIZED`, `ERR_ASSET_FROZEN`, etc.
- MVCC double-spend protection via Fabric
- Integer-only tokens, idempotency keys, composite key indexes

## Production Readiness Notes

See spec §9. Openly flagged: not a substitute for Registration Act, 1908; KYC/payment mocked; HSM signing required for prod.

## Demo Script

See `docs/DEMO_SCRIPT.md`
