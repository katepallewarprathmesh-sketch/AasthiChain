package drunix

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
)

const tAsset = "PROP-GREEN-VALLEY-PUNE-001"

func newTestRail(t *testing.T) (*UMIRail, *MemorySecurities, *DrunixChain) {
	t.Helper()
	sec := NewMemorySecurities()
	sec.Credit(tAsset, "originator1", 15000)
	chain := NewChain()
	return NewUMIRail(sec, chain), sec, chain
}

func TestUMIDvPHappyPathMovesBothLegs(t *testing.T) {
	rail, sec, chain := newTestRail(t)
	if _, _, err := rail.FundWallet("investor1", 100000); err != nil {
		t.Fatalf("fund: %v", err)
	}
	before := len(chain.Blocks)

	si, err := rail.SettleDvP(DvPRequest{AssetID: tAsset, Seller: "originator1", Buyer: "investor1",
		Tokens: 100, PricePerTokenINR: 500, AutoAssignISIN: true})
	if err != nil {
		t.Fatalf("settle: %v (%s)", err, si.FailureDetail)
	}
	if si.Status != UMIStatusSettled {
		t.Fatalf("status = %s, want SETTLED", si.Status)
	}
	if got := sec.Position(tAsset, "investor1"); got != 100 {
		t.Errorf("buyer securities = %d, want 100", got)
	}
	if got := sec.Position(tAsset, "originator1"); got != 14900 {
		t.Errorf("seller securities = %d, want 14900", got)
	}
	buyer, _ := rail.Wallet("investor1")
	seller, _ := rail.Wallet("originator1")
	if buyer.BalancePaise != INRToPaise(50000) {
		t.Errorf("buyer cash = %d paise, want %d", buyer.BalancePaise, INRToPaise(50000))
	}
	if seller.BalancePaise != INRToPaise(50000) {
		t.Errorf("seller cash = %d paise, want %d", seller.BalancePaise, INRToPaise(50000))
	}
	if buyer.ReservedPaise != 0 {
		t.Errorf("reservation leaked: %d paise still earmarked", buyer.ReservedPaise)
	}
	if si.ISIN == "" {
		t.Error("pilot ISIN not assigned")
	}
	if len(chain.Blocks) != before+1 {
		t.Errorf("blocks appended = %d, want 1", len(chain.Blocks)-before)
	}
	if v := chain.Verify(); !v.Valid {
		t.Errorf("chain broken after settlement: %s", v.Reason)
	}
	// ISO 20022 trace must contain the cash leg and the confirmation
	var hasPacs, hasConf bool
	for _, m := range si.Messages {
		if m.Family == "pacs.009" {
			hasPacs = true
		}
		if m.Family == "sese.025" {
			hasConf = true
		}
	}
	if !hasPacs || !hasConf {
		t.Errorf("incomplete message trace: pacs.009=%v sese.025=%v", hasPacs, hasConf)
	}
}

func TestUMIDvPInsufficientCashMovesNothing(t *testing.T) {
	rail, sec, _ := newTestRail(t)
	rail.FundWallet("investor1", 1000) // far too little

	si, err := rail.SettleDvP(DvPRequest{AssetID: tAsset, Seller: "originator1", Buyer: "investor1",
		Tokens: 100, PricePerTokenINR: 500, AutoAssignISIN: true})
	if !errors.Is(err, ErrUMIInsufficientCBDC) {
		t.Fatalf("err = %v, want ERR_UMI_INSUFFICIENT_CBDC", err)
	}
	if si.Status != UMIStatusFailed {
		t.Fatalf("status = %s, want FAILED", si.Status)
	}
	// ATOMICITY: neither leg moved
	if got := sec.Position(tAsset, "investor1"); got != 0 {
		t.Errorf("securities moved on a failed settlement: buyer holds %d", got)
	}
	if got := sec.Position(tAsset, "originator1"); got != 15000 {
		t.Errorf("seller position changed: %d, want 15000", got)
	}
	buyer, _ := rail.Wallet("investor1")
	if buyer.BalancePaise != INRToPaise(1000) || buyer.ReservedPaise != 0 {
		t.Errorf("cash moved or stayed locked: balance=%d reserved=%d", buyer.BalancePaise, buyer.ReservedPaise)
	}
}

func TestUMIDvPInsufficientSecuritiesLeavesCashUntouched(t *testing.T) {
	rail, _, _ := newTestRail(t)
	rail.FundWallet("investor1", 1000000)
	rail.FundWallet("investor2", 1000)

	si, err := rail.SettleDvP(DvPRequest{AssetID: tAsset, Seller: "investor2", Buyer: "investor1",
		Tokens: 10, PricePerTokenINR: 500, AutoAssignISIN: true})
	if !errors.Is(err, ErrUMIInsufficientSecurities) {
		t.Fatalf("err = %v, want ERR_UMI_INSUFFICIENT_SECURITIES", err)
	}
	if si.Status != UMIStatusFailed {
		t.Fatalf("status = %s", si.Status)
	}
	buyer, _ := rail.Wallet("investor1")
	if buyer.BalancePaise != INRToPaise(1000000) || buyer.ReservedPaise != 0 {
		t.Errorf("buyer cash disturbed: balance=%d reserved=%d", buyer.BalancePaise, buyer.ReservedPaise)
	}
}

