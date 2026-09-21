# payment-gateway — NPCI-style UPI/IMPS Settlement Rail (Simulation)

**Status: SIMULATION — Not live NPCI integration. Sandbox credentials not available for hackathon. Modeled on NPCI UPI Collect + IMPS UTR pattern.**

This module replaces the primary payment leg for AasthiChain's atomic DvP (Delivery vs Payment). The Drunix/Fabric tokenization engine is untouched — only the payment rail changes from Sepolia testnet ETH (now secondary) to INR-based UPI-style flow.

## Why UPI Collect (P2M Collect) + IMPS?

- **Real estate payment pattern:** Seller (Originator) requests payment, buyer (Investor) approves via UPI app — matches UPI Collect flow, not UPI Intent (buyer-initiated). Buyer gets collect notification: `originator@aasthichain requests ₹2,50,000 for Green Valley Villas`.
- **NPCI rail:** UPI Collect → IMPS settlement. Money moves via IMPS with UTR (Unique Transaction Reference, 12-digit numeric + check). NPCI switch generates RRN (Retrieval Reference Number, 12-digit) + UPI Txn ID (35-char alphanumeric) for reconciliation.
- **No live credentials:** NPCI does not offer public UPI sandbox (PPRO docs: "Sandbox Not Available from UPI"). No Drunix Hackathon-published NPCI sandbox found (searched). So we hand-rolled deterministic simulator inspired by `upi-mock-engine` (Haskell deterministic UPI switch simulator) — clearly labeled as internal simulation.

## Flow

```
1. Collect Request Initiated (PENDING)
   POST /api/npci/collect
   { assetId, tokenAmount, payerVpa: "investor@aasthichain", payeeVpa: "originator@aasthichain", amountINR, note, idempotencyKey }
   → Generates: upiTxnId (AAST20260921...), rrn (418...), utr (IMPS ref), status=PENDING, expiresAt=now+5min
   → NPCI-style: payee PSP → NPCI → payer PSP → payer app notification

2. Payer Approves via UPI App (PENDING → CONFIRMED)
   POST /api/npci/payments/{id}/approve
   Checks: KYC (DigiLocker mock), balance (mock), VPA validity
   → If ok: status=CONFIRMED, callback to merchant (webhook simulation)
   → If insufficient funds: FAILED_INSUFFICIENT_FUNDS → REFUNDED
   → If KYC unverified: FAILED_KYC → REFUNDED
   → If timeout: EXPIRED → REFUNDED

3. Drunix Token Transfer (Atomic DvP)
   On CONFIRMED, backend calls TransferTokens chaincode:
   transferId = TXN-...
   If success: link drunixTransferId to payment

4. Settlement Released (CONFIRMED → RELEASED)
   POST /api/npci/payments/{id}/release
   IMPS settlement: UTR credited to payee, status=RELEASED
   If Drunix fails: REFUNDED (atomic — money not moved without tokens)

Failure paths preserved per Track A7 pattern.
```

## ID Formats (Mirroring NPCI)

- **VPA:** `investor@aasthichain`, `originator@aasthichain` — handle@psp pattern, validated via regex `^[a-z0-9._-]{2,64}@[a-z]{3,64}$`
- **UPI Txn ID:** `AAST` + `YYYYMMDD` + `8-char random` + checksum, e.g., `AAST20260921X7K9P2Q1` — 35-char max, alphanumeric, NPCI spec
- **RRN:** 12-digit numeric, first 3 digits 418 (NPCI test range), e.g., `418209123456` — Retrieval Reference Number
- **UTR / IMPS Ref:** 16-digit: `IMPS` + 12-digit RRN + 4-digit time-based suffix, or 12-digit numeric for UPI, e.g., `IMPS418209123456`
- **PaymentId:** `NPCI-` + 12-char upper alphanumeric, e.g., `NPCI-7F3A9B2C1D4E`

## Money Leg: INR

- All amounts in paise internally (int64) to avoid float, displayed in ₹
- Example: ₹75L property, 15,000 tokens → ₹500/token → 500 tokens = ₹2,50,000
- No testnet ETH in primary flow — that is now secondary experimental toggle.

## LIVE vs MOCKED (Track A6 extended)

- **LIVE:** Chaincode 9 functions, API gateway JWT+MSP+rate limit+idempotency, React 4 roles, Raft 3-node, Postgres SQL 4 indexes, Drunix token transfer
- **MOCKED (pluggable):** KYC (DigiLocker stub), land registry (DILRMP stub), **NPCI payment rail (this module) — simulation, not live NPCI integration, sandbox credentials not available**, Sepolia escrow now secondary experimental
- Honest: UI shows "SIMULATION — No live NPCI" badge, no fabricated NPCI success.

## Tests

- `go test ./...` in this module: 4 required + extras:
  - successful payment→transfer
  - payment timeout→refund
  - duplicate payment idempotency
  - KYC-gate rejection
  - insufficient funds, invalid VPA, self-transfer VPA, zero amount

## Production Path

Replace mock `ApprovePayment` with real PSP adapter:
- Call NPCI UPI AutoCollect API or bank's UPI Collect API (ICICI, Yes Bank)
- Webhook: NPCI → your callback URL → confirm Drunix transfer → release
- Money: UPI → IMPS settlement, UTR from bank, reconciled via RRN

This module is designed to be drop-in: same state machine PENDING→CONFIRMED→RELEASED/REFUNDED, same idempotency, same TransferTokens call.
