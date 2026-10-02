package drunix

import (
	"context"
	"errors"
	"sync"
	"testing"
)

// fakeStore is an in-process UMIStore used to prove the persistence contract
// without needing a database in CI.
type fakeStore struct {
	mu           sync.Mutex
	wallets      map[string]CBDCWallet
	positions    map[string]int64 // assetID|holder
	isins        map[string]PilotISIN
	instructions map[string]SettlementInstruction
	funded       int64
	settled      int64
	failed       int64
	failWrites   bool
	writes       int
	initCalled   bool
}

func newFakeStore() *fakeStore {
	return &fakeStore{
		wallets:      map[string]CBDCWallet{},
		positions:    map[string]int64{},
		isins:        map[string]PilotISIN{},
		instructions: map[string]SettlementInstruction{},
	}
}

func (f *fakeStore) Init(ctx context.Context) error { f.initCalled = true; return nil }

func (f *fakeStore) LoadSnapshot(ctx context.Context) (*UMISnapshot, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	snap := &UMISnapshot{FundedPaise: f.funded, Settled: f.settled, Failed: f.failed}
	for _, w := range f.wallets {
		snap.Wallets = append(snap.Wallets, w)
	}
	for k, v := range f.positions {
		asset, holder := splitKey(k)
		snap.Positions = append(snap.Positions, PositionRow{AssetID: asset, Holder: holder, Tokens: v})
	}
	for _, p := range f.isins {
		snap.ISINs = append(snap.ISINs, p)
	}
	for _, si := range f.instructions {
		snap.Instructions = append(snap.Instructions, si)
	}
	return snap, nil
}

func splitKey(k string) (string, string) {
	for i := 0; i < len(k); i++ {
		if k[i] == '|' {
			return k[:i], k[i+1:]
		}
	}
	return k, ""
}

func (f *fakeStore) guard() error {
	f.writes++
	if f.failWrites {
		return errors.New("simulated database outage")
	}
	return nil
}

func (f *fakeStore) SaveWallet(w CBDCWallet) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if err := f.guard(); err != nil {
		return err
	}
	f.wallets[w.Participant] = w
	return nil
}

func (f *fakeStore) SavePosition(assetID, holder string, tokens int64) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if err := f.guard(); err != nil {
		return err
	}
	f.positions[assetID+"|"+holder] = tokens
	return nil
}

func (f *fakeStore) SaveISIN(p PilotISIN) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if err := f.guard(); err != nil {
		return err
	}
	f.isins[p.AssetID] = p
	return nil
}

func (f *fakeStore) SaveInstruction(si SettlementInstruction) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if err := f.guard(); err != nil {
		return err
	}
	f.instructions[si.InstructionID] = si
	return nil
}

func (f *fakeStore) SaveMeta(funded, settled, failed int64) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if err := f.guard(); err != nil {
		return err
	}
	f.funded, f.settled, f.failed = funded, settled, failed
	return nil
}

func (f *fakeStore) Mode() string      { return "fake" }
func (f *fakeStore) LastError() string { return "" }
func (f *fakeStore) Close() error      { return nil }