func TestUMIDryRunMutatesNothing(t *testing.T) {
	rail, sec, chain := newTestRail(t)
	rail.FundWallet("investor1", 100000)
	blocks := len(chain.Blocks)

	si, err := rail.SettleDvP(DvPRequest{AssetID: tAsset, Seller: "originator1", Buyer: "investor1",
		Tokens: 100, PricePerTokenINR: 500, DryRun: true, AutoAssignISIN: true})
	if err != nil {
		t.Fatalf("dry run: %v", err)
	}
	if si.Status != UMIStatusMatched {
		t.Errorf("dry-run status = %s, want MATCHED", si.Status)
	}
	if sec.Position(tAsset, "investor1") != 0 {
		t.Error("dry run moved securities")
	}
	buyer, _ := rail.Wallet("investor1")
	if buyer.BalancePaise != INRToPaise(100000) || buyer.ReservedPaise != 0 {
		t.Error("dry run touched cash or left a reservation")
	}
	if len(chain.Blocks) != blocks {
		t.Error("dry run appended a block")
	}
	if len(rail.Instructions(0)) != 0 {
		t.Error("dry run persisted an instruction")
	}
}

func TestUMISelfSettlementRejected(t *testing.T) {
	rail, _, _ := newTestRail(t)
	rail.FundWallet("originator1", 100000)
	_, err := rail.SettleDvP(DvPRequest{AssetID: tAsset, Seller: "originator1", Buyer: "originator1",
		Tokens: 1, PricePerTokenINR: 500, AutoAssignISIN: true})
	if !errors.Is(err, ErrUMISelfSettlement) {
		t.Fatalf("err = %v, want ERR_UMI_SELF_SETTLEMENT", err)
	}
}

func TestUMIPilotEligibilityEnforcedWhenAutoAssignOff(t *testing.T) {
	rail, _, _ := newTestRail(t)
	rail.FundWallet("investor1", 100000)
	_, err := rail.SettleDvP(DvPRequest{AssetID: tAsset, Seller: "originator1", Buyer: "investor1",
		Tokens: 1, PricePerTokenINR: 500, AutoAssignISIN: false})
	if !errors.Is(err, ErrUMINotPilotEligible) {
		t.Fatalf("err = %v, want ERR_UMI_NOT_PILOT_ELIGIBLE", err)
	}
	if _, _, err := rail.AssignISIN(tAsset, "originator1", ""); err != nil {
		t.Fatalf("assign isin: %v", err)
	}
	if _, err := rail.SettleDvP(DvPRequest{AssetID: tAsset, Seller: "originator1", Buyer: "investor1",
		Tokens: 1, PricePerTokenINR: 500}); err != nil {
		t.Fatalf("settle after ISIN: %v", err)
	}
}

func TestUMIServicingProRataAndConserved(t *testing.T) {
	rail, sec, _ := newTestRail(t)
	sec.Credit(tAsset, "investor1", 2000)
	sec.Credit(tAsset, "investor2", 1000)
	rail.FundWallet("originator1", 10000)

	res, err := rail.Servicing(tAsset, "originator1", 6000)
	if err != nil {
		t.Fatalf("servicing: %v", err)
	}
	got := map[string]float64{}
	for _, p := range res.Payouts {
		got[p.Holder] = p.AmountINR
	}
	// 12000 / 2000 / 1000 of 15000 → payer excluded, pro-rata over 3000 investor tokens
	if got["investor1"] != 4000 || got["investor2"] != 2000 {
		t.Errorf("payouts = %v, want investor1 4000 / investor2 2000", got)
	}
	rec := rail.Reconcile()
	if !rec.Conserved {
		t.Errorf("money not conserved after servicing: %+v", rec)
	}
}

func TestUMIReconciliationConservesMoneyAcrossSettlements(t *testing.T) {
	rail, _, _ := newTestRail(t)
	rail.FundWallet("investor1", 250000)
	rail.FundWallet("investor2", 250000)
	for i := 0; i < 5; i++ {
		if _, err := rail.SettleDvP(DvPRequest{AssetID: tAsset, Seller: "originator1", Buyer: "investor1",
			Tokens: 10, PricePerTokenINR: 500, AutoAssignISIN: true}); err != nil {
			t.Fatalf("settle %d: %v", i, err)
		}
	}
	rec := rail.Reconcile()
	if !rec.Conserved {
		t.Errorf("conservation broken: balances ₹%.2f vs funded ₹%.2f", rec.TotalBalanceINR, rec.TotalFundedINR)
	}
	if rec.TotalFundedINR != 500000 {
		t.Errorf("funded = %.2f, want 500000", rec.TotalFundedINR)
	}
	if rec.SettledCount != 5 {
		t.Errorf("settled = %d, want 5", rec.SettledCount)
	}
	if !rec.Chain.Valid {
		t.Errorf("chain invalid: %s", rec.Chain.Reason)
	}
}

