package drunix

import (
	"strings"
	"testing"
	"time"
)

// A proposing agent is only worth having if the refusals hold: it must notice,
// draft, and then stop. These tests are mostly about the stopping.

func agentFixture(t *testing.T) (*AgentDesk, *CorridorDesk, *CBDCLedger, *AMLDesk) {
	t.Helper()
	chain := NewChain()
	rail := NewUMIRail(NewMemorySecurities(), chain)
	cbdc := NewCBDCLedger(rail, chain)
	corridors := NewCorridorDesk(rail, chain, cbdc)
	aml := NewAMLDesk(chain)
	corridors.AML = aml
	agent := NewAgentDesk(chain, corridors, cbdc, aml, nil)
	return agent, corridors, cbdc, aml
}

func TestAgentDraftsNothingFromQuietState(t *testing.T) {
	agent, _, _, _ := agentFixture(t)
	if drafted := agent.Scan(time.Now()); len(drafted) != 0 {
		t.Errorf("a quiet rail should produce no proposals, got %d", len(drafted))
	}
}

func TestAgentNoticesAnUnworkedCaseAndStopsThere(t *testing.T) {
	agent, _, _, aml := agentFixture(t)
	c := aml.OpenCase(aml.Screen("Dmitri Volkanov"), "regulator1", "CBX-1", "investor1", 100000)

	// Fresh case: nothing to say yet.
	if drafted := agent.Scan(time.Now()); len(drafted) != 0 {
		t.Errorf("a case opened moments ago is not yet neglected, got %d proposals", len(drafted))
	}

	later := time.Now().Add(30 * time.Hour)
	drafted := agent.Scan(later)
	if len(drafted) != 1 {
		t.Fatalf("an unworked case should be noticed once, got %d", len(drafted))
	}
	p := drafted[0]
	if p.Status != ProposalDraft {
		t.Errorf("a proposal starts as a draft, got %s", p.Status)
	}
	if p.Subject != c.CaseID {
		t.Errorf("the proposal must name what it is about, got %q", p.Subject)
	}
	if len(p.Why) == 0 || p.WhatWillHappen == "" || p.IfIgnored == "" {
		t.Error("a proposal nobody can read is a proposal nobody should approve")
	}
	if !strings.Contains(p.WhatWillHappen, "does not clear") {
		t.Errorf("flagging must say what it does not do, got %q", p.WhatWillHappen)
	}

	// Scanning again must not pile up duplicates of the same situation.
	if again := agent.Scan(later.Add(time.Hour)); len(again) != 0 {
		t.Errorf("the same situation must not be drafted twice, got %d", len(again))
	}
}

func TestAgentCannotApproveItsOwnWork(t *testing.T) {
	agent, _, _, aml := agentFixture(t)
	aml.OpenCase(aml.Screen("Dmitri Volkanov"), "regulator1", "CBX-2", "investor1", 100000)
	drafted := agent.Scan(time.Now().Add(30 * time.Hour))
	if len(drafted) == 0 {
		t.Fatal("expected a proposal")
	}
	if _, err := agent.Approve(drafted[0].ProposalID, "", "no name"); err == nil {
		t.Error("an approval with nobody's name on it must be refused")
	}
	if _, err := agent.Reject(drafted[0].ProposalID, "regulator1", ""); err == nil {
		t.Error("a rejection with no reason must be refused")
	}
}

func TestAgentRefusesWhenTheWorldHasMoved(t *testing.T) {
	agent, _, _, aml := agentFixture(t)
	c := aml.OpenCase(aml.Screen("Dmitri Volkanov"), "regulator1", "CBX-3", "investor1", 100000)
	drafted := agent.Scan(time.Now().Add(30 * time.Hour))
	if len(drafted) == 0 {
		t.Fatal("expected a proposal")
	}

	// Somebody works the case before the proposal is approved.
	if _, err := aml.Review(c.CaseID, "regulator1", "picked up"); err != nil {
		t.Fatalf("review: %v", err)
	}

	p, err := agent.Approve(drafted[0].ProposalID, "regulator1", "approving late")
	if err == nil {
		t.Fatal("approving a proposal whose evidence has changed must fail")
	}
	if p == nil || p.Status != ProposalStale {
		t.Fatalf("the proposal should be marked stale, got %+v", p)
	}
	if !strings.Contains(p.Reason, "already worked") {
		t.Errorf("the staleness must say what changed, got %q", p.Reason)
	}
}

func TestAgentApprovalIsRecordedAsThePersonsAct(t *testing.T) {
	chain := NewChain()
	rail := NewUMIRail(NewMemorySecurities(), chain)
	cbdc := NewCBDCLedger(rail, chain)
	corridors := NewCorridorDesk(rail, chain, cbdc)
	aml := NewAMLDesk(chain)
	agent := NewAgentDesk(chain, corridors, cbdc, aml, nil)

	aml.OpenCase(aml.Screen("Miriam Oyelaran"), "regulator1", "CBX-4", "investor1", 100000)
	drafted := agent.Scan(time.Now().Add(30 * time.Hour))
	if len(drafted) == 0 {
		t.Fatal("expected a proposal")
	}
	out, err := agent.Approve(drafted[0].ProposalID, "regulator1", "worth a look")
	if err != nil {
		t.Fatalf("approve: %v", err)
	}
	if out.Status != ProposalApproved || out.DecidedBy != "regulator1" {
		t.Errorf("the approver must be recorded: %+v", out)
	}
	if !strings.Contains(out.Result, "regulator1") {
		t.Errorf("the result must name the person, got %q", out.Result)
	}
	if out.BlockHeight == 0 {
		t.Error("an approval must be on the chain")
	}

	var approvalBlock *DrunixBlock
	for _, b := range chain.Snapshot() {
		if b.Type == BlockAgentApproved {
			approvalBlock = b
		}
	}
	if approvalBlock == nil {
		t.Fatal("no approval block written")
	}
	txn := approvalBlock.Txns[0]
	if txn["approvedBy"] != "regulator1" {
		t.Errorf("the block must name the approver, got %v", txn["approvedBy"])
	}
	if !strings.Contains(strings.ToLower(takeString(txn["recordedAs"])), "act by regulator1") {
		t.Errorf("the block must record this as the person's act, got %v", txn["recordedAs"])
	}

	// And it cannot be decided twice.
	if _, err := agent.Approve(drafted[0].ProposalID, "regulator1", "again"); err == nil {
		t.Error("a decided proposal cannot be approved again")
	}
}

func takeString(v interface{}) string {
	s, _ := v.(string)
	return s
}

func TestAgentStatusDeclaresItsLimits(t *testing.T) {
	agent, _, _, _ := agentFixture(t)
	st := agent.Status()
	cannot, ok := st["itCannot"].([]string)
	if !ok || len(cannot) < 5 {
		t.Fatalf("the agent must publish what it cannot do, got %v", st["itCannot"])
	}
	joined := strings.ToLower(strings.Join(cannot, " | "))
	for _, must := range []string{"issue, redeem or move money", "approve its own proposal", "timer"} {
		if !strings.Contains(joined, must) {
			t.Errorf("the limits must mention %q, got %q", must, joined)
		}
	}
	if !strings.Contains(strings.ToLower(takeString(st["disclaimer"])), "does not execute anything on") {
		t.Errorf("the disclaimer must say it executes nothing on its own, got %v", st["disclaimer"])
	}
}
