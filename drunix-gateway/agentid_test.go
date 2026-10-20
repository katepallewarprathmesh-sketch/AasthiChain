package drunix

import (
	"bytes"
	"errors"
	"strings"
	"testing"
	"time"
)

func agentRig() *AgentRegistry {
	return NewAgentRegistry(NewChain())
}

func goodRegistration() AgentRegistration {
	return AgentRegistration{
		Purpose:    "schedules upkeep on two buildings and pays the invoices",
		Version:    "upkeep-3.1",
		Custodians: []string{"registrar1", "regulator1", "originator1"},
		Threshold:  2,
	}
}

func TestPassportHidesThePrincipalEverywhere(t *testing.T) {
	reg := agentRig()
	p, err := reg.Register("investor1", goodRegistration())
	if err != nil {
		t.Fatalf("register: %v", err)
	}
	if !strings.HasPrefix(p.AgentID, "agent:aasthi:") {
		t.Errorf("the pseudonym looks wrong: %q", p.AgentID)
	}
	if strings.Contains(p.AgentID, "investor1") {
		t.Error("the pseudonym contains the principal")
	}

	view, err := reg.Get(p.AgentID, time.Now().UTC())
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if view.Principal != "" || !view.Sponsored || view.Status != "ACTIVE" {
		t.Errorf("the public view leaks or misreports: %+v", view)
	}

	// The chain must not undo the sealing it exists to record.
	for _, blk := range reg.chain.Snapshot() {
		for _, txn := range blk.Txns {
			for k, v := range txn {
				if s, ok := v.(string); ok && strings.Contains(strings.ToLower(s), "investor1") {
					t.Fatalf("block %s field %s names the principal: %q", blk.Type, k, s)
				}
			}
		}
	}
}

func TestRegistrationRefusesAnUnsafeSplit(t *testing.T) {
	reg := agentRig()
	bad := []AgentRegistration{
		func() AgentRegistration { r := goodRegistration(); r.Purpose = ""; return r }(),
		func() AgentRegistration { r := goodRegistration(); r.Threshold = 1; return r }(),
		func() AgentRegistration { r := goodRegistration(); r.Threshold = 9; return r }(),
		func() AgentRegistration { r := goodRegistration(); r.Custodians = []string{"registrar1"}; return r }(),
		func() AgentRegistration {
			r := goodRegistration()
			r.Custodians = []string{"registrar1", "registrar1"}
			return r
		}(),
		func() AgentRegistration {
			r := goodRegistration()
			r.Custodians = []string{"investor1", "registrar1"}
			return r
		}(),
	}
	for i, req := range bad {
		if _, err := reg.Register("investor1", req); err == nil {
			t.Errorf("case %d: an unsafe split was accepted", i)
		}
	}
	if _, err := reg.Register("", goodRegistration()); err == nil {
		t.Error("an agent with no principal was registered")
	}
}

func TestIdentifyingSomebodyTakesTheThresholdAndIsRecorded(t *testing.T) {
	reg := agentRig()
	p, err := reg.Register("investor1", goodRegistration())
	if err != nil {
		t.Fatalf("register: %v", err)
	}

	// No request yet: a custodian cannot simply start handing over shares.
	if _, err := reg.ApproveReveal(p.AgentID, "registrar1"); !errors.Is(err, ErrAgentNoRequest) {
		t.Errorf("a share was accepted with no request open: %v", err)
	}

	// A request needs a stated trigger.
	if _, err := reg.RequestReveal(p.AgentID, "", "regulator1", true); err == nil {
		t.Error("a request with no stated trigger was opened")
	}
	// And a stranger cannot open one.
	if _, err := reg.RequestReveal(p.AgentID, "chargeback dispute 4412", "investor2", false); !errors.Is(err, ErrAgentNotCustodian) {
		t.Errorf("a stranger opened an identification request: %v", err)
	}
	if _, err := reg.RequestReveal(p.AgentID, "chargeback dispute 4412", "regulator1", true); err != nil {
		t.Fatalf("request: %v", err)
	}

	// One approval is not enough, and the view must not pretend otherwise.
	one, err := reg.ApproveReveal(p.AgentID, "registrar1")
	if err != nil {
		t.Fatalf("approve: %v", err)
	}
	if one.Revealed || one.Principal != "" {
		t.Fatal("one custodian identified the principal on their own")
	}
	view, _ := reg.Get(p.AgentID, time.Now().UTC())
	if view.Status != "REVEAL_PENDING" || view.Principal != "" || view.Approvals != 1 {
		t.Errorf("pending view is wrong: %+v", view)
	}

	// The same custodian cannot approve twice to reach the threshold alone.
	if _, err := reg.ApproveReveal(p.AgentID, "registrar1"); !errors.Is(err, ErrAgentDuplicate) {
		t.Errorf("a custodian approved twice: %v", err)
	}
	// Nor can somebody who holds no share.
	if _, err := reg.ApproveReveal(p.AgentID, "investor2"); !errors.Is(err, ErrAgentNotCustodian) {
		t.Errorf("a non-custodian contributed a share: %v", err)
	}

	two, err := reg.ApproveReveal(p.AgentID, "regulator1")
	if err != nil {
		t.Fatalf("second approval: %v", err)
	}
	if !two.Revealed || two.Principal != "investor1" {
		t.Fatalf("the threshold did not recover the principal: %+v", two)
	}

	// Every step is on the chain, including the result.
	types := map[string]int{}
	named := false
	for _, blk := range reg.chain.Snapshot() {
		types[blk.Type]++
		if blk.Type == BlockAgentRevealed {
			for _, txn := range blk.Txns {
				if txn["principal"] == "investor1" && txn["reason"] == "chargeback dispute 4412" {
					named = true
				}
			}
		}
	}
	if types[BlockAgentRevealRequested] != 1 || types[BlockAgentRevealApproved] != 2 || types[BlockAgentRevealed] != 1 {
		t.Errorf("the opening is not fully recorded: %v", types)
	}
	if !named {
		t.Error("the reveal block does not name the principal and the trigger")
	}
}

