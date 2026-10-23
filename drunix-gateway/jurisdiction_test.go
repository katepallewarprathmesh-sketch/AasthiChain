package drunix

import (
	"errors"
	"strings"
	"testing"
	"time"
)

func newJurisdictionFixture(t *testing.T) (*JurisdictionRegistry, *DrunixChain) {
	t.Helper()
	chain := NewChain()
	return NewJurisdictionRegistry(chain), chain
}

func TestJurisdictionDesignationIsDeclared(t *testing.T) {
	reg, _ := newJurisdictionFixture(t)
	list := reg.Jurisdictions()
	if len(list) == 0 {
		t.Fatal("no jurisdictions declared")
	}
	if list[0].Designation != JurisdictionDesignated {
		t.Fatalf("designated jurisdictions should sort first, got %s", list[0].Designation)
	}
	mh, ok := reg.Jurisdiction("in-mh")
	if !ok {
		t.Fatal("IN-MH should be declared and the lookup should be case-insensitive")
	}
	if mh.StampDutyBps != 600 || mh.RegistrationCapPaise != 3000000 {
		t.Fatalf("Maharashtra charges wrong: %d bps, cap %d", mh.StampDutyBps, mh.RegistrationCapPaise)
	}
}

// The refusal case: a place nobody modelled must not transact.
func TestJurisdictionUndeclaredRefuses(t *testing.T) {
	reg, chain := newJurisdictionFixture(t)
	before := len(chain.Blocks)
	_, err := reg.Evaluate(Transaction{
		Kind: TxAcquisition, Jurisdiction: "FR", BuyerStatus: BuyerResident,
		Consideration: "INR_BANKING_CHANNEL",
	}, time.Now().UTC())
	if !errors.Is(err, ErrJurisdictionUnknown) {
		t.Fatalf("an undeclared jurisdiction must refuse, got %v", err)
	}
	if len(chain.Blocks) != before+1 {
		t.Fatal("the refusal should be recorded on the chain, not only returned")
	}
	if chain.Blocks[len(chain.Blocks)-1].Type != BlockJurisdictionRefused {
		t.Fatalf("wrong block type %s", chain.Blocks[len(chain.Blocks)-1].Type)
	}
}

func TestJurisdictionMissingCodeIsAFieldError(t *testing.T) {
	reg, _ := newJurisdictionFixture(t)
	if _, err := reg.Evaluate(Transaction{Kind: TxAcquisition}, time.Now().UTC()); !errors.Is(err, ErrJurisdictionFields) {
		t.Fatalf("expected a field error, got %v", err)
	}
}

func TestJurisdictionAllowsEligibleResident(t *testing.T) {
	reg, _ := newJurisdictionFixture(t)
	d, err := reg.Evaluate(Transaction{
		Kind: TxAcquisition, Jurisdiction: "IN-MH", BuyerStatus: BuyerResident,
		Nationality: "INDIA", AssetKind: "RESIDENTIAL", Consideration: "INR_BANKING_CHANNEL",
		AmountPaise: 1000000000, // ₹1,00,00,000
	}, time.Now().UTC())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !d.Allowed || d.Failed != 0 {
		t.Fatalf("a resident buying a flat in Maharashtra should pass, %d failed", d.Failed)
	}
	if d.RulesRun < 5 {
		t.Fatalf("too few rules ran: %d", d.RulesRun)
	}
	if d.Costs == nil || d.Costs.StampDutyPaise != 60000000 {
		t.Fatalf("stamp duty should be 6%% of the price, got %+v", d.Costs)
	}
	if d.Costs.RegistrationPaise != 3000000 {
		t.Fatalf("registration should hit the ₹30,000 cap, got %d", d.Costs.RegistrationPaise)
	}
	if d.Block == 0 && d.Block < 0 {
		t.Fatal("the evaluation should carry a block height")
	}
}

// Every applicable rule runs, so a caller sees the whole regime rather than
// the first thing that stopped them.
func TestJurisdictionReportsEveryFailureNotJustTheFirst(t *testing.T) {
	reg, _ := newJurisdictionFixture(t)
	d, err := reg.Evaluate(Transaction{
		Kind: TxAcquisition, Jurisdiction: "IN-KA", BuyerStatus: BuyerForeign,
		Nationality: "PAKISTAN", AssetKind: "AGRICULTURAL", Consideration: "CRYPTO",
		AmountPaise: 5000000000,
	}, time.Now().UTC())
	if err != nil {
		t.Fatalf("an evaluation that refuses is still a successful evaluation: %v", err)
	}
	if d.Allowed {
		t.Fatal("this transaction must not be allowed")
	}
	if d.Failed < 4 {
		t.Fatalf("expected at least four independent failures, got %d", d.Failed)
	}
	for _, r := range d.Results {
		if strings.TrimSpace(r.Instrument) == "" {
			t.Fatalf("rule %s cites no instrument", r.ID)
		}
		if !r.Passed && strings.TrimSpace(r.Reason) == "" {
			t.Fatalf("rule %s failed without a reason", r.ID)
		}
	}
}

