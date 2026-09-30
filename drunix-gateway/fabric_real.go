//go:build real

package drunix

// Real Drunix/Fabric network adapter — compiled ONLY with `go build -tags real`.
//
// Drunix is NPCI's fork of Hyperledger Fabric and is documented as backwards
// compatible with HLF v2.5.x, so this adapter targets the standard Fabric
// Gateway SDK:
//
//	go get github.com/hyperledger/fabric-gateway
//
// Connection details come from env: DRUNIX_API_HOST, DRUNIX_API_PORT,
// DRUNIX_MSP_ID, DRUNIX_CERT_FILE, DRUNIX_KEY_FILE, DRUNIX_TLS_CERT.
//
// ---------------------------------------------------------------------------
// WHY THIS RETURNS ERRORS INSTEAD OF DATA
//
// This adapter previously held a *MockLedger as a "safety net" and forwarded
// every call to it, so building with -tags real produced a client that looked
// like it was talking to a Drunix network and was in fact returning simulated
// results. A settlement component that silently degrades to fabricated data is
// worse than one that is missing: the caller cannot tell the difference, and
// neither can an auditor reading the logs.
//
// So the fallback is gone. Until the Gateway SDK is actually wired, every
// method fails loudly with ErrGatewayNotWired. Callers that want simulation
// must ask for it explicitly by constructing a MockLedger.
// ---------------------------------------------------------------------------

import (
	"errors"
	"fmt"
	"os"
)

// ErrGatewayNotWired is returned by every FabricGateway method until the
// Fabric Gateway SDK is connected. It is deliberately not recoverable by
// falling back to simulation.
var ErrGatewayNotWired = errors.New(
	"drunix: real gateway is not wired yet — refusing to return simulated data from the real adapter; " +
		"use NewMockLedger() explicitly if simulation is what you want")

// requiredEnv lists the settings a real connection cannot work without.
var requiredEnv = []string{
	"DRUNIX_API_HOST",
	"DRUNIX_MSP_ID",
	"DRUNIX_CERT_FILE",
	"DRUNIX_KEY_FILE",
}

type FabricGateway struct {
	mspID string
	host  string
	// No fallback field. That is the point.
}

// NewFabricGateway validates that the environment describes a real endpoint.
// It refuses to construct a client that cannot possibly reach a network,
// rather than returning one that quietly simulates.
func NewFabricGateway(mspID string) (*FabricGateway, error) {
	var missing []string
	for _, k := range requiredEnv {
		if os.Getenv(k) == "" {
			missing = append(missing, k)
		}
	}
	if len(missing) > 0 {
		return nil, fmt.Errorf("drunix: cannot build a real gateway, missing env %v: %w", missing, ErrGatewayNotWired)
	}
	if mspID == "" {
		mspID = os.Getenv("DRUNIX_MSP_ID")
	}
	return &FabricGateway{mspID: mspID, host: os.Getenv("DRUNIX_API_HOST")}, nil
}

// TODO(phase-2): replace each body with the Gateway SDK equivalent —
// client.Connect -> gw.GetNetwork(channel).GetContract(chaincode) ->
// SubmitTransaction / EvaluateTransaction, then read commit status for the
// txID and block number.

func (f *FabricGateway) SubmitTransaction(chaincode, fn string, args []string, creatorMSP string) (*TxRecord, error) {
	return nil, fmt.Errorf("SubmitTransaction(%s.%s): %w", chaincode, fn, ErrGatewayNotWired)
}

func (f *FabricGateway) EvaluateTransaction(chaincode, fn string, args []string, creatorMSP string) (*TxRecord, error) {
	return nil, fmt.Errorf("EvaluateTransaction(%s.%s): %w", chaincode, fn, ErrGatewayNotWired)
}

func (f *FabricGateway) GetTransaction(txID string) (*TxRecord, error) {
	return nil, fmt.Errorf("GetTransaction(%s): %w", txID, ErrGatewayNotWired)
}

func (f *FabricGateway) LedgerStatus() (*LedgerStatus, error) {
	return nil, fmt.Errorf("LedgerStatus: %w", ErrGatewayNotWired)
}

// Compile-time proof the adapter still satisfies the interface the app depends on.
var _ DrunixClient = (*FabricGateway)(nil)
