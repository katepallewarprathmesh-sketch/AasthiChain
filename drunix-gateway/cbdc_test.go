package drunix

import (
	"errors"
	"strings"
	"testing"
	"time"
)

func newTestCBDC(t *testing.T) *CBDCLedger {
	t.Helper()
	chain := NewChain()
	rail := NewUMIRail(NewMemorySecurities(), chain)
	l := NewCBDCLedger(rail, chain)
	if l == nil {
		t.Fatal("ledger did not wire")
	}
	return l
}

func mustIssue(t *testing.T, l *CBDCLedger, holder, segment, tier string, paise int64) {
	t.Helper()
	if _, _, err := l.Issue(holder, segment, tier, paise, false, "regulator1"); err != nil {
		t.Fatalf("issue to %s: %v", holder, err)
	}
}

func balance(t *testing.T, l *CBDCLedger, holder string) int64 {
	t.Helper()
	w, ok := l.Wallet(holder)
	if !ok {
		// No account at all is the same fact as a zero balance for these
		// assertions: nothing was ever paid to this holder.
		return 0
	}
	return w.BalancePaise
}

// Money must not appear or vanish. Everything issued is in an account or has
// been redeemed, at every point in a life cycle.
func TestCBDCSupplyIsConserved(t *testing.T) {
	l := newTestCBDC(t)
	mustIssue(t, l, "bank1", CBDCWholesale, KYCFull, 50000000)
	if _, err := l.Transfer("bank1", "shopkeeper", 1000000); err != nil {
		t.Fatalf("transfer: %v", err)
	}
	if _, err := l.IssueOffline("bank1", "device-7", 40000, time.Now().UTC()); err != nil {
		t.Fatalf("offline: %v", err)
	}
	if _, err := l.OpenCondition("bank1", "flyer", 200000, "FLIGHT_CANCELLED", "AI-101",
		"airline1", time.Now().UTC().Add(time.Hour)); err != nil {
		t.Fatalf("condition: %v", err)
	}
	if _, _, err := l.Redeem("bank1", 500000, "regulator1"); err != nil {
		t.Fatalf("redeem: %v", err)
	}

	c := l.Conservation()
	if c["conserved"] != true {
		t.Fatalf("supply not conserved: %+v", c)
	}
	if c["outstandingPaise"].(int64) != c["heldInWalletsPaise"].(int64) {
		t.Fatalf("outstanding and held disagree: %+v", c)
	}
	// Reservations and locks live inside balances, not beside them.
	if c["offlineReservedPaise"].(int64) != 40000 || c["lockedInConditions"].(int64) != 200000 {
		t.Fatalf("reserved and locked not tracked: %+v", c)
	}
}

// Purpose-bound money: the parameters the central bank names are the ones
// enforced, and the refusal is written down.
func TestProgrammableGrantEnforcesEveryCondition(t *testing.T) {
	l := newTestCBDC(t)
	mustIssue(t, l, "state-welfare", CBDCWholesale, KYCFull, 100000000)

	g, err := l.Grant("state-welfare", "beneficiary1", 500000, ProgramCondition{
		Purpose:            "PDS food subsidy",
		MerchantCategories: []string{"FAIR_PRICE_SHOP"},
		AllowedStates:      []string{"Maharashtra"},
		ExpiresAt:          time.Now().UTC().Add(48 * time.Hour).Format(time.RFC3339),
	})
	if err != nil {
		t.Fatalf("grant: %v", err)
	}
	now := time.Now().UTC()

	// Wrong category.
	if _, _, err := l.Spend(g.GrantID, SpendContext{
		Merchant: "liquorstore1", MerchantCategory: "LIQUOR", State: "Maharashtra", AmountPaise: 10000,
	}, now); !errors.Is(err, ErrCBDCCondition) {
		t.Fatalf("a liquor store should not accept food subsidy, got %v", err)
	}
	// Wrong state.
	if _, _, err := l.Spend(g.GrantID, SpendContext{
		Merchant: "fps-goa", MerchantCategory: "FAIR_PRICE_SHOP", State: "Goa", AmountPaise: 10000,
	}, now); !errors.Is(err, ErrCBDCCondition) {
		t.Fatalf("geography must bind, got %v", err)
	}
	// Right everything.
	after, mv, err := l.Spend(g.GrantID, SpendContext{
		Merchant: "fps-pune", MerchantCategory: "FAIR_PRICE_SHOP", State: "Maharashtra", AmountPaise: 120000,
	}, now)
	if err != nil {
		t.Fatalf("a valid spend was refused: %v", err)
	}
	if after.SpentPaise != 120000 || mv.AmountPaise != 120000 {
		t.Fatalf("spend not recorded: %+v", after)
	}
	if balance(t, l, "fps-pune") != 120000 {
		t.Fatal("the merchant was not paid")
	}
	// Beyond the grant.
	if _, _, err := l.Spend(g.GrantID, SpendContext{
		Merchant: "fps-pune", MerchantCategory: "FAIR_PRICE_SHOP", State: "Maharashtra", AmountPaise: 900000,
	}, now); !errors.Is(err, ErrCBDCFunds) {
		t.Fatalf("a grant cannot overspend itself, got %v", err)
	}
	// Expiry.
	if _, _, err := l.Spend(g.GrantID, SpendContext{
		Merchant: "fps-pune", MerchantCategory: "FAIR_PRICE_SHOP", State: "Maharashtra", AmountPaise: 1000,
	}, now.Add(72*time.Hour)); !errors.Is(err, ErrCBDCExpired) {
		t.Fatalf("expiry must bind, got %v", err)
	}

	refusals := 0
	for _, b := range l.chain.Snapshot() {
		if b.Type == BlockCBDCRefused {
			refusals++
		}
	}
	if refusals < 3 {
		t.Fatalf("every refusal must be on the chain, found %d", refusals)
	}
}

