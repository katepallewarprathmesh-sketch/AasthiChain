package drunix

import (
	"errors"
	"strings"
	"testing"
	"time"
)

func backingRig(t *testing.T) (*UMIRail, *BackingRegistry) {
	t.Helper()
	chain := NewChain()
	rail := NewUMIRail(NewMemorySecurities(), chain)
	reg := NewBackingRegistry(rail, chain)
	rail.SetIssuanceGate(reg)
	return rail, reg
}

func goodStatement() BackingRequest {
	return BackingRequest{
		AssetID:      "PROP-BACKED",
		BackedUnits:  1000,
		ValuationINR: 5000000,
		Method:       "registry extract",
		EvidenceHash: strings.Repeat("a", 64),
		Cadence:      "720h",
	}
}

func TestBackingStatementNeedsRealEvidence(t *testing.T) {
	_, reg := backingRig(t)

	bad := []BackingRequest{
		func() BackingRequest { r := goodStatement(); r.AssetID = ""; return r }(),
		func() BackingRequest { r := goodStatement(); r.BackedUnits = 0; return r }(),
		func() BackingRequest { r := goodStatement(); r.EvidenceHash = "not-a-hash"; return r }(),
		func() BackingRequest { r := goodStatement(); r.Method = ""; return r }(),
		func() BackingRequest { r := goodStatement(); r.Cadence = "9000h"; return r }(),
		func() BackingRequest { r := goodStatement(); r.Cadence = "sometimes"; return r }(),
		func() BackingRequest {
			r := goodStatement()
			r.AsOf = time.Now().Add(48 * time.Hour).Format(time.RFC3339)
			return r
		}(),
	}
	for i, req := range bad {
		if _, err := reg.Attest(req, "registrar1", false); err == nil {
			t.Errorf("case %d: a statement with nothing behind it was accepted", i)
		}
	}

	st, err := reg.Attest(goodStatement(), "registrar1", false)
	if err != nil {
		t.Fatalf("a complete statement was refused: %v", err)
	}
	if st.NextDueAt.Sub(st.AsOf) != 720*time.Hour {
		t.Errorf("refresh date is %s after the as-of date, want 720h", st.NextDueAt.Sub(st.AsOf))
	}
}

func TestIssuanceStopsAtTheAttestedFigure(t *testing.T) {
	rail, reg := backingRig(t)
	if _, err := reg.Attest(goodStatement(), "registrar1", false); err != nil {
		t.Fatalf("attest: %v", err)
	}

	// Within the attested backing: allowed.
	if _, err := rail.SeedPosition("PROP-BACKED", "originator1", 800, 5000); err != nil {
		t.Fatalf("issuance inside the attested figure was refused: %v", err)
	}

	// Past it: refused, even though the declared cap of 5,000 has room.
	_, err := rail.SeedPosition("PROP-BACKED", "investor1", 900, 5000)
	if !errors.Is(err, ErrBackingShort) {
		t.Fatalf("issuance past the attested figure was allowed: %v", err)
	}
	if got := rail.securities.Position("PROP-BACKED", "investor1"); got != 0 {
		t.Errorf("a refused issuance still moved %d tokens", got)
	}

	// The refusal is on the ledger, or the gate cannot be audited.
	var blocked bool
	for _, blk := range NewChainView(rail) {
		if blk == BlockIssueBlocked {
			blocked = true
		}
	}
	if !blocked {
		t.Error("the refusal was not recorded on the chain")
	}

	cov := reg.Coverage("PROP-BACKED", time.Now().UTC())
	if cov.Status != BackingBacked || cov.TokensOutstanding != 800 || cov.Headroom != 200 {
		t.Errorf("coverage reads %+v", cov)
	}
	if cov.CoveragePercent < 79.9 || cov.CoveragePercent > 80.1 {
		t.Errorf("coverage percent is %v, want 80", cov.CoveragePercent)
	}
}

// NewChainView lists the committed block types, which is all these tests need.
func NewChainView(r *UMIRail) []string {
	out := []string{}
	for _, b := range r.chain.Blocks {
		out = append(out, b.Type)
	}
	return out
}

func TestStaleStatementCannotAuthoriseIssuance(t *testing.T) {
	_, reg := backingRig(t)
	req := goodStatement()
	req.Cadence = "1h"
	req.AsOf = time.Now().Add(-3 * time.Hour).UTC().Format(time.RFC3339)
	if _, err := reg.Attest(req, "registrar1", false); err != nil {
		t.Fatalf("attest: %v", err)
	}

	cov := reg.Coverage("PROP-BACKED", time.Now().UTC())
	if cov.Status != BackingStale {
		t.Fatalf("a statement two hours past its refresh date reads %s", cov.Status)
	}
	if cov.MayIssue {
		t.Error("a stale statement still permits issuance")
	}
	err := reg.GateIssue("PROP-BACKED", 1, "originator1", time.Now().UTC())
	if !errors.Is(err, ErrBackingStale) {
		t.Errorf("the gate let a stale statement through: %v", err)
	}
	if !strings.Contains(strings.ToLower(cov.Reading), "evidence about the past") {
		t.Errorf("the reading does not explain staleness: %q", cov.Reading)
	}
}

