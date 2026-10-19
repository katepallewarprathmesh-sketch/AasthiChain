package drunix

import (
	"errors"
	"strings"
	"testing"
	"time"
)

func outcomeDesk(t *testing.T) (*WorkDesk, *UMIRail) {
	t.Helper()
	chain := NewChain()
	rail := NewUMIRail(NewMemorySecurities(), chain)
	if _, _, err := rail.FundWallet("investor1", 100000); err != nil {
		t.Fatalf("fund: %v", err)
	}
	return NewWorkDesk(rail, nil), rail
}

func outcomeRequest() WorkRequest {
	return WorkRequest{
		AssetID: "PROP-OUTCOME", Title: "Structural survey", Category: "INSPECTION",
		Funder: "investor1", FeeINR: 5000,
		Verifier: "registrar1",
		Checks: []OutcomeCheck{
			{Name: "site-visit-evidence", Required: true},
			{Name: "report-signed-off", Required: true},
			{Name: "photos-attached", Required: false},
		},
		DisputeWindow: "1h",
	}
}

// Drive an order to SUBMITTED, which is where verification starts.
func submitted(t *testing.T, d *WorkDesk, req WorkRequest) *WorkOrder {
	t.Helper()
	o, err := d.Create(req, "investor1")
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if _, err := d.Fund(o.OrderID, "investor1"); err != nil {
		t.Fatalf("fund: %v", err)
	}
	if _, err := d.Assign(o.OrderID, "originator1", "", "investor1"); err != nil {
		t.Fatalf("assign: %v", err)
	}
	hash := strings.Repeat("a", 64)
	out, err := d.Submit(o.OrderID, hash, "ipfs://x", "done", "originator1")
	if err != nil {
		t.Fatalf("submit: %v", err)
	}
	return out
}

func TestOutcomeTermsAreAgreedUpFront(t *testing.T) {
	d, _ := outcomeDesk(t)
	o, err := d.Create(outcomeRequest(), "investor1")
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if o.Outcome == nil || o.Outcome.Verifier != "registrar1" || len(o.Outcome.Checks) != 3 {
		t.Fatalf("terms were not recorded: %+v", o.Outcome)
	}
	for _, c := range o.Outcome.Checks {
		if c.Status != CheckPending {
			t.Errorf("check %s started as %s", c.Name, c.Status)
		}
	}

	bad := []WorkRequest{
		func() WorkRequest { r := outcomeRequest(); r.Verifier = ""; return r }(),
		func() WorkRequest { r := outcomeRequest(); r.Checks = nil; return r }(),
		func() WorkRequest {
			r := outcomeRequest()
			r.Checks = []OutcomeCheck{{Name: "only-optional", Required: false}}
			return r
		}(),
		func() WorkRequest {
			r := outcomeRequest()
			r.Checks = []OutcomeCheck{{Name: "dupe", Required: true}, {Name: "DUPE", Required: true}}
			return r
		}(),
		func() WorkRequest { r := outcomeRequest(); r.DisputeWindow = "9000h"; return r }(),
		func() WorkRequest { r := outcomeRequest(); r.DisputeWindow = "soon"; return r }(),
	}
	for i, req := range bad {
		if _, err := d.Create(req, "investor1"); err == nil {
			t.Errorf("case %d: nonsense terms were accepted", i)
		}
	}
}

// The verifier records checks. Nobody else, and above all not the worker.
func TestOnlyTheVerifierRecordsChecks(t *testing.T) {
	d, _ := outcomeDesk(t)
	o := submitted(t, d, outcomeRequest())

	for _, actor := range []string{"originator1", "investor1", "investor2"} {
		_, err := d.RecordCheck(o.OrderID, CheckRequest{Name: "site-visit-evidence", Passed: true}, actor, false)
		if !errors.Is(err, ErrWorkNotVerifier) && !errors.Is(err, ErrWorkSelfDeal) {
			t.Errorf("%s was allowed to record a check: %v", actor, err)
		}
	}
	if _, err := d.RecordCheck(o.OrderID, CheckRequest{Name: "nope", Passed: true}, "registrar1", false); err == nil {
		t.Error("a check nobody agreed to was recorded")
	}
	if _, err := d.RecordCheck(o.OrderID, CheckRequest{Name: "site-visit-evidence", Passed: true, Evidence: "hash"}, "registrar1", false); err != nil {
		t.Fatalf("the verifier could not record a check: %v", err)
	}
	if _, err := d.RecordCheck(o.OrderID, CheckRequest{Name: "site-visit-evidence", Passed: false}, "registrar1", false); err == nil {
		t.Error("a recorded check was overwritten")
	}
}

