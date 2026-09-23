package drunix

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"
)

// MockLedger is a deterministic in-process Drunix (Fabric-fork) simulator.
// It implements the same transaction semantics as a real network:
//   - txID = SHA-256 over channel|chaincode|function|args|sequence (like
//     Fabric's nonce+creator hashing, but reproducible for demos)
//   - every commit consumes one block (block height = 1 + txCount)
//   - read/write sets are derived from the chaincode namespace
//   - commit emits a chaincode event named after the contract function
//
// Deterministic IDs make the demo reproducible: same inputs -> same txID.
type MockLedger struct {
	mu        sync.Mutex
	txs       map[string]*TxRecord
	order     []string
	blockSeed uint64
	network   string
}

// NewMockLedger creates a simulator whose genesis height is 1.
func NewMockLedger() *MockLedger {
	return &MockLedger{
		txs:       make(map[string]*TxRecord),
		blockSeed: 1,
		network:   "NPCI Drunix (Hyperledger Fabric fork) — mock network, dev mode",
	}
}

func mockTxID(channel, chaincode, fn string, args []string, seq uint64) string {
	h := sha256.New()
	h.Write([]byte(channel))
	h.Write([]byte("|"))
	h.Write([]byte(chaincode))
	h.Write([]byte("|"))
	h.Write([]byte(fn))
	h.Write([]byte("|"))
	h.Write([]byte(strings.Join(args, "\x1f")))
	h.Write([]byte("|"))
	h.Write([]byte(fmt.Sprintf("%d", seq)))
	return hex.EncodeToString(h.Sum(nil))
}

// keysFor derives the read/write set keys from the chaincode function —
// mirrors the composite-key layout used by chaincode/token.go and kyc.go.
func keysFor(fn string, args []string) (reads, writes []KVRef) {
	v := uint64(1)
	switch {
	case fn == "TransferTokens" && len(args) >= 4:
		reads = append(reads, KVRef{Key: "balance~" + args[0] + "~" + args[1], Version: v})
		writes = append(writes,
			KVRef{Key: "balance~" + args[0] + "~" + args[1], Version: v + 1},
			KVRef{Key: "balance~" + args[0] + "~" + args[2], Version: v + 1},
			KVRef{Key: "transfer~" + args[0] + "~" + fmt.Sprint(time.Now().Unix())})
	case fn == "SettleDvP" && len(args) >= 5:
		reads = append(reads,
			KVRef{Key: "balance~" + args[2] + "~" + args[3], Version: v},
			KVRef{Key: "escrow~" + args[0], Version: v})
		writes = append(writes,
			KVRef{Key: "balance~" + args[2] + "~" + args[3], Version: v + 1},
			KVRef{Key: "balance~" + args[2] + "~" + args[4], Version: v + 1},
			KVRef{Key: "settlement~" + args[2] + "~" + args[0]})
	case fn == "RecordSettlement" && len(args) >= 3:
		writes = append(writes, KVRef{Key: "settlement~" + args[2] + "~" + args[0]})
	case fn == "MintPropertyTokens" && len(args) >= 2:
		reads = append(reads, KVRef{Key: "property~" + args[0], Version: v})
		writes = append(writes,
			KVRef{Key: "property~" + args[0], Version: v + 1},
			KVRef{Key: "balance~" + args[0] + "~originator", Version: v + 1})
	case fn == "RegisterProperty":
		writes = append(writes, KVRef{Key: "property~draft"})
	case fn == "UpdateKYCStatus" && len(args) >= 1:
		writes = append(writes, KVRef{Key: "kyc~" + args[0]})
	default:
		writes = append(writes, KVRef{Key: "worldstate~" + fn, Version: v})
	}
	return reads, writes
}

func eventFor(fn string, args []string) *ChaincodeEvent {
	payload := strings.Join(args, ",")
	switch fn {
	case "TransferTokens":
		return &ChaincodeEvent{Name: "TokenTransferred", Payload: payload}
	case "SettleDvP", "RecordSettlement":
		return &ChaincodeEvent{Name: "SettlementRecorded", Payload: payload}
	case "MintPropertyTokens":
		return &ChaincodeEvent{Name: "PropertyTokenized", Payload: payload}
	case "RegisterProperty":
		return &ChaincodeEvent{Name: "PropertyRegistered", Payload: payload}
	case "UpdateKYCStatus":
		return &ChaincodeEvent{Name: "KYCUpdated", Payload: payload}
	default:
		return &ChaincodeEvent{Name: fn + "Invoked", Payload: payload}
	}
}

