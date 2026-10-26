package drunix

import "testing"

// A settled trade moves money and securities in opposite directions. These
// tests are about the durable copy only: the in-memory ledger is already
// serialised by the settlement mutex, but the database is written after that
// lock is released, and that is where a half-written trade could appear.

func settleOnce(t *testing.T, rail *UMIRail) *SettlementInstruction {
	t.Helper()
	si, err := rail.SettleDvP(DvPRequest{
		AssetID: "PROP-ACID", Seller: "originator1", Buyer: "investor1",
		Tokens: 10, PricePerTokenINR: 500, AutoAssignISIN: true,
	})
	if err != nil {
		t.Fatalf("settlement failed: %v", err)
	}
	return si
}

func acidRail(t *testing.T) (*UMIRail, *fakeStore) {
	t.Helper()
	store := newFakeStore()
	rail := NewUMIRail(NewMemorySecurities(), NewChain()).WithStore(store)
	if _, err := rail.SeedPosition("PROP-ACID", "originator1", 100, 100); err != nil {
		t.Fatalf("seed: %v", err)
	}
	if _, _, err := rail.FundWallet("investor1", 1000000); err != nil {
		t.Fatalf("fund: %v", err)
	}
	return rail, store
}

// Atomicity. Every row a settlement touches must reach the store in one
// mutation. Counting applies is the only way to see this from outside: six
// separate writes and six chances to stop halfway look identical to one write
// once they have all succeeded.
func TestSettlementPersistsAsOneMutation(t *testing.T) {
	rail, store := acidRail(t)
	before := store.applies
	settleOnce(t, rail)
	if got := store.applies - before; got != 1 {
		t.Fatalf("settlement produced %d store mutations, want exactly 1: "+
			"the cash leg and the securities leg must commit together", got)
	}
}

// Atomicity under failure. When the database refuses the write, it must hold
// none of it. A durable copy with the buyer debited and the seller not
// credited is worse than no copy at all, because a restart would trust it.
func TestFailedPersistWritesNothing(t *testing.T) {
	rail, store := acidRail(t)
	settleOnce(t, rail) // one good settlement, so the store is non-empty
	buyerBefore := store.wallets["investor1"]
	sellerBefore := store.wallets["originator1"]
	posBefore := store.positions["PROP-ACID|investor1"]
	instructionsBefore := len(store.instructions)

	store.failWrites = true
	si := settleOnce(t, rail)
	store.failWrites = false

	if store.wallets["investor1"].BalancePaise != buyerBefore.BalancePaise {
		t.Fatal("buyer wallet changed in the durable copy during a refused write")
	}
	if store.wallets["originator1"].BalancePaise != sellerBefore.BalancePaise {
		t.Fatal("seller wallet changed in the durable copy during a refused write")
	}
	if store.positions["PROP-ACID|investor1"].tokens != posBefore.tokens {
		t.Fatal("position changed in the durable copy during a refused write")
	}
	if len(store.instructions) != instructionsBefore {
		t.Fatal("instruction was stored while its legs were not")
	}
	// The settlement itself still stands: memory and the hash chain are the
	// record of truth, and a database outage must not unwind a committed trade.
	if si.Status != UMIStatusSettled {
		t.Fatalf("settlement status %q, want it to survive a persistence failure", si.Status)
	}
	if rail.PersistFailures() != 1 {
		t.Fatalf("PersistFailures()=%d, want 1, a gap between memory and disk must be countable", rail.PersistFailures())
	}
}

// Consistency. Whatever the store holds after a settlement must obey the same
// conservation rule the rail enforces in memory: cash is moved between
// wallets, never created.
func TestDurableCopyConservesCash(t *testing.T) {
	rail, store := acidRail(t)
	total := func() int64 {
		var sum int64
		for _, w := range store.wallets {
			sum += w.BalancePaise + w.ReservedPaise
		}
		return sum
	}
	settleOnce(t, rail)
	first := total()
	for i := 0; i < 5; i++ {
		settleOnce(t, rail)
	}
	if got := total(); got != first {
		t.Fatalf("cash in the durable copy moved from %d to %d paise across settlements; "+
			"transfers must conserve it", first, got)
	}
}

// Isolation is held by the settlement mutex, so the property to check is that
// concurrent settlements never interleave into an impossible durable state.
func TestConcurrentSettlementsLeaveStoreConsistent(t *testing.T) {
	rail, store := acidRail(t)
	done := make(chan struct{}, 8)
	for i := 0; i < 8; i++ {
		go func() {
			defer func() { done <- struct{}{} }()
			_, _ = rail.SettleDvP(DvPRequest{
				AssetID: "PROP-ACID", Seller: "originator1", Buyer: "investor1",
				Tokens: 1, PricePerTokenINR: 500, AutoAssignISIN: true,
			})
		}()
	}
	for i := 0; i < 8; i++ {
		<-done
	}
	var tokens int64
	for k, p := range store.positions {
		if len(k) >= 9 && k[:9] == "PROP-ACID" {
			tokens += p.tokens
		}
	}
	if tokens != 100 {
		t.Fatalf("durable positions total %d tokens, want the issued 100: "+
			"concurrent settlements created or destroyed supply", tokens)
	}
}

// Retirement is the one path that destroys supply on purpose. It must do the
// check and the debit in one step inside the ledger, which is what Burn is
// for; two steps is how the same tokens get retired twice.
func TestBurnRefusesOverRetirement(t *testing.T) {
	sec := NewMemorySecurities()
	sec.Set("PROP-ACID", "investor1", 10)
	if err := sec.Burn("PROP-ACID", "investor1", 11); err == nil {
		t.Fatal("burning more than the holder owns was allowed")
	}
	if got := sec.Position("PROP-ACID", "investor1"); got != 10 {
		t.Fatalf("refused burn still changed the position to %d, want 10 untouched", got)
	}
	if err := sec.Burn("PROP-ACID", "investor1", 10); err != nil {
		t.Fatalf("valid burn refused: %v", err)
	}
	if got := sec.Position("PROP-ACID", "investor1"); got != 0 {
		t.Fatalf("position after burn %d, want 0", got)
	}
}

// The segregated interface is the point of IssuingLedger: settlement code
// holds a SecuritiesLedger and therefore cannot mint, while issuance code
// asks for the wider contract. A compile-time assertion keeps that true.
var (
	_ SecuritiesLedger = (*MemorySecurities)(nil)
	_ IssuingLedger    = (*MemorySecurities)(nil)
)
