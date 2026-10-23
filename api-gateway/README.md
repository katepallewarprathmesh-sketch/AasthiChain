# API Gateway: AasthiChain

Go + Gin + Mock Fabric Client (pluggable to real Fabric Gateway SDK)

## Authentication, and the flag that decides how much it trusts you

By default this gateway accepts only a token it signed itself at
`POST /api/auth/login`. Three older acceptance paths remain for the demo, an
unverified JWT carrying an `identityId` claim, a base64 blob of JSON, and a
bare `X-Fabric-Identity` header, and every one of them will hand the caller
`RegulatorMSP`, the MSP that can freeze an asset. They are off unless you set:

    API_GATEWAY_DEMO_AUTH=true

Set it for a local demo where the role switcher is the point. Do not set it
anywhere a stranger can reach, and read the refusal message if you are
wondering why a token stopped working.

## Tests

    cd api-gateway && go test ./...

Covers the authentication middleware including both sides of the flag above,
the idempotency store across a simulated restart, and the mock Fabric client
lifecycle with its refusals.

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
- POST /api/auth/login: returns JWT
- POST /api/properties: RegisterProperty (Originator)
- GET /api/properties: List (status filter uses idx_property_status)
- GET /api/properties/:id: GetPropertyDetails
- POST /api/properties/:id/validate: ValidateProperty (Registrar)
- POST /api/properties/:id/mint: MintPropertyTokens (Originator, dual endorsement)
- POST /api/properties/:id/freeze: FreezeAsset (Regulator)
- POST /api/transfers: TransferTokens (Investor)
- GET /api/balances/:assetId/:ownerId: GetBalance
- GET /api/balances/wallet/:ownerId: GetWallet (idx_balance_owner)
- GET /api/transfers/history: GetTransferHistory (idx_transfer_asset_time)
- PUT /api/kyc/:identityId: UpdateKYCStatus (Registrar)
- GET /api/kyc/:identityId: GetKYCStatus
- POST /api/payments/confirm: Mock payment settlement

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
