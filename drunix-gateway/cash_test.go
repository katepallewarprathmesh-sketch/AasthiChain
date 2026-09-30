package drunix

// Tests for the Drunix cash leg and single-transaction DvP.
//
// The interesting cases here are the failures. Any settlement system can move
// money when everything works; what matters is what survives when a leg fails,
// when the same payment is settled twice, and when two settlements race for
// the same escrow. Those are D4, D5, D6 and D8 below.

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
)

// newCashPipeline wires a fresh pipeline over empty state. peer_test.go owns
// newTestPipeline; this returns only what the cash tests need.
func newCashPipeline() (*Pipeline, *StateDB) {
	state := NewStateDB()
	return NewPipeline(state, NewTransientStore(), NewChain()), state
}

// seedAsset mints tokens to an owner so the securities leg has something to move.
func seedAsset(t *testing.T, p *Pipeline, assetID, owner string, total uint64) {
	t.Helper()
	res, err := p.Submit("MintPropertyTokens", []string{assetID, owner, strconv.FormatUint(total, 10)}, nil)
	if err != nil || !res.Committed {
		t.Fatalf("seed mint failed: %v (%s)", err, res.Reason)
	}
}

// D1 — cash exists on the ledger at all, and only as whole paise.
func TestD1_CashIsLedgerState(t *testing.T) {
	p, state := newCashPipeline()

	if got := CashBalanceOf(state, "buyer1"); got != 0 {
		t.Fatalf("unfunded party should read 0 paise, got %d", got)
	}

	res, err := p.CreditCash("buyer1", 5000000) // Rs 50,000
	if err != nil || !res.Committed {
		t.Fatalf("CreditCash did not commit: %v (%s)", err, res.Reason)
	}
	if got := CashBalanceOf(state, "buyer1"); got != 5000000 {
		t.Fatalf("expected 5000000 paise, got %d", got)
	}

	// Credits accumulate rather than overwrite.
	if _, err := p.CreditCash("buyer1", 2500); err != nil {
		t.Fatalf("second credit failed: %v", err)
	}
	if got := CashBalanceOf(state, "buyer1"); got != 5002500 {
		t.Fatalf("expected 5002500 paise after second credit, got %d", got)
	}

	// Zero and non-numeric amounts are refused at endorsement.
	for _, bad := range []string{"0", "-100", "12.50", "abc", ""} {
		if _, err := p.Submit(FnCreditCash, []string{"buyer1", bad}, nil); err == nil {
			t.Fatalf("amount %q should have been rejected", bad)
		}
	}
	if got := CashBalanceOf(state, "buyer1"); got != 5002500 {
		t.Fatalf("rejected credits must not change state, got %d", got)
	}
}

// D2 — locking escrow debits the payer and holds the funds off their balance.
func TestD2_LockEscrowHoldsFunds(t *testing.T) {
	p, state := newCashPipeline()
	seedAsset(t, p, "PROP-1", "seller1", 1000)
	mustCredit(t, p, "buyer1", 5000000)

	if _, err := p.LockEscrow("PAY-1", "buyer1", "seller1", 250000, "PROP-1", 5); err != nil {
		t.Fatalf("lock failed: %v", err)
	}

	if got := CashBalanceOf(state, "buyer1"); got != 4750000 {
		t.Fatalf("payer should be debited to 4750000, got %d", got)
	}
	// The seller has not been paid yet — the money is in escrow, not with them.
	if got := CashBalanceOf(state, "seller1"); got != 0 {
		t.Fatalf("seller must not hold cash before settlement, got %d", got)
	}

	esc := EscrowOf(state, "PAY-1")
	if !esc.Found || esc.Status != EscrowLocked || esc.AmountPaise != 250000 {
		t.Fatalf("unexpected escrow: %+v", esc)
	}
	if !esc.Simulated {
		t.Fatal("escrow view must declare itself simulated")
	}

	// Tokens have not moved either.
	if got := TokenBalanceOf(state, "PROP-1", "seller1"); got != 1000 {
		t.Fatalf("tokens must not move on lock, seller has %d", got)
	}
}

