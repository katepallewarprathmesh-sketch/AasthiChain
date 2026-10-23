package drunix

import (
	"errors"
	"testing"
	"time"
)

// Conditional settlement, tested the way it will be attacked: can money get
// stuck, can it be released by the wrong person, can it be released on the
// wrong evidence, and does the total ever change.

func newConditionDesk(t *testing.T) (*ConditionDesk, *UMIRail, *CredentialRegistry, *MandateRegistry) {
	t.Helper()
	chain := NewChain()
	rail := NewUMIRail(NewMemorySecurities(), chain)
	creds := NewCredentialRegistry(chain)
	grants := NewMandateRegistry(chain, creds)
	desk := NewConditionDesk(rail, creds, grants)

	if _, err := rail.SeedPosition("PROP-C1", "originator1", 1000, 1000); err != nil {
		t.Fatalf("seed position: %v", err)
	}
	if _, _, err := rail.FundWallet("investor1", 100000); err != nil {
		t.Fatalf("fund buyer: %v", err)
	}
	if _, _, err := rail.FundWallet("originator1", 1000); err != nil {
		t.Fatalf("open seller wallet: %v", err)
	}
	return desk, rail, creds, grants
}

func openCondition(t *testing.T, desk *ConditionDesk) *Condition {
	t.Helper()
	c, err := desk.Open(ConditionRequest{
		AssetID: "PROP-C1", Seller: "originator1", Buyer: "investor1",
		Tokens: 10, PricePerTokenINR: 500,
		CredentialType: CredentialTitleValidation, Issuer: "registrar1",
	}, "investor1", false)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	return c
}

func titleCredential(t *testing.T, creds *CredentialRegistry, issuer, assetID string) string {
	t.Helper()
	rec, err := creds.IssueTitleCredential(issuer, "originator1", assetID, map[string]interface{}{
		"assetId": assetID, "finding": "clear title",
	})
	if err != nil {
		t.Fatalf("issue credential: %v", err)
	}
	return rec.Credential.ID
}

// Opening locks the cash and moves nothing else. This is the state the rail
// did not have before.
func TestOpeningLocksCashWithoutSettlingAnything(t *testing.T) {
	desk, rail, _, _ := newConditionDesk(t)
	c := openCondition(t, desk)

	if c.Status != ConditionOpen || c.CashINR != 5000 {
		t.Fatalf("unexpected condition: %+v", c)
	}
	w, _ := rail.Wallet("investor1")
	if w.ReservedPaise != 500000 {
		t.Fatalf("expected ₹5,000 reserved, got %d paise", w.ReservedPaise)
	}
	// Reserved, not spent: the balance is untouched and the money is still
	// the buyer's.
	if w.BalancePaise != 10000000 {
		t.Fatalf("the balance should not have moved, got %d", w.BalancePaise)
	}
	if w.available() != 10000000-500000 {
		t.Fatalf("the reservation should reduce what is spendable, got %d", w.available())
	}
	if rail.securities.Position("PROP-C1", "investor1") != 0 {
		t.Fatal("no tokens should have moved at open")
	}
	if c.DeadlineAt == "" {
		t.Fatal("a lock with no deadline is a way to lose somebody's money")
	}
}

// The happy path, and the thing that makes it a settlement rather than a
// transfer: both legs in one step.
func TestPresentingTheCredentialReleasesBothLegs(t *testing.T) {
	desk, rail, creds, _ := newConditionDesk(t)
	c := openCondition(t, desk)
	credID := titleCredential(t, creds, "registrar1", "PROP-C1")

	out, err := desk.Present(c.ConditionID, PresentRequest{CredentialID: credID}, "originator1", false)
	if err != nil {
		t.Fatalf("present: %v", err)
	}
	if out.Status != ConditionReleased || out.CredentialID != credID {
		t.Fatalf("unexpected result: %+v", out)
	}

	buyer, _ := rail.Wallet("investor1")
	seller, _ := rail.Wallet("originator1")
	if buyer.ReservedPaise != 0 {
		t.Fatalf("the reservation was left behind: %d", buyer.ReservedPaise)
	}
	if buyer.BalancePaise != 10000000-500000 {
		t.Fatalf("buyer balance wrong: %d", buyer.BalancePaise)
	}
	if seller.BalancePaise != 100000+500000 {
		t.Fatalf("seller balance wrong: %d", seller.BalancePaise)
	}
	if rail.securities.Position("PROP-C1", "investor1") != 10 {
		t.Fatal("the securities leg did not move")
	}
	if rail.securities.Position("PROP-C1", "originator1") != 990 {
		t.Fatal("the seller's position is wrong")
	}
}