// Passing every required check must not pay anybody yet.
func TestVerificationDoesNotReleaseImmediately(t *testing.T) {
	d, rail := outcomeDesk(t)
	o := submitted(t, d, outcomeRequest())

	if _, err := d.RecordCheck(o.OrderID, CheckRequest{Name: "site-visit-evidence", Passed: true}, "registrar1", false); err != nil {
		t.Fatalf("check: %v", err)
	}
	mid, _ := d.Order(o.OrderID)
	if mid.Status != WorkStatusSubmitted {
		t.Errorf("one of two required checks moved the order to %s", mid.Status)
	}
	after, err := d.RecordCheck(o.OrderID, CheckRequest{Name: "report-signed-off", Passed: true}, "registrar1", false)
	if err != nil {
		t.Fatalf("check: %v", err)
	}
	if after.Status != WorkStatusVerified {
		t.Fatalf("status is %s, want VERIFIED", after.Status)
	}
	if after.Outcome.ReleaseDueAt == nil {
		t.Fatal("no release time was set")
	}
	if !after.Escrowed {
		t.Error("the escrow was released on verification, before the dispute window")
	}
	if w, _ := rail.Wallet("originator1"); w != nil && w.BalancePaise != 0 {
		t.Errorf("the worker was paid early: %d paise", w.BalancePaise)
	}
	// The optional check never being recorded must not block anything.
	if n := after.Outcome.requiredOutstanding(); n != 0 {
		t.Errorf("%d required checks still outstanding", n)
	}
}

func TestFinaliseRespectsTheDisputeWindow(t *testing.T) {
	d, rail := outcomeDesk(t)
	o := submitted(t, d, outcomeRequest())
	for _, name := range []string{"site-visit-evidence", "report-signed-off"} {
		if _, err := d.RecordCheck(o.OrderID, CheckRequest{Name: name, Passed: true}, "registrar1", false); err != nil {
			t.Fatalf("check: %v", err)
		}
	}
	// A stranger cannot pull the money forward.
	if _, err := d.Finalise(o.OrderID, "investor2", false); !errors.Is(err, ErrWorkWindowOpen) {
		t.Errorf("the window was ignored: %v", err)
	}
	// The funder may waive the rest of their own window.
	done, err := d.Finalise(o.OrderID, "investor1", false)
	if err != nil {
		t.Fatalf("finalise: %v", err)
	}
	if done.Status != WorkStatusAccepted || done.Escrowed {
		t.Fatalf("order did not close: %+v", done.Status)
	}
	if w, _ := rail.Wallet("originator1"); w == nil || w.BalancePaise != INRToPaise(5000) {
		t.Errorf("the worker was not paid the fee")
	}
	if fw, _ := rail.Wallet("investor1"); fw != nil && fw.ReservedPaise != 0 {
		t.Errorf("the reservation was left behind: %d", fw.ReservedPaise)
	}
	if done.Outcome.ReleaseTrigger == "" {
		t.Error("the record does not say why the money moved")
	}
}

// Silence must not be a free delay: once the window closes the clock pays.
func TestTheClockReleasesAndRefunds(t *testing.T) {
	d, rail := outcomeDesk(t)
	o := submitted(t, d, outcomeRequest())
	for _, name := range []string{"site-visit-evidence", "report-signed-off"} {
		if _, err := d.RecordCheck(o.OrderID, CheckRequest{Name: name, Passed: true}, "registrar1", false); err != nil {
			t.Fatalf("check: %v", err)
		}
	}
	if changed := d.Tick(time.Now().UTC()); len(changed) != 0 {
		t.Errorf("the clock paid out while the window was open: %v", changed)
	}
	changed := d.Tick(time.Now().UTC().Add(2 * time.Hour))
	if len(changed) != 1 {
		t.Fatalf("the clock did not release after the window: %v", changed)
	}
	if w, _ := rail.Wallet("originator1"); w == nil || w.BalancePaise != INRToPaise(5000) {
		t.Error("the worker was not paid when the window closed")
	}

	// And the other direction: nothing delivered by the deadline.
	req := outcomeRequest()
	req.DeliverWithin = "1h"
	o2, err := d.Create(req, "investor1")
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if _, err := d.Fund(o2.OrderID, "investor1"); err != nil {
		t.Fatalf("fund: %v", err)
	}
	before, _ := rail.Wallet("investor1")
	reserved := before.ReservedPaise
	if reserved == 0 {
		t.Fatal("funding reserved nothing")
	}
	d.Tick(time.Now().UTC().Add(3 * time.Hour))
	expired, _ := d.Order(o2.OrderID)
	if expired.Status != WorkStatusRefunded {
		t.Errorf("an undelivered order stayed %s", expired.Status)
	}
	if after, _ := rail.Wallet("investor1"); after.ReservedPaise != 0 {
		t.Errorf("the escrow was not returned: %d reserved", after.ReservedPaise)
	}
}

