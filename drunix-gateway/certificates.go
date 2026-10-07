package drunix

// Generated documents: contract notes and coupon advices.
//
// The register built in documents.go covers documents that arrive from
// outside — deeds, encumbrance certificates, government IDs. This file covers
// the other half, which was missing entirely: the documents AasthiChain
// ITSELF produces.
//
// Every settlement and every coupon or rent payment is, in the real market, a
// piece of paper somebody keeps:
//
//   - a CONTRACT NOTE confirming a trade (what a broker must issue), and
//   - a COUPON / RENT ADVICE confirming income paid to a holder, which for a
//     bond is the document the holder files with their tax return.
//
// Until now those existed only as rows in memory. A holder could be told
// "₹2,000 was credited to you" but had nothing they could hand to an auditor
// and nothing anyone could verify independently.
//
// Two design rules make these worth anchoring:
//
//  1. DETERMINISM. A certificate is a pure function of facts already on the
//     ledger — instruction id, parties, quantity, price, block height. It
//     contains no wall-clock "generated at", no sequence number, nothing that
//     varies between renderings. Regenerate it a year later and you get byte
//     for byte the same document, and therefore the same CID. That is what
//     makes the certificate itself verifiable rather than just stored: anyone
//     with the underlying facts can rebuild it and check the hash matches.
//
//  2. NON-BLOCKING. Certificate generation happens after the rail's lock is
//     released, exactly like notifications, and a failure is swallowed. A
//     settlement that already moved money must never be undone, delayed or
//     failed because a PDF-equivalent could not be written.

import (
	"encoding/json"
	"fmt"
	"time"
)

// Certificate document types.
const (
	DocTypeContractNote = "CONTRACT_NOTE"
	DocTypeIncomeAdvice = "INCOME_ADVICE"
)

// contractNote is the deterministic body of a trade confirmation.
//
// Field order is the JSON field order, and encoding/json preserves struct
// order, so the bytes are stable. Floats are avoided in favour of the paise
// integers the rail settles in — a float's text representation is a bad thing
// to hash.
type contractNote struct {
	Document       string `json:"document"`
	InstructionID  string `json:"instructionId"`
	ISIN           string `json:"isin,omitempty"`
	AssetID        string `json:"assetId"`
	Seller         string `json:"seller"`
	Buyer          string `json:"buyer"`
	Tokens         int64  `json:"tokens"`
	PricePaise     int64  `json:"pricePerTokenPaise"`
	ConsiderPaise  int64  `json:"considerationPaise"`
	SettlementType string `json:"settlement"`
	CashLeg        string `json:"cashLeg"`
	SecuritiesLeg  string `json:"securitiesLeg"`
	SettledAt      string `json:"settledAt"`
	BlockHeight    int64  `json:"ledgerBlockHeight"`
	BlockHash      string `json:"ledgerBlockHash"`
	Rail           string `json:"rail"`
	Disclaimer     string `json:"disclaimer"`
}

// incomeAdvice is the deterministic body of a coupon or rent advice.
type incomeAdvice struct {
	Document    string `json:"document"`
	ServicingID string `json:"servicingId"`
	ISIN        string `json:"isin,omitempty"`
	AssetID     string `json:"assetId"`
	Payer       string `json:"payer"`
	Holder      string `json:"holder"`
	Tokens      int64  `json:"tokensHeld"`
	AmountPaise int64  `json:"amountPaise"`
	Basis       string `json:"allocationBasis"`
	PaidAt      string `json:"paidAt"`
	BlockHeight int64  `json:"ledgerBlockHeight"`
	Rail        string `json:"rail"`
	Disclaimer  string `json:"disclaimer"`
}

// canonicalJSON renders a certificate body deterministically. Indentation is
// fixed so the document is readable when opened, and readable matters: a
// certificate nobody can read is not a certificate.
func canonicalJSON(v interface{}) ([]byte, error) {
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return nil, err
	}
	return append(b, '\n'), nil
}

// WithDocuments attaches the register so the rail can file the certificates
// it generates. Optional: with no register the rail behaves exactly as before.
func (r *UMIRail) WithDocuments(dr *DocumentRegistry) *UMIRail {
	r.mu.Lock()
	r.docs = dr
	r.mu.Unlock()
	return r
}

// documentRegistry reads the register reference under the lock.
func (r *UMIRail) documentRegistry() *DocumentRegistry {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.docs
}