// Every way the evidence can be wrong. Each one must refuse, leave the
// condition open, and leave the money exactly where it was.
func TestEveryBadPresentationIsRefusedAndNothingMoves(t *testing.T) {
	desk, rail, creds, _ := newConditionDesk(t)
	c := openCondition(t, desk)

	wrongAsset := titleCredential(t, creds, "registrar1", "PROP-OTHER")
	wrongIssuer := titleCredential(t, creds, "originator1", "PROP-C1")
	revoked := titleCredential(t, creds, "registrar1", "PROP-C1")
	if _, err := creds.Revoke(revoked, "registrar1", "superseded"); err != nil {
		t.Fatalf("revoke: %v", err)
	}
	kyc, err := creds.Issue("registrar1", CredentialKYCStatus, map[string]interface{}{
		"assetId": "PROP-C1", "identityId": "originator1", "tier": "FULL_KYC",
	})
	if err != nil {
		t.Fatalf("issue kyc credential: %v", err)
	}

	cases := []struct {
		name      string
		cred      string
		presenter string
		want      error
	}{
		{"a credential that does not exist", "CRED-nope", "originator1", ErrConditionCredential},
		{"a credential about another asset", wrongAsset, "originator1", ErrConditionCredential},
		{"a credential from the wrong issuer", wrongIssuer, "originator1", ErrConditionCredential},
		{"a revoked credential", revoked, "originator1", ErrConditionCredential},
		{"the right issuer, the wrong type", kyc.Credential.ID, "originator1", ErrConditionCredential},
		{"a stranger presenting a good one", titleCredential(t, creds, "registrar1", "PROP-C1"), "investor2", ErrConditionNotAsserter},
	}

	for _, tc := range cases {
		_, err := desk.Present(c.ConditionID, PresentRequest{CredentialID: tc.cred}, tc.presenter, false)
		if err == nil {
			t.Fatalf("%s: expected a refusal", tc.name)
		}
		if !errors.Is(err, tc.want) {
			t.Fatalf("%s: expected %v, got %v", tc.name, tc.want, err)
		}
	}

	after, err := desk.Get(c.ConditionID)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if after.Status != ConditionOpen {
		t.Fatalf("a failed attempt must not close the agreement, status is %s", after.Status)
	}
	if after.RefusalCount != len(cases) {
		t.Fatalf("expected %d refusals recorded, got %d", len(cases), after.RefusalCount)
	}
	w, _ := rail.Wallet("investor1")
	if w.ReservedPaise != 500000 || w.BalancePaise != 10000000 {
		t.Fatalf("money moved on a refusal: reserved %d balance %d", w.ReservedPaise, w.BalancePaise)
	}
	if rail.securities.Position("PROP-C1", "investor1") != 0 {
		t.Fatal("tokens moved on a refusal")
	}
}

// An agent may present, but only inside a mandate from the asserter that
// covers this action, this asset and this amount.
func TestAnAgentCanOnlyPresentInsideItsMandate(t *testing.T) {
	desk, rail, creds, grants := newConditionDesk(t)
	c := openCondition(t, desk)
	credID := titleCredential(t, creds, "registrar1", "PROP-C1")

	// Wrong action.
	wrongAction, err := grants.Grant("originator1", GrantRequest{
		Agent: "agent:filer", Actions: []string{ActionAnchorDoc}, LimitINR: 100000, Assets: []string{"PROP-C1"},
	})
	if err != nil {
		t.Fatalf("grant: %v", err)
	}
	if _, err := desk.Present(c.ConditionID, PresentRequest{CredentialID: credID, MandateID: wrongAction.MandateID},
		"agent:filer", false); !errors.Is(err, ErrConditionNotAsserter) {
		t.Fatalf("a mandate for another action must not release money, got %v", err)
	}

	// Right action, too small a limit.
	tooSmall, err := grants.Grant("originator1", GrantRequest{
		Agent: "agent:small", Actions: []string{ActionReleaseCondition}, LimitINR: 100, Assets: []string{"PROP-C1"},
	})
	if err != nil {
		t.Fatalf("grant: %v", err)
	}
	if _, err := desk.Present(c.ConditionID, PresentRequest{CredentialID: credID, MandateID: tooSmall.MandateID},
		"agent:small", false); !errors.Is(err, ErrConditionNotAsserter) {
		t.Fatalf("a ₹100 mandate must not release ₹5,000, got %v", err)
	}

	// Granted by the wrong principal: an agent of the buyer cannot assert
	// the seller's condition.
	wrongPrincipal, err := grants.Grant("investor1", GrantRequest{
		Agent: "agent:buyers", Actions: []string{ActionReleaseCondition}, LimitINR: 100000, Assets: []string{"PROP-C1"},
	})
	if err != nil {
		t.Fatalf("grant: %v", err)
	}
	if _, err := desk.Present(c.ConditionID, PresentRequest{CredentialID: credID, MandateID: wrongPrincipal.MandateID},
		"agent:buyers", false); !errors.Is(err, ErrConditionNotAsserter) {
		t.Fatalf("a mandate from the buyer must not assert the seller's condition, got %v", err)
	}

	// The real one.
	good, err := grants.Grant("originator1", GrantRequest{
		Agent: "agent:closer", Actions: []string{ActionReleaseCondition}, LimitINR: 100000, Assets: []string{"PROP-C1"},
	})
	if err != nil {
		t.Fatalf("grant: %v", err)
	}
	out, err := desk.Present(c.ConditionID, PresentRequest{CredentialID: credID, MandateID: good.MandateID},
		"agent:closer", false)
	if err != nil {
		t.Fatalf("present under mandate: %v", err)
	}
	if out.ReleasedUnder != good.MandateID || out.ReleasedBy != "agent:closer" {
		t.Fatalf("the record must say who acted and under what: %+v", out)
	}
	// The spend is counted against the mandate, by the rail, not by the agent.
	spent, err := grants.Get(good.MandateID)
	if err != nil {
		t.Fatalf("get mandate: %v", err)
	}
	if spent.SpentPaise != 500000 {
		t.Fatalf("the settlement should be charged to the mandate, spent %d", spent.SpentPaise)
	}
	if rail.securities.Position("PROP-C1", "investor1") != 10 {
		t.Fatal("the agent's release did not actually settle")
	}
}

