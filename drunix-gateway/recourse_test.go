package drunix

// Tests for recourse.go.
//
// The thing worth testing here is not that a waterfall divides numbers. It
// is that the honesty rule holds under pressure: that a rank describing a
// remedy with no pot behind it pays zero, that a withdrawn backing statement
// stops paying the moment it is withdrawn, that an empty reserve wallet is
// treated exactly like no wallet at all, and that terms cannot be registered
// with a flattering gap list attached.
//
// If somebody later "improves" this by making an unfunded rank pay out its
// nominal claim, every one of these fails, which is the point.

import (
	"strings"
	"testing"
	"time"
)

func recourseFixture(t *testing.T) (*RecourseDesk, *UMIRail, *BackingRegistry) {
	t.Helper()
	chain := NewChain()
	rail := NewUMIRail(NewMemorySecurities(), chain)
	backing := NewBackingRegistry(rail, chain)
	desk := NewRecourseDesk(rail, backing)
	if desk == nil {
		t.Fatal("recourse desk should mount with a rail present")
	}
	if _, err := rail.SeedPosition("ASSET-1", "investor1", 300, 1000); err != nil {
		t.Fatalf("seed investor1: %v", err)
	}
	if _, err := rail.SeedPosition("ASSET-1", "investor2", 700, 1000); err != nil {
		t.Fatalf("seed investor2: %v", err)
	}
	return desk, rail, backing
}

func mustFund(t *testing.T, rail *UMIRail, id string, inr float64) {
	t.Helper()
	if _, _, err := rail.FundWallet(id, inr); err != nil {
		t.Fatalf("fund %s: %v", id, err)
	}
}

// emptyWallet makes a wallet that exists and holds nothing, which is a
// different thing from a wallet that does not exist and must be tested as
// such: both pay zero, but only one of them is somebody's mistake.
func emptyWallet(rail *UMIRail, id string) {
	rail.mu.Lock()
	rail.walletLocked(id)
	rail.mu.Unlock()
}

func TestRecourseDefaultTermsAreHonestRatherThanFlattering(t *testing.T) {
	desk, _, _ := recourseFixture(t)
	terms := desk.Terms("ASSET-1")

	if !terms.Default {
		t.Error("terms nobody registered must be marked as the house default")
	}
	if countFunded(terms.Priority) != 0 {
		t.Error("no rank on this platform is funded today; the defaults must not pretend otherwise")
	}
	if !strings.HasPrefix(terms.Vehicle, "None") {
		t.Error("there is no SPV, and the default terms must say so")
	}
	// The holder rank must not be first. A platform that writes itself above
	// its holders, or forgets the secured creditor who really does rank
	// first, is telling a story rather than describing a position.
	if !strings.Contains(strings.ToLower(terms.Priority[0].Claimant), "secured creditor") {
		t.Errorf("rank 1 should be the secured creditor, got %q", terms.Priority[0].Claimant)
	}
	last := terms.Priority[len(terms.Priority)-1]
	if !strings.Contains(strings.ToLower(last.Claimant), "platform") {
		t.Errorf("the platform must rank last, got %q", last.Claimant)
	}
	if len(terms.Gaps) < 3 {
		t.Errorf("default terms should enumerate their own gaps, got %d", len(terms.Gaps))
	}
}

func TestRecourseUnfundedWaterfallRecoversNothingAndSaysWhy(t *testing.T) {
	desk, _, _ := recourseFixture(t)
	sim, err := desk.Simulate("ASSET-1", TriggerIssuerDefault, "investor1", time.Now().UTC())
	if err != nil {
		t.Fatalf("simulate: %v", err)
	}
	if sim.RecoveryPaise != 0 {
		t.Errorf("nothing is funded, so recovery must be 0, got %d", sim.RecoveryPaise)
	}
	if sim.PoolPaise != 0 {
		t.Errorf("there is no pool, got %d", sim.PoolPaise)
	}
	if !strings.Contains(sim.Verdict, "recover nothing") {
		t.Errorf("the verdict must lead with the zero: %q", sim.Verdict)
	}
	if !strings.Contains(sim.Verdict, "money that does not exist") {
		t.Errorf("the verdict must say why it is zero, not merely that it is: %q", sim.Verdict)
	}
	for _, p := range sim.Waterfall {
		if p.Funded || p.PaidPaise != 0 {
			t.Errorf("rank %d paid %d while unfunded", p.Rank, p.PaidPaise)
		}
		if p.Why == "" {
			t.Errorf("rank %d pays zero without explaining itself", p.Rank)
		}
	}
	if sim.HolderTokens != 300 || sim.TokensOutstanding != 1000 {
		t.Errorf("position arithmetic wrong: %d of %d", sim.HolderTokens, sim.TokensOutstanding)
	}
}

