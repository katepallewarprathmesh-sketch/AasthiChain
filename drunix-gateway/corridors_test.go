package drunix

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"strings"
	"testing"
	"time"
)

func newCorridorTestDesk(t *testing.T) (*CorridorDesk, *CBDCLedger) {
	t.Helper()
	chain := NewChain()
	rail := NewUMIRail(NewMemorySecurities(), chain)
	cbdc := NewCBDCLedger(rail, chain)
	d := NewCorridorDesk(rail, chain, cbdc)
	if d == nil {
		t.Fatal("desk did not wire")
	}
	// Fund a payer with wholesale money, which is not capped by retail tiers.
	if _, _, err := cbdc.Issue("bank-in", CBDCWholesale, KYCFull, 5000000000, false, "regulator1"); err != nil {
		t.Fatalf("issue: %v", err)
	}
	return d, cbdc
}

func TestCorridorCatalogueIsComplete(t *testing.T) {
	d, _ := newCorridorTestDesk(t)
	want := map[string]string{
		"NIPL-P2P-NP":        SettleDeferredBank,
		"PACB-ECOM":          SettleDeferredBank,
		"BANK-CORRESPONDENT": SettleDeferredBank,
		"CARD-SCHEME":        SettleCardScheme,
		"MULTI-CBDC-PVP":     SettleAtomicOnLedger,
		"HTLC-LINKED":        SettleHTLCCrossChain,
	}
	got := map[string]Corridor{}
	for _, c := range d.Corridors() {
		got[c.ID] = c
	}
	for id, model := range want {
		c, ok := got[id]
		if !ok {
			t.Fatalf("corridor %s is missing", id)
		}
		if c.SettlementModel != model {
			t.Fatalf("%s settles as %s, expected %s", id, c.SettlementModel, model)
		}
		if c.Window == "" || c.Precedent == "" {
			t.Fatalf("%s must publish its window and the precedent it follows", id)
		}
	}
}

// A corridor this deployment is not licensed for must refuse and name the
// authorisation, rather than failing vaguely.
func TestUnlicensedCorridorRefusesByName(t *testing.T) {
	d, _ := newCorridorTestDesk(t)
	now := time.Now().UTC()

	_, err := d.Send(SendRequest{
		CorridorID: "PACB-ECOM", Payer: "bank-in", Payee: "overseas-merchant",
		AmountPaise: 500000, PurposeCode: "IMPORT_GOODS",
	}, now)
	if !errors.Is(err, ErrCorridorLicence) {
		t.Fatalf("expected a licence refusal, got %v", err)
	}
	if !strings.Contains(err.Error(), "aggregator authorisation") {
		t.Fatalf("the refusal must name what is missing: %v", err)
	}
	if !strings.Contains(err.Error(), "financial intelligence unit") {
		t.Fatalf("every missing licence should be listed: %v", err)
	}

	card, err := d.Send(SendRequest{
		CorridorID: "CARD-SCHEME", Payer: "bank-in", Payee: "overseas-shop",
		AmountPaise: 100000, PurposeCode: "IMPORT_GOODS",
	}, now)
	if card != nil || !errors.Is(err, ErrCorridorLicence) {
		t.Fatalf("the card rail needs scheme membership, got %v", err)
	}

	refusals := 0
	for _, b := range d.chain.Snapshot() {
		if b.Type == BlockCorridorRefused {
			refusals++
		}
	}
	if refusals < 2 {
		t.Fatalf("refusals must be committed, found %d", refusals)
	}
}

