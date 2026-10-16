package drunix

import (
	"errors"
	"strings"
	"testing"
	"time"
)

func newMandates(t *testing.T) *MandateRegistry {
	t.Helper()
	chain := NewChain()
	return NewMandateRegistry(chain, NewCredentialRegistry(chain))
}

func grant(t *testing.T, reg *MandateRegistry, req GrantRequest) *Mandate {
	t.Helper()
	m, err := reg.Grant("originator1", req)
	if err != nil {
		t.Fatalf("grant: %v", err)
	}
	return m
}

func TestMandateGrantAndAuthorise(t *testing.T) {
	reg := newMandates(t)
	m := grant(t, reg, GrantRequest{
		Agent:    "agent:rebalancer",
		Actions:  []string{ActionSettleDvP},
		LimitINR: 50000,
		Assets:   []string{"PROP-7"},
	})

	if m.MandateID == "" || m.GrantedBlock == 0 {
		t.Fatalf("mandate was not anchored: %+v", m)
	}
	if m.CredentialID == "" {
		t.Error("the grant was not also issued as a credential")
	}
	if m.ExpiresAt == "" {
		t.Error("a mandate was granted with no expiry")
	}

	if _, err := reg.Authorise(m.MandateID, "agent:rebalancer", ActionSettleDvP, "PROP-7", INRToPaise(10000)); err != nil {
		t.Errorf("an in-bounds action was refused: %v", err)
	}
}

// Every bound has to be enforced, and the refusal has to say which one.
func TestMandateBoundsAreEnforced(t *testing.T) {
	reg := newMandates(t)
	m := grant(t, reg, GrantRequest{
		Agent:    "agent:rebalancer",
		Actions:  []string{ActionSettleDvP},
		LimitINR: 50000,
		Assets:   []string{"PROP-7"},
	})

	cases := []struct {
		name    string
		agent   string
		action  string
		asset   string
		amount  int64
		wantErr error
	}{
		{"wrong agent", "agent:someone-else", ActionSettleDvP, "PROP-7", INRToPaise(100), ErrMandateNotFound},
		{"action not granted", "agent:rebalancer", ActionAnchorDoc, "PROP-7", 0, ErrMandateAction},
		{"asset not covered", "agent:rebalancer", ActionSettleDvP, "PROP-9", INRToPaise(100), ErrMandateAssetward},
		{"over the limit", "agent:rebalancer", ActionSettleDvP, "PROP-7", INRToPaise(50001), ErrMandateExceeded},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, err := reg.Authorise(m.MandateID, c.agent, c.action, c.asset, c.amount)
			if !errors.Is(err, c.wantErr) {
				t.Errorf("got %v, want %v", err, c.wantErr)
			}
		})
	}
}

// Spend must accumulate, so a budget cannot be spent twice by asking twice.
func TestMandateSpendAccumulates(t *testing.T) {
	reg := newMandates(t)
	m := grant(t, reg, GrantRequest{
		Agent: "agent:rebalancer", Actions: []string{ActionSettleDvP}, LimitINR: 1000,
	})

	if err := reg.Consume(m.MandateID, ActionSettleDvP, "PROP-7", "UMI-1", INRToPaise(600)); err != nil {
		t.Fatalf("consume: %v", err)
	}
	after, _ := reg.Get(m.MandateID)
	if after.SpentPaise != INRToPaise(600) || after.Uses != 1 {
		t.Fatalf("spend not recorded: %+v", after)
	}
	if _, err := reg.Authorise(m.MandateID, "agent:rebalancer", ActionSettleDvP, "", INRToPaise(500)); !errors.Is(err, ErrMandateExceeded) {
		t.Errorf("a second spend that breaches the budget was allowed: %v", err)
	}
	if _, err := reg.Authorise(m.MandateID, "agent:rebalancer", ActionSettleDvP, "", INRToPaise(400)); err != nil {
		t.Errorf("a spend inside the remaining budget was refused: %v", err)
	}
}

func TestMandateRevocationIsImmediate(t *testing.T) {
	reg := newMandates(t)
	m := grant(t, reg, GrantRequest{
		Agent: "agent:rebalancer", Actions: []string{ActionSettleDvP}, LimitINR: 1000,
	})
	if _, err := reg.Revoke(m.MandateID, "originator1"); err != nil {
		t.Fatalf("revoke: %v", err)
	}
	if _, err := reg.Authorise(m.MandateID, "agent:rebalancer", ActionSettleDvP, "", 1); !errors.Is(err, ErrMandateRevoked) {
		t.Errorf("a revoked mandate still authorised: %v", err)
	}
	if _, err := reg.Revoke(m.MandateID, "originator1"); err == nil {
		t.Error("revoking twice was allowed")
	}
}