func TestRecourseIssuerDefaultHasNoOwnerAndTheSimulationSaysSo(t *testing.T) {
	desk, _, _ := recourseFixture(t)
	sim, err := desk.Simulate("ASSET-1", TriggerIssuerDefault, "investor1", time.Now().UTC())
	if err != nil {
		t.Fatalf("simulate: %v", err)
	}
	// This is the open gap the sandbox submission declares. If it ever
	// closes, this test should be the thing that notices.
	if sim.TriggerObservable {
		t.Error("issuer default is not observable on this rail today")
	}
	if sim.TriggerDeclaredBy != "nobody" {
		t.Errorf("nobody may declare issuer default today, got %q", sim.TriggerDeclaredBy)
	}
}

func TestRecourseFundedReserveWalletPaysProRata(t *testing.T) {
	desk, rail, _ := recourseFixture(t)
	mustFund(t, rail, "reserve1", 10_000) // Rs 10,000

	_, err := desk.SetTerms(RecourseTerms{
		AssetID: "ASSET-1",
		Priority: []RecourseRank{
			{Rank: 1, Claimant: "Token holders, pro rata", Remedy: "Paid from the reserve.", Funding: FundingReserveWallet, ReserveWallet: "reserve1"},
		},
	}, "registrar1", true)
	if err != nil {
		t.Fatalf("set terms: %v", err)
	}

	sim, err := desk.Simulate("ASSET-1", TriggerIssuerDefault, "investor1", time.Now().UTC())
	if err != nil {
		t.Fatalf("simulate: %v", err)
	}
	// 300 of 1000 tokens against a Rs 10,000 pool.
	if sim.RecoveryPaise != 3_000_00 {
		t.Errorf("expected 300000 paise pro rata, got %d", sim.RecoveryPaise)
	}
	if sim.RecoveryINR != "Rs 3,000.00" {
		t.Errorf("Indian grouping wrong: %q", sim.RecoveryINR)
	}
	if sim.TermsAreHouseDefault {
		t.Error("registered terms must not report as the house default")
	}
}

func TestRecourseEmptyReserveWalletIsTreatedAsNoPot(t *testing.T) {
	desk, rail, _ := recourseFixture(t)
	emptyWallet(rail, "reserve1")

	if _, err := desk.SetTerms(RecourseTerms{
		AssetID: "ASSET-1",
		Priority: []RecourseRank{
			{Rank: 1, Claimant: "Token holders, pro rata", Remedy: "Paid from the reserve.", Funding: FundingReserveWallet, ReserveWallet: "reserve1"},
		},
	}, "registrar1", true); err != nil {
		t.Fatalf("set terms: %v", err)
	}

	sim, err := desk.Simulate("ASSET-1", TriggerIssuerDefault, "investor1", time.Now().UTC())
	if err != nil {
		t.Fatalf("simulate: %v", err)
	}
	if sim.RecoveryPaise != 0 {
		t.Errorf("an empty pot pays the same as no pot, got %d", sim.RecoveryPaise)
	}
	if !strings.Contains(sim.Waterfall[0].Why, "empty") {
		t.Errorf("the reason must name the emptiness: %q", sim.Waterfall[0].Why)
	}
}

