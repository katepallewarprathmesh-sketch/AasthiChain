package fabric

import (
	"encoding/json"
	"fmt"
	"sort"
	"sync"
	"time"

	"github.com/google/uuid"
)

// MockFabricClient simulates Drunix Fabric Gateway SDK for hackathon demo
// Implements FabricClient interface — toggled via FABRIC_MODE env var

type MockFabricClient struct {
	mu         sync.RWMutex
	properties map[string]PropertyAsset
	balances   map[string]TokenBalance // key: assetId~ownerId
	transfers  map[string]TransferRecord
	kycRecords map[string]KYCRecord
	hashIndex  map[string]string // documentHash -> assetId (for dedup)
}

func NewMockFabricClient() *MockFabricClient {
	c := &MockFabricClient{
		properties: make(map[string]PropertyAsset),
		balances:   make(map[string]TokenBalance),
		transfers:  make(map[string]TransferRecord),
		kycRecords: make(map[string]KYCRecord),
		hashIndex:  make(map[string]string),
	}

	now := time.Now()
	c.kycRecords["originator1"] = KYCRecord{DocType: "kyc", IdentityID: "originator1", KYCStatus: "VERIFIED", VerifiedAt: now, Provider: "mock"}
	c.kycRecords["investor1"] = KYCRecord{DocType: "kyc", IdentityID: "investor1", KYCStatus: "VERIFIED", VerifiedAt: now, Provider: "mock"}
	c.kycRecords["investor2"] = KYCRecord{DocType: "kyc", IdentityID: "investor2", KYCStatus: "VERIFIED", VerifiedAt: now, Provider: "mock"}
	c.kycRecords["registrar1"] = KYCRecord{DocType: "kyc", IdentityID: "registrar1", KYCStatus: "VERIFIED", VerifiedAt: now, Provider: "mock"}
	c.kycRecords["regulator1"] = KYCRecord{DocType: "kyc", IdentityID: "regulator1", KYCStatus: "VERIFIED", VerifiedAt: now, Provider: "mock"}

	propID := "PROP-" + uuid.New().String()
	c.properties[propID] = PropertyAsset{
		AssetID:                   propID,
		DocType:                   "property",
		OriginatorID:              "originator1",
		Title:                     "Green Valley Villas - Pune",
		Location:                  Location{State: "Maharashtra", City: "Pune", Pincode: "411045"},
		ValuationINR:              7500000,
		TotalTokens:               15000,
		DocumentHash:              "a3f5c1e8b9d2f4a6c8e0b1d3f5a7c9e1b2d4f6a8c0e2b4d6f8a0c2e4b6d8f0a1",
		RegistrarValidationStatus: "VALIDATED",
		Status:                    "TOKENIZED",
		CreatedAt:                 now.Add(-24 * time.Hour),
		UpdatedAt:                 now,
	}
	c.balances[propID+"~originator1"] = TokenBalance{
		DocType: "balance", AssetID: propID, OwnerID: "originator1", Balance: 12000, UpdatedAt: now,
	}
	c.balances[propID+"~investor1"] = TokenBalance{
		DocType: "balance", AssetID: propID, OwnerID: "investor1", Balance: 2000, UpdatedAt: now,
	}
	c.balances[propID+"~investor2"] = TokenBalance{
		DocType: "balance", AssetID: propID, OwnerID: "investor2", Balance: 1000, UpdatedAt: now,
	}

	// Seed some transfer history for pagination demo
	for i := 0; i < 25; i++ {
		tid := fmt.Sprintf("TXN-%s-%02d", uuid.New().String()[:8], i)
		c.transfers[tid] = TransferRecord{
			DocType:     "transfer",
			TransferID:  tid,
			AssetID:     propID,
			FromID:      "originator1",
			ToID:        []string{"investor1", "investor2"}[i%2],
			Amount:      int64(100 + i*10),
			TxTimestamp: now.Add(-time.Duration(25-i) * time.Hour),
			Status:      "COMPLETED",
		}
	}

	return c
}

func (m *MockFabricClient) Mode() string { return "mock" }

func (m *MockFabricClient) RegisterProperty(originatorId, title, state, city, pincode string, valuation int64, docHash string) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if existing, ok := m.hashIndex[docHash]; ok {
		fmt.Printf("WARN: documentHash collision with asset %s\n", existing)
	}
	assetId := "PROP-" + uuid.New().String()
	now := time.Now()
	asset := PropertyAsset{
		AssetID:                   assetId,
		DocType:                   "property",
		OriginatorID:              originatorId,
		Title:                     title,
		Location:                  Location{State: state, City: city, Pincode: pincode},
		ValuationINR:              valuation,
		TotalTokens:               0,
		DocumentHash:              docHash,
		RegistrarValidationStatus: "PENDING",
		Status:                    "DRAFT",
		CreatedAt:                 now,
		UpdatedAt:                 now,
	}
	m.properties[assetId] = asset
	m.hashIndex[docHash] = assetId
	return assetId, nil
}

