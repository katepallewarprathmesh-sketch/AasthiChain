package drunix

import (
	"testing"
	"time"
)

func newPortfolioRail(t *testing.T) *UMIRail {
	t.Helper()
	rail := NewUMIRail(NewMemorySecurities(), NewChain())
	for _, a := range []string{"PROP-A", "PROP-B", "PROP-C"} {
		if _, err := rail.SeedPosition(a, "investor1", 1000, 10000); err != nil {
			t.Fatalf("seed %s: %v", a, err)
		}
	}
	return rail
}

func twoAssetBasket() []BasketComponent {
	return []BasketComponent{
		{AssetID: "PROP-A", TokensPerUnit: 2, IndicativePriceINR: 500},
		{AssetID: "PROP-B", TokensPerUnit: 3, IndicativePriceINR: 100},
	}
}

func TestBasketNeedsAtLeastTwoDistinctAssets(t *testing.T) {
	rail := newPortfolioRail(t)

	if _, _, err := rail.CreateBasket("B1", "single", "", []BasketComponent{
		{AssetID: "PROP-A", TokensPerUnit: 1, IndicativePriceINR: 1},
	}); err == nil {
		t.Fatal("a one-asset basket is just that asset; it must be rejected")
	}

	if _, _, err := rail.CreateBasket("B2", "dupe", "", []BasketComponent{
		{AssetID: "PROP-A", TokensPerUnit: 1},
		{AssetID: "PROP-A", TokensPerUnit: 2},
	}); err == nil {
		t.Fatal("the same asset twice must be rejected")
	}

	if _, _, err := rail.CreateBasket("B3", "zero", "", []BasketComponent{
		{AssetID: "PROP-A", TokensPerUnit: 0},
		{AssetID: "PROP-B", TokensPerUnit: 1},
	}); err == nil {
		t.Fatal("a zero-token component must be rejected")
	}
}

func TestSubscribeIsFullyBacked(t *testing.T) {
	rail := newPortfolioRail(t)
	if _, _, err := rail.CreateBasket("PUNE-MIX", "Pune mix", "CUST", twoAssetBasket()); err != nil {
		t.Fatalf("create: %v", err)
	}

	if _, _, err := rail.Subscribe("PUNE-MIX", "investor1", 10); err != nil {
		t.Fatalf("subscribe: %v", err)
	}

	// 10 units at 2 and 3 tokens each = 20 and 30 delivered into custody.
	if got := rail.securities.Position("PROP-A", "CUST"); got != 20 {
		t.Fatalf("custody PROP-A = %d, want 20", got)
	}
	if got := rail.securities.Position("PROP-B", "CUST"); got != 30 {
		t.Fatalf("custody PROP-B = %d, want 30", got)
	}
	if got := rail.securities.Position("PROP-A", "investor1"); got != 980 {
		t.Fatalf("holder PROP-A = %d, want 980", got)
	}

	view, err := rail.BasketByID("PUNE-MIX")
	if err != nil {
		t.Fatalf("view: %v", err)
	}
	if !view.FullyBacked {
		t.Fatal("every issued unit must be fully backed")
	}
	// NAV per unit = 2*500 + 3*100 = 1300.
	if view.NAVPerUnitINR != 1300 {
		t.Fatalf("NAV/unit = %v, want 1300", view.NAVPerUnitINR)
	}
	if view.NAVTotalINR != 13000 {
		t.Fatalf("NAV total = %v, want 13000", view.NAVTotalINR)
	}
}

