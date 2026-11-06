package drunix

// The kill switch: can the person who created an agent stop it.
//
// This was a declared open gap, and it is the one gap that stops being
// theoretical the moment a real agent runs. Revocation required either a
// supervisor or a completed custodian ceremony, which meant the principal,
// the party with both the most exposure and the fastest reason to act,
// was the one party who could not pull the handle on their own agent.
//
// The register seals the principal, so it cannot recognise them by reading a
// name. It now recognises them by comparing a salted digest instead. These
// tests pin both halves of that: the principal can stop their agent, and the
// register still refuses to tell anyone who the principal is.

import (
	"bytes"
	"errors"
	"strings"
	"testing"
	"time"
)

func TestPrincipalCanStopTheirOwnAgentWithoutACeremony(t *testing.T) {
	reg := agentRig()
	p, err := reg.Register("investor1", goodRegistration())
	if err != nil {
		t.Fatalf("register: %v", err)
	}
	if p.Revealed {
		t.Fatal("the principal must still be sealed; this test is about revoking without opening it")
	}

	// The whole point: no supervisor, no custodian threshold, no reveal.
	stopped, err := reg.Revoke(p.AgentID, "investor1", false)
	if err != nil {
		t.Fatalf("the principal could not stop their own agent: %v", err)
	}
	if !stopped.Revoked {
		t.Fatal("revoke returned without revoking")
	}

	registered, withdrawn, by := reg.Standing(p.AgentID)
	if !registered || !withdrawn {
		t.Fatalf("standing should report a withdrawn registration, got registered=%v withdrawn=%v", registered, withdrawn)
	}
	if by != "investor1" {
		t.Errorf("the record should name who stopped it, got %q", by)
	}
}

func TestNobodyElseCanStopSomebodyElsesAgent(t *testing.T) {
	reg := agentRig()
	p, err := reg.Register("investor1", goodRegistration())
	if err != nil {
		t.Fatalf("register: %v", err)
	}

	// A different participant, and a custodian of this very passport. Holding
	// a share of somebody's identity does not make you their operator.
	for _, who := range []string{"investor2", "registrar1", "originator1"} {
		if _, err := reg.Revoke(p.AgentID, who, false); !errors.Is(err, ErrAgentNotPrincipal) {
			t.Errorf("%s should not be able to revoke this agent, got %v", who, err)
		}
	}

	if _, withdrawn, _ := reg.Standing(p.AgentID); withdrawn {
		t.Fatal("a refused revocation must not have revoked anything")
	}

	// A supervisor still can, which is the pre-existing escape hatch and has
	// not been removed.
	if _, err := reg.Revoke(p.AgentID, "regulator1", true); err != nil {
		t.Fatalf("a supervisor must still be able to stop an agent: %v", err)
	}
}

func TestRecognisingThePrincipalDoesNotDiscloseThem(t *testing.T) {
	reg := agentRig()
	p, err := reg.Register("investor1", goodRegistration())
	if err != nil {
		t.Fatalf("register: %v", err)
	}

	// The digest must not be the principal, nor a bare hash of it: salting
	// is what stops the same principal being recognisable across passports.
	if bytes.Contains(p.principalDigest, []byte("investor1")) {
		t.Fatal("the digest contains the principal in the clear")
	}
	if len(p.principalSalt) != 32 {
		t.Fatalf("expected a 32-byte salt, got %d", len(p.principalSalt))
	}

	other, err := reg.Register("investor1", goodRegistration())
	if err != nil {
		t.Fatalf("register second: %v", err)
	}
	if bytes.Equal(p.principalDigest, other.principalDigest) {
		t.Fatal("two agents of the same principal produce the same digest, so the register can cluster them by owner")
	}

	// And the public view still says nothing.
	view, err := reg.Get(p.AgentID, time.Now().UTC())
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if view.Principal != "" {
		t.Errorf("the view leaked the principal: %q", view.Principal)
	}
}