func (m *MockFabricClient) ValidateProperty(assetId, decision string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	asset, ok := m.properties[assetId]
	if !ok {
		return fmt.Errorf("ERR_ASSET_NOT_FOUND: %s", assetId)
	}
	if asset.Status != "DRAFT" {
		return fmt.Errorf("ERR_INVALID_INPUT: asset must be DRAFT to validate, current %s", asset.Status)
	}
	asset.RegistrarValidationStatus = decision
	asset.UpdatedAt = time.Now()
	m.properties[assetId] = asset
	return nil
}

func (m *MockFabricClient) MintPropertyTokens(assetId string, totalTokens int64, callerId string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	asset, ok := m.properties[assetId]
	if !ok {
		return fmt.Errorf("ERR_ASSET_NOT_FOUND")
	}
	if asset.RegistrarValidationStatus != "VALIDATED" {
		return fmt.Errorf("ERR_NOT_VALIDATED: must be VALIDATED")
	}
	if asset.Status == "TOKENIZED" {
		return fmt.Errorf("ERR_ALREADY_TOKENIZED")
	}
	if totalTokens > 10_000_000 {
		return fmt.Errorf("ERR_OVERFLOW")
	}
	asset.TotalTokens = totalTokens
	asset.Status = "TOKENIZED"
	asset.UpdatedAt = time.Now()
	m.properties[assetId] = asset
	key := assetId + "~" + asset.OriginatorID
	if _, exists := m.balances[key]; exists {
		return fmt.Errorf("ERR_DUPLICATE_MINT")
	}
	m.balances[key] = TokenBalance{
		DocType: "balance", AssetID: assetId, OwnerID: asset.OriginatorID, Balance: totalTokens, UpdatedAt: time.Now(),
	}
	return nil
}

func (m *MockFabricClient) TransferTokens(assetId, fromId, toId string, amount int64) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if amount <= 0 {
		return "", fmt.Errorf("ERR_INVALID_AMOUNT")
	}
	if fromId == toId {
		return "", fmt.Errorf("ERR_INVALID_TRANSFER: self-transfer")
	}
	asset, ok := m.properties[assetId]
	if !ok {
		return "", fmt.Errorf("ERR_ASSET_NOT_FOUND")
	}
	if asset.Status == "FROZEN" {
		return "", fmt.Errorf("ERR_ASSET_FROZEN")
	}
	if asset.Status != "TOKENIZED" {
		return "", fmt.Errorf("ERR_INVALID_TRANSFER: asset not tokenized")
	}
	if kyc, ok := m.kycRecords[fromId]; ok {
		if kyc.KYCStatus != "VERIFIED" {
			return "", fmt.Errorf("ERR_KYC_NOT_VERIFIED: sender")
		}
	} else {
		if fromId != asset.OriginatorID {
			return "", fmt.Errorf("ERR_KYC_NOT_VERIFIED: sender KYC not found")
		}
	}
	if kyc, ok := m.kycRecords[toId]; ok {
		if kyc.KYCStatus != "VERIFIED" {
			return "", fmt.Errorf("ERR_KYC_NOT_VERIFIED: receiver")
		}
	} else {
		return "", fmt.Errorf("ERR_KYC_NOT_VERIFIED: receiver KYC not found")
	}
	fromKey := assetId + "~" + fromId
	fromBal, ok := m.balances[fromKey]
	if !ok {
		return "", fmt.Errorf("ERR_BALANCE_NOT_FOUND")
	}
	if fromBal.Balance < amount {
		return "", fmt.Errorf("ERR_INSUFFICIENT_BALANCE: have %d need %d", fromBal.Balance, amount)
	}
	toKey := assetId + "~" + toId
	toBal, _ := m.balances[toKey]
	fromBal.Balance -= amount
	fromBal.UpdatedAt = time.Now()
	m.balances[fromKey] = fromBal
	toBal.AssetID = assetId
	toBal.OwnerID = toId
	toBal.DocType = "balance"
	toBal.Balance += amount
	toBal.UpdatedAt = time.Now()
	m.balances[toKey] = toBal
	transferId := "TXN-" + uuid.New().String()
	transfer := TransferRecord{
		DocType:     "transfer",
		TransferID:  transferId,
		AssetID:     assetId,
		FromID:      fromId,
		ToID:        toId,
		Amount:      amount,
		TxTimestamp: time.Now(),
		Status:      "COMPLETED",
	}
	m.transfers[transferId] = transfer
	return transferId, nil
}

