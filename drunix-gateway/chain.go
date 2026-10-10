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
	"log"
	"sync"
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
//
// Append/Verify are safe for concurrent use: a real committing peer serialises
// block cutting, and so do we — concurrent settlement requests (e.g. the UMI
// rail under load) must never interleave prevHash reads with slice appends.
// The mutex is unexported, so the zero value and &DrunixChain{} still work and
// no existing caller or JSON payload changes.
type DrunixChain struct {
	mu     sync.Mutex
	Blocks []*DrunixBlock

	// store, when set, makes the chain durable: every committed block is
	// written to append-only storage and replayed at boot, so a restart can
	// never erase history. nil => in-memory, exactly as before.
	store BlockStore
	// sealed is set when a restored chain failed verification. A tampered
	// history is never extended; the node serves it read-only and says so.
	sealed     bool
	persistErr string
	// pending holds blocks that are committed in memory but whose durable
	// write failed. They are retried in order; until the queue drains the
	// chain reports itself degraded.
	pending []*DrunixBlock
	// hub, when set, receives a notification for every committed block so
	// live subscribers can be told. Publishing never blocks a commit.
	hub *eventHub
}

// Watch attaches the live-event hub. Separate from NewChain so the chain
// keeps working untouched when nobody is listening.
func (c *DrunixChain) Watch(h *eventHub) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.hub = h
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
//
// The block is written to durable storage inside the same critical section as
// the in-memory append, so heights can never be assigned twice or committed out
// of order. A sealed (tamper-detected) chain refuses all appends.
func (c *DrunixChain) Append(blockType string, txns []map[string]interface{}) *DrunixBlock {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.sealed {
		return nil
	}
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

	// Durability first, THEN anyone is told. Publishing before the write meant
	// a subscriber could be shown a block that a restart would erase, which
	// made "if a client is told something happened, a block exists to prove
	// it" an aspiration rather than a guarantee.
	persisted := true
	if c.store != nil {
		c.flushPendingLocked()
		if err := c.store.AppendBlockWithEvents(b, blockEvents(b)); err != nil {
			// The settlement that produced this block already happened: the
			// rail mutates wallets and positions under its own lock and
			// releases it before appending, so there is nothing here that
			// could be rolled back. Refusing the block would lose the record
			// of a transfer that has occurred — strictly worse. Instead the
			// block is queued for retry and the chain reports itself degraded,
			// which the write gate uses to stop ACCEPTING further settlements.
			log.Printf("Drunix chain: block %d committed in memory but NOT persisted: %v — queued for retry", b.Height, err)
			c.persistErr = err.Error()
			c.pending = append(c.pending, b)
			persisted = false
		}
	}

	c.Blocks = append(c.Blocks, b)

	// With a store attached the outbox relay publishes from durable rows, so
	// publishing here as well would show every subscriber the same height
	// twice. Inline publish is for the in-memory case, which has no relay.
	if c.hub != nil && (c.store == nil || !persisted) {
		c.hub.publish(LedgerEvent{Height: b.Height, Type: b.Type, Hash: b.Hash, Timestamp: b.Timestamp})
	}
	return b
}

// flushPendingLocked retries blocks whose durable write failed earlier, oldest
// first. Caller holds c.mu.
//
// Order matters: a later block must never reach storage before an earlier one,
// so the first failure stops the flush and everything behind it waits.
func (c *DrunixChain) flushPendingLocked() {
	for len(c.pending) > 0 {
		b := c.pending[0]
		if err := c.store.AppendBlockWithEvents(b, blockEvents(b)); err != nil {
			return
		}
		log.Printf("Drunix chain: block %d persisted on retry", b.Height)
		c.pending = c.pending[1:]
	}
	c.persistErr = ""
}

// Behind reports how many committed blocks have not reached durable storage.
func (c *DrunixChain) Behind() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.pending)
}

// FlushPending retries queued writes from outside the append path, so a
// recovered database is picked up without waiting for the next settlement.
func (c *DrunixChain) FlushPending() {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.store != nil {
		c.flushPendingLocked()
	}
}

// Snapshot returns a race-safe copy of the block slice for read-only use.
func (c *DrunixChain) Snapshot() []*DrunixBlock {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := make([]*DrunixBlock, len(c.Blocks))
	copy(out, c.Blocks)
	return out
}

// Durability reports how the chain is stored, for /drunix/ledger/status.
// Sealed reports whether the chain refused to adopt the history it was
// restored with. A sealed chain accepts no appends, so anything that would
// have to be proved by a block must be refused rather than reported done.
func (c *DrunixChain) Sealed() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.sealed
}

func (c *DrunixChain) Durability() map[string]interface{} {
	c.mu.Lock()
	defer c.mu.Unlock()
	mode := "in-memory (resets on restart)"
	if c.store != nil {
		mode = c.store.BlockStoreMode() + " (append-only, survives restarts)"
	}
	st := map[string]interface{}{"mode": mode, "durable": c.store != nil, "sealed": c.sealed}
	if len(c.pending) > 0 {
		st["behind"] = len(c.pending)
		st["degraded"] = true
	}
	if c.persistErr != "" {
		st["lastError"] = c.persistErr
	}
	// Pending outbox work means the ledger is advancing while its consequences
	// are not landing. Invisible until now; see docs/EVENT-OUTBOX.md §6.
	if r, ok := c.store.(interface{ OutboxStatus() OutboxStats }); ok {
		st["outbox"] = r.OutboxStatus()
	}
	return st
}

// outboxProcessor exposes the store's relay side when it has one. Unexported:
// the outbox is an implementation detail of durability, not part of the
// chain's public surface.
func (c *DrunixChain) outboxProcessor() OutboxProcessor {
	c.mu.Lock()
	defer c.mu.Unlock()
	if p, ok := c.store.(OutboxProcessor); ok {
		return p
	}
	return nil
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
	c.mu.Lock()
	defer c.mu.Unlock()
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