func TestRecourseWithdrawnBackingStopsPayingImmediately(t *testing.T) {
	desk, _, backing := recourseFixture(t)
	if _, err := backing.Attest(BackingRequest{
		AssetID: "ASSET-1", BackedUnits: 1000, ValuationPaise: 50_000_00,
		Method: "registered valuation", EvidenceHash: strings.Repeat("a", 64),
		Cadence: "720h",
	}, "registrar1", true); err != nil {
		t.Fatalf("attest: %v", err)
	}
	if _, err := desk.SetTerms(RecourseTerms{
		AssetID: "ASSET-1",
		Priority: []RecourseRank{
			{Rank: 1, Claimant: "Token holders, pro rata", Remedy: "Paid from the attested valuation.", Funding: FundingBackingStatement},
		},
	}, "registrar1", true); err != nil {
		t.Fatalf("set terms: %v", err)
	}

	now := time.Now().UTC()
	sim, err := desk.Simulate("ASSET-1", TriggerImpairment, "investor1", now)
	if err != nil {
		t.Fatalf("simulate: %v", err)
	}
	if sim.RecoveryPaise != 15_000_00 { // 30% of Rs 50,000
		t.Fatalf("expected 1500000 paise, got %d", sim.RecoveryPaise)
	}

	if _, err := backing.Withdraw("ASSET-1", "valuation no longer stood behind", "registrar1", true); err != nil {
		t.Fatalf("withdraw: %v", err)
	}
	after, err := desk.Simulate("ASSET-1", TriggerImpairment, "investor1", now)
	if err != nil {
		t.Fatalf("simulate after withdrawal: %v", err)
	}
	if after.RecoveryPaise != 0 {
		t.Errorf("a withdrawn statement funds nothing, got %d", after.RecoveryPaise)
	}
	if !strings.Contains(after.Waterfall[0].Why, "withdrawn") {
		t.Errorf("the reason must name the withdrawal: %q", after.Waterfall[0].Why)
	}
}

func TestRecourseSeniorRankExhaustsThePoolBeforeHolders(t *testing.T) {
	desk, rail, _ := recourseFixture(t)
	mustFund(t, rail, "reserve1", 1_000) // Rs 1,000, less than the senior claim

	if _, err := desk.SetTerms(RecourseTerms{
		AssetID: "ASSET-1",
		Priority: []RecourseRank{
			{Rank: 1, Claimant: "Secured creditor of the issuer", Remedy: "Paid first from the reserve.", Funding: FundingReserveWallet, ReserveWallet: "reserve1"},
			{Rank: 2, Claimant: "Token holders, pro rata", Remedy: "Whatever is left.", Funding: FundingReserveWallet, ReserveWallet: "reserve1"},
		},
	}, "registrar1", true); err != nil {
		t.Fatalf("set terms: %v", err)
	}

	sim, err := desk.Simulate("ASSET-1", TriggerIssuerDefault, "investor1", time.Now().UTC())
	if err != nil {
		t.Fatalf("simulate: %v", err)
	}
	if sim.Waterfall[1].PaidPaise != 0 {
		t.Errorf("the senior rank should have taken the whole pool, holders got %d", sim.Waterfall[1].PaidPaise)
	}
	if sim.RecoveryPaise != 0 {
		t.Errorf("holder recovery should be 0 behind an exhausting senior claim, got %d", sim.RecoveryPaise)
	}
	if !strings.Contains(sim.Verdict, "exhausted by ranks above yours") {
		t.Errorf("the verdict must distinguish an empty pool from a pool taken by somebody else: %q", sim.Verdict)
	}
}

func TestRecourseGapListIsComputedNotSupplied(t *testing.T) {
	desk, _, _ := recourseFixture(t)
	terms, err := desk.SetTerms(RecourseTerms{
		AssetID:  "ASSET-1",
		Priority: []RecourseRank{{Rank: 1, Claimant: "Token holders, pro rata", Remedy: "A share of the proceeds.", Funding: FundingNone}},
		Gaps:     []string{"None. Investors are fully protected."},
	}, "registrar1", true)
	if err != nil {
		t.Fatalf("set terms: %v", err)
	}
	for _, g := range terms.Gaps {
		if strings.Contains(strings.ToLower(g), "fully protected") {
			t.Fatal("a supplied gap list was trusted; it must be recomputed from the terms")
		}
	}
	joined := strings.ToLower(strings.Join(terms.Gaps, " "))
	if !strings.Contains(joined, "no rank is funded") {
		t.Errorf("an entirely unfunded set of terms must say so in its gaps: %v", terms.Gaps)
	}
}

