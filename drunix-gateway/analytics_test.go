package drunix

import (
	"encoding/json"
	"math"
	"net/http"
	"net/http/httptest"
	"testing"
)

// analyticsRail builds a rail with a seller holding stock and two funded buyers.
func analyticsRail(t *testing.T) *UMIRail {
	t.Helper()
	r := NewUMIRail(NewMemorySecurities(), NewChain())
	if _, err := r.SeedPosition("PROP-A", "originator1", 1000, 1000); err != nil {
		t.Fatalf("seed A: %v", err)
	}
	if _, err := r.SeedPosition("PROP-B", "originator1", 1000, 1000); err != nil {
		t.Fatalf("seed B: %v", err)
	}
	for _, p := range []string{"investor1", "investor2"} {
		if _, _, err := r.FundWallet(p, 10000000); err != nil {
			t.Fatalf("fund %s: %v", p, err)
		}
	}
	return r
}

func settle(t *testing.T, r *UMIRail, asset, seller, buyer string, tokens int64, price float64) {
	t.Helper()
	si, err := r.SettleDvP(DvPRequest{AssetID: asset, Seller: seller, Buyer: buyer,
		Tokens: tokens, PricePerTokenINR: price, AutoAssignISIN: true})
	if err != nil {
		t.Fatalf("settle %s %d@%.2f: %v", asset, tokens, price, err)
	}
	if si.Status != UMIStatusSettled {
		t.Fatalf("expected settled, got %s (%s)", si.Status, si.FailureReason)
	}
}

// Buy 100 at 100 then 100 at 200: average cost is 150, not the last price and
// not the first. This is the number everything else is built on.
func TestWeightedAverageCostBasis(t *testing.T) {
	r := analyticsRail(t)
	settle(t, r, "PROP-A", "originator1", "investor1", 100, 100)
	settle(t, r, "PROP-A", "originator1", "investor1", 100, 200)

	a := r.Analytics("investor1")
	if len(a.Assets) != 1 {
		t.Fatalf("want 1 asset, got %d", len(a.Assets))
	}
	row := a.Assets[0]
	if row.AvgCostINR != 150 {
		t.Errorf("average cost = %.2f, want 150", row.AvgCostINR)
	}
	if row.CostBaseINR != 30000 {
		t.Errorf("cost basis = %.2f, want 30000", row.CostBaseINR)
	}
	if a.CostBasisMethod != costBasisWeightedAverage {
		t.Errorf("method not reported: %q", a.CostBasisMethod)
	}
}

// Selling at 250 after an average cost of 150 realises 100 a token, and the
// remaining position keeps the same average cost — a sale must not change the
// cost of what is still held.
func TestRealisedProfitUsesAverageCost(t *testing.T) {
	r := analyticsRail(t)
	settle(t, r, "PROP-A", "originator1", "investor1", 100, 100)
	settle(t, r, "PROP-A", "originator1", "investor1", 100, 200)
	settle(t, r, "PROP-A", "investor1", "investor2", 50, 250)

	a := r.Analytics("investor1")
	row := a.Assets[0]
	if got := row.RealisedINR; math.Abs(got-5000) > 0.01 {
		t.Errorf("realised = %.2f, want 5000 (50 x (250-150))", got)
	}
	if row.AvgCostINR != 150 {
		t.Errorf("average cost after a sale = %.2f, want 150", row.AvgCostINR)
	}
	if row.Tokens != 150 {
		t.Errorf("tokens = %d, want 150", row.Tokens)
	}
	if row.CostBaseINR != 22500 {
		t.Errorf("remaining cost basis = %.2f, want 22500", row.CostBaseINR)
	}
}

// An asset that has never traded must be marked at cost, so unrealised P&L is
// exactly zero. Marking it anywhere else invents a return.
func TestUntradedAssetIsMarkedAtCostNotInvented(t *testing.T) {
	r := analyticsRail(t)
	if _, err := r.SeedPosition("PROP-C", "investor1", 500, 500); err != nil {
		t.Fatalf("seed: %v", err)
	}
	a := r.Analytics("investor1")
	for _, row := range a.Assets {
		if row.AssetID != "PROP-C" {
			continue
		}
		if row.MarkSource == markSourceLastTrade {
			t.Error("an asset that never traded cannot be marked at a last trade price")
		}
		if row.UnrealisedINR != 0 {
			t.Errorf("unrealised on an untraded, never-bought position = %.2f, want 0", row.UnrealisedINR)
		}
		return
	}
	t.Fatal("seeded asset missing from the report")
}