func TestUMIStoreRoundTripRestoresEverything(t *testing.T) {
	store := newFakeStore()

	// --- first "process" ---
	sec := NewMemorySecurities()
	rail := NewUMIRail(sec, NewChain()).WithStore(store)
	if _, err := rail.SeedPosition(tAsset, "originator1", 15000); err != nil {
		t.Fatalf("seed: %v", err)
	}
	if _, _, err := rail.FundWallet("investor1", 100000); err != nil {
		t.Fatalf("fund: %v", err)
	}
	si, err := rail.SettleDvP(DvPRequest{AssetID: tAsset, Seller: "originator1", Buyer: "investor1",
		Tokens: 100, PricePerTokenINR: 500, AutoAssignISIN: true})
	if err != nil {
		t.Fatalf("settle: %v", err)
	}

	// --- restart: brand new rail, same store ---
	sec2 := NewMemorySecurities()
	rail2 := NewUMIRail(sec2, NewChain()).WithStore(store)

	buyer, ok := rail2.Wallet("investor1")
	if !ok || buyer.BalancePaise != INRToPaise(50000) {
		t.Fatalf("buyer wallet not restored: %+v", buyer)
	}
	seller, ok := rail2.Wallet("originator1")
	if !ok || seller.BalancePaise != INRToPaise(50000) {
		t.Fatalf("seller wallet not restored: %+v", seller)
	}
	if got := sec2.Position(tAsset, "investor1"); got != 100 {
		t.Errorf("buyer position = %d, want 100", got)
	}
	if got := sec2.Position(tAsset, "originator1"); got != 14900 {
		t.Errorf("seller position = %d, want 14900", got)
	}
	restored, err := rail2.Instruction(si.InstructionID)
	if err != nil {
		t.Fatalf("instruction not restored: %v", err)
	}
	if restored.Status != UMIStatusSettled || len(restored.Messages) == 0 {
		t.Errorf("instruction restored incompletely: %s, %d messages", restored.Status, len(restored.Messages))
	}
	if len(rail2.ISINs()) != 1 {
		t.Errorf("pilot ISIN register not restored: %+v", rail2.ISINs())
	}
	rec := rail2.Reconcile()
	if !rec.Conserved || rec.TotalFundedINR != 100000 || rec.SettledCount != 1 {
		t.Errorf("counters not restored: %+v", rec)
	}
	if rail2.IsEmpty() {
		t.Error("IsEmpty() true after restore — boot seeding would double-credit wallets")
	}
}

func TestUMIStoreOutageDoesNotBreakSettlement(t *testing.T) {
	store := newFakeStore()
	sec := NewMemorySecurities()
	sec.Credit(tAsset, "originator1", 15000)
	rail := NewUMIRail(sec, NewChain()).WithStore(store)
	rail.FundWallet("investor1", 100000)

	store.mu.Lock()
	store.failWrites = true // database goes away mid-demo
	store.mu.Unlock()

	si, err := rail.SettleDvP(DvPRequest{AssetID: tAsset, Seller: "originator1", Buyer: "investor1",
		Tokens: 100, PricePerTokenINR: 500, AutoAssignISIN: true})
	if err != nil {
		t.Fatalf("settlement failed because of a persistence error: %v", err)
	}
	if si.Status != UMIStatusSettled {
		t.Fatalf("status = %s, want SETTLED despite store outage", si.Status)
	}
	if got := sec.Position(tAsset, "investor1"); got != 100 {
		t.Errorf("securities leg wrong after store outage: %d", got)
	}
	if rec := rail.Reconcile(); !rec.Conserved {
		t.Error("in-memory invariants broken by a store outage")
	}
}

func TestUMIWithoutStoreIsUnchanged(t *testing.T) {
	rail, sec, _ := newTestRail(t)
	if rail.store != nil {
		t.Fatal("rail has a store by default")
	}
	st := rail.PersistenceStatus()
	if st["mode"] != "in-memory" {
		t.Errorf("persistence mode = %v, want in-memory", st["mode"])
	}
	rail.FundWallet("investor1", 100000)
	if _, err := rail.SettleDvP(DvPRequest{AssetID: tAsset, Seller: "originator1", Buyer: "investor1",
		Tokens: 10, PricePerTokenINR: 500, AutoAssignISIN: true}); err != nil {
		t.Fatalf("settle without store: %v", err)
	}
	if sec.Position(tAsset, "investor1") != 10 {
		t.Error("settlement without a store misbehaved")
	}
	// WithStore(nil) must be a no-op, not a panic
	if rail.WithStore(nil) != rail {
		t.Error("WithStore(nil) should return the same rail")
	}
}

func TestUMIStoreNilSafeHelpers(t *testing.T) {
	rail, _, _ := newTestRail(t)
	// these must all be silent no-ops without a store
	rail.pWallet(CBDCWallet{Participant: "x"})
	rail.pPosition(tAsset, "x")
	rail.pISIN(PilotISIN{AssetID: tAsset})
	rail.pInstruction(SettlementInstruction{InstructionID: "x"})
	rail.pMeta()
}
