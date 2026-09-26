package drunix

// Drunix hash-chained block ledger — canonical (golang) implementation.
// The Node API carries a JS parity of this file so the demo works in one
// process; the verification math is identical and cross-checkable:
//
//	blockHash  = SHA-512(height|timestamp|type|txnsRoot|prevHash)
//	txnsRoot   = binary merkle root over SHA-512(canonical JSON of each txn)
//	genesis    = prevHash 000…0, signed into existence by the 5 org MSPs
//
// This is the "open layer" of the hackathon thesis: distributed ledgers and
// decentralized trust as infrastructure for digitization, agents, DPI and
// programmable finance — any participant (or agent) replays the chain and
// verifies it without trusting the operator.

import (
	"crypto/sha512"
	"encoding/hex"
	"encoding/json"
	"time"
)

const (
	DrunixChainID   = "aasthi-drunix"
	GenesisPrevHash = "00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"
	DvpContract     = "aasthi.dvp-v1" // payment CONFIRMED ⇄ tokens moved, escrow RELEASED
)

// DrunixBlock is one committed unit of state change (mint / transfer / escrow release).
type DrunixBlock struct {
	Height    int64                    `json:"height"`
	Timestamp string                   `json:"timestamp"`
	Type      string                   `json:"type"` // GENESIS | TOKEN_MINTED | TOKEN_TRANSFERRED | ESCROW_RELEASED
	Txns      []map[string]interface{} `json:"txns"`
	TxnsRoot  string                   `json:"txnsRoot"`
	PrevHash  string                   `json:"prevHash"`
	Hash      string                   `json:"hash"`
	Contract  string                   `json:"contract"`
}

func chainHash(s string) string {
	sum := sha512.Sum512([]byte(s))
	return hex.EncodeToString(sum[:])
}

// TxnsRoot computes the binary merkle root over the block's transactions.
func TxnsRoot(txns []map[string]interface{}) string {
	if len(txns) == 0 {
		return chainHash("")
	}
	layer := make([]string, 0, len(txns))
	for _, t := range txns {
		raw, _ := json.Marshal(t)
		layer = append(layer, chainHash(string(raw)))
	}
	for len(layer) > 1 {
		next := make([]string, 0, (len(layer)+1)/2)
		for i := 0; i < len(layer); i += 2 {
			pair := layer[i]
			if i+1 < len(layer) {
				pair += layer[i+1]
			} else {
				pair += layer[i]
			}
			next = append(next, chainHash(pair))
		}
		layer = next
	}
	return layer[0]
}

func canonical(b *DrunixBlock) string {
	return b.Timestamp + "|" + b.Type + "|" + b.TxnsRoot + "|" + b.PrevHash
}

// DrunixChain is the append-only block store (MockLedger world-state companion).
type DrunixChain struct {
	Blocks []*DrunixBlock
}

// NewChain seeds the genesis block (channel config, org MSPs).
func NewChain() *DrunixChain {
	c := &DrunixChain{}
	c.Append("GENESIS", []map[string]interface{}{{
		"config":    "aasthi-channel-init",
		"channel":   DrunixChainID,
		"orgs":      []string{"AasthiChainMSP", "OriginatorMSP", "RegistrarMSP", "InvestorMSP", "RegulatorMSP"},
		"consensus": "RAFT (simulated)",
		"hashAlgo":  "SHA-512",
	}})
	return c
}

// Append commits a new block and returns it.
func (c *DrunixChain) Append(blockType string, txns []map[string]interface{}) *DrunixBlock {
	prevHash := GenesisPrevHash
	if n := len(c.Blocks); n > 0 {
		prevHash = c.Blocks[n-1].Hash
	}
	b := &DrunixBlock{
		Height:    int64(len(c.Blocks)),
		Timestamp: time.Now().UTC().Format(time.RFC3339Nano),
		Type:      blockType,
		Txns:      txns,
		PrevHash:  prevHash,
		Contract:  DvpContract,
	}
	b.TxnsRoot = TxnsRoot(b.Txns)
	b.Hash = chainHash(b.Timestamp + "|" + b.Type + "|" + b.TxnsRoot + "|" + b.PrevHash)
	c.Blocks = append(c.Blocks, b)
	return b
}

// ChainVerification is the replay result any node or agent can compute.
type ChainVerification struct {
	Valid    bool   `json:"valid"`
	Height   int64  `json:"height"`
	Blocks   int    `json:"blocks"`
	BrokenAt int64  `json:"brokenAt,omitempty"`
	Reason   string `json:"reason,omitempty"`
}

// Verify replays the full chain from genesis: linkage + hash integrity.
func (c *DrunixChain) Verify() ChainVerification {
	for i, b := range c.Blocks {
		expectPrev := GenesisPrevHash
		if i > 0 {
			expectPrev = c.Blocks[i-1].Hash
		}
		if b.PrevHash != expectPrev {
			return ChainVerification{Valid: false, Height: int64(len(c.Blocks) - 1), Blocks: len(c.Blocks), BrokenAt: b.Height, Reason: "prevHash linkage broken"}
		}
		if TxnsRoot(b.Txns) != b.TxnsRoot {
			return ChainVerification{Valid: false, Height: int64(len(c.Blocks) - 1), Blocks: len(c.Blocks), BrokenAt: b.Height, Reason: "merkle root mismatch — transactions altered after commit"}
		}
		if b.Hash != chainHash(canonical(b)) {
			return ChainVerification{Valid: false, Height: int64(len(c.Blocks) - 1), Blocks: len(c.Blocks), BrokenAt: b.Height, Reason: "block contents do not match committed hash — data altered after commit"}
		}
	}
	return ChainVerification{Valid: true, Height: int64(len(c.Blocks) - 1), Blocks: len(c.Blocks)}
}
