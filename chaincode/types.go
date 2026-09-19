package main

import "time"

// DocTypes
const (
	DocTypeProperty = "property"
	DocTypeBalance  = "balance"
	DocTypeTransfer = "transfer"
	DocTypeKYC      = "kyc"
)

// Status enums
const (
	// Property validation
	ValidationPending   = "PENDING"
	ValidationValidated = "VALIDATED"
	ValidationRejected  = "REJECTED"

	// Property lifecycle
	PropertyDraft     = "DRAFT"
	PropertyTokenized = "TOKENIZED"
	PropertyFrozen    = "FROZEN"
	PropertyDelisted  = "DELISTED"

	// Transfer
	TransferCompleted = "COMPLETED"
	TransferReversed  = "REVERSED"

	// KYC
	KYCUnverified = "UNVERIFIED"
	KYCPending    = "PENDING"
	KYCVerified   = "VERIFIED"
	KYCRejected   = "REJECTED"
)

// Location
type Location struct {
	State   string `json:"state"`
	City    string `json:"city"`
	Pincode string `json:"pincode"`
}

// PropertyAsset - on-chain state
type PropertyAsset struct {
	AssetID                    string    `json:"assetId"`
	DocType                    string    `json:"docType"`
	OriginatorID               string    `json:"originatorId"`
	Title                      string    `json:"title"`
	Location                   Location  `json:"location"`
	ValuationINR               int64     `json:"valuationINR"`
	TotalTokens                int64     `json:"totalTokens"`
	DocumentHash               string    `json:"documentHash"`
	RegistrarValidationStatus  string    `json:"registrarValidationStatus"`
	Status                     string    `json:"status"`
	CreatedAt                  time.Time `json:"createdAt"`
	UpdatedAt                  time.Time `json:"updatedAt"`
	Version                    int       `json:"version"` // schema version for migration
}

// TokenBalance
type TokenBalance struct {
	DocType       string    `json:"docType"`
	AssetID       string    `json:"assetId"`
	OwnerID       string    `json:"ownerId"`
	Balance       int64     `json:"balance"`
	LockedBalance int64     `json:"lockedBalance"`
	UpdatedAt     time.Time `json:"updatedAt"`
}

// TransferRecord - immutable audit
type TransferRecord struct {
	DocType     string    `json:"docType"`
	TransferID  string    `json:"transferId"`
	AssetID     string    `json:"assetId"`
	FromID      string    `json:"fromId"`
	ToID        string    `json:"toId"`
	Amount      int64     `json:"amount"`
	TxTimestamp time.Time `json:"txTimestamp"`
	Status      string    `json:"status"`
}

// KYCRecord
type KYCRecord struct {
	DocType    string    `json:"docType"`
	IdentityID string    `json:"identityId"`
	KYCStatus  string    `json:"kycStatus"`
	VerifiedAt time.Time `json:"verifiedAt"`
	Provider   string    `json:"provider"`
}

// Business caps
const (
	MaxTotalTokens          = 10_000_000
	MinValuationINR         = 100_000 // 1L minimum for demo sanity
	CompositeBalancePrefix  = "balance"
)
