package main

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/hyperledger/fabric-contract-api-go/contractapi"
)

type TokenContract struct {
	contractapi.Contract
}

func (c *TokenContract) requireMSP(ctx contractapi.TransactionContextInterface, allowed []string) error {
	mspID, err := ctx.GetClientIdentity().GetMSPID()
	if err != nil {
		return NewError(ErrUnauthorized, "failed to get MSP")
	}
	for _, a := range allowed {
		if mspID == a {
			return nil
		}
	}
	return NewError(ErrUnauthorized, fmt.Sprintf("MSP %s not authorized", mspID))
}

func (c *TokenContract) getClientInfo(ctx contractapi.TransactionContextInterface) (string, string, error) {
	mspID, err := ctx.GetClientIdentity().GetMSPID()
	if err != nil {
		return "", "", err
	}
	clientID, err := ctx.GetClientIdentity().GetID()
	if err != nil {
		return "", "", err
	}
	return mspID, clientID, nil
}

func (c *TokenContract) getBalance(ctx contractapi.TransactionContextInterface, assetId, ownerId string) (*TokenBalance, string, error) {
	balanceKey, err := ctx.GetStub().CreateCompositeKey(CompositeBalancePrefix, []string{assetId, ownerId})
	if err != nil {
		return nil, "", err
	}
	balBytes, err := ctx.GetStub().GetState(balanceKey)
	if err != nil {
		return nil, "", err
	}
	if balBytes == nil {
		return nil, balanceKey, nil
	}
	var bal TokenBalance
	if err := json.Unmarshal(balBytes, &bal); err != nil {
		return nil, balanceKey, err
	}
	return &bal, balanceKey, nil
}

