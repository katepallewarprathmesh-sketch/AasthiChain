// Package drunix implements the AasthiChain integration with NPCI Drunix —
// NPCI's open-source blockchain platform for tokenization (Hyperledger Fabric
// enterprise fork). All Drunix interaction in this repository is written in
// Golang, matching the Drunix platform itself.
//
// The package models the real Fabric transaction lifecycle:
//
//	PROPOSED -> ENDORSED -> COMMITTED (validationCode 0 = VALID)
//
// with deterministic transaction IDs, read/write sets, block heights and
// chaincode events, so the hackathon demo shows a faithful Drunix transaction
// flow (FAQ 11/14) without requiring a running Drunix network. Real-network
// mode compiles behind the `real` build tag (see fabric_real.go).
package drunix

import "time"

// Transaction status constants — Fabric peer semantics.
const (
	TxStatusProposed  = "PROPOSED"
	TxStatusEndorsed  = "ENDORSED"
	TxStatusCommitted = "COMMITTED"
	TxStatusFailed    = "FAILED"

	// ValidationCodeOK maps to Fabric's EndorsementPolicyFulfilled (0).
	ValidationCodeOK = 0
)

// Channel is the Drunix channel used by AasthiChain.
const Channel = "aasthichain"

// ChaincodeName is the deployed AasthiChain chaincode (Go contracts in chaincode/).
const ChaincodeName = "aasthichain"

// KVRef is a key read/written by a transaction with the ledger version seen.
type KVRef struct {
	Key     string `json:"key"`
	Version uint64 `json:"version"`
}

// ChaincodeEvent is emitted by chaincode on commit (Fabric chaincode events).
type ChaincodeEvent struct {
	Name    string `json:"name"`
	Payload string `json:"payload"`
}

// TxRecord is a Drunix transaction with full lifecycle metadata.
type TxRecord struct {
	TxID           string          `json:"txId"`
	Channel        string          `json:"channel"`
	Chaincode      string          `json:"chaincode"`
	Function       string          `json:"function"`
	Args           []string        `json:"args"`
	CreatorMSP     string          `json:"creatorMsp"`
	Status         string          `json:"status"`
	ValidationCode int             `json:"validationCode"`
	BlockNumber    uint64          `json:"blockNumber"`
	Timestamp      time.Time       `json:"timestamp"`
	ReadSet        []KVRef         `json:"readSet"`
	WriteSet       []KVRef         `json:"writeSet"`
	Event          *ChaincodeEvent `json:"event,omitempty"`
}

// LedgerStatus describes the current state of the Drunix ledger.
type LedgerStatus struct {
	Channel string    `json:"channel"`
	Height  uint64    `json:"height"`  // current block number (genesis = 1)
	TxCount uint64    `json:"txCount"` // committed transactions
	Mode    string    `json:"mode"`    // mock | real
	Network string    `json:"network"` // e.g. "NPCI Drunix (Hyperledger Fabric fork)"
	Time    time.Time `json:"time"`
}