func TestSubscribeIsAllOrNothing(t *testing.T) {
	rail := newPortfolioRail(t)
	// PROP-C is not seeded for investor2, so the second leg must fail and the
	// first must be given back.
	rail.SeedPosition("PROP-A", "investor2", 100, 10000)

	comps := []BasketComponent{
		{AssetID: "PROP-A", TokensPerUnit: 1, IndicativePriceINR: 10},
		{AssetID: "PROP-C", TokensPerUnit: 1, IndicativePriceINR: 10},
	}
	if _, _, err := rail.CreateBasket("PARTIAL", "partial", "CUST2", comps); err != nil {
		t.Fatalf("create: %v", err)
	}

	before := rail.securities.Position("PROP-A", "investor2")
	if _, _, err := rail.Subscribe("PARTIAL", "investor2", 5); err == nil {
		t.Fatal("subscription must fail when a component cannot be delivered")
	}

	if after := rail.securities.Position("PROP-A", "investor2"); after != before {
		t.Fatalf("PROP-A not rolled back: %d -> %d", before, after)
	}
	if got := rail.securities.Position("PROP-A", "CUST2"); got != 0 {
		t.Fatalf("custody kept %d tokens from a failed subscription", got)
	}
	view, _ := rail.BasketByID("PARTIAL")
	if view.UnitsOutstanding != 0 {
		t.Fatalf("units issued against a failed subscription: %d", view.UnitsOutstanding)
	}
}

func TestRedeemReturnsExactlyWhatWasDelivered(t *testing.T) {
	rail := newPortfolioRail(t)
	rail.CreateBasket("MIX", "mix", "CUST", twoAssetBasket())

	startA := rail.securities.Position("PROP-A", "investor1")
	startB := rail.securities.Position("PROP-B", "investor1")

	rail.Subscribe("MIX", "investor1", 10)
	if _, _, err := rail.Redeem("MIX", "investor1", 10); err != nil {
		t.Fatalf("redeem: %v", err)
	}

	if got := rail.securities.Position("PROP-A", "investor1"); got != startA {
		t.Fatalf("PROP-A round trip lost tokens: %d != %d", got, startA)
	}
	if got := rail.securities.Position("PROP-B", "investor1"); got != startB {
		t.Fatalf("PROP-B round trip lost tokens: %d != %d", got, startB)
	}
	view, _ := rail.BasketByID("MIX")
	if view.UnitsOutstanding != 0 {
		t.Fatalf("units outstanding after full redemption: %d", view.UnitsOutstanding)
	}
}

func TestCannotRedeemMoreThanHeld(t *testing.T) {
	rail := newPortfolioRail(t)
	rail.CreateBasket("MIX", "mix", "CUST", twoAssetBasket())
	rail.Subscribe("MIX", "investor1", 2)

	if _, _, err := rail.Redeem("MIX", "investor1", 3); err == nil {
		t.Fatal("redeeming more units than held must fail")
	}
	if _, _, err := rail.Redeem("MIX", "nobody", 1); err == nil {
		t.Fatal("a non-holder must not be able to redeem")
	}
}

func TestRecipeCannotChangeUnderIssuedUnits(t *testing.T) {
	rail := newPortfolioRail(t)
	rail.CreateBasket("MIX", "mix", "CUST", twoAssetBasket())
	rail.Subscribe("MIX", "investor1", 1)

	_, _, err := rail.CreateBasket("MIX", "mix v2", "CUST", []BasketComponent{
		{AssetID: "PROP-A", TokensPerUnit: 9},
		{AssetID: "PROP-C", TokensPerUnit: 9},
	})
	if err == nil {
		t.Fatal("changing the recipe under issued units would break the backing")
	}
}

func TestBasketCommitsToTheChain(t *testing.T) {
	chain := NewChain()
	rail := NewUMIRail(NewMemorySecurities(), chain)
	rail.SeedPosition("PROP-A", "investor1", 100, 1000)
	rail.SeedPosition("PROP-B", "investor1", 100, 1000)

	before := len(chain.Blocks)
	rail.CreateBasket("MIX", "mix", "CUST", twoAssetBasket())
	rail.Subscribe("MIX", "investor1", 2)
	rail.Redeem("MIX", "investor1", 1)
	after := chain.Blocks

	if len(after)-before != 3 {
		t.Fatalf("expected a block for create, subscribe and redeem; got %d", len(after)-before)
	}
	types := map[string]bool{}
	for _, b := range after[before:] {
		types[b.Type] = true
	}
	for _, want := range []string{"UMI_BASKET_CREATED", "UMI_BASKET_SUBSCRIBED", "UMI_BASKET_REDEEMED"} {
		if !types[want] {
			t.Fatalf("missing block type %s", want)
		}
	}
	if v := chain.Verify(); !v.Valid {
		t.Fatal("chain must still verify after basket activity")
	}
}

