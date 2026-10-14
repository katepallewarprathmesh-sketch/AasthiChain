package drunix

import "testing"

// A basket must survive a restart.
//
// Regression for the production fault: the chain held UMI_BASKET_CREATED
// blocks while GET /umi/baskets answered with an empty list, because nothing
// rebuilt r.baskets at startup. Every multi-property subscribe, redeem,
// transfer and DvP then failed ERR_BASKET_NOT_FOUND against a basket the
// ledger plainly recorded.
func TestBasketsSurviveRestart(t *testing.T) {
	store := newFakeStore()
	chain := NewChain()
	sec := NewMemorySecurities()
	rail := NewUMIRail(sec, chain).WithStore(store)

	sec.Set("PROP-A", "investor1", 100)
	sec.Set("PROP-B", "investor1", 100)

	b, _, err := rail.CreateBasket("BASKET-TEST", "Two flats", "CUSTODY-1", []BasketComponent{
		{AssetID: "PROP-A", TokensPerUnit: 2, IndicativePriceINR: 1000},
		{AssetID: "PROP-B", TokensPerUnit: 3, IndicativePriceINR: 500},
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if _, _, err := rail.Subscribe(b.BasketID, "investor1", 10); err != nil {
		t.Fatalf("subscribe: %v", err)
	}
	if _, _, err := rail.TransferUnits(b.BasketID, "investor1", "investor2", 4); err != nil {
		t.Fatalf("transfer: %v", err)
	}

	// Restart: a brand new rail over the same durable chain and store. The
	// securities book is carried over because positions already have a
	// restore path through the snapshot store; baskets are what did not.
	restarted := NewUMIRail(sec, chain).WithStore(store)

	view, err := restarted.BasketByID("BASKET-TEST")
	if err != nil {
		t.Fatalf("basket lost across restart: %v", err)
	}
	if got := len(view.Components); got != 2 {
		t.Fatalf("recipe lost: %d components, want 2", got)
	}
	if view.Custodian != "CUSTODY-1" {
		t.Errorf("custodian = %q, want CUSTODY-1", view.Custodian)
	}
	if view.UnitsOutstanding != 10 {
		t.Errorf("unitsOutstanding = %d, want 10", view.UnitsOutstanding)
	}
	if view.Units["investor1"] != 6 || view.Units["investor2"] != 4 {
		t.Errorf("unit ledger not replayed: %v", view.Units)
	}
	if len(restarted.Baskets()) != 1 {
		t.Errorf("Baskets() = %d, want 1", len(restarted.Baskets()))
	}
	// Redemption against the restored basket must still work: that is the
	// operation the live rail was refusing.
	if _, _, err := restarted.Redeem("BASKET-TEST", "investor2", 4); err != nil {
		t.Fatalf("redeem after restart: %v", err)
	}
}
