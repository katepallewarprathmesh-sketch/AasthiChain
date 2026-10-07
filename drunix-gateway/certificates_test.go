package drunix

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
)

func certRail(t *testing.T) (*UMIRail, *DocumentRegistry) {
	t.Helper()
	chain := NewChain()
	dr := NewDocumentRegistry(chain, NewMemoryPinStore())
	r := NewUMIRail(NewMemorySecurities(), chain).WithDocuments(dr)
	if _, err := r.SeedPosition("PROP-BOND", "originator1", 1000, 1000); err != nil {
		t.Fatalf("seed: %v", err)
	}
	for _, p := range []string{"investor1", "investor2", "originator1"} {
		if _, _, err := r.FundWallet(p, 5000000); err != nil {
			t.Fatalf("fund: %v", err)
		}
	}
	return r, dr
}

// A settled trade must leave a confirmation behind, addressed by CID.
func TestSettlementFilesAContractNote(t *testing.T) {
	r, dr := certRail(t)
	si, err := r.SettleDvP(DvPRequest{
		AssetID: "PROP-BOND", Seller: "originator1", Buyer: "investor1",
		Tokens: 100, PricePerTokenINR: 250, AutoAssignISIN: true,
	})
	if err != nil {
		t.Fatalf("settle: %v", err)
	}
	docs := dr.ForAsset("PROP-BOND")
	var note *Document
	for i := range docs {
		if docs[i].DocType == DocTypeContractNote {
			note = &docs[i]
		}
	}
	if note == nil {
		t.Fatal("no contract note was filed for a settled trade")
	}
	if note.BlockHeight == 0 {
		t.Error("the contract note was not anchored to the ledger")
	}
	// It must be the document for THIS trade and must be readable.
	body, _, err := dr.Fetch(note.CID, "investor1", "Investor")
	if err != nil {
		t.Fatalf("the buyer cannot read their own contract note: %v", err)
	}
	if !bytes.Contains(body, []byte(si.InstructionID)) {
		t.Error("the contract note does not name the instruction it confirms")
	}
	var parsed map[string]interface{}
	if err := json.Unmarshal(body, &parsed); err != nil {
		t.Fatalf("the contract note is not readable JSON: %v", err)
	}
	if parsed["considerationPaise"] == nil || parsed["ledgerBlockHeight"] == nil {
		t.Errorf("the contract note omits the figures that make it useful: %v", parsed)
	}
}

// Determinism is what makes the certificate verifiable rather than merely
// stored: rebuilding it from the ledger facts must reproduce the same bytes.
func TestContractNoteIsDeterministic(t *testing.T) {
	r, dr := certRail(t)
	si, err := r.SettleDvP(DvPRequest{
		AssetID: "PROP-BOND", Seller: "originator1", Buyer: "investor1",
		Tokens: 10, PricePerTokenINR: 100, AutoAssignISIN: true,
	})
	if err != nil {
		t.Fatalf("settle: %v", err)
	}
	a, err := BuildContractNote(si)
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	b, _ := BuildContractNote(si)
	if !bytes.Equal(a, b) {
		t.Fatal("two renderings of the same trade produced different bytes")
	}
	// And the rebuilt document must verify against what was filed.
	res := dr.VerifyContent(a)
	if !res.Anchored {
		t.Fatal("a contract note rebuilt from the instruction does not match the filed one")
	}
	if res.DocType != DocTypeContractNote {
		t.Errorf("matched the wrong document: %s", res.DocType)
	}
}