// A failed required check freezes the money. It must not pay, and it must not
// unilaterally end the engagement either.
func TestFailedCheckFreezesRatherThanPays(t *testing.T) {
	d, rail := outcomeDesk(t)
	o := submitted(t, d, outcomeRequest())
	out, err := d.RecordCheck(o.OrderID, CheckRequest{
		Name: "report-signed-off", Passed: false, Detail: "no load calculations",
	}, "registrar1", false)
	if err != nil {
		t.Fatalf("check: %v", err)
	}
	if out.Status != WorkStatusDisputed {
		t.Errorf("a failed required check left the order at %s", out.Status)
	}
	if !out.Escrowed {
		t.Error("the escrow was released despite a failed check")
	}
	if w, _ := rail.Wallet("originator1"); w != nil && w.BalancePaise != 0 {
		t.Error("the worker was paid on a failed check")
	}
	if _, err := d.Finalise(o.OrderID, "investor1", false); err == nil {
		t.Error("a disputed order could be finalised")
	}
}

// An order with outcome terms must not be payable by hand, or the checks are
// decoration.
func TestManualAcceptCannotBypassTheChecks(t *testing.T) {
	d, _ := outcomeDesk(t)
	o := submitted(t, d, outcomeRequest())
	if _, err := d.Accept(o.OrderID, "looks fine to me", "investor1"); err == nil {
		t.Fatal("the funder accepted around the agreed verification")
	}
	// An ordinary order without terms still works exactly as before.
	plain := WorkRequest{
		AssetID: "PROP-PLAIN", Title: "Photos", Category: "PHOTOGRAPHY",
		Funder: "investor1", FeeINR: 100,
	}
	p := submitted(t, d, plain)
	if _, err := d.Accept(p.OrderID, "", "investor1"); err != nil {
		t.Errorf("an order with no outcome terms stopped working: %v", err)
	}
}

// Terms, results and deadlines have to survive a restart.
func TestOutcomeTermsSurviveRestart(t *testing.T) {
	chain := NewChain()
	rail := NewUMIRail(NewMemorySecurities(), chain)
	if _, _, err := rail.FundWallet("investor1", 100000); err != nil {
		t.Fatalf("fund: %v", err)
	}
	d := NewWorkDesk(rail, nil)
	o := submitted(t, d, outcomeRequest())
	if _, err := d.RecordCheck(o.OrderID, CheckRequest{Name: "site-visit-evidence", Passed: true, Evidence: "abc"}, "registrar1", false); err != nil {
		t.Fatalf("check: %v", err)
	}

	restarted := NewWorkDesk(NewUMIRail(NewMemorySecurities(), chain), nil)
	if n := restarted.RestoreWorkFromChain(); n == 0 {
		t.Fatal("nothing was restored")
	}
	back, ok := restarted.Order(o.OrderID)
	if !ok || back.Outcome == nil {
		t.Fatal("the outcome terms did not come back")
	}
	if back.Outcome.Verifier != "registrar1" || len(back.Outcome.Checks) != 3 {
		t.Fatalf("terms came back wrong: %+v", back.Outcome)
	}
	var passed int
	for _, c := range back.Outcome.Checks {
		if c.Status == CheckPassed {
			passed++
		}
	}
	if passed != 1 {
		t.Errorf("recorded results did not survive: %d passed", passed)
	}
}

func TestOutcomeSummaryIsHonest(t *testing.T) {
	d, _ := outcomeDesk(t)
	sum := d.OutcomeSummary()
	note, _ := sum["disclaimer"].(string)
	if !strings.Contains(strings.ToLower(note), "not an adjudicator") {
		t.Errorf("the summary overstates the verifier: %q", note)
	}
}