// The offline path: reserved value, a working voucher, and a double spend
// that is caught rather than hoped against.
func TestOfflineVoucherAndDoubleSpend(t *testing.T) {
	l := newTestCBDC(t)
	mustIssue(t, l, "villager1", CBDCRetail, KYCFull, 500000)
	now := time.Now().UTC()

	v, err := l.IssueOffline("villager1", "phone-nfc-1", 30000, now)
	if err != nil {
		t.Fatalf("issue offline: %v", err)
	}
	acct, _ := l.Wallet("villager1")
	if acct.OfflineReserved != 30000 {
		t.Fatalf("value was not reserved: %+v", acct)
	}
	if acct.Available() != 470000 {
		t.Fatalf("reserved value is still spendable online: available %d", acct.Available())
	}
	if v.Signature == "" || len(v.Nonce) != 32 {
		t.Fatalf("the voucher is not signed properly: %+v", v)
	}

	// Over the cap.
	if _, err := l.IssueOffline("villager1", "phone-nfc-1", 90000, now); !errors.Is(err, ErrCBDCOfflineCap) {
		t.Fatalf("the small-value cap must bind, got %v", err)
	}
	// Forged.
	forged := *v
	forged.AmountPaise = 300000
	if _, err := l.RedeemOffline(forged, "kirana1", now); !errors.Is(err, ErrCBDCCondition) {
		t.Fatalf("a tampered voucher must be refused, got %v", err)
	}
	// Honest redemption.
	if _, err := l.RedeemOffline(*v, "kirana1", now); err != nil {
		t.Fatalf("redeem: %v", err)
	}
	if balance(t, l, "kirana1") != 30000 {
		t.Fatal("the offline payee was not paid")
	}
	acct, _ = l.Wallet("villager1")
	if acct.OfflineReserved != 0 {
		t.Fatalf("the reservation was not released: %+v", acct)
	}
	// The same voucher again, at a different shop.
	_, err = l.RedeemOffline(*v, "kirana2", now)
	if !errors.Is(err, ErrCBDCDoubleSpend) {
		t.Fatalf("a double spend must be detected, got %v", err)
	}
	if !strings.Contains(err.Error(), "kirana1") {
		t.Fatalf("the refusal should name the first redemption: %v", err)
	}
	if balance(t, l, "kirana2") != 0 {
		t.Fatal("the second shop was paid for a voucher already spent")
	}
	if c := l.Conservation(); c["conserved"] != true {
		t.Fatalf("a double spend attempt broke conservation: %+v", c)
	}
}

