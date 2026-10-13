package drunix

import (
	"strings"
	"testing"
	"time"
)

func interopRail(t testing.TB, tokens int64) *UMIRail {
	t.Helper()
	r := NewUMIRail(NewMemorySecurities(), NewChain())
	if _, err := r.SeedPosition("PROP-XCHAIN", "originator1", tokens, tokens); err != nil {
		t.Fatalf("seed: %v", err)
	}
	if _, _, err := r.AssignISIN("PROP-XCHAIN", "originator1", ""); err != nil {
		t.Fatalf("isin: %v", err)
	}
	_, _, _ = r.FundWallet("investor1", 100000000)
	return r
}

// The point of a lock is that the asset cannot be sold here while it is
// represented elsewhere. Asserting the status field says LOCKED would not
// test that, so this tries to actually settle the locked tokens.
func TestLockedTokensCannotBeSettledHere(t *testing.T) {
	r := interopRail(t, 100)
	g := r.Interop()

	if _, err := g.Lock(LockRequest{
		AssetID: "PROP-XCHAIN", Holder: "originator1", Tokens: 100, RemoteLedger: "evm",
		RemoteAccount: "0xabc", ExpiresInSec: 600,
	}); err != nil {
		t.Fatalf("lock: %v", err)
	}
	if pos := r.PositionOf("PROP-XCHAIN", "originator1"); pos != 0 {
		t.Fatalf("the holder must not still hold locked tokens, got %d", pos)
	}
	if pos := r.PositionOf("PROP-XCHAIN", InteropCustody); pos != 100 {
		t.Fatalf("custody must hold the locked tokens, got %d", pos)
	}
	_, err := r.SettleDvP(DvPRequest{
		AssetID: "PROP-XCHAIN", Seller: "originator1", Buyer: "investor1",
		Tokens: 1, PricePerTokenINR: 1,
	})
	if err == nil {
		t.Fatal("a locked position must not be settleable on this ledger")
	}
}

// Abort is the failure path and has to put every token back.
func TestAbortReturnsEverything(t *testing.T) {
	r := interopRail(t, 100)
	g := r.Interop()
	tr, err := g.Lock(LockRequest{
		AssetID: "PROP-XCHAIN", Holder: "originator1", Tokens: 40, RemoteLedger: "evm", ExpiresInSec: 600,
	})
	if err != nil {
		t.Fatalf("lock: %v", err)
	}
	if _, err := g.Abort(tr.TransferID, "originator1", false, "changed my mind"); err != nil {
		t.Fatalf("abort: %v", err)
	}
	if pos := r.PositionOf("PROP-XCHAIN", "originator1"); pos != 100 {
		t.Fatalf("the holder must get every token back, got %d", pos)
	}
	if pos := r.PositionOf("PROP-XCHAIN", InteropCustody); pos != 0 {
		t.Fatalf("custody must be empty after an abort, got %d", pos)
	}
	// And the settlement path works again.
	if _, err := r.SettleDvP(DvPRequest{
		AssetID: "PROP-XCHAIN", Seller: "originator1", Buyer: "investor1",
		Tokens: 1, PricePerTokenINR: 1,
	}); err != nil {
		t.Fatalf("after an abort the position must be spendable again: %v", err)
	}
}

// Closing twice is the classic bridge bug: abort after commit would hand the
// holder their tokens back while the remote ledger still represents them.
func TestATransferClosesOnlyOnce(t *testing.T) {
	r := interopRail(t, 100)
	g := r.Interop()
	tr, _ := g.Lock(LockRequest{
		AssetID: "PROP-XCHAIN", Holder: "originator1", Tokens: 60, RemoteLedger: "evm", ExpiresInSec: 600,
	})
	if _, err := g.Commit(tr.TransferID, CommitRequest{RemoteTxRef: "0xdeadbeef"}, "regulator1"); err != nil {
		t.Fatalf("commit: %v", err)
	}
	if _, err := g.Abort(tr.TransferID, "regulator1", true, "double close"); err == nil {
		t.Fatal("aborting a committed transfer must be refused: the tokens are represented elsewhere")
	}
	if _, err := g.Commit(tr.TransferID, CommitRequest{RemoteTxRef: "0xdeadbeef"}, "regulator1"); err == nil {
		t.Fatal("committing twice must be refused")
	}
	if pos := r.PositionOf("PROP-XCHAIN", "originator1"); pos != 40 {
		t.Fatalf("committed tokens must stay in custody, holder has %d", pos)
	}
	if pos := r.PositionOf("PROP-XCHAIN", InteropCustody); pos != 60 {
		t.Fatalf("custody must still hold the represented tokens, got %d", pos)
	}
}