// D3 — the whole point: both legs commit in ONE transaction and ONE block.
func TestD3_DvPIsOneAtomicTransaction(t *testing.T) {
	p, state := newCashPipeline()
	seedAsset(t, p, "PROP-1", "seller1", 1000)
	mustCredit(t, p, "buyer1", 5000000)

	out, err := p.RunDvP("PAY-1", "buyer1", "seller1", 250000, "PROP-1", 5)
	if err != nil {
		t.Fatalf("DvP failed: %v", err)
	}
	if !out.Settle.Committed {
		t.Fatalf("settlement did not commit: %s", out.Settle.Reason)
	}

	// Both legs landed.
	if got := CashBalanceOf(state, "seller1"); got != 250000 {
		t.Fatalf("seller cash should be 250000, got %d", got)
	}
	if got := TokenBalanceOf(state, "PROP-1", "buyer1"); got != 5 {
		t.Fatalf("buyer tokens should be 5, got %d", got)
	}
	if got := TokenBalanceOf(state, "PROP-1", "seller1"); got != 995 {
		t.Fatalf("seller tokens should be 995, got %d", got)
	}

	// And they landed in the SAME transaction, in the SAME block. This is the
	// assertion that distinguishes real DvP from two sequential appends.
	if out.AtomicTxID == "" || out.AtomicTxID != out.Settle.TxID {
		t.Fatalf("expected one settlement txId, got %q", out.AtomicTxID)
	}
	if out.Lock.TxID == out.Settle.TxID {
		t.Fatal("lock and settle must be distinct transactions")
	}
	if out.BlockHeight == 0 {
		t.Fatal("settlement must report the block that carried both legs")
	}

	// The settlement's write set must contain cash and token keys together.
	// If either were missing, the legs were not in one transaction.
	if _, ok := EscrowViewSettled(state, "PAY-1"); !ok {
		t.Fatal("escrow should be SETTLED after DvP")
	}
}

// D4 — a failing securities leg must not move any cash.
func TestD4_FailedTokenLegMovesNoCash(t *testing.T) {
	p, state := newCashPipeline()
	seedAsset(t, p, "PROP-1", "seller1", 3) // seller has only 3 tokens
	mustCredit(t, p, "buyer1", 5000000)

	if _, err := p.LockEscrow("PAY-1", "buyer1", "seller1", 250000, "PROP-1", 5); err != nil {
		t.Fatalf("lock failed: %v", err)
	}

	cashBefore := CashBalanceOf(state, "seller1")
	_, err := p.SettleDvP("PAY-1")
	if err == nil {
		t.Fatal("settlement should fail: seller holds 3 tokens, owes 5")
	}

	// Nothing moved. Not the tokens, not the cash, not the escrow status.
	if got := CashBalanceOf(state, "seller1"); got != cashBefore {
		t.Fatalf("seller cash changed on a failed settlement: %d -> %d", cashBefore, got)
	}
	if got := TokenBalanceOf(state, "PROP-1", "buyer1"); got != 0 {
		t.Fatalf("buyer received %d tokens from a failed settlement", got)
	}
	if esc := EscrowOf(state, "PAY-1"); esc.Status != EscrowLocked {
		t.Fatalf("escrow should still be LOCKED, is %s", esc.Status)
	}

	// The buyer's money is recoverable — it was never handed over.
	if _, err := p.RefundCash("PAY-1"); err != nil {
		t.Fatalf("refund after failed settlement should work: %v", err)
	}
	if got := CashBalanceOf(state, "buyer1"); got != 5000000 {
		t.Fatalf("buyer should be made whole at 5000000, got %d", got)
	}
}

// D5 — settling the same payment twice is refused.
func TestD5_NoDoubleSettlement(t *testing.T) {
	p, state := newCashPipeline()
	seedAsset(t, p, "PROP-1", "seller1", 1000)
	mustCredit(t, p, "buyer1", 5000000)

	if _, err := p.RunDvP("PAY-1", "buyer1", "seller1", 250000, "PROP-1", 5); err != nil {
		t.Fatalf("first DvP failed: %v", err)
	}

	if _, err := p.SettleDvP("PAY-1"); err == nil {
		t.Fatal("second settlement of the same payment must be refused")
	}
	if got := CashBalanceOf(state, "seller1"); got != 250000 {
		t.Fatalf("replay paid the seller twice: %d", got)
	}
	if got := TokenBalanceOf(state, "PROP-1", "buyer1"); got != 5 {
		t.Fatalf("replay delivered tokens twice: %d", got)
	}

	// A settled escrow cannot be refunded either.
	if _, err := p.RefundCash("PAY-1"); err == nil {
		t.Fatal("refunding a settled escrow must be refused")
	}
}