func TestWithdrawnStatementBlocksIssuanceButReversesNothing(t *testing.T) {
	rail, reg := backingRig(t)
	if _, err := reg.Attest(goodStatement(), "registrar1", false); err != nil {
		t.Fatalf("attest: %v", err)
	}
	if _, err := rail.SeedPosition("PROP-BACKED", "originator1", 500, 5000); err != nil {
		t.Fatalf("seed: %v", err)
	}

	if _, err := reg.Withdraw("PROP-BACKED", "the registry extract was superseded", "investor1", false); !errors.Is(err, ErrBackingNotYours) {
		t.Errorf("somebody else's statement could be withdrawn: %v", err)
	}
	if _, err := reg.Withdraw("PROP-BACKED", "the registry extract was superseded", "registrar1", false); err != nil {
		t.Fatalf("withdraw: %v", err)
	}

	cov := reg.Coverage("PROP-BACKED", time.Now().UTC())
	if cov.Status != BackingWithdrawn || cov.MayIssue {
		t.Errorf("coverage after withdrawal reads %+v", cov)
	}
	if got := rail.securities.Position("PROP-BACKED", "originator1"); got != 500 {
		t.Errorf("withdrawal moved tokens: holder now has %d, want 500", got)
	}
	if err := reg.GateIssue("PROP-BACKED", 1, "originator1", time.Now().UTC()); !errors.Is(err, ErrBackingWithdrawn) {
		t.Errorf("issuance continued after withdrawal: %v", err)
	}
}

// The condition the whole file exists to surface.
func TestOverIssuanceIsReportedNotHidden(t *testing.T) {
	rail, reg := backingRig(t)
	// Issue first, attest afterwards to a smaller figure: exactly what
	// happens when the book was built before anybody checked.
	if _, err := rail.SeedPosition("PROP-THIN", "originator1", 1000, 1000); err != nil {
		t.Fatalf("seed: %v", err)
	}
	req := goodStatement()
	req.AssetID = "PROP-THIN"
	req.BackedUnits = 600
	if _, err := reg.Attest(req, "registrar1", false); err != nil {
		t.Fatalf("attest: %v", err)
	}

	cov := reg.Coverage("PROP-THIN", time.Now().UTC())
	if cov.Status != BackingOverIssued {
		t.Fatalf("1000 tokens against 600 units reads %s", cov.Status)
	}
	if cov.Headroom != -400 {
		t.Errorf("headroom is %d, want -400", cov.Headroom)
	}
	if cov.MayIssue {
		t.Error("an over-issued book still permits issuance")
	}
	if !strings.Contains(cov.Reading, "larger than") {
		t.Errorf("the reading is evasive: %q", cov.Reading)
	}
	// It must not have quietly burned anything to make the number look right.
	if got := rail.securities.Position("PROP-THIN", "originator1"); got != 1000 {
		t.Errorf("tokens were adjusted to fit the attestation: %d", got)
	}
}

func TestUnattestedAssetsBehaveExactlyAsBefore(t *testing.T) {
	rail, reg := backingRig(t)
	if _, err := rail.SeedPosition("PROP-PLAIN", "originator1", 15000, 15000); err != nil {
		t.Fatalf("an asset nobody attested was blocked: %v", err)
	}
	cov := reg.Coverage("PROP-PLAIN", time.Now().UTC())
	if cov.Status != BackingUnattested || !cov.MayIssue {
		t.Errorf("coverage reads %+v", cov)
	}
	if !strings.Contains(cov.Reading, "issuer's own figure") {
		t.Errorf("the page would imply backing nobody stated: %q", cov.Reading)
	}
}

func TestBackingSurvivesRestart(t *testing.T) {
	chain := NewChain()
	rail := NewUMIRail(NewMemorySecurities(), chain)
	reg := NewBackingRegistry(rail, chain)
	rail.SetIssuanceGate(reg)
	if _, err := reg.Attest(goodStatement(), "registrar1", false); err != nil {
		t.Fatalf("attest: %v", err)
	}
	if _, err := reg.Withdraw("PROP-BACKED", "superseded", "registrar1", false); err != nil {
		t.Fatalf("withdraw: %v", err)
	}

	rail2 := NewUMIRail(NewMemorySecurities(), chain)
	reg2 := NewBackingRegistry(rail2, chain)
	if n := reg2.RestoreBackingFromChain(); n != 1 {
		t.Fatalf("restored %d statements, want 1", n)
	}
	cov := reg2.Coverage("PROP-BACKED", time.Now().UTC())
	if cov.Status != BackingWithdrawn {
		t.Errorf("the withdrawal did not survive the restart: %s", cov.Status)
	}
	if cov.BackedUnits != 1000 || cov.EvidenceHash != strings.Repeat("a", 64) {
		t.Errorf("the statement came back wrong: %+v", cov)
	}
}

func TestSolvencyPutsTheWorstFirstAndStaysHonest(t *testing.T) {
	rail, reg := backingRig(t)
	ok := goodStatement()
	if _, err := reg.Attest(ok, "registrar1", false); err != nil {
		t.Fatalf("attest: %v", err)
	}
	thin := goodStatement()
	thin.AssetID = "PROP-THIN"
	thin.BackedUnits = 10
	if _, err := rail.SeedPosition("PROP-THIN", "originator1", 100, 100); err != nil {
		t.Fatalf("seed: %v", err)
	}
	if _, err := reg.Attest(thin, "registrar1", false); err != nil {
		t.Fatalf("attest: %v", err)
	}

	sum := reg.Solvency(time.Now().UTC())
	rows, _ := sum["assets"].([]BackingCoverage)
	if len(rows) != 2 {
		t.Fatalf("solvency lists %d assets, want 2", len(rows))
	}
	if rows[0].Status != BackingOverIssued {
		t.Errorf("the worst asset is not first: %s", rows[0].Status)
	}
	note, _ := sum["disclaimer"].(string)
	if !strings.Contains(note, "cannot check") {
		t.Errorf("the summary overstates what the rail verifies: %q", note)
	}
	onFail, _ := sum["onFailure"].(string)
	if !strings.Contains(onFail, "does not burn tokens") {
		t.Errorf("the summary implies a reversal it does not perform: %q", onFail)
	}
}
