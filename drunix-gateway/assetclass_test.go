package drunix

import "testing"

func newCarbonRail(t *testing.T) *UMIRail {
	t.Helper()
	chain := NewChain()
	return NewUMIRail(NewMemorySecurities(), chain)
}

// The additive guarantee. Every asset that existed before classes did must
// behave exactly as it did, which means an unregistered asset is a PROPERTY
// and nothing about it changed.
func TestUnregisteredAssetIsAProperty(t *testing.T) {
	r := newCarbonRail(t)
	if got := r.AssetClassOf("PROP-ANYTHING"); got != AssetClassProperty {
		t.Fatalf("an asset nobody registered must be a PROPERTY, got %q", got)
	}
	p := r.AssetProfileOf("PROP-ANYTHING")
	if p.Class != AssetClassProperty || p.AssetID != "PROP-ANYTHING" {
		t.Fatalf("expected a synthesised property profile, got %+v", p)
	}
}

// Carbon must settle through the DvP path that already existed, untouched.
// If this needed a special case the central claim would be false.
func TestCarbonSettlesThroughTheUnmodifiedDvPPath(t *testing.T) {
	r := newCarbonRail(t)
	if _, err := r.RegisterAsset(AssetProfile{AssetID: "CARB-1", Class: AssetClassCarbon, Vintage: 2024}); err != nil {
		t.Fatalf("register: %v", err)
	}
	if _, err := r.SeedPosition("CARB-1", "originator1", 1000, 1000); err != nil {
		t.Fatalf("seed: %v", err)
	}
	if _, _, err := r.FundWallet("investor1", 100000); err != nil {
		t.Fatalf("fund: %v", err)
	}
	// Carbon clears the same pilot-eligibility gate as everything else. That
	// it is required here, unchanged, is part of the claim.
	if _, _, err := r.AssignISIN("CARB-1", "originator1", ""); err != nil {
		t.Fatalf("isin: %v", err)
	}
	res, err := r.SettleDvP(DvPRequest{
		AssetID: "CARB-1", Seller: "originator1", Buyer: "investor1",
		Tokens: 100, PricePerTokenINR: 10,
	})
	if err != nil {
		t.Fatalf("carbon should settle like anything else: %v", err)
	}
	if res.Status != UMIStatusSettled {
		t.Fatalf("want SETTLED, got %s", res.Status)
	}
	if got := r.securities.Position("CARB-1", "investor1"); got != 100 {
		t.Fatalf("buyer should hold 100 credits, holds %d", got)
	}
}

func TestOnlyCarbonCanBeRetired(t *testing.T) {
	r := newCarbonRail(t)
	if _, err := r.SeedPosition("PROP-1", "originator1", 500, 500); err != nil {
		t.Fatalf("seed: %v", err)
	}
	_, err := r.RetireCredits("PROP-1", "originator1", 10, "", "")
	if err != ErrUMINotRetirable {
		t.Fatalf("retiring a property must be refused, got %v", err)
	}
	if got := r.securities.Position("PROP-1", "originator1"); got != 500 {
		t.Fatalf("a refused retirement must not move anything, holder has %d", got)
	}
}

func TestCannotRetireMoreThanHeld(t *testing.T) {
	r := newCarbonRail(t)
	_, _ = r.RegisterAsset(AssetProfile{AssetID: "CARB-2", Class: AssetClassCarbon})
	_, _ = r.SeedPosition("CARB-2", "originator1", 50, 50)
	if _, err := r.RetireCredits("CARB-2", "originator1", 51, "", ""); err != ErrUMIInsufficientSecurities {
		t.Fatalf("want ERR_UMI_INSUFFICIENT_SECURITIES, got %v", err)
	}
	if got := r.securities.Position("CARB-2", "originator1"); got != 50 {
		t.Fatalf("a refused retirement must not debit, holder has %d", got)
	}
	if got := r.RetiredTokens("CARB-2"); got != 0 {
		t.Fatalf("nothing was retired, counter says %d", got)
	}
}

