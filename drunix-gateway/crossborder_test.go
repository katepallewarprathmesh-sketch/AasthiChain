package drunix

import (
	"errors"
	"strings"
	"testing"
	"time"
)

func cbxRig(t *testing.T) (*UMIRail, *DrunixChain, *CBXRegistry) {
	t.Helper()
	chain := NewChain()
	rail := NewUMIRail(NewMemorySecurities(), chain)
	reg := NewCBXRegistry(rail, chain, nil)
	if reg == nil {
		t.Fatal("registry should wire with a rail and a chain")
	}
	return rail, chain, reg
}

func cbxParty(name string) TravelRuleParty {
	return TravelRuleParty{
		Name:       name,
		Address:    "1 Example Street, Dubai",
		Country:    "AE",
		AccountRef: "0xabc0000000000000000000000000000000000001",
	}
}

func cbxRequest() CBXRequest {
	return CBXRequest{
		AssetID:     "PROP-GREEN-VALLEY-PUNE-001",
		AmountINR:   885000, // ~USD 10,000 at the indicative rate
		Stablecoin:  "USDC",
		BuyerStatus: BuyerNRI,
		Nationality: "INDIA",
		KYCRef:      "KYC-7781",
		Originator:  cbxParty("Buyer One"),
		Beneficiary: cbxParty("Off-ramp Provider"),
	}
}

func cbxBlocks(chain *DrunixChain, blockType string) int {
	n := 0
	for _, b := range chain.Blocks {
		if b.Type == blockType {
			n++
		}
	}
	return n
}

// A foreign national of non-Indian origin cannot buy at all, so no rail should
// quote them a way to pay. This is the correction the whole layer exists for.
func TestCBXRefusesForeignNational(t *testing.T) {
	_, chain, reg := cbxRig(t)
	req := cbxRequest()
	req.BuyerStatus = BuyerForeign
	req.Nationality = "GERMANY"

	if _, err := reg.Quote(req, "investor9", time.Now().UTC()); !errors.Is(err, ErrCBXIneligible) {
		t.Fatalf("want ErrCBXIneligible, got %v", err)
	}
	if cbxBlocks(chain, BlockCBXRefused) != 1 {
		t.Fatal("a refusal nobody can read on the ledger is indistinguishable from no gate")
	}
}

func TestCBXRefusesRestrictedNationality(t *testing.T) {
	_, _, reg := cbxRig(t)
	req := cbxRequest()
	req.Nationality = "CHINA"
	_, err := reg.Quote(req, "investor9", time.Now().UTC())
	if !errors.Is(err, ErrCBXRestricted) {
		t.Fatalf("want ErrCBXRestricted, got %v", err)
	}
	if !strings.Contains(err.Error(), "prior RBI permission") {
		t.Fatalf("the refusal should say why: %v", err)
	}
}

func TestCBXRefusesWithoutKYC(t *testing.T) {
	_, _, reg := cbxRig(t)
	req := cbxRequest()
	req.KYCRef = ""
	if _, err := reg.Quote(req, "investor1", time.Now().UTC()); !errors.Is(err, ErrCBXKYC) {
		t.Fatalf("want ErrCBXKYC, got %v", err)
	}
}

// Above the threshold the originator and beneficiary records are mandatory.
func TestCBXTravelRuleThreshold(t *testing.T) {
	_, _, reg := cbxRig(t)
	now := time.Now().UTC()

	big := cbxRequest()
	big.Originator = TravelRuleParty{Name: "Buyer One"}
	if _, err := reg.Quote(big, "investor1", now); !errors.Is(err, ErrCBXTravelRule) {
		t.Fatalf("want ErrCBXTravelRule above the threshold, got %v", err)
	}

	small := cbxRequest()
	small.AmountINR = 8850 // ~USD 100
	small.Originator = TravelRuleParty{}
	small.Beneficiary = TravelRuleParty{}
	intent, err := reg.Quote(small, "investor1", now)
	if err != nil {
		t.Fatalf("a small transfer should not need the full record: %v", err)
	}
	if intent.TravelRule {
		t.Fatal("travel rule should not be flagged below the threshold")
	}
	if intent.Originator.Name != "" {
		t.Fatal("identity data not required should not be retained")
	}
}

