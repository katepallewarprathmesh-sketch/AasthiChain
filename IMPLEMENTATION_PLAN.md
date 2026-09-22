# AasthiChain Implementation Plan — Step by Step (No Break)

## Current State (v2.2-npci-real-path + improvements)
- Mock Fabric: globalThis + file-backed /tmp/aasthi_*.json persistence
- NPCI: simulation with PENDING→CONFIRMED→RELEASED, RRN 12-digit 418..., UTR IMPS+RRN, idempotency, failure modes
- Real path documented: Setu/ICICI/Decentro via real_npcibank.go, /api/npci/real-config
- Frontend: Admin queue, Wallet human-friendly errors, Marketplace filters, etc.
- Build 416KB

## Phase 1: UPI Provider Integration — Webhook + UTR Reconciliation (THIS PHASE)
Goal: Production-ready webhook handling and UTR reconciliation, same interface works for mock and real provider.

### 1.1 UTR Generation & Storage
- Current genUTR(rrn) = IMPS+RRN+4digit — works but not realistic 12-digit
- Add genUTR12() = 12-digit numeric (real IMPS UTR format) + keep genUTR for legacy
- Add utrIndex: Map UTR → paymentId for O(1) lookup (persisted via file)
- On approve/CONFIRMED: generate UTR if missing, store in utrIndex, persist

### 1.2 Webhook Signature Verification
- Setu: HMAC SHA256 of raw body with WEBHOOK_SECRET, header X-Setu-Signature
- ICICI: Similar HMAC, header X-ICICI-Signature
- Add verifyWebhookSignature(payload, signature, secret, provider) — returns bool, logs in dev
- Mock mode: signature optional, but structure ready for real

### 1.3 Webhook Handler — POST /api/npci/webhook
**New endpoint, does not break existing /api/npci/callback**
- Input: { paymentId, upiTxnId, rrn, utr, status, amount, provider, signature, timestamp, rawCallback }
- Steps:
  1. Parse body, validate paymentId exists
  2. Check idempotency: npciIdem[webhookId] or payment already in target status → return 200 idempotent
  3. Verify signature if NPCI_MODE=real and WEBHOOK_SECRET set
  4. Validate amount matches (reconciliation check) — if mismatch, mark FAILED_AMOUNT_MISMATCH, do NOT auto-release
  5. Update payment: utr, rrn, status, webhookReceivedAt, callbackData, provider
  6. Update utrIndex
  7. If status CONFIRMED/SUCCESS and amount matches → trigger internal transfer if not already (call transfer logic or mark ready for frontend to release)
  8. Persist via saveAllPersisted()
  9. Return 200 { received: true, paymentId, status, utr }

- Idempotency: webhookId = paymentId + status + utr

### 1.4 UTR Lookup — GET /api/npci/utr/:utr
- Lookup payment by UTR via utrIndex
- Returns payment + reconciliation info: amount matched, timestamp, provider
- Used for support, audit, bank statement reconciliation

### 1.5 Reconciliation Dashboard — GET /api/npci/reconcile
- Returns:
  - pendingWithoutUTR: payments CONFIRMED but no UTR (should not happen)
  - amountMismatches: payments where webhook amount != collect amount
  - pendingTooLong: PENDING > 5 min
  - successRate, totalVolume, etc.
- For Regulator/Admin view

### 1.6 Webhook Test — POST /api/npci/webhook/test
- For local testing: simulates Setu webhook call to our own /api/npci/webhook
- Input: paymentId, scenario: success, amount_mismatch, duplicate
- Generates realistic payload with UTR, signature

### 1.7 Update Existing Flows
- collect: already generates UTR, but add utrIndex entry, set utr null initially until CONFIRMED (more realistic)
- approve: generate UTR12 on CONFIRMED if missing, add to utrIndex, set callbackReceived
- Add npciWebhooks audit log array persisted

### 1.8 Frontend Updates (non-breaking)
- NPCIPayment.jsx: Show UTR after CONFIRMED, add "View UTR" link, show webhook status
- Wallet.jsx: Show UTR in payment history
- New component: UTRReconciliation.jsx for Regulator/Admin

### Non-breaking Guarantee
- All existing endpoints keep same request/response shape
- New endpoints additive only
- globalThis fallback retained
- file-backed persistence extended, not replaced
- Frontend changes optional, hidden behind feature flag

## Phase 2: DigiLocker KYC
- DigiLocker OAuth: /api/kyc/digilocker/init, /callback, /pull-document
- Mock provider for hackathon, real toggle via DIGILOCKER_CLIENT_ID
- KYC record stores digilocker doc, verified via OTP
- Frontend: KYC page with DigiLocker button

## Phase 3: Property-Data Integrations
- Bhoomi / Dharani / e-Property integration (mock + real toggle)
- /api/properties/verify/:assetId — checks external registry, valuation, encumbrance
- Adds propertyData field: governmentRecord, valuationSource, encumbranceCheck

## Phase 4: Persistent Production Database
- db.js abstraction: getDB() returns { properties, balances, transfers, kyc, npciPayments, npciIdem, npciBalances, utrIndex, webhooks }
- If DATABASE_URL set: use Postgres via pg (or Neon/Supabase), else file-backed + globalThis
- Repository pattern: propertyRepo, balanceRepo, etc.
- Migration script: init.sql with tables matching current docType
- Keep globalThis for fallback, but primary is DB
- No break: existing code calls getDB() which handles fallback

## Implementation Order
1. Phase 1 now — webhook + UTR
2. Test Phase 1 locally + Vercel
3. Phase 2 — DigiLocker
4. Phase 3 — Property-data
5. Phase 4 — Persistent DB (most invasive, last to avoid breaking early phases)

## Success Criteria Phase 1
- POST /api/npci/webhook accepts Setu-format payload, verifies signature (mock), updates payment with UTR, returns 200
- GET /api/npci/utr/:utr returns payment
- GET /api/npci/reconcile returns pendingWithoutUTR, mismatches, etc.
- Existing flow still works: collect → approve → release → transfer
- New flow: collect → (webhook from provider) → CONFIRMED with UTR → release → transfer
- UTR is 12-digit numeric for real mode, IMPS+RRN for mock (both supported)
- Idempotency: duplicate webhook returns same result, no double credit
- Amount mismatch detection: webhook amount != collect amount → mark FAILED_AMOUNT_MISMATCH, require manual review
- Audit log: all webhooks stored