// The mark is the rail's last traded price, so a later trade between other
// parties revalues an existing holder's book.
func TestMarkFollowsTheLastTradeOnTheRail(t *testing.T) {
	r := analyticsRail(t)
	settle(t, r, "PROP-A", "originator1", "investor1", 100, 100)
	settle(t, r, "PROP-A", "originator1", "investor2", 100, 300)

	a := r.Analytics("investor1")
	row := a.Assets[0]
	if row.MarkPriceINR != 300 {
		t.Errorf("mark = %.2f, want 300 (the last trade)", row.MarkPriceINR)
	}
	if row.MarkSource != markSourceLastTrade {
		t.Errorf("mark source = %q, want %q", row.MarkSource, markSourceLastTrade)
	}
	if got := row.UnrealisedINR; math.Abs(got-20000) > 0.01 {
		t.Errorf("unrealised = %.2f, want 20000 (100 x (300-100))", got)
	}
}

// A dry run changes nothing, so it must not appear in any performance figure.
func TestDryRunsDoNotMovePerformance(t *testing.T) {
	r := analyticsRail(t)
	settle(t, r, "PROP-A", "originator1", "investor1", 100, 100)
	before := r.Analytics("investor1")

	if _, err := r.SettleDvP(DvPRequest{AssetID: "PROP-A", Seller: "originator1", Buyer: "investor1",
		Tokens: 100, PricePerTokenINR: 999, DryRun: true, AutoAssignISIN: true}); err != nil {
		t.Fatalf("dry run: %v", err)
	}
	after := r.Analytics("investor1")

	if after.Trades != before.Trades {
		t.Errorf("trade count moved on a dry run: %d -> %d", before.Trades, after.Trades)
	}
	if after.Assets[0].MarkPriceINR != before.Assets[0].MarkPriceINR {
		t.Errorf("a dry run repriced the book: %.2f -> %.2f",
			before.Assets[0].MarkPriceINR, after.Assets[0].MarkPriceINR)
	}
	if after.InvestedINR != before.InvestedINR {
		t.Errorf("a dry run changed the cost basis: %.2f -> %.2f", before.InvestedINR, after.InvestedINR)
	}
}

// A failed settlement is counted as a failure and nothing else.
func TestFailedSettlementIsCountedNotPriced(t *testing.T) {
	r := analyticsRail(t)
	// investor2 has no wallet funding headroom for this one.
	if _, _, err := r.FundWallet("pauper", 100); err != nil {
		t.Fatalf("fund: %v", err)
	}
	if _, err := r.SettleDvP(DvPRequest{AssetID: "PROP-A", Seller: "originator1", Buyer: "pauper",
		Tokens: 100, PricePerTokenINR: 5000, AutoAssignISIN: true}); err == nil {
		t.Fatal("expected the cash leg to fail")
	}
	a := r.Analytics("pauper")
	if a.FailedTrades != 1 {
		t.Errorf("failed trades = %d, want 1", a.FailedTrades)
	}
	if a.Trades != 0 {
		t.Errorf("settled trades = %d, want 0", a.Trades)
	}
	if a.MarketValueINR != 0 {
		t.Errorf("a failed trade gave the buyer %.2f of market value", a.MarketValueINR)
	}
}

// One asset is 10000 on the index; splitting evenly across two halves it.
func TestConcentrationIndex(t *testing.T) {
	r := analyticsRail(t)
	settle(t, r, "PROP-A", "originator1", "investor1", 100, 100)

	one := r.Analytics("investor1").Concentration
	if one.HHI != 10000 {
		t.Errorf("single holding HHI = %.2f, want 10000", one.HHI)
	}
	if one.Verdict != "concentrated" {
		t.Errorf("verdict = %q, want concentrated", one.Verdict)
	}
	if one.LargestPct != 100 {
		t.Errorf("largest position = %.2f%%, want 100", one.LargestPct)
	}

	settle(t, r, "PROP-B", "originator1", "investor1", 100, 100)
	two := r.Analytics("investor1").Concentration
	if math.Abs(two.HHI-5000) > 1 {
		t.Errorf("two equal holdings HHI = %.2f, want 5000", two.HHI)
	}
	if math.Abs(two.EffectiveAssets-2) > 0.01 {
		t.Errorf("effective assets = %.2f, want 2", two.EffectiveAssets)
	}
}

// Servicing income belongs in total return, not just in a separate list.
func TestIncomeCountsTowardsReturn(t *testing.T) {
	r := analyticsRail(t)
	settle(t, r, "PROP-A", "originator1", "investor1", 100, 100)
	if _, _, err := r.FundWallet("originator1", 1000000); err != nil {
		t.Fatalf("fund payer: %v", err)
	}
	if _, err := r.Servicing("PROP-A", "originator1", 5000); err != nil {
		t.Fatalf("servicing: %v", err)
	}
	a := r.Analytics("investor1")
	if a.IncomeINR <= 0 {
		t.Fatalf("income = %.2f, want the investor's share of 5000", a.IncomeINR)
	}
	if a.NetPnlINR < a.IncomeINR {
		t.Errorf("net P&L %.2f excludes income %.2f", a.NetPnlINR, a.IncomeINR)
	}
	if a.TotalReturnPct == nil || *a.TotalReturnPct <= 0 {
		t.Error("income did not move total return")
	}
}

