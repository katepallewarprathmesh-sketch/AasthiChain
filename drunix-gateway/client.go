package drunix

// DrunixClient is the abstraction over the Drunix network (Dependency Inversion).
// The application depends on this interface, not on any concrete network stack:
//   - MockLedger (mock.go): deterministic in-process Fabric-fork simulator —
//     default for hackathon dev/demo (FAQ 19: local dev environment).
//   - FabricGateway (fabric_real.go, build tag `real`): real Drunix/Fabric
//     network via the Fabric Gateway client SDK.
type DrunixClient interface {
	// SubmitTransaction runs the full lifecycle: propose -> endorse -> commit.
	// Returns the committed TxRecord (or FAILED record on endorsement error).
	SubmitTransaction(chaincode, fn string, args []string, creatorMSP string) (*TxRecord, error)

	// EvaluateTransaction runs a query against the endorsing peer only —
	// no ledger write, no block consumed.
	EvaluateTransaction(chaincode, fn string, args []string, creatorMSP string) (*TxRecord, error)

	// GetTransaction returns a committed transaction by ID.
	GetTransaction(txID string) (*TxRecord, error)

	// LedgerStatus returns channel height / transaction count.
	LedgerStatus() (*LedgerStatus, error)
}
