package fabric

import (
	"strings"
	"sync"
	"testing"
)

// The mock client is what this gateway runs against unless a Fabric network
// is configured, which means it is the thing that enforces every rule a
// reviewer will see. It had no tests. These cover the lifecycle in order and,
// for each step, one thing it must refuse.

func newSeeded(t *testing.T) (*MockFabricClient, string) {
	t.Helper()
	c := NewMockFabricClient()
	props, err := c.ListProperties("")
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(props) == 0 {
		t.Fatal("the mock should seed one property so a cold demo has something to show")
	}
	return c, props[0].AssetID
}

func TestTheLifecycleRunsInOrderAndRefusesOutOfOrder(t *testing.T) {
	c := NewMockFabricClient()

	id, err := c.RegisterProperty("originator1", "Test House", "Maharashtra", "Pune", "411045", 5000000,
		"hash-lifecycle-1")
	if err != nil {
		t.Fatalf("register: %v", err)
	}

	// Minting before a registrar has validated is the refusal that matters:
	// it is the difference between a token backed by a checked title and a
	// token backed by a form somebody filled in.
	if err := c.MintPropertyTokens(id, 1000, "originator1"); err == nil {
		t.Fatal("minting an unvalidated property must be refused")
	} else if !strings.Contains(err.Error(), "ERR_NOT_VALIDATED") {
		t.Fatalf("the refusal should name the reason, got %v", err)
	}

	if err := c.ValidateProperty(id, "VALIDATED"); err != nil {
		t.Fatalf("validate: %v", err)
	}
	if err := c.MintPropertyTokens(id, 1000, "originator1"); err != nil {
		t.Fatalf("mint: %v", err)
	}

	// Supply is set once. A second mint is the double-issue this whole
	// gateway's idempotency store exists to prevent.
	if err := c.MintPropertyTokens(id, 1000, "originator1"); err == nil {
		t.Fatal("a second mint must be refused")
	}

	// Validating something already past DRAFT is also refused.
	if err := c.ValidateProperty(id, "VALIDATED"); err == nil {
		t.Fatal("re-validating a tokenised asset must be refused")
	}

	bal, err := c.GetBalance(id, "originator1")
	if err != nil {
		t.Fatalf("balance: %v", err)
	}
	if bal.Balance != 1000 {
		t.Fatalf("the whole supply should sit with the originator, got %d", bal.Balance)
	}
}

func TestTransferRefusesEveryWayItShould(t *testing.T) {
	c, id := newSeeded(t)

	cases := []struct {
		name            string
		from, to        string
		amount          int64
		wantErrContains string
	}{
		{"zero tokens", "originator1", "investor1", 0, "ERR_INVALID_AMOUNT"},
		{"a negative amount", "originator1", "investor1", -5, "ERR_INVALID_AMOUNT"},
		{"sending to yourself", "originator1", "originator1", 10, "ERR_INVALID_TRANSFER"},
		{"more than the balance", "investor2", "investor1", 999999, "ERR_INSUFFICIENT_BALANCE"},
		{"an owner with no position", "nobody1", "investor1", 1, "ERR_"},
	}
	for _, tc := range cases {
		_, err := c.TransferTokens(id, tc.from, tc.to, tc.amount)
		if err == nil {
			t.Fatalf("%s: expected a refusal", tc.name)
		}
		if !strings.Contains(err.Error(), tc.wantErrContains) {
			t.Fatalf("%s: expected %s, got %v", tc.name, tc.wantErrContains, err)
		}
	}

	// An unknown asset is refused too, before anything looks at balances.
	if _, err := c.TransferTokens("PROP-does-not-exist", "originator1", "investor1", 1); err == nil {
		t.Fatal("transferring an unknown asset must be refused")
	}
}

func TestAGoodTransferConservesTheTokens(t *testing.T) {
	c, id := newSeeded(t)

	before1, _ := c.GetBalance(id, "originator1")
	before2, _ := c.GetBalance(id, "investor1")
	total := before1.Balance + before2.Balance

	txID, err := c.TransferTokens(id, "originator1", "investor1", 500)
	if err != nil {
		t.Fatalf("transfer: %v", err)
	}
	if txID == "" {
		t.Fatal("a completed transfer must come back with a reference")
	}

	after1, _ := c.GetBalance(id, "originator1")
	after2, _ := c.GetBalance(id, "investor1")
	if after1.Balance != before1.Balance-500 || after2.Balance != before2.Balance+500 {
		t.Fatalf("the two legs disagree: %d -> %d and %d -> %d",
			before1.Balance, after1.Balance, before2.Balance, after2.Balance)
	}
	if after1.Balance+after2.Balance != total {
		t.Fatal("tokens were created or destroyed by a transfer")
	}
}

