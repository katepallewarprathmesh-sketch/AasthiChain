package drunix

import (
	"strings"
	"testing"
)

// attestSetup builds a rail with one attested asset, one holder and one
// settled trade, which is the smallest world in which exposure means
// anything.
func attestSetup(t *testing.T) (*AttestationService, *CredentialRegistry, *UMIRail, string) {
	t.Helper()
	chain := NewChain()
	creds := NewCredentialRegistry(chain)
	rail := NewUMIRail(NewMemorySecurities(), chain)
	att := NewAttestationService(chain, creds, rail)
	if att == nil {
		t.Fatal("attestation service was not wired")
	}

	const asset = "PROP-ATTEST-1"
	if _, err := rail.SeedPosition(asset, "originator1", 1000, 1000); err != nil {
		t.Fatalf("seed: %v", err)
	}
	if _, _, err := rail.FundWallet("investor1", 100000); err != nil {
		t.Fatalf("fund: %v", err)
	}
	return att, creds, rail, asset
}

func attest(t *testing.T, creds *CredentialRegistry, asset string) *credentialRecord {
	t.Helper()
	rec, err := creds.IssueTitleCredential("registrar1", "originator1", asset, map[string]interface{}{
		"titleValidated": true,
	})
	if err != nil {
		t.Fatalf("attest: %v", err)
	}
	return rec
}

func TestAttestationImpactNamesHoldersAndTrades(t *testing.T) {
	att, creds, rail, asset := attestSetup(t)
	rec := attest(t, creds, asset)

	if _, err := rail.SettleDvP(DvPRequest{
		AssetID: asset, Seller: "originator1", Buyer: "investor1",
		Tokens: 100, PricePerTokenINR: 100, AutoAssignISIN: true,
	}); err != nil {
		t.Fatalf("settle: %v", err)
	}

	impact, err := att.Impact(rec.Credential.ID)
	if err != nil {
		t.Fatalf("impact: %v", err)
	}
	if impact.AssetID != asset || impact.Attestor != "registrar1" {
		t.Fatalf("impact describes the wrong attestation: %+v", impact)
	}
	if impact.HolderCount != 2 || impact.TokensOutstandng != 1000 {
		t.Errorf("holders wrong: count=%d tokens=%d", impact.HolderCount, impact.TokensOutstandng)
	}
	if impact.TradeCount != 1 || impact.ValueSettledPais != INRToPaise(10000) {
		t.Errorf("trades wrong: count=%d value=%d", impact.TradeCount, impact.ValueSettledPais)
	}
	if impact.Accountability == "" {
		t.Error("the impact does not say what the attestor is accountable for")
	}
	if !strings.Contains(strings.ToLower(impact.Recourse), "none") {
		t.Errorf("recourse must not be overstated: %q", impact.Recourse)
	}
}

// A trade that settled before the attestation existed did not rely on it, and
// counting it would overstate the attestor's exposure.
func TestAttestationExcludesTradesBeforeIt(t *testing.T) {
	att, creds, rail, asset := attestSetup(t)

	if _, err := rail.SettleDvP(DvPRequest{
		AssetID: asset, Seller: "originator1", Buyer: "investor1",
		Tokens: 10, PricePerTokenINR: 100, AutoAssignISIN: true,
	}); err != nil {
		t.Fatalf("settle: %v", err)
	}
	rec := attest(t, creds, asset)

	impact, err := att.Impact(rec.Credential.ID)
	if err != nil {
		t.Fatalf("impact: %v", err)
	}
	if impact.TradeCount != 0 {
		t.Errorf("a trade that predates the attestation was counted against it: %d", impact.TradeCount)
	}
	// It still has holder exposure: those tokens exist regardless.
	if impact.TokensOutstandng == 0 {
		t.Error("holder exposure was dropped along with the trade")
	}
}

