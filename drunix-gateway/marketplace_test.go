package drunix

import (
	"errors"
	"sync"
	"testing"
)

func mktRail(t *testing.T) *UMIRail {
	t.Helper()
	r := NewUMIRail(NewMemorySecurities(), NewChain())
	if _, err := r.SeedPosition("PROP-A", "alice", 1000, 1000); err != nil {
		t.Fatalf("seed: %v", err)
	}
	return r
}

func TestOfferCannotPromiseTokensTwice(t *testing.T) {
	r := mktRail(t)
	if _, err := r.CreateOffer("PROP-A", "alice", 600, 100); err != nil {
		t.Fatalf("first offer: %v", err)
	}
	// 600 already promised out of 1000; 500 more would oversell.
	if _, err := r.CreateOffer("PROP-A", "alice", 500, 100); !errors.Is(err, ErrOfferOversold) {
		t.Fatalf("want ErrOfferOversold, got %v", err)
	}
	// The remainder is still listable.
	if _, err := r.CreateOffer("PROP-A", "alice", 400, 100); err != nil {
		t.Fatalf("remainder should list: %v", err)
	}
}

func TestCancelledOfferFreesItsTokens(t *testing.T) {
	r := mktRail(t)
	o, _ := r.CreateOffer("PROP-A", "alice", 1000, 100)
	if _, err := r.CreateOffer("PROP-A", "alice", 1, 100); !errors.Is(err, ErrOfferOversold) {
		t.Fatalf("everything is promised, want oversold, got %v", err)
	}
	if _, err := r.CancelOffer(o.OfferID, "alice"); err != nil {
		t.Fatalf("cancel: %v", err)
	}
	if _, err := r.CreateOffer("PROP-A", "alice", 1000, 100); err != nil {
		t.Fatalf("cancelling should free the tokens: %v", err)
	}
}

func TestOnlySellerCancels(t *testing.T) {
	r := mktRail(t)
	o, _ := r.CreateOffer("PROP-A", "alice", 10, 100)
	if _, err := r.CancelOffer(o.OfferID, "mallory"); !errors.Is(err, ErrOfferNotSeller) {
		t.Fatalf("want ErrOfferNotSeller, got %v", err)
	}
	if _, err := r.CancelOffer(o.OfferID, "alice"); err != nil {
		t.Fatalf("seller cancel: %v", err)
	}
	if _, err := r.CancelOffer(o.OfferID, "alice"); !errors.Is(err, ErrOfferClosed) {
		t.Fatalf("second cancel should be refused, got %v", err)
	}
}

// The reason the book reserves units before settling: without it, two buyers
// racing for the same tail could both be filled and the asset would be
// oversold. One winner, one clean rejection.
func TestConcurrentTakesCannotOverfill(t *testing.T) {
	r := mktRail(t)
	o, _ := r.CreateOffer("PROP-A", "alice", 100, 10)
	for _, b := range []string{"b1", "b2", "b3", "b4", "b5", "b6", "b7", "b8"} {
		if _, _, err := r.FundWallet(b, 100000); err != nil {
			t.Fatalf("fund %s: %v", b, err)
		}
	}

	var wg sync.WaitGroup
	var mu sync.Mutex
	filled := 0
	for _, b := range []string{"b1", "b2", "b3", "b4", "b5", "b6", "b7", "b8"} {
		wg.Add(1)
		go func(buyer string) {
			defer wg.Done()
			// Each wants 20 of the 100 on offer; only five can win.
			if _, _, err := r.TakeOffer(o.OfferID, buyer, 20, false); err == nil {
				mu.Lock()
				filled++
				mu.Unlock()
			}
		}(b)
	}
	wg.Wait()

	if filled != 5 {
		t.Fatalf("100 tokens in lots of 20 should fill exactly 5 buyers, filled %d", filled)
	}
	got, err := r.Offer(o.OfferID)
	if err != nil {
		t.Fatalf("read back: %v", err)
	}
	if got.TokensRemaining != 0 || got.Status != OfferFilled {
		t.Fatalf("offer should be exhausted, got %d left status %s", got.TokensRemaining, got.Status)
	}
	// The seller cannot have delivered more than they held.
	if pos := r.PositionOf("PROP-A", "alice"); pos != 900 {
		t.Fatalf("alice should have delivered exactly 100 tokens, holds %d", pos)
	}
}

func TestFailedSettlementLeavesTheOfferOpen(t *testing.T) {
	r := mktRail(t)
	o, _ := r.CreateOffer("PROP-A", "alice", 100, 1000)
	// No wallet at all for this buyer: settlement must fail.
	if _, _, err := r.TakeOffer(o.OfferID, "pauper", 10, false); err == nil {
		t.Fatal("expected the settlement to fail")
	}
	got, _ := r.Offer(o.OfferID)
	if got.TokensRemaining != 100 || got.Status != OfferOpen {
		t.Fatalf("a failed take must not consume the offer: %d left, status %s",
			got.TokensRemaining, got.Status)
	}
	if len(got.Fills) != 0 {
		t.Fatalf("a failed take must not record a fill, got %d", len(got.Fills))
	}
}

func TestDryRunTakeChangesNothing(t *testing.T) {
	r := mktRail(t)
	o, _ := r.CreateOffer("PROP-A", "alice", 100, 10)
	if _, _, err := r.FundWallet("bob", 100000); err != nil {
		t.Fatalf("fund: %v", err)
	}
	if _, _, err := r.TakeOffer(o.OfferID, "bob", 10, true); err != nil {
		t.Fatalf("dry run: %v", err)
	}
	got, _ := r.Offer(o.OfferID)
	if got.TokensRemaining != 100 || len(got.Fills) != 0 {
		t.Fatalf("dry run must not consume the offer: %d left, %d fills",
			got.TokensRemaining, len(got.Fills))
	}
	if pos := r.PositionOf("PROP-A", "bob"); pos != 0 {
		t.Fatalf("dry run must not deliver tokens, bob holds %d", pos)
	}
}

func TestSelfTradeRejected(t *testing.T) {
	r := mktRail(t)
	o, _ := r.CreateOffer("PROP-A", "alice", 10, 10)
	if _, _, err := r.TakeOffer(o.OfferID, "alice", 1, false); !errors.Is(err, ErrOfferSelfTrade) {
		t.Fatalf("want ErrOfferSelfTrade, got %v", err)
	}
}