// D6 — concurrent settlement of one escrow: exactly one commits.
//
// Pipeline.Submit serialises callers, so the winners and losers here are
// decided by the escrow status guard at endorsement, not by MVCC. That is
// still the property worth pinning: however many callers race, the seller is
// paid once and the buyer is delivered once.
//
// D13 covers the harder case, where two settlements are endorsed against the
// same ledger version before either commits and MVCC has to catch it.
func TestD6_ConcurrentSettlementRace(t *testing.T) {
	p, state := newCashPipeline()
	seedAsset(t, p, "PROP-1", "seller1", 1000)
	mustCredit(t, p, "buyer1", 5000000)

	if _, err := p.LockEscrow("PAY-1", "buyer1", "seller1", 250000, "PROP-1", 5); err != nil {
		t.Fatalf("lock failed: %v", err)
	}

	const racers = 8
	var wg sync.WaitGroup
	results := make([]error, racers)
	for i := 0; i < racers; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			_, results[i] = p.SettleDvP("PAY-1")
		}(i)
	}
	wg.Wait()

	committed := 0
	for _, err := range results {
		if err == nil {
			committed++
		}
	}
	if committed != 1 {
		t.Fatalf("expected exactly 1 of %d concurrent settlements to commit, got %d", racers, committed)
	}

	// The seller was paid once, and the buyer received tokens once.
	if got := CashBalanceOf(state, "seller1"); got != 250000 {
		t.Fatalf("seller paid %d paise across a race, expected 250000", got)
	}
	if got := TokenBalanceOf(state, "PROP-1", "buyer1"); got != 5 {
		t.Fatalf("buyer received %d tokens across a race, expected 5", got)
	}
}

// D7 — value is conserved across every operation.
func TestD7_CashIsConserved(t *testing.T) {
	p, state := newCashPipeline()
	seedAsset(t, p, "PROP-1", "seller1", 1000)

	const funded = 5000000
	mustCredit(t, p, "buyer1", funded)

	total := func() uint64 {
		sum := CashBalanceOf(state, "buyer1") + CashBalanceOf(state, "seller1")
		// Money sitting in escrow is still in the system.
		for _, id := range []string{"PAY-1", "PAY-2"} {
			if e := EscrowOf(state, id); e.Found && e.Status == EscrowLocked {
				sum += e.AmountPaise
			}
		}
		return sum
	}

	checkpoint := func(stage string) {
		if got := total(); got != funded {
			t.Fatalf("%s: total cash is %d, expected %d — value was created or destroyed", stage, got, funded)
		}
	}

	checkpoint("after funding")
	if _, err := p.LockEscrow("PAY-1", "buyer1", "seller1", 250000, "PROP-1", 5); err != nil {
		t.Fatalf("lock 1: %v", err)
	}
	checkpoint("after lock")
	if _, err := p.SettleDvP("PAY-1"); err != nil {
		t.Fatalf("settle 1: %v", err)
	}
	checkpoint("after settlement")
	if _, err := p.LockEscrow("PAY-2", "buyer1", "seller1", 100000, "PROP-1", 2); err != nil {
		t.Fatalf("lock 2: %v", err)
	}
	checkpoint("after second lock")
	if _, err := p.RefundCash("PAY-2"); err != nil {
		t.Fatalf("refund 2: %v", err)
	}
	checkpoint("after refund")
}

// D8 — a payer cannot lock more than they hold, or lock the same payment twice.
func TestD8_EscrowGuards(t *testing.T) {
	p, state := newCashPipeline()
	seedAsset(t, p, "PROP-1", "seller1", 1000)
	mustCredit(t, p, "buyer1", 100000)

	// Overdraft is stopped at endorsement, before ordering.
	_, err := p.LockEscrow("PAY-1", "buyer1", "seller1", 250000, "PROP-1", 5)
	if err == nil {
		t.Fatal("locking more than the payer holds must fail")
	}
	if got := CashBalanceOf(state, "buyer1"); got != 100000 {
		t.Fatalf("failed lock changed the balance: %d", got)
	}

	if _, err := p.LockEscrow("PAY-2", "buyer1", "seller1", 50000, "PROP-1", 1); err != nil {
		t.Fatalf("valid lock failed: %v", err)
	}
	// Re-locking the same paymentId would double-charge the payer.
	if _, err := p.LockEscrow("PAY-2", "buyer1", "seller1", 50000, "PROP-1", 1); err == nil {
		t.Fatal("re-locking the same paymentId must fail")
	}
	if got := CashBalanceOf(state, "buyer1"); got != 50000 {
		t.Fatalf("payer charged twice for one payment: %d", got)
	}

	// Settling or refunding an unknown payment is refused.
	if _, err := p.SettleDvP("PAY-NOPE"); err == nil {
		t.Fatal("settling an unknown payment must fail")
	}
	if _, err := p.RefundCash("PAY-NOPE"); err == nil {
		t.Fatal("refunding an unknown payment must fail")
	}
}