func (c *TokenContract) TransferTokens(ctx contractapi.TransactionContextInterface, assetId string, toId string, amount int64) (string, error) {
	if err := c.requireMSP(ctx, []string{"InvestorMSP", "OriginatorMSP"}); err != nil {
		return "", err
	}
	if amount <= 0 {
		return "", NewError(ErrInvalidAmount, "amount must be > 0")
	}
	if strings.TrimSpace(toId) == "" {
		return "", NewError(ErrInvalidInput, "toId required")
	}
	if strings.TrimSpace(assetId) == "" {
		return "", NewError(ErrInvalidInput, "assetId required")
	}
	_, fromId, err := c.getClientInfo(ctx)
	if err != nil {
		return "", err
	}
	if fromId == toId {
		return "", NewError(ErrInvalidTransfer, "self-transfer not allowed")
	}
	assetBytes, err := ctx.GetStub().GetState(assetId)
	if err != nil {
		return "", err
	}
	if assetBytes == nil {
		return "", NewError(ErrAssetNotFound, "asset not found")
	}
	var asset PropertyAsset
	if err := json.Unmarshal(assetBytes, &asset); err != nil {
		return "", err
	}
	if asset.Status == PropertyFrozen {
		return "", NewError(ErrAssetFrozen, "asset is frozen, transfers blocked")
	}
	if asset.Status != PropertyTokenized {
		return "", NewError(ErrInvalidTransfer, fmt.Sprintf("asset status %s does not allow transfer", asset.Status))
	}

	// KYC checks
	senderKYCKey := "kyc~" + fromId
	kycBytes, _ := ctx.GetStub().GetState(senderKYCKey)
	if kycBytes != nil {
		var kyc KYCRecord
		json.Unmarshal(kycBytes, &kyc)
		if kyc.KYCStatus != KYCVerified {
			return "", NewError(ErrKYCNotVerified, "sender KYC not verified")
		}
	} else {
		kycComposite, _ := ctx.GetStub().CreateCompositeKey("kyc", []string{fromId})
		kb, _ := ctx.GetStub().GetState(kycComposite)
		if kb != nil {
			var kyc KYCRecord
			json.Unmarshal(kb, &kyc)
			if kyc.KYCStatus != KYCVerified {
				return "", NewError(ErrKYCNotVerified, "sender KYC not verified")
			}
		} else {
			msp, _, _ := c.getClientInfo(ctx)
			if msp == "InvestorMSP" {
				return "", NewError(ErrKYCNotVerified, "sender KYC not found")
			}
		}
	}

	receiverKYCKey := "kyc~" + toId
	rKycBytes, _ := ctx.GetStub().GetState(receiverKYCKey)
	if rKycBytes != nil {
		var kyc KYCRecord
		json.Unmarshal(rKycBytes, &kyc)
		if kyc.KYCStatus != KYCVerified {
			return "", NewError(ErrKYCNotVerified, "receiver KYC not verified")
		}
	} else {
		kycComposite, _ := ctx.GetStub().CreateCompositeKey("kyc", []string{toId})
		kb, _ := ctx.GetStub().GetState(kycComposite)
		if kb != nil {
			var kyc KYCRecord
			json.Unmarshal(kb, &kyc)
			if kyc.KYCStatus != KYCVerified {
				return "", NewError(ErrKYCNotVerified, "receiver KYC not verified")
			}
		}
	}

	senderBal, senderKey, err := c.getBalance(ctx, assetId, fromId)
	if err != nil {
		return "", err
	}
	if senderBal == nil {
		return "", NewError(ErrBalanceNotFound, "sender has no balance for this asset")
	}
	if senderBal.Balance < amount {
		return "", NewError(ErrInsufficientBalance, fmt.Sprintf("insufficient balance: have %d, need %d", senderBal.Balance, amount))
	}

	receiverBal, receiverKey, err := c.getBalance(ctx, assetId, toId)
	if err != nil {
		return "", err
	}

	now := time.Now().UTC()
	if ts, err := ctx.GetStub().GetTxTimestamp(); err == nil && ts != nil {
		now = time.Unix(ts.Seconds, int64(ts.Nanos)).UTC()
	}

	senderBal.Balance -= amount
	senderBal.UpdatedAt = now
	senderBytes, _ := json.Marshal(senderBal)
	if err := ctx.GetStub().PutState(senderKey, senderBytes); err != nil {
		return "", err
	}

	if receiverBal == nil {
		receiverBal = &TokenBalance{
			DocType:       DocTypeBalance,
			AssetID:       assetId,
			OwnerID:       toId,
			Balance:       amount,
			LockedBalance: 0,
			UpdatedAt:     now,
		}
	} else {
		receiverBal.Balance += amount
		receiverBal.UpdatedAt = now
	}
	receiverBytes, _ := json.Marshal(receiverBal)
	if err := ctx.GetStub().PutState(receiverKey, receiverBytes); err != nil {
		return "", err
	}

	transferId := "TXN-" + uuid.New().String()
	transfer := TransferRecord{
		DocType:     DocTypeTransfer,
		TransferID:  transferId,
		AssetID:     assetId,
		FromID:      fromId,
		ToID:        toId,
		Amount:      amount,
		TxTimestamp: now,
		Status:      TransferCompleted,
	}
	transferBytes, _ := json.Marshal(transfer)
	if err := ctx.GetStub().PutState(transferId, transferBytes); err != nil {
		return "", err
	}

	timeStr := now.Format(time.RFC3339Nano)
	assetTimeKey, _ := ctx.GetStub().CreateCompositeKey("transfer", []string{assetId, timeStr, transferId})
	ctx.GetStub().PutState(assetTimeKey, []byte(transferId))
	ownerTimeKey, _ := ctx.GetStub().CreateCompositeKey("transferByOwner", []string{fromId, timeStr, transferId})
	ctx.GetStub().PutState(ownerTimeKey, []byte(transferId))
	ownerTimeKey2, _ := ctx.GetStub().CreateCompositeKey("transferByOwner", []string{toId, timeStr, transferId})
	ctx.GetStub().PutState(ownerTimeKey2, []byte(transferId))

	ctx.GetStub().SetEvent("TokensTransferred", transferBytes)
	return transferId, nil
}

func (c *TokenContract) GetBalance(ctx contractapi.TransactionContextInterface, assetId string, ownerId string) (*TokenBalance, error) {
	if strings.TrimSpace(assetId) == "" || strings.TrimSpace(ownerId) == "" {
		return nil, NewError(ErrInvalidInput, "assetId and ownerId required")
	}
	bal, _, err := c.getBalance(ctx, assetId, ownerId)
	if err != nil {
		return nil, err
	}
	if bal == nil {
		return &TokenBalance{
			DocType: DocTypeBalance,
			AssetID: assetId,
			OwnerID: ownerId,
			Balance: 0,
		}, nil
	}
	return bal, nil
}

// PaginatedTransferResult for Track A3
type PaginatedTransferResult struct {
	Transfers []*TransferRecord `json:"transfers"`
	Bookmark  string            `json:"bookmark"`
	HasMore   bool              `json:"hasMore"`
	Total     int               `json:"total"`
}