func TestOwnershipIsTimeWeightedNotJustCurrent(t *testing.T) {
	rail := NewUMIRail(NewMemorySecurities(), NewChain())
	rail.SeedPosition("PROP-X", "alice", 100, 1000)

	now := time.Now().UTC()
	// Alice holds 100 for the first 10 days. Bob appears on day 10 with 100
	// and both hold to day 20. Current ownership says 50/50; time-weighted
	// says alice earned twice the stake-time.
	rail.ownership = &ownershipLog{events: []OwnershipEvent{
		{AssetID: "PROP-X", Holder: "alice", Tokens: 100, At: now.Add(-20 * 24 * time.Hour), Reason: "SEED"},
		{AssetID: "PROP-X", Holder: "bob", Tokens: 100, At: now.Add(-10 * 24 * time.Hour), Reason: "DVP"},
	}}
	rail.securities.(*MemorySecurities).Set("PROP-X", "alice", 100)
	rail.securities.(*MemorySecurities).Set("PROP-X", "bob", 100)

	table := rail.CapTable("PROP-X", now.Add(-20*24*time.Hour), now)
	byHolder := map[string]OwnershipSlice{}
	for _, s := range table {
		byHolder[s.Holder] = s
	}

	a, b := byHolder["alice"], byHolder["bob"]
	if a.PctNow != 50 || b.PctNow != 50 {
		t.Fatalf("current ownership should be 50/50, got %v / %v", a.PctNow, b.PctNow)
	}
	// alice: 100 tokens x 20 days = 2000 token-days. bob: 100 x 10 = 1000.
	if a.TokenDays <= b.TokenDays {
		t.Fatalf("alice held longer so must have more token-days: %v vs %v", a.TokenDays, b.TokenDays)
	}
	if a.PctTimeWeighted < 66 || a.PctTimeWeighted > 67 {
		t.Fatalf("alice time-weighted share = %v, want about 66.67", a.PctTimeWeighted)
	}
	if a.PctTimeWeighted+b.PctTimeWeighted < 99.9 {
		t.Fatalf("time-weighted shares must total 100, got %v", a.PctTimeWeighted+b.PctTimeWeighted)
	}
}

func TestOwnershipJournalRecordsBasketActivity(t *testing.T) {
	rail := newPortfolioRail(t)
	rail.CreateBasket("MIX", "mix", "CUST", twoAssetBasket())
	rail.Subscribe("MIX", "investor1", 1)

	events := rail.OwnershipHistory("PROP-A")
	if len(events) == 0 {
		t.Fatal("subscribing moves a position and must be journalled")
	}
	var sawCustody bool
	for _, e := range events {
		if e.Holder == "CUST" && e.Reason == "BASKET_SUBSCRIBE" {
			sawCustody = true
		}
	}
	if !sawCustody {
		t.Fatal("custody side of the move must be journalled too")
	}
}

func TestBasketHoldingsValueAcrossProperties(t *testing.T) {
	rail := newPortfolioRail(t)
	rail.CreateBasket("MIX", "mix", "CUST", twoAssetBasket())
	rail.Subscribe("MIX", "investor1", 4)

	h := rail.BasketHoldings("investor1")
	if len(h) != 1 {
		t.Fatalf("expected one basket holding, got %d", len(h))
	}
	if h[0]["units"].(int64) != 4 {
		t.Fatalf("units = %v, want 4", h[0]["units"])
	}
	// 4 units x 1300 = 5200 across two different properties, as one number.
	if h[0]["valueINR"].(float64) != 5200 {
		t.Fatalf("value = %v, want 5200", h[0]["valueINR"])
	}
	if len(rail.BasketHoldings("stranger")) != 0 {
		t.Fatal("a non-holder must hold nothing")
	}
}

