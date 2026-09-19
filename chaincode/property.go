package main

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/hyperledger/fabric-contract-api-go/contractapi"
)

type PropertyContract struct {
	contractapi.Contract
}

// Helper: get client MSP and ID
func (c *PropertyContract) getClientInfo(ctx contractapi.TransactionContextInterface) (mspID string, clientID string, err error) {
	mspID, err = ctx.GetClientIdentity().GetMSPID()
	if err != nil {
		return "", "", NewError(ErrUnauthorized, "failed to get MSP ID")
	}
	clientID, err = ctx.GetClientIdentity().GetID()
	if err != nil {
		return "", "", NewError(ErrUnauthorized, "failed to get client ID")
	}
	return mspID, clientID, nil
}

func (c *PropertyContract) requireMSP(ctx contractapi.TransactionContextInterface, allowed []string) error {
	mspID, _, err := c.getClientInfo(ctx)
	if err != nil {
		return err
	}
	for _, a := range allowed {
		if mspID == a {
			return nil
		}
	}
	return NewError(ErrUnauthorized, fmt.Sprintf("MSP %s not authorized, requires one of %v", mspID, allowed))
}

// RegisterProperty - Originator only
func (c *PropertyContract) RegisterProperty(ctx contractapi.TransactionContextInterface, title string, state string, city string, pincode string, valuationINR int64, documentHash string) (string, error) {
	if err := c.requireMSP(ctx, []string{"OriginatorMSP"}); err != nil {
		return "", err
	}

	// Input validation
	if strings.TrimSpace(title) == "" {
		return "", NewError(ErrInvalidInput, "title cannot be empty")
	}
	if strings.TrimSpace(state) == "" || strings.TrimSpace(city) == "" || strings.TrimSpace(pincode) == "" {
		return "", NewError(ErrInvalidInput, "location fields required")
	}
	if valuationINR < MinValuationINR {
		return "", NewError(ErrInvalidInput, fmt.Sprintf("valuation must be >= %d", MinValuationINR))
	}
	if strings.TrimSpace(documentHash) == "" || len(documentHash) != 64 {
		// Expect SHA-256 hex (64 chars) - strict for demo
		return "", NewError(ErrInvalidInput, "documentHash must be SHA-256 hex (64 chars)")
	}

	mspID, clientID, err := c.getClientInfo(ctx)
	if err != nil {
		return "", err
	}

	// Off-chain dedup hint: check for existing asset with same documentHash
	// We iterate via range query simulation - in production use SQL index
	// For chaincode, we do a composite check: if hash exists, flag but allow (spec says allow but flag)
	// Here we just proceed but could emit event

	assetID := "PROP-" + uuid.New().String()
	now := time.Now().UTC()
	// Use block timestamp if available (Fabric provides TxTimestamp)
	if ts, err := ctx.GetStub().GetTxTimestamp(); err == nil && ts != nil {
		now = time.Unix(ts.Seconds, int64(ts.Nanos)).UTC()
	}

	asset := PropertyAsset{
		AssetID:                   assetID,
		DocType:                   DocTypeProperty,
		OriginatorID:              clientID,
		Title:                     title,
		Location:                  Location{State: state, City: city, Pincode: pincode},
		ValuationINR:              valuationINR,
		TotalTokens:               0, // set at mint
		DocumentHash:              documentHash,
		RegistrarValidationStatus: ValidationPending,
		Status:                    PropertyDraft,
		CreatedAt:                 now,
		UpdatedAt:                 now,
		Version:                   1,
	}

	assetBytes, err := json.Marshal(asset)
	if err != nil {
		return "", NewError(ErrInvalidInput, "failed to marshal asset")
	}

	if err := ctx.GetStub().PutState(assetID, assetBytes); err != nil {
		return "", fmt.Errorf("failed to put state: %w", err)
	}

	// Also create secondary index for hash -> assetID mapping (for dedup detection)
	hashIndexKey := "hash~" + documentHash + "~" + assetID
	if err := ctx.GetStub().PutState(hashIndexKey, []byte(assetID)); err != nil {
		// non-fatal for demo, but log
	}

	_ = mspID // used for endorsement policy enforcement at network level

	ctx.GetStub().SetEvent("PropertyRegistered", assetBytes)
	return assetID, nil
}