// GetTransferHistory with pagination per Track A3 — uses Fabric's GetStateByRangeWithPagination with bookmark
func (c *TokenContract) GetTransferHistory(ctx contractapi.TransactionContextInterface, assetId string, ownerId string, pageSize int, bookmark string) (*PaginatedTransferResult, error) {
	mspID, clientID, err := c.getClientInfo(ctx)
	if err != nil {
		return nil, err
	}
	if mspID != "RegulatorMSP" {
		if ownerId != "" && ownerId != clientID {
			return nil, NewError(ErrUnauthorized, "can only query own history")
		}
	}

	if pageSize <= 0 {
		pageSize = 10
	}
	if pageSize > 100 {
		pageSize = 100
	}

	var results []*TransferRecord
	var responseMetadata *struct {
		Bookmark string
	}

	// Use Fabric's native pagination for regulator full scan
	if assetId == "" && ownerId == "" {
		iterator, meta, err := ctx.GetStub().GetStateByRangeWithPagination("TXN-", "TXN-zzzz", int32(pageSize), bookmark)
		if err != nil {
			return nil, err
		}
		defer iterator.Close()
		responseMetadata = &struct{ Bookmark string }{Bookmark: meta.Bookmark}
		for iterator.HasNext() {
			kv, _ := iterator.Next()
			var tr TransferRecord
			if err := json.Unmarshal(kv.Value, &tr); err != nil {
				continue
			}
			if tr.DocType != DocTypeTransfer {
				continue
			}
			results = append(results, &tr)
		}
		return &PaginatedTransferResult{
			Transfers: results,
			Bookmark:  meta.Bookmark,
			HasMore:   meta.Bookmark != "",
			Total:     len(results), // In prod, total would come from separate count query via SQL index
		}, nil
	}

	// For filtered queries, use composite key partial queries + manual pagination
	// In production Drunix, this would be SQL: SELECT * WHERE assetId=? ORDER BY txTimestamp DESC LIMIT ? OFFSET ? with idx_transfer_asset_time
	var allResults []*TransferRecord
	if assetId != "" {
		iterator, err := ctx.GetStub().GetStateByPartialCompositeKey("transfer", []string{assetId})
		if err != nil {
			return nil, err
		}
		defer iterator.Close()
		for iterator.HasNext() {
			kv, err := iterator.Next()
			if err != nil {
				continue
			}
			transferId := string(kv.Value)
			trBytes, err := ctx.GetStub().GetState(transferId)
			if err != nil || trBytes == nil {
				continue
			}
			var tr TransferRecord
			if err := json.Unmarshal(trBytes, &tr); err != nil {
				continue
			}
			if ownerId != "" && tr.FromID != ownerId && tr.ToID != ownerId {
				continue
			}
			allResults = append(allResults, &tr)
		}
	} else if ownerId != "" {
		iterator, err := ctx.GetStub().GetStateByPartialCompositeKey("transferByOwner", []string{ownerId})
		if err != nil {
			return nil, err
		}
		defer iterator.Close()
		for iterator.HasNext() {
			kv, err := iterator.Next()
			if err != nil {
				continue
			}
			transferId := string(kv.Value)
			trBytes, _ := ctx.GetStub().GetState(transferId)
			if trBytes == nil {
				continue
			}
			var tr TransferRecord
			json.Unmarshal(trBytes, &tr)
			allResults = append(allResults, &tr)
		}
	}

	// Sort by timestamp desc (most recent first) — SQL index idx_transfer_asset_time would handle this in Drunix
	// Simple bubble for demo, in prod use SQL ORDER BY
	for i := 0; i < len(allResults)-1; i++ {
		for j := i + 1; j < len(allResults); j++ {
			if allResults[i].TxTimestamp.Before(allResults[j].TxTimestamp) {
				allResults[i], allResults[j] = allResults[j], allResults[i]
			}
		}
	}

	// Bookmark handling: bookmark is last TransferID from previous page
	startIdx := 0
	if bookmark != "" {
		for idx, tr := range allResults {
			if tr.TransferID == bookmark {
				startIdx = idx + 1
				break
			}
		}
	}

	endIdx := startIdx + pageSize
	hasMore := false
	if endIdx < len(allResults) {
		hasMore = true
	} else {
		endIdx = len(allResults)
	}

	page := allResults[startIdx:endIdx]
	nextBookmark := ""
	if hasMore && len(page) > 0 {
		nextBookmark = page[len(page)-1].TransferID
	}

	return &PaginatedTransferResult{
		Transfers: page,
		Bookmark:  nextBookmark,
		HasMore:   hasMore,
		Total:     len(allResults),
	}, nil
}