// Caps differ per corridor and are enforced per corridor.
func TestCorridorCapsAreEnforcedPerCorridor(t *testing.T) {
	d, _ := newCorridorTestDesk(t)
	now := time.Now().UTC()

	// The scheme-to-scheme link carries small person-to-person amounts.
	_, err := d.Send(SendRequest{
		CorridorID: "NIPL-P2P-NP", Payer: "bank-in", Payee: "np-user",
		AmountPaise: 2000000, PurposeCode: "P2P_REMITTANCE",
	}, now)
	if !errors.Is(err, ErrCorridorCap) {
		t.Fatalf("the per-transaction ceiling must bind, got %v", err)
	}

	// Within the cap it works.
	ok1, err := d.Send(SendRequest{
		CorridorID: "NIPL-P2P-NP", Payer: "bank-in", Payee: "np-user",
		AmountPaise: 1400000, PurposeCode: "P2P_REMITTANCE",
	}, now)
	if err != nil {
		t.Fatalf("a compliant transfer was refused: %v", err)
	}
	if ok1.Status != CorridorAwaitingLeg {
		t.Fatalf("a scheme corridor should wait for its far leg, got %s", ok1.Status)
	}

	// The monthly ceiling accumulates across payments.
	for i := 0; i < 8; i++ {
		_, err = d.Send(SendRequest{
			CorridorID: "NIPL-P2P-NP", Payer: "bank-in", Payee: "np-user",
			AmountPaise: 1400000, PurposeCode: "P2P_REMITTANCE",
		}, now)
	}
	if !errors.Is(err, ErrCorridorCap) {
		t.Fatalf("the monthly ceiling must bind, got %v", err)
	}

	// The wrong purpose on the right corridor.
	_, err = d.Send(SendRequest{
		CorridorID: "NIPL-P2P-NP", Payer: "bank-in", Payee: "np-merchant",
		AmountPaise: 100000, PurposeCode: "IMPORT_GOODS",
	}, now)
	if !errors.Is(err, ErrCorridorPurpose) && !errors.Is(err, ErrCorridorCap) {
		t.Fatalf("a merchant purpose does not belong on a person-to-person link, got %v", err)
	}
}

// Both legs here: one block, no gap, financially final immediately.
func TestBothLegsOnOneLedgerSettleAtomically(t *testing.T) {
	d, cbdc := newCorridorTestDesk(t)
	now := time.Now().UTC()

	tr, err := d.Send(SendRequest{
		CorridorID: "MULTI-CBDC-PVP", Payer: "bank-in", Payee: "bank-ae",
		AmountPaise: 25000000, PurposeCode: "IMPORT_GOODS",
		Originator: "Exporter Pvt Ltd", Beneficiary: "Gulf Trading LLC",
	}, now)
	if err != nil {
		t.Fatalf("send: %v", err)
	}
	if tr.Status != CorridorSettled {
		t.Fatalf("expected immediate settlement, got %s", tr.Status)
	}
	if tr.Finality.Financial != FinalityFinal || tr.Finality.SettlementWindow != "" {
		t.Fatalf("an on-ledger payment-versus-payment leg has no window: %+v", tr.Finality)
	}
	w, _ := cbdc.Wallet("bank-ae")
	if w.BalancePaise != 25000000 {
		t.Fatalf("the receiving bank was not credited: %+v", w)
	}
	if s, _ := cbdc.Wallet(suspenseFor("MULTI-CBDC-PVP")); s.BalancePaise != 0 {
		t.Fatal("an atomic corridor should never park money in suspense")
	}
}

