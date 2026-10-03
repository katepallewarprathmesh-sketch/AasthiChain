package drunix

import (
	"context"
	"errors"
	"sync"
	"testing"
)

type posRow struct{ tokens, rev int64 }

// fakeStore is an in-process UMIStore used to prove the persistence contract
// without needing a database in CI.
type fakeStore struct {
	mu           sync.Mutex
	wallets      map[string]CBDCWallet
	positions    map[string]posRow // assetID|holder
	isins        map[string]PilotISIN
	instructions map[string]SettlementInstruction
	funded       int64
	settled      int64
	failed       int64
	servicing    []ServicingRecord
	failWrites   bool
	writes       int
	initCalled   bool
}

func newFakeStore() *fakeStore {
	return &fakeStore{
		wallets:      map[string]CBDCWallet{},
		positions:    map[string]posRow{},
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
		if w.Rev > snap.MaxRev {
			snap.MaxRev = w.Rev
		}
		snap.Wallets = append(snap.Wallets, w)
	}
	for k, v := range f.positions {
		asset, holder := splitKey(k)
		if v.rev > snap.MaxRev {
			snap.MaxRev = v.rev
		}
		snap.Positions = append(snap.Positions, PositionRow{AssetID: asset, Holder: holder, Tokens: v.tokens, Rev: v.rev})
	}
	for _, p := range f.isins {
		snap.ISINs = append(snap.ISINs, p)
	}
	for _, rec := range f.servicing {
		if rec.Rev > snap.MaxRev {
			snap.MaxRev = rec.Rev
		}
		snap.Servicing = append(snap.Servicing, rec)
	}
	for _, si := range f.instructions {
		if si.Rev > snap.MaxRev {
			snap.MaxRev = si.Rev
		}
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
	if prev, ok := f.wallets[w.Participant]; ok && prev.Rev > w.Rev {
		return nil // rev guard
	}
	f.wallets[w.Participant] = w
	return nil
}

func (f *fakeStore) SavePosition(assetID, holder string, tokens, rev int64) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if err := f.guard(); err != nil {
		return err
	}
	k := assetID + "|" + holder
	if prev, ok := f.positions[k]; ok && prev.rev >= rev {
		return nil // rev guard, same as the SQL WHERE clause
	}
	f.positions[k] = posRow{tokens: tokens, rev: rev}
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

func (f *fakeStore) SaveServicing(rec ServicingRecord) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if err := f.guard(); err != nil {
		return err
	}
	f.servicing = append(f.servicing, rec)
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
	rail.pPosition([]PositionRow{{AssetID: tAsset, Holder: "x"}})
	rail.pISIN(PilotISIN{AssetID: tAsset})
	rail.pInstruction(SettlementInstruction{InstructionID: "x"})
	rail.pMeta()
}

func TestInstructionBlockAnchorSurvivesRestart(t *testing.T) {
	store := newFakeStore()
	sec := NewMemorySecurities()
	rail := NewUMIRail(sec, NewChain()).WithStore(store)
	rail.SeedPosition(tAsset, "originator1", 15000)
	rail.FundWallet("investor1", 100000)

	si, err := rail.SettleDvP(DvPRequest{AssetID: tAsset, Seller: "originator1", Buyer: "investor1",
		Tokens: 100, PricePerTokenINR: 500, AutoAssignISIN: true})
	if err != nil {
		t.Fatalf("settle: %v", err)
	}
	if si.BlockHeight == 0 || si.BlockHash == "" {
		t.Fatalf("settled instruction has no block anchor: height=%d hash=%q", si.BlockHeight, si.BlockHash)
	}

	// restart: the anchor must come back, or the UI cannot link a settlement
	// to the block that proves it
	rail2 := NewUMIRail(NewMemorySecurities(), NewChain()).WithStore(store)
	got, err := rail2.Instruction(si.InstructionID)
	if err != nil {
		t.Fatalf("instruction not restored: %v", err)
	}
	if got.BlockHeight != si.BlockHeight {
		t.Errorf("blockHeight after restart = %d, want %d", got.BlockHeight, si.BlockHeight)
	}
	if got.BlockHash != si.BlockHash {
		t.Errorf("blockHash after restart = %q, want %q", got.BlockHash, si.BlockHash)
	}
}

// reorderingStore delivers writes out of order, the way concurrent settlements
// racing after the mutex is released actually behave in production.
type reorderingStore struct {
	*fakeStore
	held []CBDCWallet
}

func (r *reorderingStore) SaveWallet(w CBDCWallet) error {
	r.held = append(r.held, w)
	return nil
}

// flushReversed applies the buffered writes newest-first — the worst case.
func (r *reorderingStore) flushReversed() {
	for i := len(r.held) - 1; i >= 0; i-- {
		w := r.held[i]
		prev, exists := r.fakeStore.wallets[w.Participant]
		if exists && prev.Rev > w.Rev {
			continue // the rev guard: a stale snapshot must not win
		}
		r.fakeStore.wallets[w.Participant] = w
	}
	r.held = nil
}