// ValidateProperty - Registrar only
func (c *PropertyContract) ValidateProperty(ctx contractapi.TransactionContextInterface, assetId string, decision string) error {
	if err := c.requireMSP(ctx, []string{"RegistrarMSP"}); err != nil {
		return err
	}

	if decision != ValidationValidated && decision != ValidationRejected {
		return NewError(ErrInvalidInput, "decision must be VALIDATED or REJECTED")
	}

	assetBytes, err := ctx.GetStub().GetState(assetId)
	if err != nil {
		return fmt.Errorf("failed to get asset: %w", err)
	}
	if assetBytes == nil {
		return NewError(ErrAssetNotFound, fmt.Sprintf("asset %s not found", assetId))
	}

	var asset PropertyAsset
	if err := json.Unmarshal(assetBytes, &asset); err != nil {
		return NewError(ErrInvalidInput, "failed to unmarshal asset")
	}

	if asset.Status != PropertyDraft {
		return NewError(ErrInvalidInput, fmt.Sprintf("asset status must be DRAFT to validate, current %s", asset.Status))
	}

	now := time.Now().UTC()
	if ts, err := ctx.GetStub().GetTxTimestamp(); err == nil && ts != nil {
		now = time.Unix(ts.Seconds, int64(ts.Nanos)).UTC()
	}

	asset.RegistrarValidationStatus = decision
	if decision == ValidationRejected {
		asset.Status = PropertyDraft // remains draft, can resubmit as new asset per spec
	} else {
		// Validated, stays DRAFT until mint
		asset.RegistrarValidationStatus = ValidationValidated
	}
	asset.UpdatedAt = now

	updatedBytes, _ := json.Marshal(asset)
	if err := ctx.GetStub().PutState(assetId, updatedBytes); err != nil {
		return err
	}

	ctx.GetStub().SetEvent("PropertyValidated", updatedBytes)
	return nil
}

// MintPropertyTokens - requires Originator AND Registrar endorsement (enforced at network level)
// But chaincode also validates business rules
func (c *PropertyContract) MintPropertyTokens(ctx contractapi.TransactionContextInterface, assetId string, totalTokens int64) error {
	// Allow OriginatorMSP caller; endorsement policy will require both orgs at commit time
	if err := c.requireMSP(ctx, []string{"OriginatorMSP", "RegistrarMSP"}); err != nil {
		return err
	}

	if totalTokens <= 0 {
		return NewError(ErrInvalidAmount, "totalTokens must be positive")
	}
	if totalTokens > MaxTotalTokens {
		return NewError(ErrOverflow, fmt.Sprintf("totalTokens exceeds cap %d", MaxTotalTokens))
	}

	assetBytes, err := ctx.GetStub().GetState(assetId)
	if err != nil {
		return err
	}
	if assetBytes == nil {
		return NewError(ErrAssetNotFound, "asset not found")
	}

	var asset PropertyAsset
	if err := json.Unmarshal(assetBytes, &asset); err != nil {
		return err
	}

	if asset.RegistrarValidationStatus != ValidationValidated {
		return NewError(ErrNotValidated, "asset must be VALIDATED before mint")
	}
	if asset.Status == PropertyTokenized {
		return NewError(ErrAlreadyTokenized, "asset already tokenized - duplicate mint")
	}
	if asset.Status == PropertyFrozen {
		return NewError(ErrAssetFrozen, "asset is frozen")
	}

	// Idempotency: check if balance already exists for originator for this asset with totalTokens
	_, clientID, _ := c.getClientInfo(ctx)
	balanceKey, _ := ctx.GetStub().CreateCompositeKey(CompositeBalancePrefix, []string{assetId, asset.OriginatorID})
	existingBal, _ := ctx.GetStub().GetState(balanceKey)
	if existingBal != nil {
		return NewError(ErrDuplicateMint, "tokens already minted for this asset")
	}

	now := time.Now().UTC()
	if ts, err := ctx.GetStub().GetTxTimestamp(); err == nil && ts != nil {
		now = time.Unix(ts.Seconds, int64(ts.Nanos)).UTC()
	}

	asset.TotalTokens = totalTokens
	asset.Status = PropertyTokenized
	asset.UpdatedAt = now

	updatedBytes, _ := json.Marshal(asset)
	if err := ctx.GetStub().PutState(assetId, updatedBytes); err != nil {
		return err
	}

	// Create TokenBalance for originator holding full supply
	balance := TokenBalance{
		DocType:       DocTypeBalance,
		AssetID:       assetId,
		OwnerID:       asset.OriginatorID,
		Balance:       totalTokens,
		LockedBalance: 0,
		UpdatedAt:     now,
	}
	_ = clientID
	balBytes, _ := json.Marshal(balance)
	if err := ctx.GetStub().PutState(balanceKey, balBytes); err != nil {
		return err
	}

	// Create index entries for SQL state store simulation
	// In Drunix SQL state, these would be actual SQL indexes; here we simulate with composite keys

	ctx.GetStub().SetEvent("TokensMinted", updatedBytes)
	return nil
}

