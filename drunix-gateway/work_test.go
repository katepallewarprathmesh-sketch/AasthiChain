package drunix

import (
	"strings"
	"testing"
)

func newTestDesk(t *testing.T) (*WorkDesk, *UMIRail) {
	t.Helper()
	chain := NewChain()
	rail := NewUMIRail(NewMemorySecurities(), chain)
	if _, _, err := rail.FundWallet("originator1", 50000); err != nil {
		t.Fatalf("fund: %v", err)
	}
	return NewWorkDesk(rail, NewWorkProvider()), rail
}

func mustCreate(t *testing.T, d *WorkDesk, fee float64) *WorkOrder {
	t.Helper()
	o, err := d.Create(WorkRequest{
		AssetID:            "PROP-GREEN-VALLEY-PUNE-001",
		Title:              "Annual structural inspection",
		Spec:               "Walk the building, photograph every floor, report on damp.",
		Category:           "INSPECTION",
		Funder:             "originator1",
		FeeINR:             fee,
		AcceptanceCriteria: []string{"photographs of all four floors", "signed PDF report"},
	}, "originator1")
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	return o
}

const testHash = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"

// The happy path must do exactly two things to the money: reserve it, then
// move it. Nothing may be created along the way.
func TestWorkEscrowPaysOnAcceptance(t *testing.T) {
	d, rail := newTestDesk(t)
	o := mustCreate(t, d, 9000)

	if o.Status != WorkStatusCreated || o.Escrowed {
		t.Fatalf("a new order must hold no money, got %s escrowed=%v", o.Status, o.Escrowed)
	}

	if _, err := d.Fund(o.OrderID, "originator1"); err != nil {
		t.Fatalf("fund: %v", err)
	}
	w, _ := rail.Wallet("originator1")
	if w.ReservedPaise != 900000 {
		t.Fatalf("funding must reserve the fee, reserved=%d", w.ReservedPaise)
	}
	if w.BalancePaise != 5000000 {
		t.Fatalf("funding must not spend the balance, balance=%d", w.BalancePaise)
	}

	if _, err := d.Assign(o.OrderID, "wrk-anita-s", "WRK-1", "originator1"); err != nil {
		t.Fatalf("assign: %v", err)
	}
	if _, err := d.Submit(o.OrderID, testHash, "ipfs://report", "done", "wrk-anita-s"); err != nil {
		t.Fatalf("submit: %v", err)
	}
	done, err := d.Accept(o.OrderID, "looks right", "originator1")
	if err != nil {
		t.Fatalf("accept: %v", err)
	}
	if done.Status != WorkStatusAccepted || done.Escrowed || done.SettledAt == nil {
		t.Fatalf("accepted order looks wrong: %+v", done)
	}

	funder, _ := rail.Wallet("originator1")
	worker, _ := rail.Wallet("wrk-anita-s")
	if funder.BalancePaise != 4100000 || funder.ReservedPaise != 0 {
		t.Fatalf("funder should be down the fee with nothing reserved, got %d/%d", funder.BalancePaise, funder.ReservedPaise)
	}
	if worker.BalancePaise != 900000 {
		t.Fatalf("worker should hold the fee, got %d", worker.BalancePaise)
	}

	// The invariant the whole rail rests on.
	rec := rail.Reconcile()
	if !rec.Conserved {
		t.Fatalf("work escrow created or destroyed money: %s", rec.ConservationNote)
	}
}

// Escrowed money must be invisible to anything else that wants to spend it,
// otherwise the promise to the worker is worthless.
func TestEscrowRemovesSpendingPower(t *testing.T) {
	d, rail := newTestDesk(t)
	o := mustCreate(t, d, 40000)
	if _, err := d.Fund(o.OrderID, "originator1"); err != nil {
		t.Fatalf("fund: %v", err)
	}
	w, _ := rail.Wallet("originator1")
	if w.AvailableINR != 10000 {
		t.Fatalf("available should drop to the unreserved remainder, got %.2f", w.AvailableINR)
	}
	// A second order for more than what is left must be refused at funding.
	o2 := mustCreate(t, d, 20000)
	_, err := d.Fund(o2.OrderID, "originator1")
	if err == nil || !strings.Contains(err.Error(), "ERR_UMI_INSUFFICIENT_CBDC") {
		t.Fatalf("expected a short-escrow refusal, got %v", err)
	}
}

func TestRefundReturnsTheEscrow(t *testing.T) {
	d, rail := newTestDesk(t)
	o := mustCreate(t, d, 9000)
	if _, err := d.Fund(o.OrderID, "originator1"); err != nil {
		t.Fatalf("fund: %v", err)
	}
	back, err := d.Refund(o.OrderID, "owner postponed the survey", "originator1")
	if err != nil {
		t.Fatalf("refund: %v", err)
	}
	if back.Status != WorkStatusRefunded || back.Escrowed {
		t.Fatalf("refunded order still holds escrow: %+v", back)
	}
	w, _ := rail.Wallet("originator1")
	if w.ReservedPaise != 0 || w.BalancePaise != 5000000 {
		t.Fatalf("refund must restore full spending power, got %d/%d", w.BalancePaise, w.ReservedPaise)
	}
	if rec := rail.Reconcile(); !rec.Conserved {
		t.Fatalf("refund broke conservation")
	}
}

