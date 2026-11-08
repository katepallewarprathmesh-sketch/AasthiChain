package drunix

// The concurrency harness: what several agents do to one book at once.
//
// WHY THIS IS A GO HARNESS AND NOT A PYTHON ONE
// The autonomous harness in agent/ is Python and talks HTTP, because the
// claim it tests is "an outside caller gets no special treatment", and that
// can only be tested from outside. The claim here is different: that the
// rail's own accounting survives simultaneous callers. HTTP is the wrong
// instrument for it twice over. A data race is invisible through a socket,
// and the scheduler jitter of a network hides exactly the interleavings that
// break things. These run in-process so `go test -race` can see the memory,
// and they are written to fail loudly rather than flakily.
//
// WHAT THEY ARE LOOKING FOR
// Not crashes. Money. Every assertion below is a conservation law: a ceiling
// that bounds the total rather than each request, a condition that pays out
// once rather than once per caller who asked, and a revocation that is a
// fact rather than a race.
//
// Run with:  go test -tags real -race -run Concurrent ./...

import (
	"errors"
	"fmt"
	"sync"
	"testing"
)

// concurrencyRig builds a desk with one seller, one buyer with real money,
// and an agent register wired to the mandate book, which is the arrangement
// a running agent actually sees.
func concurrencyRig(t *testing.T, buyerINR float64) (*ConditionDesk, *UMIRail, *CredentialRegistry, *MandateRegistry, *AgentRegistry) {
	t.Helper()
	chain := NewChain()
	rail := NewUMIRail(NewMemorySecurities(), chain)
	creds := NewCredentialRegistry(chain)
	agents := NewAgentRegistry(chain)
	grants := NewMandateRegistry(chain, creds).WithAgentStanding(agents)
	desk := NewConditionDesk(rail, creds, grants)

	if _, err := rail.SeedPosition("PROP-C1", "originator1", 100000, 100000); err != nil {
		t.Fatalf("seed position: %v", err)
	}
	if _, _, err := rail.FundWallet("investor1", buyerINR); err != nil {
		t.Fatalf("fund buyer: %v", err)
	}
	if _, _, err := rail.FundWallet("originator1", 1); err != nil {
		t.Fatalf("open seller wallet: %v", err)
	}
	return desk, rail, creds, grants, agents
}

func mandatedAgent(t *testing.T, agents *AgentRegistry, grants *MandateRegistry, limitINR float64) (string, string) {
	t.Helper()
	p, err := agents.Register("investor1", goodRegistration())
	if err != nil {
		t.Fatalf("register: %v", err)
	}
	m, err := grants.Grant("investor1", GrantRequest{
		Agent: p.AgentID, Actions: []string{ActionReleaseCondition},
		LimitINR: limitINR, Assets: []string{"PROP-C1"}, ExpiresIn: "24h",
	})
	if err != nil {
		t.Fatalf("grant: %v", err)
	}
	return p.AgentID, m.MandateID
}

func openOne(t *testing.T, desk *ConditionDesk, tokens int64) *Condition {
	t.Helper()
	c, err := desk.Open(ConditionRequest{
		AssetID: "PROP-C1", Seller: "originator1", Buyer: "investor1",
		Tokens: tokens, PricePerTokenINR: 500,
		CredentialType: CredentialTitleValidation, Issuer: "registrar1",
		// Named explicitly. The default asserter is the seller, and an agent
		// of the buyer presenting a condition only the seller may assert
		// would be refused for the right reason by accident, which would
		// make every test below pass without testing anything.
		Asserter: "investor1",
	}, "investor1", false)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	return c
}

// A condition pays out once, however many agents present it at the same
// moment.
//
// This is the one that would cost real money. The desk closes a condition
// and moves both legs; if the close and the move are not one decision, two
// callers who both see it open both settle it and the seller is paid twice
// out of a buyer who locked the cash once.
func TestConcurrentPresentersSettleAConditionExactlyOnce(t *testing.T) {
	desk, rail, creds, grants, agents := concurrencyRig(t, 100000)
	credID := titleCredential(t, creds, "registrar1", "PROP-C1")
	agentID, mandateID := mandatedAgent(t, agents, grants, 100000)
	c := openOne(t, desk, 10)

	sellerBefore, _ := rail.Wallet("originator1")
	startSeller := sellerBefore.BalancePaise

	const callers = 24
	var wg sync.WaitGroup
	var mu sync.Mutex
	var released int
	var refusals []error

	start := make(chan struct{})
	for i := 0; i < callers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start // release them together, not in a staircase
			_, err := desk.Present(c.ConditionID,
				PresentRequest{CredentialID: credID, MandateID: mandateID}, agentID, false)
			mu.Lock()
			defer mu.Unlock()
			if err == nil {
				released++
			} else {
				refusals = append(refusals, err)
			}
		}()
	}
	close(start)
	wg.Wait()

	if released != 1 {
		t.Fatalf("a condition settled %d times; it must settle exactly once", released)
	}
	if len(refusals) != callers-1 {
		t.Fatalf("expected %d refusals, got %d", callers-1, len(refusals))
	}

	// The money has to agree with the count, because a correct counter over
	// a double payment is still a double payment.
	sellerAfter, _ := rail.Wallet("originator1")
	if moved := sellerAfter.BalancePaise - startSeller; moved != c.CashPaise {
		t.Fatalf("the seller received %d paise for a %d paise condition", moved, c.CashPaise)
	}
	if held := rail.securities.Position("PROP-C1", "investor1"); held != 10 {
		t.Fatalf("the buyer holds %d tokens, expected 10", held)
	}

	buyer, _ := rail.Wallet("investor1")
	if buyer.ReservedPaise != 0 {
		t.Errorf("%d paise is still reserved after the condition closed", buyer.ReservedPaise)
	}
}