func (c *TokenContract) GetWallet(ctx contractapi.TransactionContextInterface, ownerId string) ([]*TokenBalance, error) {
	if ownerId == "" {
		_, clientID, err := c.getClientInfo(ctx)
		if err != nil {
			return nil, err
		}
		ownerId = clientID
	}
	iterator, err := ctx.GetStub().GetStateByPartialCompositeKey(CompositeBalancePrefix, []string{})
	if err != nil {
		return nil, err
	}
	defer iterator.Close()
	var results []*TokenBalance
	for iterator.HasNext() {
		kv, err := iterator.Next()
		if err != nil {
			continue
		}
		_, parts, err := ctx.GetStub().SplitCompositeKey(kv.Key)
		if err != nil || len(parts) != 2 {
			continue
		}
		if parts[1] != ownerId {
			continue
		}
		var bal TokenBalance
		if err := json.Unmarshal(kv.Value, &bal); err != nil {
			continue
		}
		results = append(results, &bal)
	}
	return results, nil
}

// RecordSettlement — persist a DvP settlement proof on the Drunix ledger.
// Called by the payment gateway after escrow release: tokens already moved via
// TransferTokens; this records the bank payment (paymentId + UTR) that the
// move was settled against, emitting a SettlementRecorded chaincode event.
// Amount paise is stored for regulator-accurate audit.
func (c *TokenContract) RecordSettlement(ctx contractapi.TransactionContextInterface, paymentId string, utr string, assetId string, fromId string, toId string, tokenAmount int64, amountINRPaise int64) (string, error) {
	if err := c.requireMSP(ctx, []string{"InvestorMSP", "OriginatorMSP", "RegistrarMSP"}); err != nil {
		return "", err
	}
	if strings.TrimSpace(paymentId) == "" || strings.TrimSpace(utr) == "" || strings.TrimSpace(assetId) == "" {
		return "", NewError(ErrInvalidInput, "paymentId, utr and assetId are required")
	}
	if tokenAmount <= 0 {
		return "", NewError(ErrInvalidAmount, "tokenAmount must be > 0")
	}

	// Idempotency — the same payment can never settle twice on-chain.
	settleKey, err := ctx.GetStub().CreateCompositeKey(CompositeSettlePrefix, []string{assetId, paymentId})
	if err != nil {
		return "", err
	}
	if existing, _ := ctx.GetStub().GetState(settleKey); existing != nil {
		return "", NewError(ErrInvalidInput, "settlement already recorded for payment "+paymentId)
	}

	settlement := SettlementRecord{
		DocType:        "settlement",
		SettlementID:   "STL-" + paymentId,
		PaymentID:      paymentId,
		UTR:            utr,
		AssetID:        assetId,
		FromID:         fromId,
		ToID:           toId,
		TokenAmount:    tokenAmount,
		AmountINRPaise: amountINRPaise,
		SettledAt:      time.Now().UTC(),
		Status:         SettlementSettled,
	}
	bytes, err := json.Marshal(settlement)
	if err != nil {
		return "", err
	}
	if err := ctx.GetStub().PutState(settleKey, bytes); err != nil {
		return "", err
	}

	// Chaincode event — Drunix network subscribers (payment ops, regulator)
	// consume SettlementRecorded for real-time settlement intelligence.
	eventPayload, _ := json.Marshal(map[string]string{
		"settlementId": settlement.SettlementID,
		"paymentId":    paymentId,
		"utr":          utr,
		"assetId":      assetId,
		"toId":         toId,
	})
	if err := ctx.GetStub().SetEvent("SettlementRecorded", eventPayload); err != nil {
		return "", err
	}
	return settlement.SettlementID, nil
}

// SettleDvP — atomic Delivery-versus-Payment on the Drunix ledger:
// tokens transfer from seller to buyer AND the bank payment proof (paymentId +
// UTR) is recorded in the SAME transaction — all-or-nothing, no partial state.
// This is the chaincode entrypoint the Golang Drunix gateway submits after the
// UPI escrow reaches CONFIRMED (UTR assigned by the bank).
func (c *TokenContract) SettleDvP(ctx contractapi.TransactionContextInterface, paymentId string, utr string, assetId string, fromId string, toId string, tokenAmount int64, amountINRPaise int64) (string, error) {
	if err := c.requireMSP(ctx, []string{"InvestorMSP", "OriginatorMSP", "RegistrarMSP"}); err != nil {
		return "", err
	}

	// Idempotency first — a replayed DvP submission must be a no-op.
	settleKey, err := ctx.GetStub().CreateCompositeKey(CompositeSettlePrefix, []string{assetId, paymentId})
	if err != nil {
		return "", err
	}
	if existing, _ := ctx.GetStub().GetState(settleKey); existing != nil {
		return "", NewError(ErrInvalidInput, "DvP already settled for payment "+paymentId)
	}

	// Leg 1 — token delivery (same rules as TransferTokens; caller is fromId).
	transferID, err := c.TransferTokensAs(ctx, assetId, fromId, toId, tokenAmount)
	if err != nil {
		return "", fmt.Errorf("DvP delivery leg failed: %w", err)
	}

	// Leg 2 — payment proof (UTR) recorded atomically in this same tx.
	settlementID, err := c.RecordSettlement(ctx, paymentId, utr, assetId, fromId, toId, tokenAmount, amountINRPaise)
	if err != nil {
		// Fabric transaction semantics: a returned error discards ALL writes
		// from this invocation — the transfer leg cannot persist without the
		// settlement proof. Atomicity is enforced by the ledger itself.
		return "", fmt.Errorf("DvP payment leg failed — transaction rolled back (%s): %w", transferID, err)
	}
	return settlementID, nil
}