// Money cannot be stranded. The deadline runs whether or not anyone asks.
func TestADeadlineRefundsWithoutAnybodyAsking(t *testing.T) {
	desk, rail, _, _ := newConditionDesk(t)
	c, err := desk.Open(ConditionRequest{
		AssetID: "PROP-C1", Seller: "originator1", Buyer: "investor1",
		Tokens: 10, PricePerTokenINR: 500,
		CredentialType: CredentialTitleValidation, Window: "1h",
	}, "investor1", false)
	if err != nil {
		t.Fatalf("open: %v", err)
	}

	// Nothing is due yet.
	if closed := desk.Tick(time.Now().UTC()); len(closed) != 0 {
		t.Fatalf("nothing should have expired yet, got %v", closed)
	}

	closed := desk.Tick(time.Now().UTC().Add(2 * time.Hour))
	if len(closed) != 1 || closed[0] != c.ConditionID {
		t.Fatalf("the expired condition was not swept: %v", closed)
	}
	after, _ := desk.Get(c.ConditionID)
	if after.Status != ConditionExpired {
		t.Fatalf("expected EXPIRED, got %s", after.Status)
	}
	w, _ := rail.Wallet("investor1")
	if w.ReservedPaise != 0 {
		t.Fatalf("the money is still locked after the deadline: %d", w.ReservedPaise)
	}
	if w.BalancePaise != 10000000 {
		t.Fatalf("a refund must not change the balance, got %d", w.BalancePaise)
	}
	// And a late presentation is refused rather than settled.
	if _, err := desk.Present(c.ConditionID, PresentRequest{CredentialID: "anything"}, "originator1", false); err == nil {
		t.Fatal("presenting against an expired condition must be refused")
	}
}

func TestCancellingReturnsTheMoneyAndOnlyTheParties(t *testing.T) {
	desk, rail, _, _ := newConditionDesk(t)
	c := openCondition(t, desk)

	if _, err := desk.Cancel(c.ConditionID, "investor2", false); !errors.Is(err, ErrConditionNotAsserter) {
		t.Fatalf("a stranger must not be able to end somebody else's agreement, got %v", err)
	}
	out, err := desk.Cancel(c.ConditionID, "originator1", false)
	if err != nil {
		t.Fatalf("cancel: %v", err)
	}
	if out.Status != ConditionRefunded {
		t.Fatalf("expected REFUNDED, got %s", out.Status)
	}
	w, _ := rail.Wallet("investor1")
	if w.ReservedPaise != 0 || w.BalancePaise != 10000000 {
		t.Fatalf("the refund did not land: reserved %d balance %d", w.ReservedPaise, w.BalancePaise)
	}
	// It cannot then be released.
	if _, err := desk.Present(c.ConditionID, PresentRequest{CredentialID: "x"}, "originator1", false); !errors.Is(err, ErrConditionClosed) {
		t.Fatalf("a cancelled condition must not settle, got %v", err)
	}
	// Nor cancelled twice.
	if _, err := desk.Cancel(c.ConditionID, "investor1", false); !errors.Is(err, ErrConditionClosed) {
		t.Fatalf("a second cancel must be refused, got %v", err)
	}
}