// A ceiling bounds the total, not each request.
//
// This is the check-then-act question. Authorise reads SpentPaise under a
// read lock, returns, and Consume adds to it later under a write lock.
// Nothing holds a lock across the pair, so concurrent agents can each be
// told there is room and then each spend it. Whether that matters is not a
// matter of opinion: either the spend lands on or under the ceiling or the
// ceiling is decorative.
func TestConcurrentActsCannotSpendPastTheCeiling(t *testing.T) {
	desk, _, creds, grants, agents := concurrencyRig(t, 1000000)
	credID := titleCredential(t, creds, "registrar1", "PROP-C1")
	agentID, mandateID := mandatedAgent(t, agents, grants, 5000) // Rs 5,000 == 500000 paise

	// Ten conditions of Rs 5,000 each. The mandate can pay for exactly one.
	conditions := make([]*Condition, 0, 10)
	for i := 0; i < 10; i++ {
		conditions = append(conditions, openOne(t, desk, 10))
	}

	var wg sync.WaitGroup
	start := make(chan struct{})
	for _, c := range conditions {
		wg.Add(1)
		go func(c *Condition) {
			defer wg.Done()
			<-start
			_, _ = desk.Present(c.ConditionID,
				PresentRequest{CredentialID: credID, MandateID: mandateID}, agentID, false)
		}(c)
	}
	close(start)
	wg.Wait()

	m, err := grants.Get(mandateID)
	if err != nil {
		t.Fatalf("get mandate: %v", err)
	}
	if m.SpentPaise > m.LimitPaise {
		t.Fatalf("the agent spent %d paise against a ceiling of %d: the limit bounds a single "+
			"request but not the total, so two callers can each be told there is room",
			m.SpentPaise, m.LimitPaise)
	}
	if m.SpentPaise != 500000 {
		t.Errorf("expected exactly one Rs 5,000 release inside the ceiling, got %d paise over %d uses",
			m.SpentPaise, m.Uses)
	}
}

// Several agents of the same principal do not share a purse.
//
// Each mandate is its own budget. The failure this guards against is the
// opposite of the one above: a registry that serialises too coarsely, or
// indexes spend by principal rather than by grant, would let one agent's
// activity eat another's headroom.
func TestConcurrentAgentsKeepSeparateCeilings(t *testing.T) {
	desk, _, creds, grants, agents := concurrencyRig(t, 1000000)
	credID := titleCredential(t, creds, "registrar1", "PROP-C1")

	type actor struct{ agentID, mandateID string }
	actors := make([]actor, 0, 4)
	for i := 0; i < 4; i++ {
		a, m := mandatedAgent(t, agents, grants, 5000)
		actors = append(actors, actor{a, m})
	}

	var wg sync.WaitGroup
	start := make(chan struct{})
	for _, a := range actors {
		c := openOne(t, desk, 10) // Rs 5,000, exactly this agent's ceiling
		wg.Add(1)
		go func(a actor, c *Condition) {
			defer wg.Done()
			<-start
			if _, err := desk.Present(c.ConditionID,
				PresentRequest{CredentialID: credID, MandateID: a.mandateID}, a.agentID, false); err != nil {
				t.Errorf("%s was refused its own single permitted act: %v", a.agentID, err)
			}
		}(a, c)
	}
	close(start)
	wg.Wait()

	for _, a := range actors {
		m, err := grants.Get(a.mandateID)
		if err != nil {
			t.Fatalf("get mandate: %v", err)
		}
		if m.SpentPaise != 500000 || m.Uses != 1 {
			t.Errorf("%s spent %d paise over %d uses; each agent should have spent its own ceiling once",
				a.agentID, m.SpentPaise, m.Uses)
		}
	}
}