func TestUMIConcurrentInstructionsCannotDoubleSpend(t *testing.T) {
	rail, sec, _ := newTestRail(t)
	rail.FundWallet("investor1", 50000) // exactly one 100-token lot at ₹500

	var wg sync.WaitGroup
	results := make([]error, 4)
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			_, err := rail.SettleDvP(DvPRequest{AssetID: tAsset, Seller: "originator1", Buyer: "investor1",
				Tokens: 100, PricePerTokenINR: 500, AutoAssignISIN: true})
			results[i] = err
		}(i)
	}
	wg.Wait()

	ok := 0
	for _, e := range results {
		if e == nil {
			ok++
		}
	}
	if ok != 1 {
		t.Fatalf("%d instructions settled, want exactly 1 (double spend)", ok)
	}
	buyer, _ := rail.Wallet("investor1")
	if buyer.BalancePaise != 0 {
		t.Errorf("buyer balance = %d paise, want 0", buyer.BalancePaise)
	}
	if got := sec.Position(tAsset, "investor1"); got != 100 {
		t.Errorf("buyer securities = %d, want 100", got)
	}
	if rec := rail.Reconcile(); !rec.Conserved {
		t.Error("money not conserved under concurrency")
	}
}

func TestUMIRoutesAreAdditiveAndServe(t *testing.T) {
	srv := NewServer(NewMockLedger())
	// without the rail, existing routes work and /umi is simply absent
	h := srv.Router()
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/health", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("health without UMI = %d", rec.Code)
	}
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/umi/config", nil))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("/umi/config without rail = %d, want 404", rec.Code)
	}

	// with the rail
	rail, _, _ := newTestRail(t)
	srv.UMI = rail
	h = srv.Router()

	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/health", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("health with UMI = %d — existing route broken", rec.Code)
	}

	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/umi/config", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("/umi/config = %d", rec.Code)
	}
	var cfg map[string]interface{}
	json.Unmarshal(rec.Body.Bytes(), &cfg)
	if cfg["mode"] != UMIMode {
		t.Errorf("config mode = %v, want simulation", cfg["mode"])
	}

	// Wallet and settlement routes act on someone's money, so the rail now
	// wants to know who is asking. Funding is a settlement-bank act.
	postAs := func(path, identity, role string, body interface{}) *httptest.ResponseRecorder {
		raw, _ := json.Marshal(body)
		r := httptest.NewRequest(http.MethodPost, path, bytes.NewReader(raw))
		r.Header.Set("Content-Type", "application/json")
		if identity != "" {
			r.Header.Set("X-Fabric-Identity", identity)
			r.Header.Set("X-Identity-Role", role)
		}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w
	}
	post := func(path string, body interface{}) *httptest.ResponseRecorder {
		return postAs(path, "regulator1", "Regulator", body)
	}

	if w := post("/umi/wallets/investor1/fund", map[string]float64{"amountINR": 100000}); w.Code != http.StatusOK {
		t.Fatalf("fund = %d: %s", w.Code, w.Body.String())
	}
	w := postAs("/umi/dvp", "investor1", "Investor", map[string]interface{}{
		"assetId": tAsset, "seller": "originator1", "buyer": "investor1",
		"tokens": 100, "pricePerTokenINR": 500,
	})
	if w.Code != http.StatusOK {
		t.Fatalf("dvp = %d: %s", w.Code, w.Body.String())
	}
	var resp struct {
		OK          bool                  `json:"ok"`
		Instruction SettlementInstruction `json:"instruction"`
	}
	json.Unmarshal(w.Body.Bytes(), &resp)
	if !resp.OK || resp.Instruction.Status != UMIStatusSettled {
		t.Fatalf("dvp response = %+v", resp)
	}

	rec = httptest.NewRecorder()
	lookup := httptest.NewRequest(http.MethodGet, "/umi/instructions/"+resp.Instruction.InstructionID, nil)
	lookup.Header.Set("X-Fabric-Identity", "regulator1")
	lookup.Header.Set("X-Identity-Role", "Regulator")
	h.ServeHTTP(rec, lookup)
	if rec.Code != http.StatusOK {
		t.Fatalf("instruction lookup = %d", rec.Code)
	}

	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/umi/reconciliation", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("reconciliation = %d", rec.Code)
	}
	var r2 Reconciliation
	json.Unmarshal(rec.Body.Bytes(), &r2)
	if !r2.Conserved {
		t.Error("reconciliation reports money not conserved")
	}
}

func TestINRToPaiseNoFloatDrift(t *testing.T) {
	cases := map[float64]int64{0.01: 1, 0.1: 10, 1: 100, 1234.56: 123456, 99999.99: 9999999, 0.07: 7}
	for inr, want := range cases {
		if got := INRToPaise(inr); got != want {
			t.Errorf("INRToPaise(%v) = %d, want %d", inr, got, want)
		}
	}
}
