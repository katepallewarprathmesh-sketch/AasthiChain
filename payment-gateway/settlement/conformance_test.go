package settlement

import (
	"context"
	"errors"
	"testing"
	"time"
)

// This file is the executable half of docs/UMI_PATTERN_CONFORMANCE.md.
//
// Any team building a tokenised-settlement rail can copy RunConformance into their own
// repository, pass their implementation to it, and get a pass/fail answer against the
// behaviours that SEBI and RBI have publicly described for Demat 2.0 / UMI. The point
// is to make "we follow the pattern" a testable claim rather than a slide.

func fixedClock() func() time.Time {
	t := time.Date(2026, 9, 30, 10, 0, 0, 0, time.UTC)
	return func() time.Time { return t }
}

func newFundedRail(t *testing.T) *UMISimRail {
	t.Helper()
	r := NewUMISimRail(fixedClock())
	if _, err := r.OpenWallet("investor1", "INVESTOR", "SimBank", 1_000_000); err != nil {
		t.Fatalf("open investor wallet: %v", err)
	}
	if _, err := r.OpenWallet("spv-mumbai-01", "ISSUER_SPV", "SimBank", 0); err != nil {
		t.Fatalf("open spv wallet: %v", err)
	}
	return r
}

// C1: the rail must never claim to be real.
func TestConformance_HonestyContract(t *testing.T) {
	r := NewUMISimRail(nil)
	if err := AssertSimulated(r); err != nil {
		t.Fatalf("simulated rail failed honesty guard: %v", err)
	}
	c := r.Capabilities()
	if c.CentralBankMoney {
		t.Error("simulator must not claim central bank money")
	}
	if !c.Simulated {
		t.Error("simulator must report simulated=true")
	}
	if c.RegulatoryStatus != StatusSimulatedNotConnected {
		t.Errorf("regulatoryStatus = %q, want %q", c.RegulatoryStatus, StatusSimulatedNotConnected)
	}
}

// C2: reserving the cash leg must not move money.
func TestConformance_ReserveDoesNotMoveMoney(t *testing.T) {
	r := newFundedRail(t)
	ctx := context.Background()

	before, _ := r.GetWallet("investor1")
	lock, err := r.Reserve(ctx, DvPRequest{
		DvPID: "DVP-1", AssetID: "PROP-1",
		PayerID: "investor1", PayeeID: "spv-mumbai-01",
		AmountPaise: 250_000, TokenCount: 5,
	})
	if err != nil {
		t.Fatalf("reserve: %v", err)
	}
	after, _ := r.GetWallet("investor1")
	payee, _ := r.GetWallet("spv-mumbai-01")

	if after.BalancePaise != before.BalancePaise {
		t.Errorf("balance changed on reserve: %d -> %d", before.BalancePaise, after.BalancePaise)
	}
	if after.HeldPaise != 250_000 {
		t.Errorf("held = %d, want 250000", after.HeldPaise)
	}
	if payee.BalancePaise != 0 {
		t.Errorf("payee credited before settlement: %d", payee.BalancePaise)
	}
	if lock.Phase != PhaseReserved {
		t.Errorf("phase = %s, want RESERVED", lock.Phase)
	}
}

// C3: both legs commit together, and the cash reference ties to the ledger reference.
func TestConformance_AtomicSettlement(t *testing.T) {
	r := newFundedRail(t)
	ctx := context.Background()

	lock, err := r.Reserve(ctx, DvPRequest{
		DvPID: "DVP-2", AssetID: "PROP-1",
		PayerID: "investor1", PayeeID: "spv-mumbai-01",
		AmountPaise: 250_000, TokenCount: 5,
	})
	if err != nil {
		t.Fatalf("reserve: %v", err)
	}

	receipt, err := r.AtomicSettle(ctx, lock, TokenLeg{
		AssetID: "PROP-1", FromID: "spv-mumbai-01", ToID: "investor1",
		TokenCount: 5, LedgerTxID: "TXN-abc123",
	})
	if err != nil {
		t.Fatalf("settle: %v", err)
	}

	payer, _ := r.GetWallet("investor1")
	payee, _ := r.GetWallet("spv-mumbai-01")

	if payer.BalancePaise != 750_000 {
		t.Errorf("payer balance = %d, want 750000", payer.BalancePaise)
	}
	if payer.HeldPaise != 0 {
		t.Errorf("hold not released: %d", payer.HeldPaise)
	}
	if payee.BalancePaise != 250_000 {
		t.Errorf("payee balance = %d, want 250000", payee.BalancePaise)
	}
	if receipt.LedgerTxID != "TXN-abc123" {
		t.Errorf("receipt lost the security leg reference: %q", receipt.LedgerTxID)
	}
	if receipt.CashRef == "" {
		t.Error("receipt missing cash leg reference")
	}
	if !receipt.Simulated || receipt.CentralBankMoney {
		t.Error("receipt must stay honest: simulated=true, centralBankMoney=false")
	}
	if receipt.Phase != PhaseSettled {
		t.Errorf("phase = %s, want SETTLED", receipt.Phase)
	}
}