// An attestation is not an observation, and the record has to say which it
// is. This is the honesty property of the whole subsystem.
func TestCommitWithoutAConnectorIsAttestedNotVerified(t *testing.T) {
	r := interopRail(t, 10)
	g := r.Interop()
	tr, _ := g.Lock(LockRequest{
		AssetID: "PROP-XCHAIN", Holder: "originator1", Tokens: 10, RemoteLedger: "evm", ExpiresInSec: 600,
	})
	out, err := g.Commit(tr.TransferID, CommitRequest{RemoteTxRef: "0xfeed"}, "regulator1")
	if err != nil {
		t.Fatalf("commit: %v", err)
	}
	if out.Verified {
		t.Fatal("with no configured connector nothing was observed, so verified must be false")
	}
	if !strings.Contains(strings.ToLower(out.Evidence), "attested") {
		t.Fatalf("the record must say it is an attestation, got %q", out.Evidence)
	}
	stats := g.Stats()
	if stats["committedAttestedOnly"].(int64) != 1 || stats["committedVerified"].(int64) != 0 {
		t.Fatalf("attested and verified must be counted separately: %v", stats)
	}
	// A commit with no counterpart reference at all is just a deletion.
	tr2, _ := g.Lock(LockRequest{AssetID: "PROP-XCHAIN", Holder: InteropCustody, Tokens: 1, RemoteLedger: "evm"})
	if tr2 != nil {
		if _, err := g.Commit(tr2.TransferID, CommitRequest{}, "regulator1"); err == nil {
			t.Fatal("a commit with no remote reference must be refused")
		}
	}
}

// Before expiry a stranger must not be able to release someone's lock.
// After it, anyone may, because a stuck lock strands the asset.
func TestWhoCanAbortDependsOnExpiry(t *testing.T) {
	r := interopRail(t, 100)
	g := r.Interop()
	tr, _ := g.Lock(LockRequest{
		AssetID: "PROP-XCHAIN", Holder: "originator1", Tokens: 10, RemoteLedger: "evm", ExpiresInSec: 600,
	})
	if _, err := g.Abort(tr.TransferID, "investor2", false, "not mine"); err == nil {
		t.Fatal("a stranger must not release a live lock")
	}

	// Expire it by hand rather than sleeping.
	g.mu.Lock()
	g.transfers[tr.TransferID].ExpiresAt = time.Now().UTC().Add(-time.Minute).Format(time.RFC3339Nano)
	g.mu.Unlock()

	out, err := g.Abort(tr.TransferID, "investor2", false, "")
	if err != nil {
		t.Fatalf("after expiry anyone may release the lock: %v", err)
	}
	if !strings.Contains(out.AbortReason, "expired") {
		t.Fatalf("the reason must record that it expired, got %q", out.AbortReason)
	}
	if pos := r.PositionOf("PROP-XCHAIN", "originator1"); pos != 100 {
		t.Fatalf("an expiry release returns the tokens to the holder, got %d", pos)
	}
}

// Locking more than you hold has to fail at the ledger, and must not leave a
// transfer record behind claiming otherwise.
func TestCannotLockWhatYouDoNotHold(t *testing.T) {
	r := interopRail(t, 10)
	g := r.Interop()
	if _, err := g.Lock(LockRequest{
		AssetID: "PROP-XCHAIN", Holder: "originator1", Tokens: 11, RemoteLedger: "evm",
	}); err == nil {
		t.Fatal("locking more than the holder owns must fail")
	}
	if n := len(g.Transfers(10)); n != 0 {
		t.Fatalf("a failed lock must not create a transfer, got %d", n)
	}
	if _, err := g.Lock(LockRequest{
		AssetID: "PROP-XCHAIN", Holder: "originator1", Tokens: 5, RemoteLedger: "solana",
	}); err == nil {
		t.Fatal("a ledger with no connector must be refused by name")
	}
	if _, err := g.Lock(LockRequest{
		AssetID: "PROP-XCHAIN", Holder: "originator1", Tokens: 5, RemoteLedger: "drunix",
	}); err == nil {
		t.Fatal("a transfer to this same ledger is an ordinary settlement and must be refused")
	}
}