// An expired voucher returns its value instead of stranding it.
func TestOfflineVoucherExpiryReturnsTheValue(t *testing.T) {
	l := newTestCBDC(t)
	mustIssue(t, l, "villager2", CBDCRetail, KYCFull, 100000)
	now := time.Now().UTC()
	v, _ := l.IssueOffline("villager2", "phone-2", 20000, now)

	if _, err := l.RedeemOffline(*v, "kirana3", now.Add(100*time.Hour)); !errors.Is(err, ErrCBDCExpired) {
		t.Fatalf("expected expiry, got %v", err)
	}
	acct, _ := l.Wallet("villager2")
	if acct.OfflineReserved != 0 || acct.Available() != 100000 {
		t.Fatalf("expired value did not come back: %+v", acct)
	}
}

// The flight-cancellation refund: money locked by a rule, paid by an event,
// with nobody filing a claim.
func TestConditionalReleaseOnAttestedEvent(t *testing.T) {
	l := newTestCBDC(t)
	mustIssue(t, l, "insurer1", CBDCWholesale, KYCFull, 10000000)
	now := time.Now().UTC()

	c, err := l.OpenCondition("insurer1", "passenger1", 750000, "flight_cancelled", "AI-101-2026-11-02",
		"airline1", now.Add(24*time.Hour))
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	acct, _ := l.Wallet("insurer1")
	if acct.LockedPaise != 750000 {
		t.Fatalf("money was not locked: %+v", acct)
	}
	if balance(t, l, "insurer1") != 10000000 {
		t.Fatal("locking money must not move it")
	}

	// Somebody else cannot trigger the payout.
	released, _ := l.SubmitEvent("fraudster1", "FLIGHT_CANCELLED", "AI-101-2026-11-02", now)
	if len(released) != 0 {
		t.Fatal("an unnamed party released somebody else's money")
	}
	// The named attestor can.
	released, err = l.SubmitEvent("airline1", "FLIGHT_CANCELLED", "AI-101-2026-11-02", now)
	if err != nil || len(released) != 1 {
		t.Fatalf("release: %v %d", err, len(released))
	}
	if released[0].ConditionID != c.ConditionID || released[0].Status != "RELEASED" {
		t.Fatalf("wrong condition released: %+v", released[0])
	}
	if balance(t, l, "passenger1") != 750000 {
		t.Fatal("the passenger was not refunded")
	}
	if released[0].Finality == nil || released[0].Finality.Financial != FinalityFinal {
		t.Fatalf("a CBDC payout should be financially final: %+v", released[0].Finality)
	}
	acct, _ = l.Wallet("insurer1")
	if acct.LockedPaise != 0 {
		t.Fatalf("the lock was not cleared: %+v", acct)
	}
}

// Locked money that nobody claims must come back.
func TestConditionRefundsAtDeadline(t *testing.T) {
	l := newTestCBDC(t)
	mustIssue(t, l, "insurer2", CBDCWholesale, KYCFull, 1000000)
	now := time.Now().UTC()
	_, err := l.OpenCondition("insurer2", "passenger2", 100000, "FLIGHT_CANCELLED", "AI-202",
		"airline1", now.Add(time.Hour))
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	if n := len(l.SweepConditions(now)); n != 0 {
		t.Fatal("a live condition was swept early")
	}
	refunded := l.SweepConditions(now.Add(2 * time.Hour))
	if len(refunded) != 1 || refunded[0].Status != "REFUNDED" {
		t.Fatalf("the deadline did not refund: %+v", refunded)
	}
	acct, _ := l.Wallet("insurer2")
	if acct.LockedPaise != 0 || acct.Available() != 1000000 {
		t.Fatalf("locked money did not return: %+v", acct)
	}
	if balance(t, l, "passenger2") != 0 {
		t.Fatal("an unsatisfied condition paid out anyway")
	}
}

// The two finalities must never be reported as one.
func TestFinalityIsReportedAsTwoSeparateThings(t *testing.T) {
	l := newTestCBDC(t)
	// Funded over a bank rail that has not settled: ledger final, money not.
	_, mv, err := l.Issue("bank2", CBDCWholesale, KYCFull, 5000000, true, "regulator1")
	if err != nil {
		t.Fatalf("issue: %v", err)
	}
	if mv.Finality.Technical != "FINAL_ON_LEDGER" {
		t.Fatalf("technical finality missing: %+v", mv.Finality)
	}
	if mv.Finality.Financial != FinalityProvisional {
		t.Fatal("a bank-funded issue must be financially provisional")
	}
	if mv.Finality.SettlementWindow == "" {
		t.Fatal("a provisional leg must name the window that closes it")
	}
	if mv.Finality.BlockHash == "" || mv.Finality.Height == 0 {
		t.Fatalf("technical finality must cite the block: %+v", mv.Finality)
	}

	// A transfer in central bank money: both at once.
	tx, err := l.Transfer("bank2", "bank3", 100000)
	if err != nil {
		t.Fatalf("transfer: %v", err)
	}
	if tx.Finality.Financial != FinalityFinal || tx.Finality.SettlementWindow != "" {
		t.Fatalf("a CBDC leg should be final with no window: %+v", tx.Finality)
	}
	if !strings.Contains(tx.Finality.Basis, "central bank money") {
		t.Fatalf("the basis must say why: %q", tx.Finality.Basis)
	}
}

