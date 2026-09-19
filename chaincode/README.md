# Chaincode — AasthiChain

Implements spec §5 API with full §6 edge cases.

## Contracts
- PropertyContract: RegisterProperty, ValidateProperty, MintPropertyTokens, GetPropertyDetails, FreezeAsset, GetAllProperties
- TokenContract: TransferTokens, GetBalance, GetTransferHistory, GetWallet
- KYCContract: UpdateKYCStatus, GetKYCStatus, BatchVerify

## Key Design Decisions

### Composite Keys
- `balance~assetId~ownerId` enables efficient range queries per asset and per owner via SQL state store, avoiding full ledger scans.
- `transfer~assetId~timestamp~transferId` for audit trail by asset
- `transferByOwner~ownerId~timestamp~transferId` for wallet history
- `kyc~identityId` for KYC lookups

### Endorsement Enforcement
Chaincode checks MSP at function level (defense in depth), but real enforcement is at network channel config:
- MintPropertyTokens: `AND('OriginatorMSP.peer','RegistrarMSP.peer')`
- TransferTokens: `OR('InvestorMSP.peer')` with regulator as non-endorsing observer
- FreezeAsset: `OR('RegulatorMSP.peer')`

### Edge Cases Implemented
- Duplicate mint: check status != TOKENIZED + existing balance check
- Insufficient balance: explicit ERR_INSUFFICIENT_BALANCE
- Self-transfer: ERR_INVALID_TRANSFER
- KYC unverified: ERR_KYC_NOT_VERIFIED for both sender and receiver
- Zero/negative amount: ERR_INVALID_AMOUNT
- Frozen asset: check status != FROZEN before transfer
- MVCC double-spend: Fabric's read-write set validation rejects second conflicting tx automatically — caller retries
- Integer-only tokens: no decimals, smallest unit = 1 token
- Document hash collision: flagged via hash~docHash~assetId index
- Clock skew: use block timestamp from `ctx.GetStub().GetTxTimestamp()`, not local peer clock
- Idempotency: API gateway uses X-Idempotency-Key cache, chaincode checks duplicate mint

### SQL Indexes (Drunix on-chain SQL)
In production Drunix, these would be actual SQL CREATE INDEX statements on the state DB:
- `idx_balance_owner` on (ownerId) — fast wallet lookups
- `idx_balance_asset` on (assetId) — cap table per property
- `idx_property_status` on (status) — marketplace listing
- `idx_transfer_asset_time` on (assetId, txTimestamp) — regulator audit

### Testing
```bash
go test -v ./...
```
Covers:
- Property registration validation
- Token transfer edge cases (self, insufficient, zero)
- Mint validation (overflow, already tokenized, not validated)
- KYC status transitions
- Composite key creation/parsing
- Serialization

## Production Migration Notes
- Use versioned composite keys with `version` field for schema evolution
- Never mutate historical TransferRecord
- Migration chaincode invoked once per channel during upgrade