// A participant with no history gets an empty report, not a crash and not a
// divide by zero dressed up as a percentage.
func TestUnknownParticipantIsEmptyNotBroken(t *testing.T) {
	a := analyticsRail(t).Analytics("nobody")
	if a.Trades != 0 || len(a.Assets) != 0 {
		t.Errorf("unexpected history for an unknown participant: %+v", a)
	}
	if a.TotalReturnPct != nil {
		t.Errorf("return on zero outlay should be nil, got %v", *a.TotalReturnPct)
	}
	if a.Concentration.Verdict != "no holdings" {
		t.Errorf("verdict = %q", a.Concentration.Verdict)
	}
}

// Annualising a few days of a demo ledger produces a meaningless headline.
func TestShortPeriodsAreNotAnnualised(t *testing.T) {
	r := analyticsRail(t)
	settle(t, r, "PROP-A", "originator1", "investor1", 100, 100)
	if a := r.Analytics("investor1"); a.AnnualisedPct != nil {
		t.Errorf("annualised a same-day holding as %v%%", *a.AnnualisedPct)
	}
}

// Rail view: success rate, volume and the busiest asset.
func TestRailAnalyticsSummarisesActivity(t *testing.T) {
	r := analyticsRail(t)
	settle(t, r, "PROP-A", "originator1", "investor1", 100, 100) // 10,000
	settle(t, r, "PROP-A", "originator1", "investor2", 50, 120)  //  6,000
	settle(t, r, "PROP-B", "originator1", "investor1", 10, 100)  //  1,000
	if _, err := r.SettleDvP(DvPRequest{AssetID: "PROP-A", Seller: "originator1", Buyer: "ghost",
		Tokens: 1, PricePerTokenINR: 10, AutoAssignISIN: true}); err == nil {
		t.Fatal("expected a failure for a participant with no wallet")
	}

	out := r.RailAnalytics(14)
	if out.Settled != 3 {
		t.Errorf("settled = %d, want 3", out.Settled)
	}
	if out.Failed != 1 {
		t.Errorf("failed = %d, want 1", out.Failed)
	}
	if math.Abs(out.VolumeINR-17000) > 0.01 {
		t.Errorf("volume = %.2f, want 17000", out.VolumeINR)
	}
	if math.Abs(out.SuccessRatePct-75) > 0.01 {
		t.Errorf("success rate = %.2f, want 75", out.SuccessRatePct)
	}
	if len(out.TopAssets) == 0 || out.TopAssets[0].AssetID != "PROP-A" {
		t.Errorf("busiest asset should be PROP-A, got %+v", out.TopAssets)
	}
	if out.TopAssets[0].ChangePct == nil || math.Abs(*out.TopAssets[0].ChangePct-20) > 0.01 {
		t.Errorf("price change should be +20%% (100 -> 120), got %v", out.TopAssets[0].ChangePct)
	}
	if len(out.FailuresByReason) == 0 {
		t.Error("failures are not broken down by reason")
	}
}

// Analytics must never be able to write. Everything is GET only.
func TestAnalyticsRoutesAreReadOnly(t *testing.T) {
	s := newTestServerWithUMI(t)
	h := s.Router()
	for _, path := range []string{"/umi/analytics", "/umi/analytics/investor1"} {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, path, nil))
		if rec.Code != http.StatusMethodNotAllowed {
			t.Errorf("POST %s returned %d, want 405", path, rec.Code)
		}
	}
}

func TestAnalyticsEndpointsRespond(t *testing.T) {
	s := newTestServerWithUMI(t)
	h := s.Router()

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/umi/analytics?days=7", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("rail analytics returned %d: %s", rec.Code, rec.Body.String())
	}
	var railBody struct {
		Analytics RailAnalytics `json:"analytics"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &railBody); err != nil {
		t.Fatalf("rail analytics is not JSON: %v", err)
	}

	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/umi/analytics/investor1", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("investor analytics returned %d: %s", rec.Code, rec.Body.String())
	}
	var invBody struct {
		Analytics InvestorAnalytics `json:"analytics"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &invBody); err != nil {
		t.Fatalf("investor analytics is not JSON: %v", err)
	}
	if invBody.Analytics.Participant != "investor1" {
		t.Errorf("participant = %q", invBody.Analytics.Participant)
	}

	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/umi/analytics/", nil))
	if rec.Code != http.StatusBadRequest {
		t.Errorf("a missing participant returned %d, want 400", rec.Code)
	}
}

// An analytics read must not leak a participant id into a metric label.
func TestAnalyticsPathIsTemplatedForMetrics(t *testing.T) {
	if got := routeFor("/umi/analytics/investor1"); got != "/umi/analytics/{id}" {
		t.Errorf("routeFor = %q, want /umi/analytics/{id}", got)
	}
	if got := routeFor("/umi/analytics"); got != "/umi/analytics" {
		t.Errorf("routeFor = %q, want /umi/analytics", got)
	}
}