func TestAttestationWithdrawalIsRecordedWithTheHoldersOfThatMoment(t *testing.T) {
	att, creds, rail, asset := attestSetup(t)
	rec := attest(t, creds, asset)
	if _, err := rail.SettleDvP(DvPRequest{
		AssetID: asset, Seller: "originator1", Buyer: "investor1",
		Tokens: 100, PricePerTokenINR: 100, AutoAssignISIN: true,
	}); err != nil {
		t.Fatalf("settle: %v", err)
	}
	if _, err := creds.Revoke(rec.Credential.ID, "registrar1", "survey showed a boundary dispute"); err != nil {
		t.Fatalf("revoke: %v", err)
	}

	impact, blk := att.RecordWithdrawal(rec.Credential.ID)
	if blk == nil {
		t.Fatal("no notice block was appended")
	}
	if blk.Type != BlockAttestationWithdrawn {
		t.Errorf("wrong block type: %s", blk.Type)
	}
	if !impact.Withdrawn || impact.WithdrawnReason == "" {
		t.Errorf("the withdrawal is not reflected in the impact: %+v", impact)
	}
	txn := blk.Txns[0]
	if got, _ := txn["assetId"].(string); got != asset {
		t.Errorf("the notice names the wrong asset: %v", txn["assetId"])
	}
	if got, _ := txn["attestor"].(string); got != "registrar1" {
		t.Errorf("the notice does not name the attestor: %v", txn["attestor"])
	}
	// The dangerous failure here would be a notice that reads like a
	// reversal, so the block has to say plainly that nothing was undone.
	effect, _ := txn["effect"].(string)
	if !strings.Contains(strings.ToLower(effect), "no settled trade is reversed") {
		t.Errorf("the notice does not disclaim reversal: %q", effect)
	}
	if rail.PositionOf(asset, "investor1") != 100 {
		t.Error("withdrawing an attestation moved tokens, which it must never do")
	}
}

// Withdrawing an attestation that nobody holds must not invent an exposure.
func TestAttestationWithdrawalWithoutAnAssetIsQuiet(t *testing.T) {
	att, creds, _, _ := attestSetup(t)
	rec, err := creds.Issue("registrar1", CredentialKYCStatus, map[string]interface{}{"id": "investor1"})
	if err != nil {
		t.Fatalf("issue: %v", err)
	}
	if _, err := creds.Revoke(rec.Credential.ID, "registrar1", "documents expired"); err != nil {
		t.Fatalf("revoke: %v", err)
	}
	impact, blk := att.RecordWithdrawal(rec.Credential.ID)
	if blk != nil {
		t.Error("a credential with no asset produced an asset exposure notice")
	}
	if impact == nil || impact.TokensOutstandng != 0 || impact.TradeCount != 0 {
		t.Errorf("exposure was invented for a non-asset credential: %+v", impact)
	}
}

func TestAttestorRecordCountsWhatWasWithdrawn(t *testing.T) {
	att, creds, _, asset := attestSetup(t)
	good := attest(t, creds, asset)
	_ = good
	bad, err := creds.IssueTitleCredential("registrar1", "originator1", asset+"-B", nil)
	if err != nil {
		t.Fatalf("attest: %v", err)
	}
	if _, err := creds.Revoke(bad.Credential.ID, "registrar1", "wrong parcel"); err != nil {
		t.Fatalf("revoke: %v", err)
	}

	rec := att.Attestor("registrar1")
	if rec.Issued != 2 || rec.Withdrawn != 1 || rec.Standing != 1 {
		t.Errorf("record wrong: %+v", rec)
	}
	if rec.WithdrawalRate != "50% (1 of 2)" {
		t.Errorf("withdrawal rate wrong: %q", rec.WithdrawalRate)
	}
	if rec.PublicKey == "" {
		t.Error("an attestor record without the key cannot be checked by anyone")
	}
	if !strings.Contains(strings.ToLower(rec.Accountability), "does not enforce") {
		t.Errorf("the record overstates what the rail enforces: %q", rec.Accountability)
	}
	empty := att.Attestor("nobody1")
	if empty.Issued != 0 || empty.WithdrawalRate != "0% (0 of 0)" {
		t.Errorf("an unknown attestor produced a figure: %+v", empty)
	}
}
