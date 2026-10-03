package drunix

import (
	"context"
	"errors"
	"sync"
	"testing"
)

// fakeBlockStore is an append-only block store with no update or delete path,
// mirroring the SQL contract (INSERT ... ON CONFLICT DO NOTHING).
type fakeBlockStore struct {
	mu       sync.Mutex
	rows     map[int64]DrunixBlock // height -> block, write-once
	order    []int64
	failNext bool
}

func newFakeBlockStore() *fakeBlockStore {
	return &fakeBlockStore{rows: map[int64]DrunixBlock{}}
}

func (f *fakeBlockStore) InitBlocks(ctx context.Context) error { return nil }

func (f *fakeBlockStore) LoadBlocks(ctx context.Context) ([]*DrunixBlock, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]*DrunixBlock, 0, len(f.order))
	for _, h := range f.order {
		b := f.rows[h]
		out = append(out, &b)
	}
	return out, nil
}

func (f *fakeBlockStore) AppendBlock(b *DrunixBlock) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.failNext {
		return errors.New("simulated storage outage")
	}
	if _, exists := f.rows[b.Height]; exists {
		return nil // ON CONFLICT DO NOTHING — never overwrite committed history
	}
	f.rows[b.Height] = *b
	f.order = append(f.order, b.Height)
	return nil
}

func (f *fakeBlockStore) BlockStoreMode() string { return "fake-durable" }

func TestChainSurvivesRestart(t *testing.T) {
	store := newFakeBlockStore()

	// --- process 1: genesis + some settlements ---
	c1, v1 := NewChainWithStore(store)
	if !v1.Valid || len(c1.Blocks) != 1 || c1.Blocks[0].Type != "GENESIS" {
		t.Fatalf("fresh chain should start at genesis, got %d blocks", len(c1.Blocks))
	}
	c1.Append(BlockUMIDvPSettled, []map[string]interface{}{{"isin": "AASTHI758681", "cashINR": 50000}})
	c1.Append(BlockUMIServicingPaid, []map[string]interface{}{{"amountINR": 6000}})
	wantHeight := c1.Verify().Height
	wantTip := c1.Blocks[len(c1.Blocks)-1].Hash

	// --- process 2: restart, nothing in memory ---
	c2, v2 := NewChainWithStore(store)
	if !v2.Valid {
		t.Fatalf("restored chain failed verification: %+v", v2)
	}
	if len(c2.Blocks) != 3 {
		t.Fatalf("restored %d blocks, want 3 — history was erased by a restart", len(c2.Blocks))
	}
	if v2.Height != wantHeight {
		t.Errorf("height = %d, want %d", v2.Height, wantHeight)
	}
	if tip := c2.Blocks[len(c2.Blocks)-1].Hash; tip != wantTip {
		t.Errorf("tip hash changed across restart: %s != %s", tip, wantTip)
	}
	if c2.Blocks[1].Type != BlockUMIDvPSettled || c2.Blocks[1].Txns[0]["isin"] != "AASTHI758681" {
		t.Errorf("block payload not restored faithfully: %+v", c2.Blocks[1])
	}

	// --- the chain keeps growing from the restored tip, not from genesis ---
	b := c2.Append(BlockUMIDvPSettled, []map[string]interface{}{{"isin": "AASTHI758681", "cashINR": 25000}})
	if b.Height != 3 {
		t.Errorf("new block height = %d, want 3 (must continue, not restart numbering)", b.Height)
	}
	if b.PrevHash != wantTip {
		t.Errorf("new block does not link to the restored tip")
	}
	if !c2.Verify().Valid {
		t.Error("chain invalid after appending to restored history")
	}
}

func TestStoredBlocksAreNeverOverwritten(t *testing.T) {
	store := newFakeBlockStore()
	c, _ := NewChainWithStore(store)
	orig := c.Append(BlockUMIDvPSettled, []map[string]interface{}{{"cashINR": 50000}})

	// an attacker (or a bug) tries to rewrite committed history at that height
	forged := &DrunixBlock{Height: orig.Height, Type: "FORGED", Timestamp: orig.Timestamp,
		TxnsRoot: orig.TxnsRoot, PrevHash: orig.PrevHash, Hash: "deadbeef",
		Txns: []map[string]interface{}{{"cashINR": 999999}}}
	if err := store.AppendBlock(forged); err != nil {
		t.Fatalf("append returned error: %v", err)
	}

	blocks, _ := store.LoadBlocks(context.Background())
	if blocks[orig.Height].Hash != orig.Hash || blocks[orig.Height].Type == "FORGED" {
		t.Fatal("committed block was overwritten — the store is not append-only")
	}
}

func TestTamperedChainIsSealedNotExtended(t *testing.T) {
	store := newFakeBlockStore()
	c, _ := NewChainWithStore(store)
	c.Append(BlockUMIDvPSettled, []map[string]interface{}{{"cashINR": 50000}})

	// tamper with stored history directly, as if someone edited the database
	store.mu.Lock()
	b := store.rows[1]
	b.Txns = []map[string]interface{}{{"cashINR": 999999}}
	store.rows[1] = b
	store.mu.Unlock()

	c2, v := NewChainWithStore(store)
	if v.Valid {
		t.Fatal("verification passed on tampered history — the tamper-evidence is broken")
	}
	if v.Reason == "" || v.BrokenAt != 1 {
		t.Errorf("tamper not localised: %+v", v)
	}
	if got := c2.Append(BlockUMIDvPSettled, nil); got != nil {
		t.Error("a sealed chain must refuse new blocks rather than extend tampered history")
	}
	if d := c2.Durability(); d["sealed"] != true {
		t.Errorf("durability should report sealed: %+v", d)
	}
}

func TestBlockPersistenceFailureDoesNotBlockCommit(t *testing.T) {
	store := newFakeBlockStore()
	c, _ := NewChainWithStore(store)
	store.mu.Lock()
	store.failNext = true
	store.mu.Unlock()

	b := c.Append(BlockUMIDvPSettled, []map[string]interface{}{{"cashINR": 50000}})
	if b == nil {
		t.Fatal("storage outage must not stop a block being committed in memory")
	}
	if !c.Verify().Valid {
		t.Error("chain invalid after a storage outage")
	}
	if d := c.Durability(); d["lastError"] == nil {
		t.Error("a failed persist should be surfaced in Durability()")
	}
}

func TestChainWithoutStoreIsUnchanged(t *testing.T) {
	c, v := NewChainWithStore(nil)
	if !v.Valid || len(c.Blocks) != 1 {
		t.Fatalf("nil store should behave like NewChain(), got %d blocks", len(c.Blocks))
	}
	if c.Append("X", nil) == nil {
		t.Error("in-memory chain must still accept blocks")
	}
	d := c.Durability()
	if d["durable"] != false {
		t.Errorf("durability should report in-memory: %+v", d)
	}
}