func TestCBXQuotePointsAtOfframpNotSeller(t *testing.T) {
	_, chain, reg := cbxRig(t)
	intent, err := reg.Quote(cbxRequest(), "investor1", time.Now().UTC())
	if err != nil {
		t.Fatalf("eligible NRI should get a quote: %v", err)
	}
	if intent.Status != CBXQuoted || intent.AmountCoin <= 0 || intent.Rate <= 0 {
		t.Fatalf("bad quote: %+v", intent)
	}
	if !strings.HasPrefix(intent.PayTo, "offramp:") {
		t.Fatalf("payment must be directed at the off-ramp, got %q", intent.PayTo)
	}
	if !strings.Contains(intent.PayToIs, "never the seller") {
		t.Fatal("the destination must say plainly that it is not the seller")
	}
	if intent.IndicativeTDSINR <= 0 {
		t.Fatal("TDS should be shown for information")
	}
	if cbxBlocks(chain, BlockCBXQuoted) != 1 {
		t.Fatal("the quote should be on the ledger")
	}
}

func TestCBXOnlyBuyerReportsPayment(t *testing.T) {
	_, _, reg := cbxRig(t)
	now := time.Now().UTC()
	intent, _ := reg.Quote(cbxRequest(), "investor1", now)
	if _, err := reg.RecordPayment(intent.ID, "0xdead", "investor2", now); !errors.Is(err, ErrCBXNotBuyer) {
		t.Fatalf("want ErrCBXNotBuyer, got %v", err)
	}
	if _, err := reg.RecordPayment("CBX-9999", "0xdead", "investor1", now); !errors.Is(err, ErrCBXNotFound) {
		t.Fatalf("want ErrCBXNotFound, got %v", err)
	}
}

func TestCBXQuoteExpires(t *testing.T) {
	_, chain, reg := cbxRig(t)
	now := time.Now().UTC()
	intent, _ := reg.Quote(cbxRequest(), "investor1", now)

	later := now.Add(cbxQuoteLife + time.Minute)
	if _, err := reg.RecordPayment(intent.ID, "0xdead", "investor1", later); !errors.Is(err, ErrCBXExpired) {
		t.Fatalf("want ErrCBXExpired, got %v", err)
	}
	got, _ := reg.Intent(intent.ID, later)
	if got.Status != CBXExpired {
		t.Fatalf("status should be EXPIRED, got %s", got.Status)
	}
	if cbxBlocks(chain, BlockCBXExpired) != 1 {
		t.Fatal("expiry should be recorded")
	}
}