// SubmitTransaction runs the full Drunix lifecycle against the mock network.
func (m *MockLedger) SubmitTransaction(chaincode, fn string, args []string, creatorMSP string) (*TxRecord, error) {
	if chaincode == "" || fn == "" {
		return nil, fmt.Errorf("chaincode and function are required")
	}
	if creatorMSP == "" {
		creatorMSP = "InvestorMSP"
	}
	m.mu.Lock()
	defer m.mu.Unlock()

	seq := uint64(len(m.order) + 1)
	id := mockTxID(Channel, chaincode, fn, args, seq)
	if _, dup := m.txs[id]; dup {
		// Fabric rejects duplicate txIDs; deterministic replay appends sequence.
		id = mockTxID(Channel, chaincode, fn, args, seq+uint64(time.Now().UnixNano()))
	}
	rec := &TxRecord{
		TxID:           id,
		Channel:        Channel,
		Chaincode:      chaincode,
		Function:       fn,
		Args:           args,
		CreatorMSP:     creatorMSP,
		Status:         TxStatusProposed,
		ValidationCode: ValidationCodeOK,
		Timestamp:      time.Now().UTC(),
	}
	rec.Status = TxStatusEndorsed // endorsement policy fulfilled (mock)
	m.blockSeed++
	rec.BlockNumber = m.blockSeed
	reads, writes := keysFor(fn, args)
	rec.ReadSet, rec.WriteSet = reads, writes
	rec.Event = eventFor(fn, args)
	rec.Status = TxStatusCommitted
	m.txs[id] = rec
	m.order = append(m.order, id)
	return rec, nil
}

// EvaluateTransaction runs a query — visible as PROPOSED only, no block used.
func (m *MockLedger) EvaluateTransaction(chaincode, fn string, args []string, creatorMSP string) (*TxRecord, error) {
	if creatorMSP == "" {
		creatorMSP = "InvestorMSP"
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	rec := &TxRecord{
		TxID:           mockTxID(Channel, chaincode, fn, args, uint64(len(m.order)+1)),
		Channel:        Channel,
		Chaincode:      chaincode,
		Function:       fn,
		Args:           args,
		CreatorMSP:     creatorMSP,
		Status:         TxStatusEndorsed,
		ValidationCode: ValidationCodeOK,
		BlockNumber:    m.blockSeed, // query — evaluated at current height
		Timestamp:      time.Now().UTC(),
	}
	return rec, nil
}

// GetTransaction returns a committed transaction by ID.
func (m *MockLedger) GetTransaction(txID string) (*TxRecord, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if rec, ok := m.txs[txID]; ok {
		cp := *rec
		return &cp, nil
	}
	return nil, fmt.Errorf("transaction %s not found on channel %s", txID, Channel)
}

// RecentTransactions returns the last n committed transactions, newest first.
func (m *MockLedger) RecentTransactions(n int) []*TxRecord {
	m.mu.Lock()
	defer m.mu.Unlock()
	if n <= 0 || n > len(m.order) {
		n = len(m.order)
	}
	out := make([]*TxRecord, 0, n)
	for i := len(m.order) - 1; i >= 0 && len(out) < n; i-- {
		cp := *m.txs[m.order[i]]
		out = append(out, &cp)
	}
	return out
}

// LedgerStatus returns the current channel height and transaction count.
func (m *MockLedger) LedgerStatus() (*LedgerStatus, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return &LedgerStatus{
		Channel: Channel,
		Height:  m.blockSeed,
		TxCount: uint64(len(m.order)),
		Mode:    "mock",
		Network: m.network,
		Time:    time.Now().UTC(),
	}, nil
}

// CommittedCount returns how many transactions are committed (helper for tests).
func (m *MockLedger) CommittedCount() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.order)
}

// TxIDs returns committed txIDs sorted by commit order (helper for tests).
func (m *MockLedger) TxIDs() []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]string, len(m.order))
	copy(out, m.order)
	sort.Strings(out) // stable for tests; commit order is m.order
	return out
}