// KYC is a precondition on both sides, not just the sender. A rail that
// checks only the payer lets an unverified person receive.
func TestTransferChecksKYCOnBothSides(t *testing.T) {
	c, id := newSeeded(t)

	if _, err := c.TransferTokens(id, "originator1", "stranger-with-no-kyc", 1); err == nil {
		t.Fatal("sending to an identity with no KYC record must be refused")
	} else if !strings.Contains(err.Error(), "ERR_KYC_NOT_VERIFIED") {
		t.Fatalf("the refusal should name KYC, got %v", err)
	}

	if err := c.UpdateKYC("investor1", "REJECTED"); err != nil {
		t.Fatalf("update kyc: %v", err)
	}
	if _, err := c.TransferTokens(id, "investor1", "investor2", 1); err == nil {
		t.Fatal("a sender whose KYC was withdrawn must be refused")
	}
}

func TestAFrozenAssetStopsMoving(t *testing.T) {
	c, id := newSeeded(t)

	if err := c.FreezeAsset(id); err != nil {
		t.Fatalf("freeze: %v", err)
	}
	if _, err := c.TransferTokens(id, "originator1", "investor1", 1); err == nil {
		t.Fatal("a frozen asset must not transfer")
	} else if !strings.Contains(err.Error(), "ERR_ASSET_FROZEN") {
		t.Fatalf("the refusal should say the asset is frozen, got %v", err)
	}

	// Reading is still allowed: freezing stops movement, not sight.
	if _, err := c.GetProperty(id); err != nil {
		t.Fatalf("a frozen asset must still be readable: %v", err)
	}
	if err := c.FreezeAsset("PROP-nope"); err == nil {
		t.Fatal("freezing an unknown asset must be refused")
	}
}

func TestPaginationWalksTheHistoryWithoutRepeatingItself(t *testing.T) {
	c, id := newSeeded(t)

	page1, err := c.GetTransferHistoryPaginated(id, "", 10, "")
	if err != nil {
		t.Fatalf("page 1: %v", err)
	}
	if len(page1.Transfers) != 10 {
		t.Fatalf("expected a full first page, got %d", len(page1.Transfers))
	}
	if page1.Bookmark == "" {
		t.Fatal("a page that is not the last must hand back a bookmark")
	}

	seen := map[string]bool{}
	for _, tr := range page1.Transfers {
		seen[tr.TransferID] = true
	}

	page2, err := c.GetTransferHistoryPaginated(id, "", 10, page1.Bookmark)
	if err != nil {
		t.Fatalf("page 2: %v", err)
	}
	for _, tr := range page2.Transfers {
		if seen[tr.TransferID] {
			t.Fatalf("transfer %s appeared on two pages", tr.TransferID)
		}
		seen[tr.TransferID] = true
	}
	if len(seen) != len(page1.Transfers)+len(page2.Transfers) {
		t.Fatal("the two pages overlap")
	}
}

func TestUnknownThingsAreNotFoundRatherThanEmpty(t *testing.T) {
	c, _ := newSeeded(t)

	if _, err := c.GetProperty("PROP-nope"); err == nil {
		t.Fatal("an unknown property must be an error, not an empty asset")
	}
	// A balance is deliberately different: holding none of something is a
	// real answer, so this returns zero rather than an error. Pinned here
	// because the two conventions sitting side by side look like a bug
	// until you see the reason.
	zero, err := c.GetBalance("PROP-nope", "investor1")
	if err != nil {
		t.Fatalf("an unheld position is zero, not an error: %v", err)
	}
	if zero.Balance != 0 || zero.OwnerID != "investor1" {
		t.Fatalf("expected an explicit zero for the asked-for owner, got %+v", zero)
	}
	w, err := c.GetWallet("nobody-at-all")
	if err != nil {
		t.Fatalf("an empty wallet is not an error: %v", err)
	}
	if len(w) != 0 {
		t.Fatalf("a stranger should hold nothing, got %d positions", len(w))
	}
}

// The gateway serves concurrent requests against one client.
func TestConcurrentTransfersDoNotRace(t *testing.T) {
	c, id := newSeeded(t)
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, _ = c.TransferTokens(id, "originator1", "investor1", 1)
			_, _ = c.GetBalance(id, "originator1")
		}()
	}
	wg.Wait()

	after, err := c.GetBalance(id, "originator1")
	if err != nil {
		t.Fatalf("balance: %v", err)
	}
	if after.Balance != 12000-20 {
		t.Fatalf("twenty single-token transfers should leave 11980, got %d", after.Balance)
	}
}
