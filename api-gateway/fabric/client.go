package fabric

import "time"

// Location
type Location struct {
	State   string `json:"state"`
	City    string `json:"city"`
	Pincode string `json:"pincode"`
}

type PropertyAsset struct {
	AssetID                   string    `json:"assetId"`
	DocType                   string    `json:"docType"`
	OriginatorID              string    `json:"originatorId"`
	Title                     string    `json:"title"`
	Location                  Location  `json:"location"`
	ValuationINR              int64     `json:"valuationINR"`
	TotalTokens               int64     `json:"totalTokens"`
	DocumentHash              string    `json:"documentHash"`
	RegistrarValidationStatus string    `json:"registrarValidationStatus"`
	Status                    string    `json:"status"`
	CreatedAt                 time.Time `json:"createdAt"`
	UpdatedAt                 time.Time `json:"updatedAt"`
}

type TokenBalance struct {
	DocType       string    `json:"docType"`
	AssetID       string    `json:"assetId"`
	OwnerID       string    `json:"ownerId"`
	Balance       int64     `json:"balance"`
	LockedBalance int64     `json:"lockedBalance"`
	UpdatedAt     time.Time `json:"updatedAt"`
}

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

type KYCRecord struct {
	DocType    string    `json:"docType"`
	IdentityID string    `json:"identityId"`
	KYCStatus  string    `json:"kycStatus"`
	VerifiedAt time.Time `json:"verifiedAt"`
	Provider   string    `json:"provider"`
}

// Paginated history result
type PaginatedTransfers struct {
	Transfers []TransferRecord `json:"transfers"`
	Bookmark  string           `json:"bookmark"`
	HasMore   bool             `json:"hasMore"`
	Total     int              `json:"total"`
}

// FabricClient interface — both mock and live implement this
// Allows toggling via FABRIC_MODE env var per Track A1
type FabricClient interface {
	RegisterProperty(originatorId, title, state, city, pincode string, valuation int64, docHash string) (string, error)
	ValidateProperty(assetId, decision string) error
	MintPropertyTokens(assetId string, totalTokens int64, callerId string) error
	TransferTokens(assetId, fromId, toId string, amount int64) (string, error)
	GetBalance(assetId, ownerId string) (*TokenBalance, error)
	GetWallet(ownerId string) ([]TokenBalance, error)
	GetProperty(assetId string) (*PropertyAsset, error)
	ListProperties(status string) ([]PropertyAsset, error)
	GetTransferHistory(assetId, ownerId string) ([]TransferRecord, error)
	// New paginated version for A3
	GetTransferHistoryPaginated(assetId, ownerId string, pageSize int, bookmark string) (*PaginatedTransfers, error)
	UpdateKYC(identityId, status string) error
	GetKYC(identityId string) (*KYCRecord, error)
	FreezeAsset(assetId string) error
	DumpState() string
	// Mode returns "mock" or "live"
	Mode() string
}