// C4: a mismatched security leg must abort the trade with no money moved.
func TestConformance_MismatchedLegAbortsCleanly(t *testing.T) {
	r := newFundedRail(t)
	ctx := context.Background()

	lock, _ := r.Reserve(ctx, DvPRequest{
		DvPID: "DVP-3", AssetID: "PROP-1",
		PayerID: "investor1", PayeeID: "spv-mumbai-01",
		AmountPaise: 100_000, TokenCount: 2,
	})

	// Security leg names the wrong counterparty.
	_, err := r.AtomicSettle(ctx, lock, TokenLeg{
		AssetID: "PROP-1", FromID: "someone-else", ToID: "investor1",
		TokenCount: 2, LedgerTxID: "TXN-bad",
	})
	if !errors.Is(err, ErrLegMismatch) {
		t.Fatalf("err = %v, want ErrLegMismatch", err)
	}

	payer, _ := r.GetWallet("investor1")
	payee, _ := r.GetWallet("spv-mumbai-01")
	if payer.BalancePaise != 1_000_000 || payee.BalancePaise != 0 {
		t.Errorf("money moved on a failed trade: payer=%d payee=%d", payer.BalancePaise, payee.BalancePaise)
	}
	if payer.HeldPaise != 100_000 {
		t.Errorf("reservation should survive a rejected settle, held=%d", payer.HeldPaise)
	}
}

// C5: a settled lock cannot be replayed.
func TestConformance_NoDoubleSettle(t *testing.T) {
	r := newFundedRail(t)
	ctx := context.Background()

	lock, _ := r.Reserve(ctx, DvPRequest{
		DvPID: "DVP-4", AssetID: "PROP-1",
		PayerID: "investor1", PayeeID: "spv-mumbai-01",
		AmountPaise: 400_000, TokenCount: 8,
	})
	leg := TokenLeg{AssetID: "PROP-1", FromID: "spv-mumbai-01", ToID: "investor1", TokenCount: 8, LedgerTxID: "TXN-once"}

	if _, err := r.AtomicSettle(ctx, lock, leg); err != nil {
		t.Fatalf("first settle: %v", err)
	}
	if _, err := r.AtomicSettle(ctx, lock, leg); !errors.Is(err, ErrLockConsumed) {
		t.Fatalf("replay err = %v, want ErrLockConsumed", err)
	}

	payee, _ := r.GetWallet("spv-mumbai-01")
	if payee.BalancePaise != 400_000 {
		t.Errorf("replay paid twice: %d", payee.BalancePaise)
	}
}

// C6: unwinding returns the reservation and leaves balances untouched.
func TestConformance_UnwindRestoresAvailability(t *testing.T) {
	r := newFundedRail(t)
	ctx := context.Background()

	lock, _ := r.Reserve(ctx, DvPRequest{
		DvPID: "DVP-5", AssetID: "PROP-1",
		PayerID: "investor1", PayeeID: "spv-mumbai-01",
		AmountPaise: 600_000, TokenCount: 12,
	})
	if err := r.Unwind(ctx, lock, "investor abandoned the flow"); err != nil {
		t.Fatalf("unwind: %v", err)
	}

	payer, _ := r.GetWallet("investor1")
	if payer.HeldPaise != 0 || payer.BalancePaise != 1_000_000 {
		t.Errorf("unwind did not restore wallet: balance=%d held=%d", payer.BalancePaise, payer.HeldPaise)
	}
	if err := r.Unwind(ctx, lock, "again"); !errors.Is(err, ErrLockConsumed) {
		t.Errorf("double unwind err = %v, want ErrLockConsumed", err)
	}
}