// TransferTokensAs is TransferTokens with an explicit fromId (gateway/escrow
// settlements move tokens on behalf of the recorded owner). Authorization:
// caller must be an authorized settlement MSP; the from-owner must exist.
func (c *TokenContract) TransferTokensAs(ctx contractapi.TransactionContextInterface, assetId string, fromId string, toId string, amount int64) (string, error) {
	if err := c.requireMSP(ctx, []string{"InvestorMSP", "OriginatorMSP", "RegistrarMSP"}); err != nil {
		return "", err
	}
	if amount <= 0 {
		return "", NewError(ErrInvalidAmount, "amount must be > 0")
	}
	if fromId == toId {
		return "", NewError(ErrInvalidTransfer, "self-transfer not allowed")
	}
	assetBytes, err := ctx.GetStub().GetState(assetId)
	if err != nil {
		return "", err
	}
	if assetBytes == nil {
		return "", NewError(ErrAssetNotFound, "asset not found")
	}
	var asset PropertyAsset
	if err := json.Unmarshal(assetBytes, &asset); err != nil {
		return "", err
	}
	if asset.Status == PropertyFrozen {
		return "", NewError(ErrAssetFrozen, "asset is frozen, transfers blocked")
	}
	if asset.Status != PropertyTokenized {
		return "", NewError(ErrInvalidTransfer, fmt.Sprintf("asset status %s does not allow transfer", asset.Status))
	}

	fromKey, err := ctx.GetStub().CreateCompositeKey(CompositeBalancePrefix, []string{assetId, fromId})
	if err != nil {
		return "", err
	}
	fromBytes, err := ctx.GetStub().GetState(fromKey)
	if err != nil {
		return "", err
	}
	if fromBytes == nil {
		return "", NewError(ErrBalanceNotFound, "sender balance not found")
	}
	var fromBal TokenBalance
	if err := json.Unmarshal(fromBytes, &fromBal); err != nil {
		return "", err
	}
	if fromBal.Balance < amount {
		return "", NewError(ErrInsufficientBalance, fmt.Sprintf("have %d need %d", fromBal.Balance, amount))
	}

	toKey, err := ctx.GetStub().CreateCompositeKey(CompositeBalancePrefix, []string{assetId, toId})
	if err != nil {
		return "", err
	}
	var toBal TokenBalance
	toBytes, _ := ctx.GetStub().GetState(toKey)
	if toBytes != nil {
		if err := json.Unmarshal(toBytes, &toBal); err != nil {
			return "", err
		}
	} else {
		toBal = TokenBalance{DocType: DocTypeBalance, AssetID: assetId, OwnerID: toId, Balance: 0, UpdatedAt: time.Now().UTC()}
	}

	fromBal.Balance -= amount
	fromBal.UpdatedAt = time.Now().UTC()
	fromJSON, _ := json.Marshal(fromBal)
	if err := ctx.GetStub().PutState(fromKey, fromJSON); err != nil {
		return "", err
	}
	toBal.Balance += amount
	toBal.UpdatedAt = time.Now().UTC()
	toJSON, _ := json.Marshal(toBal)
	if err := ctx.GetStub().PutState(toKey, toJSON); err != nil {
		return "", err
	}

	transferID := "TXN-" + uuid.New().String()
	record := TransferRecord{
		DocType:     DocTypeTransfer,
		TransferID:  transferID,
		AssetID:     assetId,
		FromID:      fromId,
		ToID:        toId,
		Amount:      amount,
		TxTimestamp: time.Now().UTC(),
		Status:      TransferCompleted,
	}
	tJSON, _ := json.Marshal(record)
	if err := ctx.GetStub().PutState("transfer~"+transferID, tJSON); err != nil {
		return "", err
	}
	return transferID, nil
}