func TestAnUnfinishedRequestLapses(t *testing.T) {
	reg := agentRig()
	p, _ := reg.Register("investor1", goodRegistration())
	if _, err := reg.RequestReveal(p.AgentID, "fraud review 88", "regulator1", true); err != nil {
		t.Fatalf("request: %v", err)
	}
	if _, err := reg.ApproveReveal(p.AgentID, "registrar1"); err != nil {
		t.Fatalf("approve: %v", err)
	}

	// Walk the deadline into the past rather than sleeping for a fortnight.
	reg.mu.Lock()
	reg.book[p.AgentID].RequestDueAt = time.Now().UTC().Add(-time.Minute)
	reg.mu.Unlock()

	if _, err := reg.ApproveReveal(p.AgentID, "regulator1"); !errors.Is(err, ErrAgentNoRequest) {
		t.Errorf("a lapsed request still completed: %v", err)
	}
	view, _ := reg.Get(p.AgentID, time.Now().UTC())
	if view.Status != "ACTIVE" || view.Revealed || view.Approvals != 0 {
		t.Errorf("a lapsed request left state behind: %+v", view)
	}
	var expired bool
	for _, blk := range reg.chain.Snapshot() {
		if blk.Type == BlockAgentRevealExpired {
			expired = true
		}
	}
	if !expired {
		t.Error("the lapse was not recorded")
	}
}

func TestRevocationStopsTheAgentButNotTheAccounting(t *testing.T) {
	reg := agentRig()
	p, _ := reg.Register("investor1", goodRegistration())

	if _, err := reg.Revoke(p.AgentID, "investor2", false); !errors.Is(err, ErrAgentNotPrincipal) {
		t.Errorf("a stranger revoked somebody else's agent: %v", err)
	}
	if _, err := reg.Revoke(p.AgentID, "regulator1", true); err != nil {
		t.Fatalf("revoke: %v", err)
	}
	view, _ := reg.Get(p.AgentID, time.Now().UTC())
	if view.Status != "REVOKED" {
		t.Fatalf("status after revocation is %s", view.Status)
	}

	// Revocation must not become a way to bury who was responsible.
	if _, err := reg.RequestReveal(p.AgentID, "post mortem on order 12", "regulator1", true); err != nil {
		t.Fatalf("request after revocation: %v", err)
	}
	if _, err := reg.ApproveReveal(p.AgentID, "registrar1"); err != nil {
		t.Fatalf("approve: %v", err)
	}
	out, err := reg.ApproveReveal(p.AgentID, "originator1")
	if err != nil || out.Principal != "investor1" {
		t.Fatalf("a revoked agent's principal is no longer recoverable: %v %+v", err, out)
	}
}

func TestListPutsOpenRequestsFirst(t *testing.T) {
	reg := agentRig()
	quiet, _ := reg.Register("investor2", goodRegistration())
	loud, _ := reg.Register("investor1", goodRegistration())
	if _, err := reg.RequestReveal(loud.AgentID, "sanctions screening hit", "regulator1", true); err != nil {
		t.Fatalf("request: %v", err)
	}
	rows := reg.List(time.Now().UTC())
	if len(rows) != 2 {
		t.Fatalf("listed %d agents", len(rows))
	}
	if rows[0].AgentID != loud.AgentID || rows[1].AgentID != quiet.AgentID {
		t.Errorf("an open request is not surfaced first: %+v", rows)
	}
	if !strings.Contains(rows[1].Reading, "custodians") {
		t.Errorf("the plain reading is missing: %q", rows[1].Reading)
	}
}

// The arithmetic the whole design rests on. If k-1 shares recovered anything,
// the threshold would be decoration.
func TestSharesBelowTheThresholdRevealNothing(t *testing.T) {
	secret := []byte("investor1")
	shares, err := splitSecret(secret, 3, 5)
	if err != nil {
		t.Fatalf("split: %v", err)
	}
	for i, s := range shares {
		if bytes.Equal(s, secret) {
			t.Fatalf("share %d is the secret in the clear", i)
		}
	}

	// Two of three: wrong answer, and not the secret.
	short, err := combineSecret([]secretShare{{1, shares[0]}, {2, shares[1]}})
	if err != nil {
		t.Fatalf("combine: %v", err)
	}
	if bytes.Equal(short, secret) {
		t.Fatal("two shares of a three-of-five split recovered the secret")
	}

	// Any three, in any order, recover it exactly.
	got, err := combineSecret([]secretShare{{4, shares[3]}, {1, shares[0]}, {5, shares[4]}})
	if err != nil {
		t.Fatalf("combine: %v", err)
	}
	if !bytes.Equal(got, secret) {
		t.Fatalf("three shares recovered %q, want %q", got, secret)
	}
}
