# AasthiChain Payment Gateway — Go Implementation

Stay close with Golang — production-ready implementation of UPI Webhook + UTR reconciliation, DigiLocker KYC, Property Data, Persistent DB.

## Architecture — Go Modules

```
payment-gateway/
├── gateway.go              — Core UPI Collect: PENDING→CONFIRMED→RELEASED, idempotency, KYC, balance checks
├── webhook.go              — NEW: Webhook + UTR reconciliation (Phase 1)
├── digilocker.go           — NEW: DigiLocker KYC (Phase 2)
├── property_data.go        — NEW: Property data verification Bhoomi/Dharani (Phase 3)
├── db.go                   — NEW: Persistent DB abstraction file-backed/Postgres (Phase 4)
├── server.go               — NEW: Go HTTP server integrating all modules
├── real_npcibank.go        — Real NPCI via Setu/ICICI/Decentro
├── gateway_test.go         — Existing tests
├── webhook_test.go         — NEW: UTR12, webhook signature, idempotency, reconciliation
├── digilocker_test.go      — NEW: DigiLocker OAuth flow
├── property_data_test.go   — NEW: Property verification
├── db_test.go              — NEW: FileStore, Postgres abstraction
└── go.mod
```

## Phase 1: UPI Webhook + UTR Reconciliation (Go)

### UTR Generation
```go
func GenerateUTR12() string // 12-digit numeric realistic IMPS UTR
func GenerateUTRRealistic() UTRBundle // {RRN, UTR12, UTRImps, UTR}
```

- Real bank assigns UTR on CONFIRMED, not at collect time
- 12-digit numeric starting with 4 for IMPS realism
- Legacy IMPS+RRN for backward compatibility

### Webhook Signature Verification
```go
func VerifyWebhookSignature(rawBody []byte, signature, secret, provider string) bool
// Setu: HMAC SHA256, header X-Setu-Signature
// ICICI: X-ICICI-Signature
// Mock mode allows without secret
```

### Webhook Handler
```go
type GatewayWithWebhook struct {
    *Gateway
    utrIndex    map[string]string // UTR -> PaymentID O(1)
    webhooks    []WebhookEvent
    webhookIdem map[string]*Payment
}

func (g *GatewayWithWebhook) ProcessWebhook(payload WebhookPayload, rawBody []byte, signature, secret string) (*Payment, error)
// - Validates payment exists
// - Checks idempotency: paymentId~status~utr
// - Verifies signature if secret set
// - Amount reconciliation: mismatch → FAILED_AMOUNT_MISMATCH, no auto-release
// - Updates UTR, RRN, utrIndex
// - Maps provider status to our status
// - Allows only forward transitions
// - Audit log

func (g *GatewayWithWebhook) GetPaymentByUTR(utr string) (*Payment, error) // O(1) via index
func (g *GatewayWithWebhook) GetReconciliationReport() ReconciliationReport
func (g *GatewayWithWebhook) ListWebhooks(limit int) []WebhookEvent
func (g *GatewayWithWebhook) SimulateWebhook(paymentID, scenario string) (*Payment, WebhookPayload, error)
```

### Reconciliation Dashboard
```go
type ReconciliationReport struct {
    Summary struct {
        TotalPayments, SuccessCount, PendingCount, FailedCount
        TotalVolumeINR, SuccessRate, UTRCoverage
        WebhookCount, UTRIndexCount
    }
    Issues struct {
        PendingWithoutUTR, AmountMismatches, PendingTooLong, FailedProvider []PaymentSummary
    }
    RecentWebhooks []WebhookEvent
    UTRIndexSample []UTRSample
}
```

### Endpoints (Go server.go)
- POST /api/npci/webhook — production webhook
- GET /api/npci/utr/:utr — UTR lookup
- GET /api/npci/reconcile — Regulator dashboard
- POST /api/npci/webhook/test — test webhook
- GET /api/npci/webhooks — audit log

## Phase 2: DigiLocker KYC (Go)

```go
type DigiLockerProvider struct {
    sessions map[state]*Session
    kyc map[identityId]KYCStatus
    records map[identityId]*Session
    mode DigiLockerMode // mock or real
}

func NewDigiLockerProvider(mode, clientID, redirectURI) *DigiLockerProvider
func (d *DigiLockerProvider) Init(identityID) (*Session, error) // returns authUrl, state
func (d *DigiLockerProvider) Callback(identityID, code, state) (*Session, error) // exchange code for token, mock Aadhaar/PAN
func (d *DigiLockerProvider) PullDocument(identityID, docType) (*Document, error)
func (d *DigiLockerProvider) GetKYCStatus(identityID) (KYCStatus, error) // implements KYCProvider interface
```

Real flow: OAuth 2.0 → DigiLocker login → consent → callback with code → exchange for access_token → pull document
Mock for hackathon, real toggle via DIGILOCKER_CLIENT_ID, DIGILOCKER_MODE=real

## Phase 3: Property Data Verification (Go)