// The terminal state. After retirement the credits are gone from the book and
// cannot be settled, which is what stops the same tonne being sold twice.
func TestRetiredCreditsCannotBeSettledAgain(t *testing.T) {
	r := newCarbonRail(t)
	_, _ = r.RegisterAsset(AssetProfile{AssetID: "CARB-3", Class: AssetClassCarbon})
	_, _ = r.SeedPosition("CARB-3", "originator1", 100, 100)
	_, _, _ = r.FundWallet("investor1", 100000)
	_, _, _ = r.AssignISIN("CARB-3", "originator1", "")

	rec, err := r.RetireCredits("CARB-3", "originator1", 100, "Acme Ltd", "FY25 emissions")
	if err != nil {
		t.Fatalf("retire: %v", err)
	}
	if rec.BlockHeight == 0 {
		t.Fatal("a retirement must be proved by a block")
	}
	if got := r.securities.Position("CARB-3", "originator1"); got != 0 {
		t.Fatalf("retired credits must leave the holder, holds %d", got)
	}
	if _, err := r.SettleDvP(DvPRequest{
		AssetID: "CARB-3", Seller: "originator1", Buyer: "investor1",
		Tokens: 1, PricePerTokenINR: 10,
	}); err == nil {
		t.Fatal("selling a retired credit must fail: this is the double count")
	}
}

// outstanding + retired must never exceed authorised, through a settlement
// and a retirement.
func TestConservationCountsRetiredSupply(t *testing.T) {
	r := newCarbonRail(t)
	_, _ = r.RegisterAsset(AssetProfile{AssetID: "CARB-4", Class: AssetClassCarbon})
	_, _ = r.SeedPosition("CARB-4", "originator1", 1000, 1000)
	_, _, _ = r.FundWallet("investor1", 1000000)
	_, _, _ = r.AssignISIN("CARB-4", "originator1", "")

	if _, err := r.SettleDvP(DvPRequest{
		AssetID: "CARB-4", Seller: "originator1", Buyer: "investor1",
		Tokens: 400, PricePerTokenINR: 10,
	}); err != nil {
		t.Fatalf("settle: %v", err)
	}
	if _, err := r.RetireCredits("CARB-4", "investor1", 400, "Acme", "offset"); err != nil {
		t.Fatalf("retire: %v", err)
	}

	authorised, outstanding := r.AuthorisedSupply("CARB-4")
	retired := r.RetiredTokens("CARB-4")
	if outstanding != 600 || retired != 400 || authorised != 1000 {
		t.Fatalf("want 600 outstanding / 400 retired / 1000 authorised, got %d/%d/%d",
			outstanding, retired, authorised)
	}
	if outstanding+retired > authorised {
		t.Fatalf("conservation broken: %d + %d > %d", outstanding, retired, authorised)
	}
	if b := r.SupplyBreaches(); len(b) != 0 {
		t.Fatalf("no breach expected, got %v", b)
	}
}

// The hole that matters most. Retired tokens are not positions, so a restore
// that only reads positions would shrink the cap by the retired amount and
// let that supply be issued a second time.
func TestRestoreRebuildsRetiredSupplyFromTheChain(t *testing.T) {
	chain := NewChain()
	r := NewUMIRail(NewMemorySecurities(), chain)
	_, _ = r.RegisterAsset(AssetProfile{AssetID: "CARB-5", Class: AssetClassCarbon})
	_, _ = r.SeedPosition("CARB-5", "originator1", 1000, 1000)
	if _, err := r.RetireCredits("CARB-5", "originator1", 600, "Acme", "offset"); err != nil {
		t.Fatalf("retire: %v", err)
	}

	// A fresh rail over the SAME chain, as a restart would produce, with the
	// 400 surviving credits restored as positions.
	restored := NewUMIRail(NewMemorySecurities(), chain)
	restored.mu.Lock()
	restored.authorised["CARB-5"] = 400 // what the position-only derivation yields
	restored.restoreCarbonFromChain()
	restored.mu.Unlock()
	if mem, ok := restored.securities.(*MemorySecurities); ok {
		mem.Set("CARB-5", "originator1", 400)
	}

	if got := restored.RetiredTokens("CARB-5"); got != 600 {
		t.Fatalf("restore must rebuild retired totals from the chain, got %d", got)
	}
	authorised, outstanding := restored.AuthorisedSupply("CARB-5")
	if authorised != 1000 {
		t.Fatalf("retired supply must stay counted against the cap, authorised restored as %d", authorised)
	}
	if outstanding+restored.RetiredTokens("CARB-5") != 1000 {
		t.Fatalf("outstanding %d + retired %d should still account for all 1000 issued",
			outstanding, restored.RetiredTokens("CARB-5"))
	}
	if got := restored.AssetClassOf("CARB-5"); got != AssetClassCarbon {
		t.Fatalf("the class must survive a restart too, got %q", got)
	}
}