// Every illegal jump must be refused by name, not quietly applied.
func TestWorkStateMachineRefusesJumps(t *testing.T) {
	d, _ := newTestDesk(t)
	o := mustCreate(t, d, 9000)

	if _, err := d.Submit(o.OrderID, testHash, "", "", "someone"); err == nil {
		t.Fatal("a CREATED order must not accept a deliverable")
	}
	if _, err := d.Accept(o.OrderID, "", "originator1"); err == nil {
		t.Fatal("a CREATED order must not be acceptable")
	}
	if _, err := d.Assign(o.OrderID, "wrk-anita-s", "", "originator1"); err == nil {
		t.Fatal("an unfunded order must not be assignable")
	}
	if _, err := d.Fund(o.OrderID, "originator1"); err != nil {
		t.Fatalf("fund: %v", err)
	}
	if _, err := d.Fund(o.OrderID, "originator1"); err == nil {
		t.Fatal("funding twice would reserve the fee twice")
	}
	if _, err := d.Assign(o.OrderID, "originator1", "", "originator1"); err == nil {
		t.Fatal("the funder must not be able to assign the work to themselves")
	}
}

// Acceptance without evidence would make the hash decorative.
func TestAcceptNeedsADeliverable(t *testing.T) {
	d, _ := newTestDesk(t)
	o := mustCreate(t, d, 9000)
	_, _ = d.Fund(o.OrderID, "originator1")
	_, _ = d.Assign(o.OrderID, "wrk-anita-s", "", "originator1")
	if _, err := d.Submit(o.OrderID, "not-a-hash", "", "", "wrk-anita-s"); err == nil {
		t.Fatal("a malformed deliverable hash must be refused")
	}
	if _, err := d.Accept(o.OrderID, "", "originator1"); err == nil {
		t.Fatal("accepting an ASSIGNED order with no submission must fail")
	}
}

func TestDisputeFreezesThenResolves(t *testing.T) {
	d, rail := newTestDesk(t)
	o := mustCreate(t, d, 9000)
	_, _ = d.Fund(o.OrderID, "originator1")
	_, _ = d.Assign(o.OrderID, "wrk-anita-s", "", "originator1")
	_, _ = d.Submit(o.OrderID, testHash, "", "", "wrk-anita-s")
	if _, err := d.Dispute(o.OrderID, "two floors were not photographed", "originator1"); err != nil {
		t.Fatalf("dispute: %v", err)
	}
	w, _ := rail.Wallet("originator1")
	if w.ReservedPaise != 900000 {
		t.Fatalf("a dispute must keep the money frozen, reserved=%d", w.ReservedPaise)
	}
	// A dispute is not a verdict: both ways out stay open.
	if _, err := d.Accept(o.OrderID, "resolved after a second visit", "originator1"); err != nil {
		t.Fatalf("a dispute must still be resolvable in the worker's favour: %v", err)
	}
	if rec := rail.Reconcile(); !rec.Conserved {
		t.Fatalf("dispute path broke conservation")
	}
}

// The desk must come back from the ledger alone, escrow included.
func TestWorkRestoresFromChain(t *testing.T) {
	chain := NewChain()
	rail := NewUMIRail(NewMemorySecurities(), chain)
	_, _, _ = rail.FundWallet("originator1", 50000)
	d := NewWorkDesk(rail, NewWorkProvider())
	o := mustCreate(t, d, 9000)
	_, _ = d.Fund(o.OrderID, "originator1")
	_, _ = d.Assign(o.OrderID, "wrk-anita-s", "WRK-7", "originator1")

	// Restart: same chain, fresh rail and desk.
	rail2 := NewUMIRail(NewMemorySecurities(), chain)
	_, _, _ = rail2.FundWallet("originator1", 50000)
	d2 := NewWorkDesk(rail2, NewWorkProvider())
	if n := d2.RestoreWorkFromChain(); n != 1 {
		t.Fatalf("expected one restored order, got %d", n)
	}
	got, ok := d2.Order(o.OrderID)
	if !ok {
		t.Fatal("the order did not survive the restart")
	}
	if got.Status != WorkStatusAssigned || got.Worker != "wrk-anita-s" || got.FeeINR != 9000 {
		t.Fatalf("restored order lost detail: %+v", got)
	}
	w, _ := rail2.Wallet("originator1")
	if w.ReservedPaise != 900000 {
		t.Fatalf("restart must re-apply live escrow, reserved=%d", w.ReservedPaise)
	}
}

// The adapter must never imply a partnership that is not configured.
func TestProviderIsHonestAboutItsMode(t *testing.T) {
	t.Setenv("WORK_PROVIDER_URL", "")
	t.Setenv("WORK_PROVIDER_KEY", "")
	p := NewWorkProvider()
	if p.Mode() != "simulation" {
		t.Fatalf("unconfigured adapter must say simulation, said %s", p.Mode())
	}
	if len(p.Roster("TITLE_VERIFICATION")) == 0 {
		t.Fatal("the roster should still shortlist by category")
	}
	for _, c := range p.Roster("TITLE_VERIFICATION") {
		if c.Source != "simulation" {
			t.Fatalf("roster entries must carry the mode, got %q", c.Source)
		}
	}
	t.Setenv("WORK_PROVIDER_URL", "https://example.invalid/api")
	t.Setenv("WORK_PROVIDER_KEY", "k")
	if NewWorkProvider().Mode() != "live" {
		t.Fatal("both variables set should read as live")
	}
}
