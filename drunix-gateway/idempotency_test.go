package drunix

// These tests exist to prove the one property the feature is for: a retried
// settlement must not move money twice. They assert on wallet balances and
// chain height, not just on HTTP status codes, because a handler can return
// the right status while still having settled again underneath.

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
)

func idemTestServer(t *testing.T) *Server {
	t.Helper()
	sec := NewMemorySecurities()
	srv := &Server{Ledger: NewMockLedger(), UMI: NewUMIRail(sec, NewChain()), Idem: NewIdemStore()}
	if _, err := srv.UMI.SeedPosition("PROP-X", "seller1", 1000); err != nil {
		t.Fatalf("seed position: %v", err)
	}
	if _, _, err := srv.UMI.FundWallet("buyer1", 500000); err != nil {
		t.Fatalf("fund buyer: %v", err)
	}
	if _, err := srv.UMI.OpenWallet("seller1"); err != nil {
		t.Fatalf("open seller wallet: %v", err)
	}
	return srv
}

func dvpPost(t *testing.T, srv *Server, key string, payload map[string]interface{}) *httptest.ResponseRecorder {
	t.Helper()
	b, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	req := httptest.NewRequest(http.MethodPost, "/umi/dvp", bytes.NewReader(b))
	if key != "" {
		req.Header.Set("Idempotency-Key", key)
	}
	rec := httptest.NewRecorder()
	srv.handleUMIDvP(rec, req)
	return rec
}

// chainHeight is blocks-minus-genesis: the number of committed settlements.
func chainHeight(srv *Server) int {
	n := len(srv.UMI.chain.Snapshot())
	if n == 0 {
		return 0
	}
	return n - 1
}

func walletBalance(t *testing.T, srv *Server, participant string) int64 {
	t.Helper()
	for _, w := range srv.UMI.Wallets() {
		if w.Participant == participant {
			return w.BalancePaise
		}
	}
	t.Fatalf("wallet %s not found", participant)
	return 0
}

var dvpBody = map[string]interface{}{
	"assetId": "PROP-X", "seller": "seller1", "buyer": "buyer1",
	"tokens": 10, "pricePerTokenINR": 500,
}

// The central guarantee: same key, same body, twice => one settlement.
func TestIdempotentRetryDoesNotSettleTwice(t *testing.T) {
	srv := idemTestServer(t)
	before := walletBalance(t, srv, "buyer1")
	heightBefore := chainHeight(srv)

	r1 := dvpPost(t, srv, "key-abc", dvpBody)
	if r1.Code != http.StatusOK {
		t.Fatalf("first settlement failed: %d %s", r1.Code, r1.Body.String())
	}
	afterFirst := walletBalance(t, srv, "buyer1")
	spent := before - afterFirst
	if spent <= 0 {
		t.Fatalf("expected buyer to be debited, balance went %d -> %d", before, afterFirst)
	}

	r2 := dvpPost(t, srv, "key-abc", dvpBody)
	if r2.Code != http.StatusOK {
		t.Fatalf("replay should return the original status, got %d", r2.Code)
	}
	if got := walletBalance(t, srv, "buyer1"); got != afterFirst {
		t.Fatalf("RETRY MOVED MONEY AGAIN: balance %d -> %d (expected unchanged)", afterFirst, got)
	}
	if h := chainHeight(srv); h != heightBefore+1 {
		t.Fatalf("retry committed extra blocks: height %d -> %d, expected +1 total", heightBefore, h)
	}
	if r2.Header().Get("Idempotent-Replay") != "true" {
		t.Errorf("replay not flagged in the response header")
	}

	var m map[string]interface{}
	if err := json.Unmarshal(r2.Body.Bytes(), &m); err != nil {
		t.Fatalf("replay body not JSON: %v", err)
	}
	if m["idempotentReplay"] != true {
		t.Errorf("replay body missing idempotentReplay flag: %v", m)
	}
	// The replayed instruction must be the SAME instruction, not a new one.
	var first map[string]interface{}
	_ = json.Unmarshal(r1.Body.Bytes(), &first)
	id1 := first["instruction"].(map[string]interface{})["instructionId"]
	id2 := m["instruction"].(map[string]interface{})["instructionId"]
	if id1 != id2 {
		t.Fatalf("replay returned a different instruction: %v vs %v", id1, id2)
	}
}

// Without a key the old behaviour must be preserved exactly: two settlements.
func TestNoKeyStillSettlesTwice(t *testing.T) {
	srv := idemTestServer(t)
	base := chainHeight(srv)
	r1 := dvpPost(t, srv, "", dvpBody)
	r2 := dvpPost(t, srv, "", dvpBody)
	if r1.Code != http.StatusOK || r2.Code != http.StatusOK {
		t.Fatalf("expected both to settle, got %d and %d", r1.Code, r2.Code)
	}
	if h := chainHeight(srv) - base; h != 2 {
		t.Fatalf("expected 2 settlements without a key, got %d", h)
	}
}