```go
type PropertyDataProvider struct {
    verifications map[assetId]*Verification
    mode PropertyDataMode
    apiKeys map[Source]string
}

func NewPropertyDataProvider(mode, apiKeys) *PropertyDataProvider
func (p *PropertyDataProvider) Verify(assetID, ourValuation, originatorID, state, city, pincode, source) (*Verification, error)
// Mock government record: surveyNumber, ownerName, gov valuation 90-110%, encumbrance 10% chance, matchScore 85-100%
// Real: POST https://bhoomi.karnataka.gov.in/api/landrecords with API key
```

Sources: Bhoomi Karnataka, Dharani Telangana, Mahabhulekh Maharashtra, via Setu AA

## Phase 4: Persistent Production Database (Go)

```go
type Store interface {
    Get(key) ([]byte, error)
    Set(key, value []byte) error
    Delete(key) error
    All() (map[string][]byte, error)
}

type FileStore struct // in-memory for Go, file-backed in JS
type PostgresStore struct // production with pg

type DB struct {
    Mode DBMode // file-backed or postgres
    Properties, Balances, Transfers, KYC, Idempotency, NPCIPayments, UTRIndex, Webhooks Store
}

func GetDB() (*DB, error) // singleton, auto detects DATABASE_URL
func (db *DB) Init() error // creates tables if postgres
func (db *DB) Stats() (map[string]int, error)
func SaveJSON(store, key, v) error
func LoadJSON(store, key, v) error
```

Tables: properties, balances, transfers, kyc, idempotency, npci_payments, npci_balances, utr_index, webhooks
Indexes: idx_properties_status, idx_transfers_asset, idx_npcipayments_status, idx_npcipayments_utr

Toggle: Set DATABASE_URL env (Neon/Supabase/RDS) → auto switches to Postgres, no code change

## Go Server — Production Ready

```go
// server.go
type Server struct {
    Gateway *GatewayWithWebhook
    DigiLocker *DigiLockerProvider
    PropertyData *PropertyDataProvider
    DB *DB
}

func NewServer() (*Server, error) // init DB, DigiLocker, PropertyData, Gateway
func (s *Server) Router() http.Handler // all endpoints with CORS

// Run:
// go run ./payment-gateway -port 8080
// Env: DATABASE_URL, NPCI_MODE, DIGILOCKER_CLIENT_ID, PROPERTY_DATA_API_KEY, WEBHOOK_SECRET
```

Endpoints:
- Health: /health, /api/health
- NPCI: /api/npci/config, /real-config, /collect, /payments/{id}, /payments/{id}/approve|release|refund|decline|timeout, /callback, /webhook (NEW), /utr/:utr (NEW), /reconcile (NEW), /webhook/test (NEW), /webhooks (NEW)
- DigiLocker: /api/kyc/digilocker/config|init|callback|pull-document (NEW)
- Property: /api/properties/verify/config, /api/properties/{id}/verify (NEW)
- DB: /api/db/config|stats|migrate (NEW)

## Testing

```bash
cd payment-gateway
go test -v
go test -run TestWebhook -v
go test -run TestDigiLocker -v
go test -run TestPropertyData -v
go test -run TestDB -v
```

Tests:
- webhook_test.go: UTR12 12-digit, realistic bundle, signature verification, payload parsing, success, amount mismatch, idempotency, reconciliation report, JSON
- digilocker_test.go: Init, Callback, PullDocument, KYCProvider interface, real mode
- property_data_test.go: Verify, encumbrance, get, list, real mode
- db_test.go: FileStore basic, DB file-backed, SaveLoadJSON, stats, singleton

## Why Go?

- Type safety for UTR, webhook, reconciliation
- Concurrency with sync.RWMutex for utrIndex, webhooks
- Real HMAC SHA256 signature verification
- Postgres with pg driver, connection pooling
- Same interface as JS mock — easy toggle mock/real
- Production-ready: handles idempotency, amount mismatch, forward transitions, audit log

## Integration with JS Frontend

- JS frontend/api/index.js already has webhook + UTR + DigiLocker + Property Data + DB endpoints
- Go server.go provides same endpoints with Go implementation
- For Vercel: JS version deployed (serverless)
- For production Go server: deploy server.go to Cloud Run/Fly.io with DATABASE_URL
- Both share same API contract — frontend works with either

## Env Vars

```
DATABASE_URL=postgres://user:pass@host:5432/dbname?sslmode=require
NPCI_MODE=mock|real
WEBHOOK_SECRET=your-webhook-secret (for Setu/ICICI signature verification)
SETU_API_KEY=xxx
SETU_WEBHOOK_SECRET=yyy
DIGILOCKER_MODE=mock|real
DIGILOCKER_CLIENT_ID=xxx
DIGILOCKER_CLIENT_SECRET=yyy
PROPERTY_DATA_MODE=mock|real
BHOOMI_API_KEY=xxx
```

## Non-Breaking

- All existing gateway.go functionality retained
- New files additive: webhook.go, digilocker.go, property_data.go, db.go, server.go
- GatewayWithWebhook embeds *Gateway — all old methods still work
- Tests pass for both old and new
