# API Gateway — AasthiChain

Go + Gin + Mock Fabric Client (pluggable to real Fabric Gateway SDK)

## Features
- JWT auth (mock login returns token with identityId, mspId, role)
- MSP-based authorization middleware (RequireMSP)
- Rate limiting (100 req/min per identity, in-memory for hackathon, Redis in prod)
- Audit logging (correlation IDs tied to transferId/assetId)
- Idempotency via X-Idempotency-Key header (prevents double mint on retries)
- Input validation at gateway + chaincode boundary (never trust gateway alone)
- KYC check at gateway (defense in depth, chaincode also checks)
- Mock payment confirmation (off-chain settlement per spec non-goals)

## Endpoints
- POST /api/auth/login — returns JWT
- POST /api/properties — RegisterProperty (Originator)
- GET /api/properties — List (status filter uses idx_property_status)
- GET /api/properties/:id — GetPropertyDetails
- POST /api/properties/:id/validate — ValidateProperty (Registrar)
- POST /api/properties/:id/mint — MintPropertyTokens (Originator, dual endorsement)
- POST /api/properties/:id/freeze — FreezeAsset (Regulator)
- POST /api/transfers — TransferTokens (Investor)
- GET /api/balances/:assetId/:ownerId — GetBalance
- GET /api/balances/wallet/:ownerId — GetWallet (idx_balance_owner)
- GET /api/transfers/history — GetTransferHistory (idx_transfer_asset_time)
- PUT /api/kyc/:identityId — UpdateKYCStatus (Registrar)
- GET /api/kyc/:identityId — GetKYCStatus
- POST /api/payments/confirm — Mock payment settlement

## Running
```bash
go mod tidy
go run main.go
# :8080
```

## Production TODO
- Replace MockFabricClient with real fabric-gateway client:
  ```go
  import "github.com/hyperledger/fabric-gateway/pkg/client"
  // Use gateway.NewGateway with HSM-backed signer
  ```
- HSM for private keys, not plaintext
- Redis rate limiter
- Structured logging to ELK
- Prometheus metrics for block commit latency, endorsement failures
