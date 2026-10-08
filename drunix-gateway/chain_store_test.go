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
	// outbox mirrors umi_outbox: keyed by (topic, dedupe_key) for the UNIQUE
	// constraint, and only ever written in the same call as the block.
	outbox map[string]OutboxEvent
}

func newFakeBlockStore() *fakeBlockStore {
	return &fakeBlockStore{rows: map[int64]DrunixBlock{}, outbox: map[string]OutboxEvent{}}
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

func (f *fakeBlockStore) AppendBlockWithEvents(b *DrunixBlock, evs []OutboxEvent) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	// A failure must leave neither the block nor its events behind, which is
	// what the real implementation gets from wrapping both in one transaction.
	if f.failNext {
		return errors.New("simulated storage outage")
	}
	if _, exists := f.rows[b.Height]; exists {
		return nil // ON CONFLICT DO NOTHING — never overwrite committed history
	}
	f.rows[b.Height] = *b
	f.order = append(f.order, b.Height)
	for _, e := range evs {
		key := e.Topic + "|" + e.DedupeKey
		if _, dup := f.outbox[key]; dup {
			continue // UNIQUE (topic, dedupe_key)
		}
		f.outbox[key] = e
	}
	return nil
}

func (f *fakeBlockStore) pending() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.outbox)
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
	if err := store.AppendBlockWithEvents(forged, nil); err != nil {
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

// --- outbox, step 1: the atomic write (docs/EVENT-OUTBOX.md §7 tests 1, 2, 6)

// A block and the events it implies are one fact. If the write fails, the
// store must be left with neither — not a block whose consequences were lost.
func TestOutboxBlockAndEventsCommitTogether(t *testing.T) {
	store := newFakeBlockStore()
	c, _ := NewChainWithStore(store)

	if store.pending() != 1 {
		t.Fatalf("genesis should have produced one outbox row, got %d", store.pending())
	}

	c.Append(BlockUMIDvPSettled, []map[string]interface{}{{"isin": "AASTHI758681"}})
	if got := store.pending(); got != 2 {
		t.Fatalf("after one settlement want 2 outbox rows, got %d", got)
	}

	// Now the storage layer refuses the write.
	store.failNext = true
	before := store.pending()
	c.Append(BlockUMIDvPSettled, []map[string]interface{}{{"isin": "AASTHI999999"}})
	if got := store.pending(); got != before {
		t.Fatalf("a failed append must not leave an event behind: %d -> %d", before, got)
	}
	blocks, _ := store.LoadBlocks(context.Background())
	for _, b := range blocks {
		for _, txn := range b.Txns {
			if txn["isin"] == "AASTHI999999" {
				t.Fatal("a failed append must not leave a block behind either")
			}
		}
	}
}

// The dedupe key is derived from the block height, so replaying the same block
// cannot produce a second notification. This is what makes an at-least-once
// relay safe to build on top.
func TestOutboxDedupeKeyIsStable(t *testing.T) {
	b := &DrunixBlock{Height: 7, Type: BlockUMIDvPSettled, Hash: "abc", Timestamp: "t"}
	first := blockEvents(b)
	second := blockEvents(b)
	if len(first) != 1 || first[0].DedupeKey != second[0].DedupeKey {
		t.Fatalf("dedupe key must be derived from the fact, got %q then %q",
			first[0].DedupeKey, second[0].DedupeKey)
	}
	if first[0].DedupeKey != "ledger.block:7" {
		t.Fatalf("unexpected dedupe key %q", first[0].DedupeKey)
	}

	store := newFakeBlockStore()
	if err := store.AppendBlockWithEvents(b, first); err != nil {
		t.Fatal(err)
	}
	// Same height replayed: ON CONFLICT DO NOTHING on both tables.
	if err := store.AppendBlockWithEvents(b, second); err != nil {
		t.Fatal(err)
	}
	if got := store.pending(); got != 1 {
		t.Fatalf("replaying a block must not duplicate its events, got %d", got)
	}
}

// No store configured is the default everywhere (local runs, every test, the
// demo instance today). That path must be untouched by any of this.
func TestOutboxAbsentWithoutStore(t *testing.T) {
	c := NewChain()
	hub := newEventHub()
	c.Watch(hub)
	id, ch := hub.subscribe()
	defer hub.unsubscribe(id)

	b := c.Append(BlockUMIDvPSettled, []map[string]interface{}{{"isin": "AASTHI111111"}})
	if b == nil {
		t.Fatal("append must still work with no durable store")
	}
	select {
	case ev := <-ch:
		if ev.Height != b.Height {
			t.Fatalf("subscriber got height %d, want %d", ev.Height, b.Height)
		}
	default:
		t.Fatal("live subscribers must still be notified with no store configured")
	}
}