func TestStaleWalletWriteCannotWinTheRace(t *testing.T) {
	base := newFakeStore()
	store := &reorderingStore{fakeStore: base}

	sec := NewMemorySecurities()
	rail := NewUMIRail(sec, NewChain()).WithStore(store)
	rail.SeedPosition(tAsset, "originator1", 15000)
	rail.FundWallet("investor1", 100000)

	// three sequential settlements; the buyer's balance strictly decreases
	for i := 0; i < 3; i++ {
		if _, err := rail.SettleDvP(DvPRequest{AssetID: tAsset, Seller: "originator1", Buyer: "investor1",
			Tokens: 10, PricePerTokenINR: 500, AutoAssignISIN: true}); err != nil {
			t.Fatalf("settle %d: %v", i, err)
		}
	}
	want, _ := rail.Wallet("investor1")

	// writes land in reverse order — without the rev guard the oldest, richest
	// snapshot would be the one left in the database
	store.flushReversed()

	got := base.wallets["investor1"]
	if got.BalancePaise != want.BalancePaise {
		t.Fatalf("persisted balance = %d, want %d — a stale write overwrote newer state (money invented/destroyed)",
			got.BalancePaise, want.BalancePaise)
	}

	// and a restart must agree with the live rail
	rail2 := NewUMIRail(NewMemorySecurities(), NewChain()).WithStore(base)
	if rec := rail2.Reconcile(); !rec.Conserved {
		t.Errorf("conservation broken after restart: funded ₹%.2f vs held ₹%.2f",
			rec.TotalFundedINR, rec.TotalBalanceINR)
	}
}

func TestRevisionsResumeAboveRestoredHighWaterMark(t *testing.T) {
	store := newFakeStore()
	sec := NewMemorySecurities()
	rail := NewUMIRail(sec, NewChain()).WithStore(store)
	rail.SeedPosition(tAsset, "originator1", 15000)
	rail.FundWallet("investor1", 100000)
	rail.SettleDvP(DvPRequest{AssetID: tAsset, Seller: "originator1", Buyer: "investor1",
		Tokens: 10, PricePerTokenINR: 500, AutoAssignISIN: true})

	before := store.wallets["investor1"].Rev
	if before == 0 {
		t.Fatal("no revision was stamped")
	}

	// restart, then keep trading: writes must still land
	rail2 := NewUMIRail(NewMemorySecurities(), NewChain()).WithStore(store)
	rail2.SettleDvP(DvPRequest{AssetID: tAsset, Seller: "originator1", Buyer: "investor1",
		Tokens: 10, PricePerTokenINR: 500, AutoAssignISIN: true})

	after := store.wallets["investor1"]
	if after.Rev <= before {
		t.Fatalf("revision after restart = %d, not above restored high-water mark %d — later writes would be discarded",
			after.Rev, before)
	}
	live, _ := rail2.Wallet("investor1")
	if after.BalancePaise != live.BalancePaise {
		t.Errorf("persisted balance %d != live balance %d after restart", after.BalancePaise, live.BalancePaise)
	}
}

func TestServicingIncomeIsPerHolderAndSurvivesRestart(t *testing.T) {
	store := newFakeStore()
	sec := NewMemorySecurities()
	rail := NewUMIRail(sec, NewChain()).WithStore(store)
	rail.SeedPosition(tAsset, "originator1", 1000)
	rail.FundWallet("originator1", 100000)
	rail.FundWallet("investor1", 100000)
	rail.FundWallet("investor2", 100000)

	// two investors with different stakes => different shares of the rent
	if _, err := rail.SettleDvP(DvPRequest{AssetID: tAsset, Seller: "originator1", Buyer: "investor1",
		Tokens: 300, PricePerTokenINR: 100, AutoAssignISIN: true}); err != nil {
		t.Fatalf("dvp1: %v", err)
	}
	if _, err := rail.SettleDvP(DvPRequest{AssetID: tAsset, Seller: "originator1", Buyer: "investor2",
		Tokens: 100, PricePerTokenINR: 100, AutoAssignISIN: true}); err != nil {
		t.Fatalf("dvp2: %v", err)
	}
	if _, err := rail.Servicing(tAsset, "originator1", 10000); err != nil {
		t.Fatalf("servicing: %v", err)
	}

	t1, rows1 := rail.Income("investor1")
	t2, rows2 := rail.Income("investor2")
	if len(rows1) != 1 || len(rows2) != 1 {
		t.Fatalf("expected one payout each, got %d and %d", len(rows1), len(rows2))
	}
	if !(t1 > t2) {
		t.Errorf("investor1 holds 3x the tokens but earned ₹%.2f vs ₹%.2f", t1, t2)
	}
	if rows1[0].BlockHeight == 0 {
		t.Error("payout is not anchored to a ledger block")
	}
	if rows1[0].Holder != "investor1" || rows1[0].Payer != "originator1" {
		t.Errorf("payout attributed wrongly: %+v", rows1[0])
	}

	// a holder with no servicing must get an empty answer, not someone else's
	if total, rows := rail.Income("nobody"); total != 0 || len(rows) != 0 {
		t.Errorf("unknown holder leaked data: %v %v", total, rows)
	}

	// restart
	rail2 := NewUMIRail(NewMemorySecurities(), NewChain()).WithStore(store)
	r1, got1 := rail2.Income("investor1")
	if len(got1) != 1 || r1 != t1 {
		t.Fatalf("income after restart = ₹%.2f (%d rows), want ₹%.2f (1 row)", r1, len(got1), t1)
	}
	if got1[0].BlockHeight != rows1[0].BlockHeight {
		t.Errorf("block anchor lost across restart: %d != %d", got1[0].BlockHeight, rows1[0].BlockHeight)
	}
}