// Two ledgers: hash time-locked, claimable only with the preimage.
func TestCrossLedgerSwapClaimsOnlyWithTheSecret(t *testing.T) {
	d, cbdc := newCorridorTestDesk(t)
	now := time.Now().UTC()
	secret := "jasper-ubin-style-preimage-2026"
	sum := sha256.Sum256([]byte(secret))
	lock := hex.EncodeToString(sum[:])

	tr, err := d.Send(SendRequest{
		CorridorID: "HTLC-LINKED", Payer: "bank-in", Payee: "bank-sg",
		AmountPaise: 10000000, PurposeCode: "IMPORT_GOODS", HashLock: lock, TimeoutHours: 6,
		Originator: "Exporter Pvt Ltd", Beneficiary: "Lion Trading Pte",
		ForeignLedger: "sgd-ledger-sim",
	}, now)
	if err != nil {
		t.Fatalf("send: %v", err)
	}
	if tr.Status != CorridorAwaitingClaim {
		t.Fatalf("expected a lock, got %s", tr.Status)
	}
	if tr.Finality.Financial != FinalityProvisional || tr.Finality.SettlementWindow == "" {
		t.Fatalf("a locked leg is provisional and must say until when: %+v", tr.Finality)
	}
	// The money is out of the payer and not yet the payee's.
	if w, _ := cbdc.Wallet("bank-sg"); w.BalancePaise != 0 {
		t.Fatal("the payee was credited before the secret was revealed")
	}
	if susp, _ := cbdc.Wallet(suspenseFor("HTLC-LINKED")); susp.BalancePaise != 10000000 {
		t.Fatalf("locked value is not in corridor suspense: %+v", susp)
	}

	// A wrong secret proves nothing and moves nothing.
	if _, err := d.Claim(tr.TransferID, "not-the-secret", now); !errors.Is(err, ErrCorridorSecret) {
		t.Fatalf("a wrong preimage must be refused, got %v", err)
	}
	if w, _ := cbdc.Wallet("bank-sg"); w.BalancePaise != 0 {
		t.Fatal("a failed claim paid out anyway")
	}

	done, err := d.Claim(tr.TransferID, secret, now)
	if err != nil {
		t.Fatalf("claim: %v", err)
	}
	if done.Status != CorridorSettled || done.Finality.Financial != FinalityFinal {
		t.Fatalf("a claimed swap is settled and final: %+v", done)
	}
	if w, _ := cbdc.Wallet("bank-sg"); w.BalancePaise != 10000000 {
		t.Fatal("the far bank was not paid after a valid claim")
	}
	// Claiming twice is not a second payment.
	if _, err := d.Claim(tr.TransferID, secret, now); !errors.Is(err, ErrCorridorState) {
		t.Fatalf("a settled swap cannot be claimed again, got %v", err)
	}
}

// The half that demonstrations skip: an unclaimed lock must refund.
func TestCrossLedgerSwapRefundsOnTimeout(t *testing.T) {
	d, cbdc := newCorridorTestDesk(t)
	now := time.Now().UTC()
	sum := sha256.Sum256([]byte("never-revealed"))
	lock := hex.EncodeToString(sum[:])

	before, _ := cbdc.Wallet("bank-in")
	tr, err := d.Send(SendRequest{
		CorridorID: "HTLC-LINKED", Payer: "bank-in", Payee: "bank-ca",
		AmountPaise: 7000000, PurposeCode: "IMPORT_GOODS", HashLock: lock, TimeoutHours: 2,
		Originator: "A", Beneficiary: "B",
	}, now)
	if err != nil {
		t.Fatalf("send: %v", err)
	}
	if n := len(d.Sweep(now)); n != 0 {
		t.Fatal("a live lock was swept early")
	}
	refunded := d.Sweep(now.Add(3 * time.Hour))
	if len(refunded) != 1 || refunded[0].TransferID != tr.TransferID {
		t.Fatalf("the timeout did not refund: %+v", refunded)
	}
	after, _ := cbdc.Wallet("bank-in")
	if after.BalancePaise != before.BalancePaise {
		t.Fatalf("the payer did not get the money back: %d then %d", before.BalancePaise, after.BalancePaise)
	}
	if w, _ := cbdc.Wallet("bank-ca"); w.BalancePaise != 0 {
		t.Fatal("an expired lock paid the payee")
	}
	// After a refund the secret is worthless.
	if _, err := d.Claim(tr.TransferID, "never-revealed", now.Add(4*time.Hour)); err == nil {
		t.Fatal("a refunded transfer was still claimable")
	}
}

// A deferred corridor is provisional until the far institution confirms.
func TestDeferredCorridorIsProvisionalUntilConfirmed(t *testing.T) {
	d, cbdc := newCorridorTestDesk(t)
	now := time.Now().UTC()

	tr, err := d.Send(SendRequest{
		CorridorID: "BANK-CORRESPONDENT", Payer: "bank-in", Payee: "beneficiary-uk",
		AmountPaise: 40000000, PurposeCode: "FAMILY_MAINTENANCE",
		Originator: "Sender Name", Beneficiary: "Receiver Name",
	}, now)
	if err != nil {
		t.Fatalf("send: %v", err)
	}
	if tr.Status != CorridorAwaitingLeg || tr.Finality.Financial != FinalityProvisional {
		t.Fatalf("a correspondent leg is provisional: %+v", tr)
	}
	if !strings.Contains(tr.Finality.SettlementWindow, "three to five") {
		t.Fatalf("the window must be named: %q", tr.Finality.SettlementWindow)
	}
	if w, _ := cbdc.Wallet("beneficiary-uk"); w.BalancePaise != 0 {
		t.Fatal("the beneficiary was paid before the far leg confirmed")
	}

	done, err := d.ConfirmLeg(tr.TransferID, "correspondent-bank-1", now.Add(time.Hour))
	if err != nil {
		t.Fatalf("confirm: %v", err)
	}
	if done.Finality.Financial != FinalityFinal || done.Finality.SettlementWindow != "" {
		t.Fatalf("confirmation closes the window: %+v", done.Finality)
	}
	if !strings.Contains(done.Finality.Basis, "correspondent-bank-1") {
		t.Fatalf("the basis should name who confirmed: %q", done.Finality.Basis)
	}
	if w, _ := cbdc.Wallet("beneficiary-uk"); w.BalancePaise != 40000000 {
		t.Fatal("the beneficiary was not paid after confirmation")
	}
}