// Changing a class after the fact would reinterpret history rather than
// describe it, so it is refused.
func TestAssetClassCannotBeChanged(t *testing.T) {
	r := newCarbonRail(t)
	if _, err := r.RegisterAsset(AssetProfile{AssetID: "CARB-6", Class: AssetClassCarbon}); err != nil {
		t.Fatalf("register: %v", err)
	}
	if _, err := r.RegisterAsset(AssetProfile{AssetID: "CARB-6", Class: AssetClassProperty}); err != ErrUMIAssetClassLocked {
		t.Fatalf("want ERR_UMI_ASSET_CLASS_LOCKED, got %v", err)
	}
	// Re-registering the same class is fine and updates metadata.
	p, err := r.RegisterAsset(AssetProfile{AssetID: "CARB-6", Class: AssetClassCarbon, Vintage: 2023})
	if err != nil {
		t.Fatalf("same-class re-registration should be allowed: %v", err)
	}
	if p.Vintage != 2023 {
		t.Fatalf("metadata should update, vintage is %d", p.Vintage)
	}
}

func TestUnknownAssetClassRefused(t *testing.T) {
	r := newCarbonRail(t)
	if _, err := r.RegisterAsset(AssetProfile{AssetID: "X-1", Class: "GOLD"}); err == nil {
		t.Fatal("an unsupported class must be refused rather than silently stored")
	}
}

// Nothing here is backed by an external registry, and the record must say so
// on its own rather than relying on a page elsewhere.
func TestCarbonProfileDeclaresItselfSimulated(t *testing.T) {
	r := newCarbonRail(t)
	p, err := r.RegisterAsset(AssetProfile{AssetID: "CARB-7", Class: AssetClassCarbon})
	if err != nil {
		t.Fatalf("register: %v", err)
	}
	if !p.Simulated {
		t.Fatal("a carbon profile must mark itself simulated")
	}
	if p.Registry == "" {
		t.Fatal("the registry field must say which registry, even when it is ours")
	}
}

// The discriminating case for the widened invariant.
//
// Retire 600 of 1000, leaving 400 outstanding. Then re-issue 300. Outstanding
// is 700, comfortably under the 1000 cap, so the OLD check sees nothing wrong.
// But 700 live plus 600 already consumed is 1300 tonnes claimed against 1000
// ever issued: 300 of them counted twice. Only the retired term catches it,
// which is the whole reason the term exists.
func TestReissuingRetiredSupplyIsABreach(t *testing.T) {
	r := newCarbonRail(t)
	_, _ = r.RegisterAsset(AssetProfile{AssetID: "CARB-8", Class: AssetClassCarbon})
	_, _ = r.SeedPosition("CARB-8", "originator1", 1000, 1000)
	if _, err := r.RetireCredits("CARB-8", "originator1", 600, "Acme", "offset"); err != nil {
		t.Fatalf("retire: %v", err)
	}

	// Re-issue into the headroom retirement appeared to free up.
	mem := r.securities.(*MemorySecurities)
	mem.Credit("CARB-8", "originator1", 300)

	_, outstanding := r.AuthorisedSupply("CARB-8")
	if outstanding != 700 {
		t.Fatalf("setup: expected 700 outstanding, got %d", outstanding)
	}
	// The old rule would be satisfied here, which is the point.
	if outstanding > 1000 {
		t.Fatal("setup is wrong: outstanding alone must stay under the cap")
	}

	breaches := r.SupplyBreaches()
	if len(breaches) == 0 {
		t.Fatal("re-issuing retired supply must be reported as a breach: 700 live + 600 retired against 1000 issued is a double count")
	}
	b := breaches[0]
	if b["excessTokens"].(int64) != 300 {
		t.Fatalf("excess should be the 300 double-counted credits, got %v", b["excessTokens"])
	}
	if b["retiredTokens"].(int64) != 600 {
		t.Fatalf("the breach row must show the retired tally that caused it, got %v", b["retiredTokens"])
	}
}