func (m *MockFabricClient) GetBalance(assetId, ownerId string) (*TokenBalance, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	key := assetId + "~" + ownerId
	if bal, ok := m.balances[key]; ok {
		return &bal, nil
	}
	return &TokenBalance{DocType: "balance", AssetID: assetId, OwnerID: ownerId, Balance: 0}, nil
}

func (m *MockFabricClient) GetWallet(ownerId string) ([]TokenBalance, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	var res []TokenBalance
	for _, bal := range m.balances {
		if bal.OwnerID == ownerId {
			res = append(res, bal)
		}
	}
	return res, nil
}

func (m *MockFabricClient) GetProperty(assetId string) (*PropertyAsset, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if p, ok := m.properties[assetId]; ok {
		return &p, nil
	}
	return nil, fmt.Errorf("ERR_ASSET_NOT_FOUND")
}

func (m *MockFabricClient) ListProperties(status string) ([]PropertyAsset, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	var res []PropertyAsset
	for _, p := range m.properties {
		if status == "" || p.Status == status {
			res = append(res, p)
		}
	}
	return res, nil
}

func (m *MockFabricClient) GetTransferHistory(assetId, ownerId string) ([]TransferRecord, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	var res []TransferRecord
	for _, t := range m.transfers {
		if assetId != "" && t.AssetID != assetId {
			continue
		}
		if ownerId != "" && t.FromID != ownerId && t.ToID != ownerId {
			continue
		}
		res = append(res, t)
	}
	// Sort by timestamp desc for audit
	sort.Slice(res, func(i, j int) bool {
		return res[i].TxTimestamp.After(res[j].TxTimestamp)
	})
	return res, nil
}

// A3: Paginated version using bookmark pattern (Fabric native) + LIMIT/OFFSET
func (m *MockFabricClient) GetTransferHistoryPaginated(assetId, ownerId string, pageSize int, bookmark string) (*PaginatedTransfers, error) {
	all, err := m.GetTransferHistory(assetId, ownerId)
	if err != nil {
		return nil, err
	}

	if pageSize <= 0 {
		pageSize = 10
	}
	if pageSize > 100 {
		pageSize = 100
	}

	// Bookmark is last TransferID from previous page
	startIdx := 0
	if bookmark != "" {
		for i, t := range all {
			if t.TransferID == bookmark {
				startIdx = i + 1
				break
			}
		}
	}

	endIdx := startIdx + pageSize
	hasMore := false
	if endIdx < len(all) {
		hasMore = true
	} else {
		endIdx = len(all)
	}

	page := all[startIdx:endIdx]
	nextBookmark := ""
	if hasMore && len(page) > 0 {
		nextBookmark = page[len(page)-1].TransferID
	}

	return &PaginatedTransfers{
		Transfers: page,
		Bookmark:  nextBookmark,
		HasMore:   hasMore,
		Total:     len(all),
	}, nil
}

func (m *MockFabricClient) UpdateKYC(identityId, status string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	rec := m.kycRecords[identityId]
	rec.DocType = "kyc"
	rec.IdentityID = identityId
	rec.KYCStatus = status
	rec.VerifiedAt = time.Now()
	rec.Provider = "mock"
	m.kycRecords[identityId] = rec
	return nil
}

func (m *MockFabricClient) GetKYC(identityId string) (*KYCRecord, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if r, ok := m.kycRecords[identityId]; ok {
		return &r, nil
	}
	return &KYCRecord{DocType: "kyc", IdentityID: identityId, KYCStatus: "UNVERIFIED", Provider: "mock"}, nil
}

func (m *MockFabricClient) FreezeAsset(assetId string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	p, ok := m.properties[assetId]
	if !ok {
		return fmt.Errorf("ERR_ASSET_NOT_FOUND")
	}
	p.Status = "FROZEN"
	p.UpdatedAt = time.Now()
	m.properties[assetId] = p
	return nil
}

func (m *MockFabricClient) DumpState() string {
	m.mu.RLock()
	defer m.mu.RUnlock()
	b, _ := json.MarshalIndent(map[string]interface{}{
		"properties": m.properties,
		"balances":   m.balances,
		"transfers":  m.transfers,
	}, "", "  ")
	return string(b)
}