func TestIncomeSplitCanBeTimeWeighted(t *testing.T) {
	rail := NewUMIRail(NewMemorySecurities(), NewChain())
	rail.SeedPosition("PROP-R", "originator1", 200, 1000)
	rail.FundWallet("originator1", 100000)

	now := time.Now().UTC()
	// Both hold 100 today, but alice has held for 20 days and bob for 10.
	mem := rail.securities.(*MemorySecurities)
	mem.Set("PROP-R", "originator1", 0)
	mem.Set("PROP-R", "alice", 100)
	mem.Set("PROP-R", "bob", 100)
	rail.ownership = &ownershipLog{events: []OwnershipEvent{
		{AssetID: "PROP-R", Holder: "alice", Tokens: 100, At: now.Add(-20 * 24 * time.Hour)},
		{AssetID: "PROP-R", Holder: "bob", Tokens: 100, At: now.Add(-10 * 24 * time.Hour)},
	}}

	snap, err := rail.ServicingByBasis("PROP-R", "originator1", 3000, ServicingBasisSnapshot, time.Time{}, time.Time{})
	if err != nil {
		t.Fatalf("snapshot servicing: %v", err)
	}
	paid := map[string]float64{}
	for _, p := range snap.Payouts {
		paid[p.Holder] = p.AmountINR
	}
	if paid["alice"] != paid["bob"] {
		t.Fatalf("a snapshot must split evenly: %v vs %v", paid["alice"], paid["bob"])
	}
	if snap.Basis != ServicingBasisSnapshot {
		t.Fatalf("basis not recorded: %q", snap.Basis)
	}

	tw, err := rail.ServicingByBasis("PROP-R", "originator1", 3000,
		ServicingBasisTimeWeighted, now.Add(-20*24*time.Hour), now)
	if err != nil {
		t.Fatalf("time-weighted servicing: %v", err)
	}
	twPaid := map[string]float64{}
	for _, p := range tw.Payouts {
		twPaid[p.Holder] = p.AmountINR
	}
	if twPaid["alice"] <= twPaid["bob"] {
		t.Fatalf("alice held twice as long and must be paid more: %v vs %v", twPaid["alice"], twPaid["bob"])
	}
	// 2:1 on token-days => about 2000 / 1000 of 3000.
	if twPaid["alice"] < 1900 || twPaid["alice"] > 2100 {
		t.Fatalf("alice time-weighted payout = %v, want about 2000", twPaid["alice"])
	}
	if tw.Basis != ServicingBasisTimeWeighted {
		t.Fatalf("basis not recorded: %q", tw.Basis)
	}
	if tw.DistributedINR > 3000 {
		t.Fatalf("distributed more than the gross: %v", tw.DistributedINR)
	}
}

func TestTimeWeightedFallsBackWhenThereIsNoHistory(t *testing.T) {
	rail := NewUMIRail(NewMemorySecurities(), NewChain())
	rail.SeedPosition("PROP-N", "originator1", 100, 1000)
	rail.FundWallet("originator1", 50000)
	mem := rail.securities.(*MemorySecurities)
	mem.Set("PROP-N", "carol", 100)
	// Window entirely before any position existed.
	old := time.Now().UTC().Add(-400 * 24 * time.Hour)
	res, err := rail.ServicingByBasis("PROP-N", "originator1", 1000,
		ServicingBasisTimeWeighted, old, old.Add(24*time.Hour))
	if err != nil {
		t.Fatalf("must not refuse to pay: %v", err)
	}
	if res.DistributedINR <= 0 {
		t.Fatal("falling back to snapshot should still pay the holders")
	}
}