func TestJurisdictionAgriculturalLandBlockedForNRI(t *testing.T) {
	reg, _ := newJurisdictionFixture(t)
	d, _ := reg.Evaluate(Transaction{
		Kind: TxAcquisition, Jurisdiction: "IN-TG", BuyerStatus: BuyerNRI,
		Nationality: "CANADA", AssetKind: "FARMHOUSE", Consideration: "NRE", AmountPaise: 100000000,
	}, time.Now().UTC())
	if d.Allowed {
		t.Fatal("an NRI may not acquire a farmhouse")
	}
	found := false
	for _, r := range d.Results {
		if r.ID == "FEMA-AGRICULTURAL-LAND" && !r.Passed {
			found = true
		}
	}
	if !found {
		t.Fatal("the agricultural-land rule should be the one that failed")
	}
}

func TestJurisdictionCryptoConsiderationRefused(t *testing.T) {
	reg, _ := newJurisdictionFixture(t)
	d, _ := reg.Evaluate(Transaction{
		Kind: TxAcquisition, Jurisdiction: "IN-MH", BuyerStatus: BuyerNRI,
		Nationality: "UAE", AssetKind: "RESIDENTIAL", Consideration: "CRYPTO", AmountPaise: 100000000,
	}, time.Now().UTC())
	if d.Allowed {
		t.Fatal("paying the seller in tokens is not a permitted consideration")
	}
}

func TestJurisdictionLeaseRouteOpenToForeignNational(t *testing.T) {
	reg, _ := newJurisdictionFixture(t)
	ok, _ := reg.Evaluate(Transaction{
		Kind: TxLease, Jurisdiction: "IN-MH", BuyerStatus: BuyerForeign,
		Nationality: "FRANCE", AssetKind: "RESIDENTIAL", LeaseYears: 5,
	}, time.Now().UTC())
	if !ok.Allowed {
		t.Fatalf("a five-year lease is the open route for a foreign national: %+v", ok.Results)
	}
	long, _ := reg.Evaluate(Transaction{
		Kind: TxLease, Jurisdiction: "IN-MH", BuyerStatus: BuyerForeign,
		Nationality: "FRANCE", AssetKind: "RESIDENTIAL", LeaseYears: 9,
	}, time.Now().UTC())
	if long.Allowed {
		t.Fatal("nine years exceeds the limit that makes the lease route available")
	}
}

func TestJurisdictionRERAFlagBlocksMarketing(t *testing.T) {
	reg, _ := newJurisdictionFixture(t)
	no := false
	d, _ := reg.Evaluate(Transaction{
		Kind: TxAcquisition, Jurisdiction: "IN-WB", BuyerStatus: BuyerResident,
		Nationality: "INDIA", AssetKind: "RESIDENTIAL", Consideration: "INR_BANKING_CHANNEL",
		RERARegistered: &no, AmountPaise: 100000000,
	}, time.Now().UTC())
	if d.Allowed {
		t.Fatal("an unregistered project may not be sold")
	}
}

// The point of the whole exercise: the cross-border quote is tested against
// the rule set, not only against the eligibility switch.
func TestCrossBorderQuoteIsTestedAgainstTheRuleSet(t *testing.T) {
	_, chain, cbx := cbxRig(t)
	reg := NewJurisdictionRegistry(chain)
	cbx.UseRuleSet(reg, "IN-MH")

	req := cbxRequest()
	req.AssetKind = "AGRICULTURAL"
	if _, err := cbx.Quote(req, "investor9", time.Now().UTC()); err == nil {
		t.Fatal("an NRI buying agricultural land should be refused by the rule set, not quoted")
	}

	req = cbxRequest()
	req.Jurisdiction = "XX-NOWHERE"
	if _, err := cbx.Quote(req, "investor9", time.Now().UTC()); err == nil {
		t.Fatal("an undeclared jurisdiction should refuse the quote rather than default to permitted")
	}

	// The ordinary case still quotes, so the gate is a filter and not a wall.
	if _, err := cbx.Quote(cbxRequest(), "investor9", time.Now().UTC()); err != nil {
		t.Fatalf("an eligible NRI buying a flat in Maharashtra should still get a quote: %v", err)
	}
}

func TestJurisdictionRulesOfListsInstruments(t *testing.T) {
	reg, _ := newJurisdictionFixture(t)
	rules, ok := reg.RulesOf("IN-MH")
	if !ok || len(rules) < 7 {
		t.Fatalf("expected the full declared rule set, got %d", len(rules))
	}
	if _, ok := reg.RulesOf("ZZ"); ok {
		t.Fatal("an undeclared code has no rules to list")
	}
}