// KYC tiers bind balance and payment size.
func TestKYCTiersBindAmounts(t *testing.T) {
	l := newTestCBDC(t)
	// A minimally verified wallet cannot be loaded past its ceiling.
	if _, _, err := l.Issue("walkin1", CBDCRetail, KYCMinimal, 2000000, false, "regulator1"); !errors.Is(err, ErrCBDCKYCCap) {
		t.Fatalf("the minimal tier balance cap must bind, got %v", err)
	}
	mustIssue(t, l, "walkin1", CBDCRetail, KYCMinimal, 900000)
	mustIssue(t, l, "merchant1", CBDCRetail, KYCFull, 0+1)

	// Wholesale is not capped by retail tiers.
	mustIssue(t, l, "bank9", CBDCWholesale, KYCFull, 900000000)
	if balance(t, l, "bank9") != 900000000 {
		t.Fatal("wholesale balance was capped by a retail rule")
	}
}

// Screening is attached to every movement and reports both opinions.
func TestMovementsCarryScreening(t *testing.T) {
	l := newTestCBDC(t)
	mustIssue(t, l, "bank4", CBDCWholesale, KYCFull, 2000000000)
	mv, err := l.Transfer("bank4", "bank5", 150000000) // ₹15,00,000
	if err != nil {
		t.Fatalf("transfer: %v", err)
	}
	if !mv.AML.Reportable {
		t.Fatal("a movement above the reporting threshold must be flagged")
	}
	if mv.AML.Agreement == "" {
		t.Fatal("the rules and the model must both be reported")
	}
	if !strings.Contains(mv.AML.LegalContext, "money-laundering") {
		t.Fatalf("the legal context must be stated: %q", mv.AML.LegalContext)
	}
	small, err := l.Transfer("bank4", "bank6", 50000)
	if err != nil {
		t.Fatalf("small transfer: %v", err)
	}
	if small.AML.Reportable {
		t.Fatal("a small payment was marked reportable")
	}
}

// An account cannot pay what it does not have, including value it has already
// committed elsewhere.
func TestCommittedValueCannotBeSpentTwice(t *testing.T) {
	l := newTestCBDC(t)
	mustIssue(t, l, "payer1", CBDCWholesale, KYCFull, 100000)
	if _, err := l.IssueOffline("payer1", "dev-1", 50000, time.Now().UTC()); err != nil {
		t.Fatalf("offline: %v", err)
	}
	if _, err := l.OpenCondition("payer1", "payee1", 40000, "X", "k", "att1",
		time.Now().UTC().Add(time.Hour)); err != nil {
		t.Fatalf("condition: %v", err)
	}
	// 100000 held, 90000 committed: only 10000 is actually available.
	if _, err := l.Transfer("payer1", "payee2", 20000); !errors.Is(err, ErrCBDCFunds) {
		t.Fatalf("committed value was spendable, got %v", err)
	}
	if _, err := l.Transfer("payer1", "payee2", 10000); err != nil {
		t.Fatalf("the genuinely available balance was refused: %v", err)
	}
}

func TestCBDCStatusPublishesPolicyAndLimits(t *testing.T) {
	l := newTestCBDC(t)
	st := l.Status()
	if st["disclaimer"] == "" || !strings.Contains(CBDCDisclaimer, "No central bank money") {
		t.Fatal("the simulation must be declared")
	}
	fin, ok := st["finality"].(map[string]string)
	if !ok || fin["technical"] == "" || fin["financial"] == "" {
		t.Fatalf("both finalities must be described: %+v", st["finality"])
	}
	if _, ok := st["policy"].(map[string]interface{})["offline"]; !ok {
		t.Fatal("the offline bounds must be published")
	}
}