// Both sides of a trade are entitled to the confirmation; a stranger is not.
func TestContractNoteIsReadableByBothCounterparties(t *testing.T) {
	r, dr := certRail(t)
	if _, err := r.SettleDvP(DvPRequest{
		AssetID: "PROP-BOND", Seller: "originator1", Buyer: "investor1",
		Tokens: 5, PricePerTokenINR: 100, AutoAssignISIN: true,
	}); err != nil {
		t.Fatalf("settle: %v", err)
	}
	var cid string
	for _, d := range dr.ForAsset("PROP-BOND") {
		if d.DocType == DocTypeContractNote {
			cid = d.CID
		}
	}
	for _, who := range []string{"investor1", "originator1"} {
		if _, _, err := dr.Fetch(cid, who, "Investor"); err != nil {
			t.Errorf("%s was denied their own contract note: %v", who, err)
		}
	}
	if _, _, err := dr.Fetch(cid, "investor2", "Investor"); err == nil {
		t.Error("an unrelated party read someone else's contract note")
	}
}

// A dry run confirms nothing, so it must not produce a confirmation.
func TestDryRunFilesNoCertificate(t *testing.T) {
	r, dr := certRail(t)
	if _, err := r.SettleDvP(DvPRequest{
		AssetID: "PROP-BOND", Seller: "originator1", Buyer: "investor1",
		Tokens: 10, PricePerTokenINR: 100, DryRun: true, AutoAssignISIN: true,
	}); err != nil {
		t.Fatalf("dry run: %v", err)
	}
	for _, d := range dr.ForAsset("PROP-BOND") {
		if d.DocType == DocTypeContractNote {
			t.Fatal("a dry run produced a contract note")
		}
	}
}

// The bond case the whole exercise is about: a coupon payment must leave each
// holder a document they can file.
func TestCouponPaymentFilesAnAdvicePerHolder(t *testing.T) {
	r, dr := certRail(t)
	for _, buyer := range []string{"investor1", "investor2"} {
		if _, err := r.SettleDvP(DvPRequest{
			AssetID: "PROP-BOND", Seller: "originator1", Buyer: buyer,
			Tokens: 100, PricePerTokenINR: 100, AutoAssignISIN: true,
		}); err != nil {
			t.Fatalf("settle for %s: %v", buyer, err)
		}
	}
	if _, err := r.Servicing("PROP-BOND", "originator1", 4000); err != nil {
		t.Fatalf("coupon: %v", err)
	}

	advices := map[string]Document{}
	for _, d := range dr.ForAsset("PROP-BOND") {
		if d.DocType == DocTypeIncomeAdvice {
			advices[d.Subject] = d
		}
	}
	for _, holder := range []string{"investor1", "investor2"} {
		adv, ok := advices[holder]
		if !ok {
			t.Fatalf("no income advice for %s", holder)
		}
		body, _, err := dr.Fetch(adv.CID, holder, "Investor")
		if err != nil {
			t.Fatalf("%s cannot read their own advice: %v", holder, err)
		}
		if !strings.Contains(string(body), holder) {
			t.Errorf("the advice for %s does not name them", holder)
		}
		if !strings.Contains(string(body), "amountPaise") {
			t.Errorf("the advice carries no amount: %s", body)
		}
	}
	// One holder must not be able to read the other's income.
	if _, _, err := dr.Fetch(advices["investor1"].CID, "investor2", "Investor"); err == nil {
		t.Error("one holder read another holder's income advice")
	}
}

// Certificates must never be able to break settlement, even with no register
// attached at all.
func TestRailWorksWithNoDocumentRegister(t *testing.T) {
	r := NewUMIRail(NewMemorySecurities(), NewChain())
	if _, err := r.SeedPosition("PROP-X", "originator1", 100, 100); err != nil {
		t.Fatalf("seed: %v", err)
	}
	if _, _, err := r.FundWallet("investor1", 100000); err != nil {
		t.Fatalf("fund: %v", err)
	}
	si, err := r.SettleDvP(DvPRequest{
		AssetID: "PROP-X", Seller: "originator1", Buyer: "investor1",
		Tokens: 10, PricePerTokenINR: 100, AutoAssignISIN: true,
	})
	if err != nil || si.Status != UMIStatusSettled {
		t.Fatalf("settlement broke without a register: %v %+v", err, si)
	}
}