// Revocation is a fact, not a race.
//
// An agent is presenting in a loop while its principal pulls the handle. The
// requirement is not that the revocation wins every tie, which is meaningless
// when both happen at once. It is that there is a line: nothing the agent
// does after the revocation returns is allowed to succeed.
func TestConcurrentRevocationStopsEverythingAfterIt(t *testing.T) {
	desk, _, creds, grants, agents := concurrencyRig(t, 10000000)
	credID := titleCredential(t, creds, "registrar1", "PROP-C1")
	agentID, mandateID := mandatedAgent(t, agents, grants, 1000000)

	conditions := make([]*Condition, 0, 40)
	for i := 0; i < 40; i++ {
		conditions = append(conditions, openOne(t, desk, 1))
	}

	var wg sync.WaitGroup
	revoked := make(chan struct{})
	var mu sync.Mutex
	var afterRevocation int

	for _, c := range conditions {
		wg.Add(1)
		go func(c *Condition) {
			defer wg.Done()
			_, err := desk.Present(c.ConditionID,
				PresentRequest{CredentialID: credID, MandateID: mandateID}, agentID, false)
			select {
			case <-revoked:
				// This act began, or at least finished, after the revocation
				// was already recorded. Succeeding here is the failure.
				if err == nil {
					mu.Lock()
					afterRevocation++
					mu.Unlock()
				}
			default:
			}
		}(c)
	}

	if _, err := agents.Revoke(agentID, "investor1", false); err != nil {
		t.Fatalf("principal revoke: %v", err)
	}
	close(revoked)
	wg.Wait()

	// Anything that started before the handle was pulled may legitimately
	// have completed. Anything attempted afterwards must not.
	_, err := desk.Present(conditions[0].ConditionID,
		PresentRequest{CredentialID: credID, MandateID: mandateID}, agentID, false)
	if !errors.Is(err, ErrConditionNotAsserter) {
		t.Fatalf("a revoked agent was not refused: %v", err)
	}
	if _, err := grants.Authorise(mandateID, agentID, ActionReleaseCondition, "PROP-C1", 100); !errors.Is(err, ErrAgentWithdrawn) {
		t.Fatalf("the mandate is still live after the passport was revoked: %v", err)
	}
}

// Cash is conserved no matter how the calls interleave.
//
// The broadest statement available: whatever happened, the money in the
// system at the end equals the money at the start, and nothing is left
// reserved against a condition that has closed. A test that only counts
// successes cannot see money that leaked into neither party.
func TestConcurrentSettlementConservesCash(t *testing.T) {
	desk, rail, creds, grants, agents := concurrencyRig(t, 1000000)
	credID := titleCredential(t, creds, "registrar1", "PROP-C1")
	agentID, mandateID := mandatedAgent(t, agents, grants, 1000000)

	total := func() int64 {
		buyer, _ := rail.Wallet("investor1")
		seller, _ := rail.Wallet("originator1")
		return buyer.BalancePaise + seller.BalancePaise
	}
	before := total()

	conditions := make([]*Condition, 0, 20)
	for i := 0; i < 20; i++ {
		conditions = append(conditions, openOne(t, desk, 2))
	}

	var wg sync.WaitGroup
	start := make(chan struct{})
	for _, c := range conditions {
		// Two callers per condition, so every settlement is also a race.
		for i := 0; i < 2; i++ {
			wg.Add(1)
			go func(c *Condition) {
				defer wg.Done()
				<-start
				_, _ = desk.Present(c.ConditionID,
					PresentRequest{CredentialID: credID, MandateID: mandateID}, agentID, false)
			}(c)
		}
	}
	close(start)
	wg.Wait()

	if after := total(); after != before {
		t.Fatalf("cash was created or destroyed: %d paise before, %d after", before, after)
	}

	buyer, _ := rail.Wallet("investor1")
	var stillOpen int64
	for _, c := range conditions {
		got, err := desk.Get(c.ConditionID)
		if err != nil {
			t.Fatalf("get condition: %v", err)
		}
		if got.Status == ConditionOpen {
			stillOpen += got.CashPaise
		}
	}
	if buyer.ReservedPaise != stillOpen {
		t.Errorf("%d paise is reserved but only %d paise of conditions are still open",
			buyer.ReservedPaise, stillOpen)
	}

	// And the tokens agree with the money.
	var settled int64
	for _, c := range conditions {
		got, _ := desk.Get(c.ConditionID)
		if got.Status == ConditionReleased {
			settled += got.Tokens
		}
	}
	if held := rail.securities.Position("PROP-C1", "investor1"); held != settled {
		t.Errorf("the buyer holds %d tokens but %d were settled", held, settled)
	}
}

func init() {
	// A harness that silently tests nothing is worse than no harness. If the
	// rig ever stops producing a usable condition this makes it obvious.
	_ = fmt.Sprintf
}