// The compliant path end to end: rupees appear only against an attestation
// carrying a bank advice reference and a purpose code.
func TestCBXOfframpCreditsRupeesWithEvidence(t *testing.T) {
	rail, chain, reg := cbxRig(t)
	now := time.Now().UTC()
	intent, err := reg.Quote(cbxRequest(), "investor1", now)
	if err != nil {
		t.Fatalf("quote: %v", err)
	}

	// Off-ramp before payment is reported is a state error, not a credit.
	if _, err := reg.Offramp(intent.ID, "regulator1", true, now); !errors.Is(err, ErrCBXState) {
		t.Fatalf("want ErrCBXState, got %v", err)
	}

	paid, err := reg.RecordPayment(intent.ID, "0xfeed1234", "investor1", now)
	if err != nil {
		t.Fatalf("record payment: %v", err)
	}
	if paid.Status != CBXPaid || paid.TransferRef != "0xfeed1234" {
		t.Fatalf("bad payment state: %+v", paid)
	}

	before := 0.0
	if w, ok := rail.Wallet("investor1"); ok {
		before = w.BalanceINR
	}

	out, err := reg.Offramp(intent.ID, "regulator1", true, now)
	if err != nil {
		t.Fatalf("offramp: %v", err)
	}
	if out.Status != CBXOfframped {
		t.Fatalf("status %s", out.Status)
	}
	if out.OfframpAdvice == "" || out.PurposeCode == "" {
		t.Fatal("an off-ramp without a bank advice and a purpose code is not evidence of anything")
	}
	if out.CreditedINR <= 0 || out.CreditedINR >= out.AmountINR {
		t.Fatalf("credited amount should be net of the provider spread: %v", out.CreditedINR)
	}

	w, ok := rail.Wallet("investor1")
	if !ok || w.BalanceINR <= before {
		t.Fatal("the rupee wallet should be credited by the off-ramp")
	}
	if cbxBlocks(chain, BlockCBXOfframped) != 1 {
		t.Fatal("the off-ramp should be on the ledger")
	}

	// Twice is a state error, not a second credit.
	if _, err := reg.Offramp(intent.ID, "regulator1", true, now); !errors.Is(err, ErrCBXState) {
		t.Fatalf("want ErrCBXState on a repeat, got %v", err)
	}
}

func TestCBXRejectsUnauthorisedStablecoin(t *testing.T) {
	_, _, reg := cbxRig(t)
	req := cbxRequest()
	req.Stablecoin = "USDT"
	if _, err := reg.Quote(req, "investor1", time.Now().UTC()); !errors.Is(err, ErrCBXFields) {
		t.Fatalf("want ErrCBXFields, got %v", err)
	}
}

func TestCBXIntentsScopedAndBounded(t *testing.T) {
	_, _, reg := cbxRig(t)
	now := time.Now().UTC()
	for i := 0; i < 3; i++ {
		if _, err := reg.Quote(cbxRequest(), "investor1", now); err != nil {
			t.Fatalf("quote %d: %v", i, err)
		}
	}
	if _, err := reg.Quote(cbxRequest(), "investor2", now); err != nil {
		t.Fatalf("quote for second buyer: %v", err)
	}
	if n := len(reg.Intents("investor1", 0, now)); n != 3 {
		t.Fatalf("scoped list should hold 3, got %d", n)
	}
	if n := len(reg.Intents("", 0, now)); n != 4 {
		t.Fatalf("supervisor list should hold 4, got %d", n)
	}
	if n := len(reg.Intents("", 2, now)); n != 2 {
		t.Fatalf("limit should bind, got %d", n)
	}
}

func TestCBXRulesStateTheProhibition(t *testing.T) {
	_, _, reg := cbxRig(t)
	rules := reg.Rules()
	if rules["settlementCurrency"] != "INR" {
		t.Fatal("settlement is in rupees")
	}
	prohibited, _ := rules["prohibited"].(string)
	if !strings.Contains(prohibited, "cryptocurrency or digital tokens") {
		t.Fatalf("the rules must name the prohibited method: %v", prohibited)
	}
	if !strings.Contains(rules["disclaimer"].(string), "Simulated") {
		t.Fatal("the leg must label itself simulated")
	}
	if len(rules["restrictedNationalities"].([]string)) != 11 {
		t.Fatal("eleven nationalities need prior permission")
	}
}

func TestCBXEligibilityHelper(t *testing.T) {
	if ok, _ := EligibilityOf(BuyerOCI, "CANADA"); !ok {
		t.Fatal("an OCI may purchase")
	}
	if ok, why := EligibilityOf(BuyerForeign, "FRANCE"); ok || !strings.Contains(why, "cannot purchase") {
		t.Fatalf("a foreign national may not: %v %q", ok, why)
	}
	if ok, _ := EligibilityOf("", ""); ok {
		t.Fatal("an undeclared status is not eligible")
	}
}
