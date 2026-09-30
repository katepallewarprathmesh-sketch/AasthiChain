package main

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/hyperledger/fabric-contract-api-go/contractapi"
)

type KYCContract struct {
	contractapi.Contract
}

func (c *KYCContract) requireMSP(ctx contractapi.TransactionContextInterface, allowed []string) error {
	mspID, err := ctx.GetClientIdentity().GetMSPID()
	if err != nil {
		return NewError(ErrUnauthorized, "failed to get MSP")
	}
	for _, a := range allowed {
		if mspID == a {
			return nil
		}
	}
	return NewError(ErrUnauthorized, fmt.Sprintf("MSP %s not authorized, requires %v", mspID, allowed))
}

// UpdateKYCStatus - Registrar or KYC-service (RegistrarMSP for hackathon)
func (c *KYCContract) UpdateKYCStatus(ctx contractapi.TransactionContextInterface, identityId string, status string) error {
	if err := c.requireMSP(ctx, []string{"RegistrarMSP", "RegulatorMSP"}); err != nil {
		return err
	}

	if strings.TrimSpace(identityId) == "" {
		return NewError(ErrInvalidInput, "identityId required")
	}

	validStatuses := map[string]bool{
		KYCUnverified: true,
		KYCPending:    true,
		KYCVerified:   true,
		KYCRejected:   true,
	}
	if !validStatuses[status] {
		return NewError(ErrInvalidInput, fmt.Sprintf("invalid KYC status %s", status))
	}

	now := time.Now().UTC()
	if ts, err := ctx.GetStub().GetTxTimestamp(); err == nil && ts != nil {
		now = time.Unix(ts.Seconds, int64(ts.Nanos)).UTC()
	}

	// Try composite key first
	kycKey, _ := ctx.GetStub().CreateCompositeKey("kyc", []string{identityId})
	kycBytes, _ := ctx.GetStub().GetState(kycKey)

	var record KYCRecord
	if kycBytes != nil {
		json.Unmarshal(kycBytes, &record)
	} else {
		// Also check simple key for backward compat
		simpleKey := "kyc~" + identityId
		sb, _ := ctx.GetStub().GetState(simpleKey)
		if sb != nil {
			json.Unmarshal(sb, &record)
		}
	}

	record.DocType = DocTypeKYC
	record.IdentityID = identityId
	record.KYCStatus = status
	record.VerifiedAt = now
	if record.Provider == "" {
		record.Provider = "mock"
	}

	updatedBytes, _ := json.Marshal(record)

	// Store both formats for query flexibility
	if err := ctx.GetStub().PutState(kycKey, updatedBytes); err != nil {
		return err
	}
	simpleKey := "kyc~" + identityId
	if err := ctx.GetStub().PutState(simpleKey, updatedBytes); err != nil {
		return err
	}

	ctx.GetStub().SetEvent("KYCUpdated", updatedBytes)
	return nil
}

func (c *KYCContract) GetKYCStatus(ctx contractapi.TransactionContextInterface, identityId string) (*KYCRecord, error) {
	if strings.TrimSpace(identityId) == "" {
		return nil, NewError(ErrInvalidInput, "identityId required")
	}

	kycKey, _ := ctx.GetStub().CreateCompositeKey("kyc", []string{identityId})
	kycBytes, err := ctx.GetStub().GetState(kycKey)
	if err != nil {
		return nil, err
	}
	if kycBytes == nil {
		// try simple key
		simpleKey := "kyc~" + identityId
		kycBytes, _ = ctx.GetStub().GetState(simpleKey)
		if kycBytes == nil {
			return &KYCRecord{
				DocType:    DocTypeKYC,
				IdentityID: identityId,
				KYCStatus:  KYCUnverified,
				Provider:   "mock",
			}, nil
		}
	}

	var record KYCRecord
	if err := json.Unmarshal(kycBytes, &record); err != nil {
		return nil, err
	}
	return &record, nil
}

// Batch verification for demo
func (c *KYCContract) BatchVerify(ctx contractapi.TransactionContextInterface, identityIds []string) error {
	if err := c.requireMSP(ctx, []string{"RegistrarMSP"}); err != nil {
		return err
	}
	for _, id := range identityIds {
		if err := c.UpdateKYCStatus(ctx, id, KYCVerified); err != nil {
			return err
		}
	}
	return nil
}