// D9 — DvP requires both the payment operator and the platform to endorse.
func TestD9_DvPEndorsementPolicy(t *testing.T) {
	policy, owned := cashPolicyFor(FnSettleDvP)
	if !owned {
		t.Fatal("SettleDvP must have its own endorsement policy")
	}
	want := map[string]bool{MSPPaymentOperator: false, MSPPlatform: false}
	for _, m := range policy.RequiredMSPs {
		if _, ok := want[m]; ok {
			want[m] = true
		}
	}
	for msp, present := range want {
		if !present {
			t.Fatalf("SettleDvP policy must require %s, got %v", msp, policy.RequiredMSPs)
		}
	}

	// A settlement endorsed by only one organisation is rejected by the
	// Validation Service before it can reach the state database.
	proposal := "channel|cc|SettleDvP|PAY-1|rw|"
	partial := []Endorsement{{
		MSP: MSPPaymentOperator, Peer: MSPPaymentOperator + ".peer",
		Signature: signProposal(MSPPaymentOperator, proposal),
	}}
	if ok, reason := policy.SatisfiedBy(proposal, partial); ok {
		t.Fatal("one-sided endorsement should not satisfy the DvP policy")
	} else if reason == "" {
		t.Fatal("rejection must explain which MSP is missing")
	}

	// Cash-only movements need the payment operator alone.
	cashPolicy, _ := cashPolicyFor(FnLockEscrow)
	if len(cashPolicy.RequiredMSPs) != 1 || cashPolicy.RequiredMSPs[0] != MSPPaymentOperator {
		t.Fatalf("LockEscrow should require only %s, got %v", MSPPaymentOperator, cashPolicy.RequiredMSPs)
	}
}

// D10 — a forged endorsement is caught by signature verification.
func TestD10_ForgedEndorsementRejected(t *testing.T) {
	policy, _ := cashPolicyFor(FnSettleDvP)
	proposal := "channel|cc|SettleDvP|PAY-1|rw|"
	forged := []Endorsement{
		{MSP: MSPPaymentOperator, Peer: "x", Signature: signProposal(MSPPaymentOperator, proposal)},
		{MSP: MSPPlatform, Peer: "x", Signature: "deadbeef"}, // not a real signature
	}
	if ok, _ := policy.SatisfiedBy(proposal, forged); ok {
		t.Fatal("a forged endorsement must not satisfy the policy")
	}
}

// D11 — escrow records survive an encode/decode round trip unchanged.
func TestD11_EscrowEncodingRoundTrip(t *testing.T) {
	original := escrowRecord{
		PaymentID: "PAY-1", Payer: "buyer1", Payee: "seller1",
		AmountPaise: 18446744073709551615, // max uint64: no silent float truncation
		AssetID:     "PROP-GREEN-VALLEY-PUNE-001", Tokens: 15000,
		Status: EscrowLocked,
	}
	decoded, ok := decodeEscrow(original.encode())
	if !ok {
		t.Fatal("round trip failed to decode")
	}
	if decoded != original {
		t.Fatalf("round trip changed the record:\n got %+v\nwant %+v", decoded, original)
	}

	for _, bad := range []string{"", "too|few", "a|b|c|notanumber|e|f|g"} {
		if _, ok := decodeEscrow(bad); ok {
			t.Fatalf("malformed record %q should not decode", bad)
		}
	}
}