// The connector list must not flatter itself: an unconfigured connector has
// to say so, because that is what a reader uses to decide what is live.
func TestConnectorsReportConfigurationHonestly(t *testing.T) {
	g := interopRail(t, 1).Interop()
	conns := g.Connectors()
	if len(conns) < 2 {
		t.Fatalf("want at least the local and the EVM connector, got %d", len(conns))
	}
	var sawEVM bool
	for _, c := range conns {
		if c["ledger"] == "evm" {
			sawEVM = true
			// No EVM_RPC_URL in the test environment.
			if c["configured"].(bool) {
				t.Fatal("the EVM connector must not report configured with no RPC URL set")
			}
			if !strings.Contains(c["status"].(string), "Not configured") {
				t.Fatalf("the status line must say so plainly, got %q", c["status"])
			}
		}
		if c["ledger"] == "drunix" && !c["configured"].(bool) {
			t.Fatal("the local connector is this process and must report configured")
		}
	}
	if !sawEVM {
		t.Fatal("the EVM connector must be listed even when it is not configured")
	}
}

// A restart must not forget what a custody balance means.
func TestRestoreRebuildsTheTransferBook(t *testing.T) {
	r := interopRail(t, 100)
	g := r.Interop()
	locked, _ := g.Lock(LockRequest{
		AssetID: "PROP-XCHAIN", Holder: "originator1", Tokens: 25, RemoteLedger: "evm", ExpiresInSec: 600,
	})
	committed, _ := g.Lock(LockRequest{
		AssetID: "PROP-XCHAIN", Holder: "originator1", Tokens: 15, RemoteLedger: "evm", ExpiresInSec: 600,
	})
	if _, err := g.Commit(committed.TransferID, CommitRequest{RemoteTxRef: "0x1"}, "regulator1"); err != nil {
		t.Fatalf("commit: %v", err)
	}
	aborted, _ := g.Lock(LockRequest{
		AssetID: "PROP-XCHAIN", Holder: "originator1", Tokens: 5, RemoteLedger: "evm", ExpiresInSec: 600,
	})
	if _, err := g.Abort(aborted.TransferID, "originator1", false, "no counterpart"); err != nil {
		t.Fatalf("abort: %v", err)
	}

	fresh := newInteropGateway(r, r.chain)
	if n := fresh.restoreInteropFromChain(r.chain); n != 3 {
		t.Fatalf("want 3 transfers replayed, got %d", n)
	}
	for id, want := range map[string]string{
		locked.TransferID:    InteropLocked,
		committed.TransferID: InteropCommitted,
		aborted.TransferID:   InteropAborted,
	} {
		got, err := fresh.Transfer(id)
		if err != nil {
			t.Fatalf("%s missing after restore: %v", id, err)
		}
		if got.Status != want {
			t.Fatalf("%s restored as %s, want %s", id, got.Status, want)
		}
	}
	stats := fresh.Stats()
	if stats["tokensLockedPending"].(int64) != 25 {
		t.Fatalf("pending lock total wrong after restore: %v", stats)
	}
	if stats["tokensRepresentedRemotely"].(int64) != 15 {
		t.Fatalf("represented total wrong after restore: %v", stats)
	}
	// The next id must not collide with a restored one.
	next, err := fresh.Lock(LockRequest{
		AssetID: "PROP-XCHAIN", Holder: "originator1", Tokens: 1, RemoteLedger: "evm",
	})
	if err != nil {
		t.Fatalf("lock after restore: %v", err)
	}
	if next.TransferID == locked.TransferID || next.TransferID == committed.TransferID {
		t.Fatalf("a restarted gateway reused the id %s", next.TransferID)
	}
}
