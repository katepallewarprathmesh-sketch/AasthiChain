package drunix

import "testing"

// A property reported 101.1% allocated — 10,110 tokens outstanding against a
// 10,000 token issue. Seeding credited on every call, so it minted securities
// from nothing. These tests pin the cap.

func newSupplyRail() *UMIRail { return NewUMIRail(NewMemorySecurities(), NewChain()) }

func TestSeedIsAbsoluteNotAdditive(t *testing.T) {
	r := newSupplyRail()
	if _, err := r.SeedPosition("PROP-A", "originator1", 10000, 10000); err != nil {
		t.Fatalf("first seed: %v", err)
	}
	// The old bug: this used to make it 20,000.
	pos, err := r.SeedPosition("PROP-A", "originator1", 10000, 0)
	if err != nil {
		t.Fatalf("re-seed should be idempotent, got %v", err)
	}
	if pos != 10000 {
		t.Fatalf("re-seeding inflated the position to %d, want 10000", pos)
	}
	if auth, out := r.AuthorisedSupply("PROP-A"); out != 10000 || auth != 10000 {
		t.Fatalf("authorised=%d outstanding=%d, want 10000/10000", auth, out)
	}
}

func TestSeedCannotExceedAuthorisedSupply(t *testing.T) {
	r := newSupplyRail()
	r.SeedPosition("PROP-A", "originator1", 9000, 10000)
	// 9,000 already issued; 1,500 more to a second holder would be 10,500.
	if _, err := r.SeedPosition("PROP-A", "investor1", 1500, 0); err == nil {
		t.Fatal("seeding past the authorised supply was allowed")
	}
	if _, out := r.AuthorisedSupply("PROP-A"); out != 9000 {
		t.Fatalf("a rejected seed changed the book: outstanding=%d, want 9000", out)
	}
	// Exactly filling the issue is fine.
	if _, err := r.SeedPosition("PROP-A", "investor1", 1000, 0); err != nil {
		t.Fatalf("seeding up to the cap should be allowed: %v", err)
	}
	if _, out := r.AuthorisedSupply("PROP-A"); out != 10000 {
		t.Fatalf("outstanding=%d, want exactly 10000", out)
	}
}

func TestSupplyCannotBeRedeclared(t *testing.T) {
	r := newSupplyRail()
	r.SeedPosition("PROP-A", "originator1", 10000, 10000)
	if _, err := r.SeedPosition("PROP-A", "originator1", 10000, 99999); err == nil {
		t.Fatal("raising the authorised supply after issuance was allowed")
	}
}

func TestFirstSeedEstablishesSupplyWhenUndeclared(t *testing.T) {
	r := newSupplyRail()
	r.SeedPosition("PROP-B", "originator1", 500, 0)
	if auth, _ := r.AuthorisedSupply("PROP-B"); auth != 500 {
		t.Fatalf("authorised=%d, want 500", auth)
	}
	if _, err := r.SeedPosition("PROP-B", "investor1", 1, 0); err == nil {
		t.Fatal("exceeded a supply established by the first seed")
	}
}

func TestSettlementDoesNotChangeOutstanding(t *testing.T) {
	r := newSupplyRail()
	r.SeedPosition("PROP-A", "originator1", 10000, 10000)
	r.AssignISIN("PROP-A", "originator1", "NSDL")
	r.FundWallet("investor1", 5000000.0)
	if _, err := r.SettleDvP(DvPRequest{
		AssetID: "PROP-A", Seller: "originator1", Buyer: "investor1",
		Tokens: 100, PricePerTokenINR: 500,
	}); err != nil {
		t.Fatalf("settle: %v", err)
	}
	if _, out := r.AuthorisedSupply("PROP-A"); out != 10000 {
		t.Fatalf("settlement changed outstanding to %d, want 10000", out)
	}
	if b := r.SupplyBreaches(); len(b) != 0 {
		t.Fatalf("unexpected supply breach: %v", b)
	}
}

func TestReconciliationReportsSupplyBreach(t *testing.T) {
	r := newSupplyRail()
	r.SeedPosition("PROP-A", "originator1", 10000, 10000)
	// Simulate a book inflated before the cap existed, as production is today.
	r.securities.(*MemorySecurities).Credit("PROP-A", "ghost", 110)
	rec := r.Reconcile()
	if rec.SupplyConserved {
		t.Fatal("reconciliation reported supply conserved with 110 excess tokens")
	}
	if len(rec.SupplyBreaches) != 1 || rec.SupplyBreaches[0]["excessTokens"].(int64) != 110 {
		t.Fatalf("breach not reported correctly: %v", rec.SupplyBreaches)
	}
}