// GetPropertyDetails - read only
func (c *PropertyContract) GetPropertyDetails(ctx contractapi.TransactionContextInterface, assetId string) (*PropertyAsset, error) {
	assetBytes, err := ctx.GetStub().GetState(assetId)
	if err != nil {
		return nil, err
	}
	if assetBytes == nil {
		return nil, NewError(ErrAssetNotFound, "asset not found")
	}
	var asset PropertyAsset
	if err := json.Unmarshal(assetBytes, &asset); err != nil {
		return nil, err
	}
	return &asset, nil
}

// FreezeAsset - Regulator only
func (c *PropertyContract) FreezeAsset(ctx contractapi.TransactionContextInterface, assetId string, reason string) error {
	if err := c.requireMSP(ctx, []string{"RegulatorMSP"}); err != nil {
		return err
	}
	if strings.TrimSpace(reason) == "" {
		return NewError(ErrInvalidInput, "reason required")
	}

	assetBytes, err := ctx.GetStub().GetState(assetId)
	if err != nil {
		return err
	}
	if assetBytes == nil {
		return NewError(ErrAssetNotFound, "asset not found")
	}

	var asset PropertyAsset
	json.Unmarshal(assetBytes, &asset)

	now := time.Now().UTC()
	if ts, err := ctx.GetStub().GetTxTimestamp(); err == nil && ts != nil {
		now = time.Unix(ts.Seconds, int64(ts.Nanos)).UTC()
	}

	asset.Status = PropertyFrozen
	asset.UpdatedAt = now

	updatedBytes, _ := json.Marshal(asset)
	return ctx.GetStub().PutState(assetId, updatedBytes)
}

// GetAllProperties - for marketplace listing (uses status index in production)
func (c *PropertyContract) GetAllProperties(ctx contractapi.TransactionContextInterface, status string) ([]*PropertyAsset, error) {
	// In production, this would be a SQL query: SELECT * FROM state WHERE docType='property' AND status=?
	// For chaincode shim, we do range query
	iterator, err := ctx.GetStub().GetStateByRange("", "")
	if err != nil {
		return nil, err
	}
	defer iterator.Close()

	var results []*PropertyAsset
	for iterator.HasNext() {
		kv, err := iterator.Next()
		if err != nil {
			continue
		}
		// Filter only property docType and ignore composite keys
		if !strings.HasPrefix(kv.Key, "PROP-") {
			continue
		}
		var asset PropertyAsset
		if err := json.Unmarshal(kv.Value, &asset); err != nil {
			continue
		}
		if asset.DocType != DocTypeProperty {
			continue
		}
		if status != "" && asset.Status != status {
			continue
		}
		results = append(results, &asset)
	}
	return results, nil
}