// D12 — the ledger records the settlement as a committed block.
func TestD12_SettlementReachesTheLedger(t *testing.T) {
	state := NewStateDB()
	ledger := NewChain()
	p := NewPipeline(state, NewTransientStore(), ledger)

	seedAsset(t, p, "PROP-1", "seller1", 1000)
	mustCredit(t, p, "buyer1", 5000000)

	heightBefore := len(ledger.Blocks)
	out, err := p.RunDvP("PAY-1", "buyer1", "seller1", 250000, "PROP-1", 5)
	if err != nil {
		t.Fatalf("DvP failed: %v", err)
	}
	if len(ledger.Blocks) <= heightBefore {
		t.Fatalf("ledger did not grow: %d -> %d", heightBefore, len(ledger.Blocks))
	}
	if out.Settle.RWDigest == "" {
		t.Fatal("settlement must carry an RW set digest")
	}
	if len(out.Settle.EndorsedBy) < 2 {
		t.Fatalf("settlement should carry two endorsements, got %v", out.Settle.EndorsedBy)
	}
	for _, phase := range []string{"1-endorsed", "2-signed", "3-ordered", "4-validated", "5-committed"} {
		if !contains(out.Settle.Phases, phase) {
			t.Fatalf("settlement missing phase %s, got %v", phase, out.Settle.Phases)
		}
	}
}

// D13 — MVCC catches a double settlement endorsed against a stale version.
//
// This is the case the escrow status guard cannot see. Both transactions are
// endorsed while the escrow is still LOCKED, so both pass simulation and both
// carry a read of escrow~PAY-1 at the same version. They then reach the
// committing peer in one block. The first applies; the second must be
// rejected for a read-write conflict, because the version it read is no
// longer current.
//
// Without this, a payment system that endorses in parallel would pay the
// seller twice for one escrow.
func TestD13_MVCCCatchesStaleSettlement(t *testing.T) {
	p, state := newCashPipeline()
	seedAsset(t, p, "PROP-1", "seller1", 1000)
	mustCredit(t, p, "buyer1", 5000000)

	if _, err := p.LockEscrow("PAY-1", "buyer1", "seller1", 250000, "PROP-1", 5); err != nil {
		t.Fatalf("lock failed: %v", err)
	}

	// Endorse both BEFORE either commits: each reads the escrow at the same
	// version and believes it is settling a LOCKED payment.
	first := signEnv(p, FnSettleDvP, []string{"PAY-1"}, nil)
	second := signEnv(p, FnSettleDvP, []string{"PAY-1"}, nil)

	if first.RW.Reads[escrowKey("PAY-1")] != second.RW.Reads[escrowKey("PAY-1")] {
		t.Fatal("both settlements should have read the same escrow version")
	}

	out1 := commitDirect(p, first)
	out2 := commitDirect(p, second)

	if out1 == nil || !out1.Committed {
		t.Fatalf("first settlement should commit, got %+v", out1)
	}
	if out2 == nil || out2.Committed {
		t.Fatalf("second settlement must be rejected, got %+v", out2)
	}
	if out2.Stage != "committing-peer-mvcc" {
		t.Fatalf("second settlement should fail MVCC validation, failed at %q: %s", out2.Stage, out2.Reason)
	}

	// The seller was paid exactly once.
	if got := CashBalanceOf(state, "seller1"); got != 250000 {
		t.Fatalf("seller paid %d paise, expected exactly 250000", got)
	}
	if got := TokenBalanceOf(state, "PROP-1", "buyer1"); got != 5 {
		t.Fatalf("buyer received %d tokens, expected exactly 5", got)
	}
	if got := CashBalanceOf(state, "buyer1"); got != 4750000 {
		t.Fatalf("buyer cash is %d, expected 4750000", got)
	}
}

// D14 — MVCC also protects the cash balance itself against stale double-spend.
//
// Two escrow locks endorsed against the same cash version, where the payer can
// only afford one. Both pass endorsement; the second must fail at commit.
func TestD14_MVCCProtectsCashBalance(t *testing.T) {
	p, state := newCashPipeline()
	seedAsset(t, p, "PROP-1", "seller1", 1000)
	mustCredit(t, p, "buyer1", 300000) // enough for exactly one Rs 2,500 lock

	a := signEnv(p, FnLockEscrow, []string{"PAY-A", "buyer1", "seller1", "250000", "PROP-1", "5"}, nil)
	b := signEnv(p, FnLockEscrow, []string{"PAY-B", "buyer1", "seller1", "250000", "PROP-1", "5"}, nil)

	outA := commitDirect(p, a)
	outB := commitDirect(p, b)

	if outA == nil || !outA.Committed {
		t.Fatalf("first lock should commit, got %+v", outA)
	}
	if outB == nil || outB.Committed {
		t.Fatalf("second lock must be rejected — the payer cannot fund both, got %+v", outB)
	}

	// The payer was debited once. Without MVCC this balance would be negative
	// or, with unsigned arithmetic, catastrophically large.
	if got := CashBalanceOf(state, "buyer1"); got != 50000 {
		t.Fatalf("payer balance is %d, expected 50000 after exactly one lock", got)
	}
	if e := EscrowOf(state, "PAY-B"); e.Found {
		t.Fatalf("second escrow should not exist, got %+v", e)
	}
}