// Above the Travel Rule threshold a payment without named parties does not go.
func TestTravelRuleRequiresBothEnds(t *testing.T) {
	d, _ := newCorridorTestDesk(t)
	now := time.Now().UTC()

	_, err := d.Send(SendRequest{
		CorridorID: "BANK-CORRESPONDENT", Payer: "bank-in", Payee: "someone",
		AmountPaise: 20000000, PurposeCode: "EDUCATION",
	}, now)
	if !errors.Is(err, ErrCorridorTravel) {
		t.Fatalf("expected the travel rule to bind, got %v", err)
	}
	// Under the threshold the same payment is fine.
	small, err := d.Send(SendRequest{
		CorridorID: "BANK-CORRESPONDENT", Payer: "bank-in", Payee: "someone",
		AmountPaise: 500000, PurposeCode: "EDUCATION",
	}, now)
	if err != nil {
		t.Fatalf("a small transfer should not need the travel rule fields: %v", err)
	}
	if small.TravelRule {
		t.Fatal("the travel rule was applied below its threshold")
	}
}

// Money is never lost between corridors: suspense is an account like any
// other and the CBDC conservation check still balances.
func TestCorridorsPreserveConservation(t *testing.T) {
	d, cbdc := newCorridorTestDesk(t)
	now := time.Now().UTC()
	sum := sha256.Sum256([]byte("s"))
	lock := hex.EncodeToString(sum[:])

	_, _ = d.Send(SendRequest{CorridorID: "MULTI-CBDC-PVP", Payer: "bank-in", Payee: "bank-th",
		AmountPaise: 1000000, PurposeCode: "IMPORT_GOODS", Originator: "A", Beneficiary: "B"}, now)
	_, _ = d.Send(SendRequest{CorridorID: "HTLC-LINKED", Payer: "bank-in", Payee: "bank-sg",
		AmountPaise: 2000000, PurposeCode: "IMPORT_GOODS", HashLock: lock, Originator: "A", Beneficiary: "B"}, now)
	tr, _ := d.Send(SendRequest{CorridorID: "BANK-CORRESPONDENT", Payer: "bank-in", Payee: "bank-uk",
		AmountPaise: 3000000, PurposeCode: "IMPORT_GOODS", Originator: "A", Beneficiary: "B"}, now)
	_, _ = d.ConfirmLeg(tr.TransferID, "corr-1", now)

	if c := cbdc.Conservation(); c["conserved"] != true {
		t.Fatalf("corridors broke conservation: %+v", c)
	}
}

func TestCorridorStatusNamesWhatItCannotDo(t *testing.T) {
	d, _ := newCorridorTestDesk(t)
	st := d.Status()
	blocked, ok := st["blockedCorridors"].(map[string][]string)
	if !ok || len(blocked) == 0 {
		t.Fatalf("the status must say which corridors are unusable: %+v", st["blockedCorridors"])
	}
	if _, ok := blocked["PACB-ECOM"]; !ok {
		t.Fatal("the aggregator corridor should be blocked without its authorisation")
	}
	usable, _ := st["usableCorridors"].([]string)
	if len(usable) == 0 {
		t.Fatal("at least the on-ledger corridors should be usable")
	}
	if !strings.Contains(CorridorDisclaimer, "holds no payment licence") {
		t.Fatal("the layer must declare that it holds no licence")
	}
}