func TestTheDigestOnlyMatchesTheRightCaller(t *testing.T) {
	reg := agentRig()
	p, _ := reg.Register("investor1", goodRegistration())

	if !p.isPrincipal("investor1") {
		t.Error("the principal must be recognised")
	}
	if !p.isPrincipal("  INVESTOR1  ") {
		t.Error("recognition should survive case and surrounding space, as every other identity check here does")
	}
	for _, wrong := range []string{"investor2", "investor", "investor11", "", "   "} {
		if p.isPrincipal(wrong) {
			t.Errorf("%q must not be recognised as the principal", wrong)
		}
	}
}

func TestRevokingThePassportMakesEveryMandateInert(t *testing.T) {
	// The register and the mandate book are separate on purpose, so the one
	// thing that must be true between them is this: stopping the agent stops
	// everything it was ever granted, without the principal having to find
	// and revoke each grant.
	chain := NewChain()
	reg := NewAgentRegistry(chain)
	book := NewMandateRegistry(chain, nil).WithAgentStanding(reg)

	p, err := reg.Register("investor1", goodRegistration())
	if err != nil {
		t.Fatalf("register: %v", err)
	}
	m, err := book.Grant("investor1", GrantRequest{
		Agent: p.AgentID, Actions: []string{ActionReleaseCondition}, LimitINR: 5000, ExpiresIn: "24h",
	})
	if err != nil {
		t.Fatalf("grant: %v", err)
	}

	if _, err := book.Authorise(m.MandateID, p.AgentID, ActionReleaseCondition, "", 100_00); err != nil {
		t.Fatalf("the mandate should authorise before revocation: %v", err)
	}

	if _, err := reg.Revoke(p.AgentID, "investor1", false); err != nil {
		t.Fatalf("principal revoke: %v", err)
	}

	_, err = book.Authorise(m.MandateID, p.AgentID, ActionReleaseCondition, "", 100_00)
	if !errors.Is(err, ErrAgentWithdrawn) {
		t.Fatalf("a withdrawn passport must make the mandate inert, got %v", err)
	}
}

// A refusal has to say which refusal it was.
//
// Every way an agent can fail to present collapses into one sentinel,
// ERR_UMI_CONDITION_NOT_ASSERTER, because from the desk's point of view they
// are all "you may not assert this". That is fine as a code and useless as
// an answer: a withdrawn passport, a spent ceiling and a genuinely wrong
// agent are three different problems with three different fixes. The desk
// already composed the real reason and then dropped it on the way out,
// recording it only on the chain.
func TestARefusalCarriesTheReasonBackToTheCaller(t *testing.T) {
	desk, _, creds, grants := newConditionDesk(t)
	chain := NewChain()
	reg := NewAgentRegistry(chain)
	grants = grants.WithAgentStanding(reg)
	desk.grants = grants

	c := openCondition(t, desk)
	credID := titleCredential(t, creds, "registrar1", "PROP-C1")

	p, err := reg.Register("investor1", goodRegistration())
	if err != nil {
		t.Fatalf("register: %v", err)
	}
	m, err := grants.Grant("investor1", GrantRequest{
		Agent: p.AgentID, Actions: []string{ActionReleaseCondition},
		LimitINR: 100000, Assets: []string{"PROP-C1"}, ExpiresIn: "24h",
	})
	if err != nil {
		t.Fatalf("grant: %v", err)
	}

	if _, err := reg.Revoke(p.AgentID, "investor1", false); err != nil {
		t.Fatalf("principal revoke: %v", err)
	}

	_, err = desk.Present(c.ConditionID,
		PresentRequest{CredentialID: credID, MandateID: m.MandateID}, p.AgentID, false)
	if !errors.Is(err, ErrConditionNotAsserter) {
		t.Fatalf("expected a refusal, got %v", err)
	}
	// The code says "not the asserter". The agent is the asserter's agent,
	// so that sentence alone sends the operator to look at the wrong thing.
	if !strings.Contains(err.Error(), "withdrawn") {
		t.Errorf("the refusal must say the passport was withdrawn, got: %v", err)
	}
}