// C7: a reservation cannot exceed available funds, and concurrent reservations cannot
// oversubscribe the same wallet.
func TestConformance_NoOversubscription(t *testing.T) {
	r := newFundedRail(t)
	ctx := context.Background()

	if _, err := r.Reserve(ctx, DvPRequest{
		DvPID: "DVP-6", AssetID: "PROP-1", PayerID: "investor1", PayeeID: "spv-mumbai-01",
		AmountPaise: 900_000, TokenCount: 18,
	}); err != nil {
		t.Fatalf("first reserve: %v", err)
	}
	_, err := r.Reserve(ctx, DvPRequest{
		DvPID: "DVP-7", AssetID: "PROP-1", PayerID: "investor1", PayeeID: "spv-mumbai-01",
		AmountPaise: 200_000, TokenCount: 4,
	})
	if !errors.Is(err, ErrInsufficientFunds) {
		t.Fatalf("err = %v, want ErrInsufficientFunds", err)
	}
}

// C8: corporate actions pay every holder or nobody, and conserve money exactly.
func TestConformance_CorporateActionIsAllOrNothing(t *testing.T) {
	r := newFundedRail(t)
	ctx := context.Background()
	if _, err := r.OpenWallet("investor2", "INVESTOR", "SimBank", 0); err != nil {
		t.Fatal(err)
	}
	if _, err := r.OpenWallet("rent-pool", "INVESTMENT_MANAGER", "SimBank", 600_000); err != nil {
		t.Fatal(err)
	}

	// Happy path: 6000.00 split pro rata, in paise, no rounding drift.
	action, err := r.DistributeCorporateAction(ctx, CorporateAction{
		AssetID: "PROP-1", Kind: "RENT", FromID: "rent-pool",
		Splits: map[string]int64{"investor1": 480_000, "investor2": 120_000},
	})
	if err != nil {
		t.Fatalf("distribute: %v", err)
	}
	if !action.Simulated {
		t.Error("corporate action must report simulated=true")
	}

	i1, _ := r.GetWallet("investor1")
	i2, _ := r.GetWallet("investor2")
	pool, _ := r.GetWallet("rent-pool")
	if i1.BalancePaise != 1_480_000 || i2.BalancePaise != 120_000 || pool.BalancePaise != 0 {
		t.Errorf("bad allocation: i1=%d i2=%d pool=%d", i1.BalancePaise, i2.BalancePaise, pool.BalancePaise)
	}

	// Underfunded distribution must pay nobody.
	if _, err := r.DistributeCorporateAction(ctx, CorporateAction{
		AssetID: "PROP-1", Kind: "RENT", FromID: "rent-pool",
		Splits: map[string]int64{"investor1": 1, "investor2": 1},
	}); !errors.Is(err, ErrInsufficientFunds) {
		t.Fatalf("err = %v, want ErrInsufficientFunds", err)
	}
	i1After, _ := r.GetWallet("investor1")
	if i1After.BalancePaise != 1_480_000 {
		t.Errorf("partial payout leaked: %d", i1After.BalancePaise)
	}
}

// C9: zero and negative amounts are rejected before any state is touched.
func TestConformance_RejectsInvalidAmounts(t *testing.T) {
	r := newFundedRail(t)
	ctx := context.Background()

	for _, tc := range []struct {
		name   string
		amount int64
		tokens int64
	}{
		{"zero amount", 0, 5},
		{"negative amount", -100, 5},
		{"zero tokens", 100, 0},
	} {
		if _, err := r.Reserve(ctx, DvPRequest{
			DvPID: "DVP-X", AssetID: "PROP-1", PayerID: "investor1", PayeeID: "spv-mumbai-01",
			AmountPaise: tc.amount, TokenCount: tc.tokens,
		}); !errors.Is(err, ErrInvalidAmount) {
			t.Errorf("%s: err = %v, want ErrInvalidAmount", tc.name, err)
		}
	}
	payer, _ := r.GetWallet("investor1")
	if payer.HeldPaise != 0 {
		t.Errorf("invalid request created a hold: %d", payer.HeldPaise)
	}
}

// C10: unknown participants cannot transact.
func TestConformance_UnknownParticipantRejected(t *testing.T) {
	r := newFundedRail(t)
	ctx := context.Background()

	if _, err := r.Reserve(ctx, DvPRequest{
		DvPID: "DVP-Y", AssetID: "PROP-1", PayerID: "ghost", PayeeID: "spv-mumbai-01",
		AmountPaise: 100, TokenCount: 1,
	}); !errors.Is(err, ErrUnknownParticipant) {
		t.Errorf("unknown payer err = %v, want ErrUnknownParticipant", err)
	}
	if _, err := r.GetWallet("ghost"); !errors.Is(err, ErrUnknownParticipant) {
		t.Errorf("unknown wallet err = %v, want ErrUnknownParticipant", err)
	}
}

// Compile-time proof that the simulator satisfies the substitution boundary.
var _ SettlementRail = (*UMISimRail)(nil)