// BuildContractNote renders the deterministic bytes of a trade confirmation.
// Exported so a verifier can rebuild the document from the instruction and
// confirm the CID, without having to trust the copy they were handed.
func BuildContractNote(si *SettlementInstruction) ([]byte, error) {
	if si == nil {
		return nil, fmt.Errorf("no instruction")
	}
	settled := ""
	if si.SettledAt != nil {
		settled = si.SettledAt.UTC().Format(time.RFC3339)
	}
	var pricePaise int64
	if si.Tokens > 0 {
		pricePaise = si.CashPaise / si.Tokens
	}
	return canonicalJSON(contractNote{
		Document:       "Contract note — UMI atomic DvP settlement",
		InstructionID:  si.InstructionID,
		ISIN:           si.ISIN,
		AssetID:        si.AssetID,
		Seller:         si.Seller,
		Buyer:          si.Buyer,
		Tokens:         si.Tokens,
		PricePaise:     pricePaise,
		ConsiderPaise:  si.CashPaise,
		SettlementType: "Atomic delivery-versus-payment, both legs or neither",
		CashLeg:        si.CashLeg,
		SecuritiesLeg:  si.SecuritiesLeg,
		SettledAt:      settled,
		BlockHeight:    si.BlockHeight,
		BlockHash:      si.BlockHash,
		Rail:           "RBI UMI pattern (simulated), e₹-W wholesale CBDC cash leg",
		Disclaimer:     UMIDisclaimer,
	})
}

// BuildIncomeAdvice renders the deterministic bytes of a coupon or rent advice.
func BuildIncomeAdvice(rec ServicingRecord, basis string) ([]byte, error) {
	return canonicalJSON(incomeAdvice{
		Document:    "Income advice — coupon or rent distributed to a CBDC wallet",
		ServicingID: rec.ServicingID,
		ISIN:        rec.ISIN,
		AssetID:     rec.AssetID,
		Payer:       rec.Payer,
		Holder:      rec.Holder,
		Tokens:      rec.Tokens,
		AmountPaise: rec.AmountPaise,
		Basis:       basis,
		PaidAt:      rec.SettledAt.UTC().Format(time.RFC3339),
		BlockHeight: rec.BlockHeight,
		Rail:        "RBI UMI pattern (simulated), e₹-W wholesale CBDC cash leg",
		Disclaimer:  UMIDisclaimer,
	})
}

// fileContractNote anchors the confirmation for a settled trade.
//
// Called after the rail lock is released. Errors are dropped on purpose: the
// trade is already final, and a filing problem must not surface as a
// settlement failure. A duplicate (the same trade certified twice) is simply
// the same bytes and is rejected by the register, which is the correct
// outcome, not an error worth reporting.
func (r *UMIRail) fileContractNote(si *SettlementInstruction) {
	dr := r.documentRegistry()
	if dr == nil || si == nil || si.Status != UMIStatusSettled || si.DryRun {
		return
	}
	body, err := BuildContractNote(si)
	if err != nil {
		return
	}
	_, _, _ = dr.Anchor(AnchorRequest{
		AssetID:     si.AssetID,
		DocType:     DocTypeContractNote,
		Title:       "Contract note " + si.InstructionID,
		Issuer:      "AasthiChain UMI rail",
		SubmittedBy: si.Buyer,
		MediaType:   "application/json",
		// Restricted: a contract note names both counterparties and the
		// consideration. The parties, a registrar and a regulator can read
		// it; the fact of its existence is public, as it should be.
		Visibility: DocRestricted,
		Parties:    []string{si.Buyer, si.Seller},
		Content:    body,
	})
}

// fileIncomeAdvices anchors one advice per holder paid.
func (r *UMIRail) fileIncomeAdvices(records []ServicingRecord, basis string) {
	dr := r.documentRegistry()
	if dr == nil || len(records) == 0 {
		return
	}
	for _, rec := range records {
		body, err := BuildIncomeAdvice(rec, basis)
		if err != nil {
			continue
		}
		_, _, _ = dr.Anchor(AnchorRequest{
			AssetID:     rec.AssetID,
			Subject:     rec.Holder,
			DocType:     DocTypeIncomeAdvice,
			Title:       "Income advice " + rec.ServicingID,
			Issuer:      "AasthiChain UMI rail",
			SubmittedBy: rec.Holder,
			MediaType:   "application/json",
			Visibility:  DocRestricted,
			Parties:     []string{rec.Holder, rec.Payer},
			Content:     body,
		})
	}
}
