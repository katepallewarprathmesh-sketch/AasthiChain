package drunix

import (
	"errors"
	"testing"
)

// Withdrawing an agent's registration has to stop the agent. A principal who
// revokes a passport has said "this software no longer acts for me"; if the
// grants it already holds stay live, the revocation was theatre and the
// principal has to remember every mandate they ever signed.

// standingStub stands in for a register, so the mandate book can be tested
// against the interface it actually depends on.
type standingStub struct {
	registered bool
	withdrawn  bool
	by         string
}

func (s standingStub) Standing(string) (bool, bool, string) {
	return s.registered, s.withdrawn, s.by
}

func grantForTest(t *testing.T, r *MandateRegistry) *Mandate {
	t.Helper()
	m, err := r.Grant("investor1", GrantRequest{
		Agent:     "agent-ops",
		Actions:   []string{ActionSettleDvP},
		LimitINR:  100000,
		ExpiresIn: "24h",
		Purpose:   "settle instructions on my behalf",
	})
	if err != nil {
		t.Fatalf("grant: %v", err)
	}
	return m
}

func TestWithdrawnAgentCannotUseALiveMandate(t *testing.T) {
	book := NewMandateRegistry(NewChain(), nil)
	m := grantForTest(t, book)

	// The grant works while the agent is in good standing.
	if _, err := book.Authorise(m.MandateID, "agent-ops", ActionSettleDvP, "PROP-1", 5000); err != nil {
		t.Fatalf("a live mandate was refused: %v", err)
	}

	book.WithAgentStanding(standingStub{registered: true, withdrawn: true, by: "investor1"})
	_, err := book.Authorise(m.MandateID, "agent-ops", ActionSettleDvP, "PROP-1", 5000)
	if !errors.Is(err, ErrAgentWithdrawn) {
		t.Fatalf("a withdrawn agent was authorised: err=%v, want ErrAgentWithdrawn", err)
	}
}

// An agent nobody registered is not the register's business. Deployments that
// run mandates without passports must behave exactly as they did.
func TestUnregisteredAgentIsUnaffected(t *testing.T) {
	book := NewMandateRegistry(NewChain(), nil).
		WithAgentStanding(standingStub{registered: false})
	m := grantForTest(t, book)
	if _, err := book.Authorise(m.MandateID, "agent-ops", ActionSettleDvP, "PROP-1", 5000); err != nil {
		t.Fatalf("an unregistered agent was refused: %v", err)
	}
}

func TestNoRegisterMeansOldBehaviour(t *testing.T) {
	book := NewMandateRegistry(NewChain(), nil)
	m := grantForTest(t, book)
	if _, err := book.Authorise(m.MandateID, "agent-ops", ActionSettleDvP, "PROP-1", 5000); err != nil {
		t.Fatalf("mandate refused with no register attached: %v", err)
	}
}

// The real register, not a stub: revoking a passport must change the answer
// the mandate book gives.
func TestRealRegisterWithdrawalStopsTheAgent(t *testing.T) {
	chain := NewChain()
	agents := NewAgentRegistry(chain)
	passport, err := agents.Register("investor1", AgentRegistration{
		Purpose:    "settle instructions on my behalf",
		Custodians: []string{"registrar1", "regulator1"},
		Threshold:  2,
	})
	if err != nil {
		t.Fatalf("register: %v", err)
	}

	book := NewMandateRegistry(chain, nil).WithAgentStanding(agents)
	m, err := book.Grant("investor1", GrantRequest{
		Agent:     passport.AgentID,
		Actions:   []string{ActionSettleDvP},
		LimitINR:  100000,
		ExpiresIn: "24h",
		Purpose:   "settle instructions on my behalf",
	})
	if err != nil {
		t.Fatalf("grant: %v", err)
	}
	if _, err := book.Authorise(m.MandateID, passport.AgentID, ActionSettleDvP, "PROP-1", 5000); err != nil {
		t.Fatalf("live passport refused: %v", err)
	}

	// A supervisor withdraws it. The principal is sealed behind the custodian
	// threshold until a reveal completes, so the register cannot match the
	// caller against it; see the note in agentid.go on who may revoke.
	if _, err := agents.Revoke(passport.AgentID, "regulator1", true); err != nil {
		t.Fatalf("revoke: %v", err)
	}
	_, err = book.Authorise(m.MandateID, passport.AgentID, ActionSettleDvP, "PROP-1", 5000)
	if !errors.Is(err, ErrAgentWithdrawn) {
		t.Fatalf("revoking the passport did not stop the agent: err=%v", err)
	}

	// Standing itself reports the three states a counterparty needs.
	if reg, wd, by := agents.Standing(passport.AgentID); !reg || !wd || by != "regulator1" {
		t.Fatalf("Standing()=(%v,%v,%q), want (true,true,\"regulator1\")", reg, wd, by)
	}
	if reg, _, _ := agents.Standing("agent-nobody-registered"); reg {
		t.Fatal("an unknown agent was reported as registered")
	}
}
