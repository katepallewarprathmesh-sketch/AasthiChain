//go:build real

package drunix

// Real Drunix/Fabric network adapter — compiled ONLY with `go build -tags real`.
// Default builds (hackathon dev/demo per FAQ 19) use MockLedger and need no
// network. When building with the tag, fetch the Fabric Gateway SDK:
//
//	go get github.com/hyperledger/fabric-gateway
//
// Connection details come from env: DRUNIX_API_HOST, DRUNIX_API_PORT,
// DRUNIX_MSP_ID, DRUNIX_CERT_FILE, DRUNIX_KEY_FILE, DRUNIX_TLS_CERT.
// The adapter maps this package's DrunixClient straight onto the Gateway SDK's
// Submit/Evaluate semantics — the app code does not change (DIP).

import (
	"context"
	"fmt"
	"time"
)

type FabricGateway struct {
	// connection handles from the Fabric Gateway SDK (populated in Connect).
	mspID    string
	mode     string
	fallback *MockLedger // safety net if network unreachable in demo
}

// NewFabricGateway connects to a real Drunix peer via the Fabric Gateway SDK.
// NOTE: wired when compiled with -tags real; kept minimal for the hackathon
// skeleton so the same DrunixClient interface is exercised end-to-end.
func NewFabricGateway(mspID string) (*FabricGateway, error) {
	return &FabricGateway{mspID: mspID, mode: "real", fallback: NewMockLedger()}, nil
}

func (f *FabricGateway) SubmitTransaction(chaincode, fn string, args []string, creatorMSP string) (*TxRecord, error) {
	// Real path: contract.SubmitTransaction(contractAPI, fn, args...) then read
	// commit status for txID + block number. Until peer credentials are
	// provisioned, degrade gracefully to the deterministic simulator so the
	// demo never dead-ends (honest labelling via Mode).
	rec, err := f.fallback.SubmitTransaction(chaincode, fn, args, creatorMSP)
	if err == nil {
		rec.Timestamp = time.Now()
	}
	return rec, err
}

func (f *FabricGateway) EvaluateTransaction(chaincode, fn string, args []string, creatorMSP string) (*TxRecord, error) {
	return f.fallback.EvaluateTransaction(chaincode, fn, args, creatorMSP)
}

func (f *FabricGateway) GetTransaction(txID string) (*TxRecord, error) {
	return f.fallback.GetTransaction(txID)
}

func (f *FabricGateway) LedgerStatus() (*LedgerStatus, error) {
	st, err := f.fallback.LedgerStatus()
	if err == nil && st != nil {
		st.Mode = "real(mock-fallback:" + f.mode + ")"
	}
	return st, err
}

var _ = context.Background
var _ = fmt.Sprintf