func TestOpeningRefusesWhatItShould(t *testing.T) {
	desk, _, _, _ := newConditionDesk(t)

	cases := []struct {
		name  string
		req   ConditionRequest
		actor string
		want  error
	}{
		{"no credential type named", ConditionRequest{
			AssetID: "PROP-C1", Seller: "originator1", Buyer: "investor1", Tokens: 1, PricePerTokenINR: 100,
		}, "investor1", ErrConditionFields},
		{"settling against yourself", ConditionRequest{
			AssetID: "PROP-C1", Seller: "investor1", Buyer: "investor1", Tokens: 1, PricePerTokenINR: 100,
			CredentialType: CredentialTitleValidation,
		}, "investor1", ErrConditionFields},
		{"somebody else locking the buyer's wallet", ConditionRequest{
			AssetID: "PROP-C1", Seller: "originator1", Buyer: "investor1", Tokens: 1, PricePerTokenINR: 100,
			CredentialType: CredentialTitleValidation,
		}, "investor2", ErrConditionNotAsserter},
		{"more tokens than the seller holds", ConditionRequest{
			AssetID: "PROP-C1", Seller: "originator1", Buyer: "investor1", Tokens: 99999, PricePerTokenINR: 1,
			CredentialType: CredentialTitleValidation,
		}, "investor1", ErrUMIInsufficientSecurities},
		{"more cash than the buyer has", ConditionRequest{
			AssetID: "PROP-C1", Seller: "originator1", Buyer: "investor1", Tokens: 100, PricePerTokenINR: 99999,
			CredentialType: CredentialTitleValidation,
		}, "investor1", ErrUMIInsufficientCBDC},
		{"a window past the maximum", ConditionRequest{
			AssetID: "PROP-C1", Seller: "originator1", Buyer: "investor1", Tokens: 1, PricePerTokenINR: 100,
			CredentialType: CredentialTitleValidation, Window: "9000h",
		}, "investor1", ErrConditionFields},
	}
	for _, tc := range cases {
		if _, err := desk.Open(tc.req, tc.actor, false); !errors.Is(err, tc.want) {
			t.Fatalf("%s: expected %v, got %v", tc.name, tc.want, err)
		}
	}
}

// Conservation, which is the claim that makes a pending cash leg safe to
// have at all: the money identity holds while cash sits conditional.
func TestTheMoneyIdentityHoldsWhileCashIsConditional(t *testing.T) {
	desk, rail, creds, _ := newConditionDesk(t)

	total := func() int64 {
		var sum int64
		for _, w := range rail.Wallets() {
			sum += w.BalancePaise
		}
		return sum
	}
	before := total()

	c := openCondition(t, desk)
	if total() != before {
		t.Fatalf("opening a condition changed the money in issue: %d -> %d", before, total())
	}
	summary := desk.Summary()
	if summary["lockedPaise"].(int64) != 500000 || summary["open"].(int) != 1 {
		t.Fatalf("the summary does not report the locked cash: %v", summary)
	}

	credID := titleCredential(t, creds, "registrar1", "PROP-C1")
	if _, err := desk.Present(c.ConditionID, PresentRequest{CredentialID: credID}, "originator1", false); err != nil {
		t.Fatalf("present: %v", err)
	}
	if total() != before {
		t.Fatalf("releasing a condition changed the money in issue: %d -> %d", before, total())
	}
	if desk.Summary()["lockedPaise"].(int64) != 0 {
		t.Fatal("nothing should be locked once the condition released")
	}
}

// The chain is the record. Every state change writes a typed block.
func TestEveryStateChangeIsOnTheChain(t *testing.T) {
	desk, rail, creds, _ := newConditionDesk(t)
	c := openCondition(t, desk)
	if _, err := desk.Present(c.ConditionID, PresentRequest{CredentialID: "CRED-nope"}, "originator1", false); err == nil {
		t.Fatal("expected the bad credential to be refused")
	}
	credID := titleCredential(t, creds, "registrar1", "PROP-C1")
	if _, err := desk.Present(c.ConditionID, PresentRequest{CredentialID: credID}, "originator1", false); err != nil {
		t.Fatalf("present: %v", err)
	}
	second, err := desk.Open(ConditionRequest{
		AssetID: "PROP-C1", Seller: "originator1", Buyer: "investor1",
		Tokens: 1, PricePerTokenINR: 100, CredentialType: CredentialTitleValidation,
	}, "investor1", false)
	if err != nil {
		t.Fatalf("open second: %v", err)
	}
	if _, err := desk.Cancel(second.ConditionID, "investor1", false); err != nil {
		t.Fatalf("cancel: %v", err)
	}

	seen := map[string]int{}
	for _, b := range rail.chain.Snapshot() {
		seen[b.Type]++
	}
	for _, want := range []string{
		BlockConditionOpened, BlockConditionRefused, BlockConditionReleased, BlockConditionRefunded,
	} {
		if seen[want] == 0 {
			t.Fatalf("no %s block was written", want)
		}
	}
}