func TestRecourseTermsAreRegistrarOrSupervisorOnly(t *testing.T) {
	desk, _, _ := recourseFixture(t)
	_, err := desk.SetTerms(RecourseTerms{
		AssetID:  "ASSET-1",
		Priority: []RecourseRank{{Rank: 1, Claimant: "Token holders", Remedy: "Something.", Funding: FundingNone}},
	}, "originator1", false)
	if err == nil {
		t.Fatal("the issuer must not write the terms of its own failure")
	}
}

func TestRecourseRejectsARankWithAnInventedFundingSource(t *testing.T) {
	desk, _, _ := recourseFixture(t)
	_, err := desk.SetTerms(RecourseTerms{
		AssetID:  "ASSET-1",
		Priority: []RecourseRank{{Rank: 1, Claimant: "Token holders", Remedy: "Covered by insurance.", Funding: "insurance-policy"}},
	}, "registrar1", true)
	if err == nil {
		t.Fatal("a funding source this ledger cannot check must be refused outright, not recorded and ignored")
	}
	_, err = desk.SetTerms(RecourseTerms{
		AssetID:  "ASSET-1",
		Priority: []RecourseRank{{Rank: 1, Claimant: "Token holders", Remedy: "From the reserve.", Funding: FundingReserveWallet}},
	}, "registrar1", true)
	if err == nil {
		t.Fatal("a reserve-funded rank naming no wallet must be refused")
	}
}

func TestRecourseDeclaringATriggerMovesNoMoney(t *testing.T) {
	desk, rail, _ := recourseFixture(t)
	mustFund(t, rail, "reserve1", 10_000)
	before, _ := rail.Wallet("reserve1")
	start := before.BalancePaise

	blk, err := desk.Declare("ASSET-1", TriggerImpairment, "valuation fell below tokens outstanding", "regulator1", true)
	if err != nil {
		t.Fatalf("declare: %v", err)
	}
	if blk == nil || blk.Height == 0 {
		t.Fatal("a declaration must be on the ledger; otherwise nobody can prove when it happened")
	}
	after, _ := rail.Wallet("reserve1")
	if after.BalancePaise != start {
		t.Errorf("declaring a failure must not pay for it: %d -> %d", start, after.BalancePaise)
	}

	if _, err := desk.Declare("ASSET-1", TriggerImpairment, "x", "investor1", false); err == nil {
		t.Error("a non-supervisor must not declare a trigger")
	}
	if _, err := desk.Declare("ASSET-1", "MARKET_SENTIMENT", "x", "regulator1", true); err == nil {
		t.Error("an unknown trigger must be refused rather than recorded")
	}
}

func TestRecourseRefusesAHolderWithNoPosition(t *testing.T) {
	desk, _, _ := recourseFixture(t)
	if _, err := desk.Simulate("ASSET-1", TriggerIssuerDefault, "stranger1", time.Now().UTC()); err == nil {
		t.Fatal("somebody holding nothing has nothing to recover and should be told so")
	}
	if _, err := desk.Simulate("ASSET-1", "NOT_A_TRIGGER", "investor1", time.Now().UTC()); err == nil {
		t.Fatal("an unknown trigger must be an error, not a zero")
	}
}

func TestIndianGroupingOfLargeAmounts(t *testing.T) {
	cases := map[int64]string{
		0:            "Rs 0.00",
		99_99:        "Rs 99.99",
		1_50_000_00:  "Rs 1,50,000.00",
		75_00_000_00: "Rs 75,00,000.00",
		-1_000_00:    "-Rs 1,000.00",
	}
	for paise, want := range cases {
		if got := paiseToINRString(paise); got != want {
			t.Errorf("paiseToINRString(%d) = %q, want %q", paise, got, want)
		}
	}
}