// Reusing a key for a different payload is a client bug and must be refused,
// not silently settled.
func TestKeyReuseWithDifferentBodyIsRejected(t *testing.T) {
	srv := idemTestServer(t)
	if r := dvpPost(t, srv, "key-xyz", dvpBody); r.Code != http.StatusOK {
		t.Fatalf("setup settlement failed: %d", r.Code)
	}
	balance := walletBalance(t, srv, "buyer1")

	other := map[string]interface{}{
		"assetId": "PROP-X", "seller": "seller1", "buyer": "buyer1",
		"tokens": 99, "pricePerTokenINR": 500, // different amount
	}
	r := dvpPost(t, srv, "key-xyz", other)
	if r.Code != http.StatusUnprocessableEntity {
		t.Fatalf("expected 422 for key reuse, got %d %s", r.Code, r.Body.String())
	}
	if got := walletBalance(t, srv, "buyer1"); got != balance {
		t.Fatalf("rejected request still moved money: %d -> %d", balance, got)
	}
}

// A failed settlement is a recorded outcome: retrying must replay the failure
// rather than get a second attempt.
func TestFailedSettlementIsAlsoIdempotent(t *testing.T) {
	srv := idemTestServer(t)
	tooMuch := map[string]interface{}{
		"assetId": "PROP-X", "seller": "seller1", "buyer": "buyer1",
		"tokens": 10, "pricePerTokenINR": 999999, // more cash than the buyer has
	}
	r1 := dvpPost(t, srv, "key-fail", tooMuch)
	if r1.Code != http.StatusBadRequest {
		t.Fatalf("expected the settlement to fail, got %d %s", r1.Code, r1.Body.String())
	}
	balance := walletBalance(t, srv, "buyer1")

	r2 := dvpPost(t, srv, "key-fail", tooMuch)
	if r2.Code != http.StatusBadRequest {
		t.Fatalf("expected the failure to replay, got %d", r2.Code)
	}
	if r2.Header().Get("Idempotent-Replay") != "true" {
		t.Errorf("replayed failure not flagged")
	}
	if got := walletBalance(t, srv, "buyer1"); got != balance {
		t.Fatalf("replayed failure moved money: %d -> %d", balance, got)
	}
}

// Concurrent duplicates: exactly one settles, and the losers are told so.
// This is the real-world shape of the bug — a user double-clicking, or a
// proxy retrying before the first response lands.
func TestConcurrentDuplicatesSettleOnce(t *testing.T) {
	srv := idemTestServer(t)
	before := walletBalance(t, srv, "buyer1")

	base := chainHeight(srv)
	const n = 8
	var wg sync.WaitGroup
	codes := make([]int, n)
	replay := make([]bool, n)
	wg.Add(n)
	for i := 0; i < n; i++ {
		go func(i int) {
			defer wg.Done()
			r := dvpPost(t, srv, "key-race", dvpBody)
			codes[i] = r.Code
			replay[i] = r.Header().Get("Idempotent-Replay") == "true"
		}(i)
	}
	wg.Wait()

	// A replay also answers 200, so the count that matters is how many
	// responses were a FRESH settlement rather than a recording of one.
	fresh := 0
	for i, c := range codes {
		switch {
		case c == http.StatusOK && !replay[i]:
			fresh++
		case c == http.StatusOK, c == http.StatusConflict:
			// replayed, or correctly rejected as still in flight
		default:
			t.Errorf("unexpected status in race: %d", c)
		}
	}
	if fresh != 1 {
		t.Fatalf("expected exactly 1 fresh settlement out of %d duplicates, got %d (codes %v, replay %v)", n, fresh, codes, replay)
	}

	// The real assertion: the money moved exactly once.
	unit := int64(10 * 500 * 100) // tokens * price * paise
	if got := before - walletBalance(t, srv, "buyer1"); got != unit {
		t.Fatalf("expected exactly one debit of %d paise, got %d", unit, got)
	}
	if h := chainHeight(srv) - base; h != 1 {
		t.Fatalf("expected exactly 1 block from the race, got %d", h)
	}
}

// An oversized key is rejected before anything is executed.
func TestOversizedKeyRejected(t *testing.T) {
	srv := idemTestServer(t)
	long := make([]byte, idemMaxKeyLen+1)
	for i := range long {
		long[i] = 'k'
	}
	base := chainHeight(srv)
	r := dvpPost(t, srv, string(long), dvpBody)
	if r.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for an oversized key, got %d", r.Code)
	}
	if h := chainHeight(srv) - base; h != 0 {
		t.Fatalf("rejected request still settled: %d extra blocks", h)
	}
}

func TestFingerprintStability(t *testing.T) {
	a := Fingerprint([]byte(`{"a":1}`))
	if a != Fingerprint([]byte(`{"a":1}`)) {
		t.Error("fingerprint is not stable for identical bytes")
	}
	if a == Fingerprint([]byte(`{"a":2}`)) {
		t.Error("different bodies produced the same fingerprint")
	}
}