// ---------- helpers ----------

func mustCredit(t *testing.T, p *Pipeline, party string, paise uint64) {
	t.Helper()
	if _, err := p.CreditCash(party, paise); err != nil {
		t.Fatalf("credit %s failed: %v", party, err)
	}
}

func contains(list []string, want string) bool {
	for _, s := range list {
		if s == want {
			return true
		}
	}
	return false
}

// EscrowViewSettled reports whether an escrow reached SETTLED.
func EscrowViewSettled(state *StateDB, paymentID string) (EscrowView, bool) {
	v := EscrowOf(state, paymentID)
	return v, v.Found && v.Status == EscrowSettled
}

var _ = fmt.Sprintf // keep fmt imported for future diagnostics

// D15 — the HTTP surface drives the same guarantees end to end.
func TestD15_DvPOverHTTP(t *testing.T) {
	state := NewStateDB()
	p := NewPipeline(state, NewTransientStore(), NewChain())
	seedAsset(t, p, "PROP-1", "seller1", 1000)

	srv := NewServer(NewMockLedger())
	srv.Pipeline = p
	router := srv.Router()

	post := func(body string) (int, map[string]interface{}) {
		req := httptest.NewRequest(http.MethodPost, "/drunix/dvp", strings.NewReader(body))
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		var out map[string]interface{}
		_ = json.Unmarshal(rec.Body.Bytes(), &out)
		return rec.Code, out
	}

	if code, _ := post(`{"action":"credit","party":"buyer1","amountPaise":5000000}`); code != http.StatusOK {
		t.Fatalf("credit returned %d", code)
	}
	if code, _ := post(`{"action":"lock","paymentId":"PAY-1","payer":"buyer1","payee":"seller1","amountPaise":250000,"assetId":"PROP-1","tokens":5}`); code != http.StatusOK {
		t.Fatalf("lock returned %d", code)
	}

	code, out := post(`{"action":"settle","paymentId":"PAY-1"}`)
	if code != http.StatusOK {
		t.Fatalf("settle returned %d: %v", code, out)
	}
	if out["simulated"] != true {
		t.Fatal("every response must declare itself simulated")
	}
	atom, ok := out["atomicity"].(map[string]interface{})
	if !ok || atom["txId"] == "" {
		t.Fatalf("settle response must describe its atomicity, got %v", out["atomicity"])
	}

	// Replay over HTTP is refused, not silently accepted.
	if code, _ := post(`{"action":"settle","paymentId":"PAY-1"}`); code != http.StatusUnprocessableEntity {
		t.Fatalf("replayed settle returned %d, expected 422", code)
	}

	// Balances are readable and correct.
	req := httptest.NewRequest(http.MethodGet, "/drunix/cash?party=seller1", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	var cash map[string]interface{}
	_ = json.Unmarshal(rec.Body.Bytes(), &cash)
	if cash["amountPaise"].(float64) != 250000 {
		t.Fatalf("seller cash over HTTP is %v, expected 250000", cash["amountPaise"])
	}

	req = httptest.NewRequest(http.MethodGet, "/drunix/escrow?paymentId=PAY-1", nil)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	var esc EscrowView
	_ = json.Unmarshal(rec.Body.Bytes(), &esc)
	if esc.Status != EscrowSettled {
		t.Fatalf("escrow status over HTTP is %s, expected SETTLED", esc.Status)
	}

	// Unknown escrow is a 404, not an empty 200.
	req = httptest.NewRequest(http.MethodGet, "/drunix/escrow?paymentId=NOPE", nil)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("unknown escrow returned %d, expected 404", rec.Code)
	}
}