func TestMandateExpiryIsEnforcedAndMandatory(t *testing.T) {
	reg := newMandates(t)
	m := grant(t, reg, GrantRequest{
		Agent: "agent:rebalancer", Actions: []string{ActionSettleDvP}, LimitINR: 1000, ExpiresIn: "1h",
	})

	// Move the clock past the expiry rather than sleeping.
	reg.nowFunc = func() time.Time { return time.Now().UTC().Add(2 * time.Hour) }
	if _, err := reg.Authorise(m.MandateID, "agent:rebalancer", ActionSettleDvP, "", 1); !errors.Is(err, ErrMandateExpired) {
		t.Errorf("an expired mandate still authorised: %v", err)
	}

	// An open-ended grant must not be possible: the default is short.
	reg.nowFunc = func() time.Time { return time.Now().UTC() }
	plain := grant(t, reg, GrantRequest{Agent: "agent:x", Actions: []string{ActionSettleDvP}, LimitINR: 1})
	exp, err := time.Parse(time.RFC3339, plain.ExpiresAt)
	if err != nil {
		t.Fatalf("expiry is not RFC3339: %q", plain.ExpiresAt)
	}
	if exp.After(time.Now().UTC().Add(mandateMaxLifetime)) {
		t.Errorf("default expiry exceeds the ceiling: %s", plain.ExpiresAt)
	}
}

func TestMandateRejectsNonsense(t *testing.T) {
	reg := newMandates(t)
	bad := []GrantRequest{
		{Agent: "", Actions: []string{ActionSettleDvP}, LimitINR: 10},
		{Agent: "agent:x", Actions: nil, LimitINR: 10},
		{Agent: "agent:x", Actions: []string{ActionSettleDvP}, LimitINR: 0},
		{Agent: "agent:x", Actions: []string{"DRAIN_EVERYTHING"}, LimitINR: 10},
		{Agent: "originator1", Actions: []string{ActionSettleDvP}, LimitINR: 10},
		{Agent: "agent:x", Actions: []string{ActionSettleDvP}, LimitINR: 10, ExpiresAt: "2001-01-01T00:00:00Z"},
	}
	for i, req := range bad {
		if _, err := reg.Grant("originator1", req); err == nil {
			t.Errorf("case %d: a nonsense grant was accepted: %+v", i, req)
		}
	}
}

// A budget that resets when the process restarts is not a budget.
func TestMandateSpendSurvivesRestart(t *testing.T) {
	chain := NewChain()
	reg := NewMandateRegistry(chain, NewCredentialRegistry(chain))
	m, err := reg.Grant("originator1", GrantRequest{
		Agent: "agent:rebalancer", Actions: []string{ActionSettleDvP}, LimitINR: 1000,
	})
	if err != nil {
		t.Fatalf("grant: %v", err)
	}
	if err := reg.Consume(m.MandateID, ActionSettleDvP, "PROP-7", "UMI-1", INRToPaise(900)); err != nil {
		t.Fatalf("consume: %v", err)
	}

	restarted := NewMandateRegistry(chain, nil)
	if n := restarted.RestoreFromChain(); n != 1 {
		t.Fatalf("restored %d mandates, want 1", n)
	}
	back, err := restarted.Get(m.MandateID)
	if err != nil {
		t.Fatalf("mandate did not come back: %v", err)
	}
	if back.SpentPaise != INRToPaise(900) {
		t.Errorf("spend reset across a restart: %d paise", back.SpentPaise)
	}
	if _, err := restarted.Authorise(m.MandateID, "agent:rebalancer", ActionSettleDvP, "", INRToPaise(200)); !errors.Is(err, ErrMandateExceeded) {
		t.Errorf("the restored budget did not bind: %v", err)
	}
}

// Every use has to be attributable: agent, principal and mandate on the chain.
func TestMandateUseIsAttributedOnTheChain(t *testing.T) {
	chain := NewChain()
	reg := NewMandateRegistry(chain, nil)
	m, err := reg.Grant("originator1", GrantRequest{
		Agent: "agent:rebalancer", Actions: []string{ActionSettleDvP}, LimitINR: 1000,
	})
	if err != nil {
		t.Fatalf("grant: %v", err)
	}
	_ = reg.Consume(m.MandateID, ActionSettleDvP, "PROP-7", "UMI-9", INRToPaise(10))

	found := false
	for _, b := range chain.Snapshot() {
		if b.Type != BlockMandateUsed {
			continue
		}
		for _, txn := range b.Txns {
			agent, _ := txn["agent"].(string)
			principal, _ := txn["principal"].(string)
			ref, _ := txn["reference"].(string)
			if agent == "agent:rebalancer" && principal == "originator1" && ref == "UMI-9" {
				found = true
			}
		}
	}
	if !found {
		t.Error("an agent action was not attributed on the chain")
	}
}

func TestMandateSummaryDisclosesThatNoAgentRuns(t *testing.T) {
	reg := newMandates(t)
	sum := reg.Summary()
	note, _ := sum["disclaimer"].(string)
	if !strings.Contains(strings.ToLower(note), "no autonomous agent") {
		t.Errorf("the summary does not disclose that nothing autonomous runs: %q", note)
	}
}
