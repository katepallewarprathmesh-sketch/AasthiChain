package drunix

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"testing"
)

// The encodings have to be exactly right or a transaction is rejected by the
// cluster with no useful error, so they are tested against known values
// rather than against themselves.
func TestBase58KnownVectors(t *testing.T) {
	cases := map[string]string{
		"":            "",
		"Hello World": "JxF12TrwUP45BMd",
	}
	for in, want := range cases {
		if got := Base58Encode([]byte(in)); got != want {
			t.Fatalf("Base58Encode(%q) = %q, want %q", in, got, want)
		}
	}
	// The memo program id is a real 32-byte account, so it must survive a
	// round trip at exactly 32 bytes.
	raw, err := Base58Decode(solanaMemoProgram)
	if err != nil {
		t.Fatalf("decode memo program: %v", err)
	}
	if len(raw) != 32 {
		t.Fatalf("memo program decoded to %d bytes, want 32", len(raw))
	}
	if Base58Encode(raw) != solanaMemoProgram {
		t.Fatal("memo program did not survive a base58 round trip")
	}
	if _, err := Base58Decode("not valid 0OIl"); err == nil {
		t.Fatal("characters outside the alphabet must be refused, not guessed")
	}
}

func TestShortvec(t *testing.T) {
	cases := []struct {
		in   int
		want []byte
	}{
		{0, []byte{0}},
		{1, []byte{1}},
		{127, []byte{0x7f}},
		{128, []byte{0x80, 0x01}},
		{16384, []byte{0x80, 0x80, 0x01}},
	}
	for _, c := range cases {
		got := shortvec(c.in)
		if string(got) != string(c.want) {
			t.Fatalf("shortvec(%d) = %v, want %v", c.in, got, c.want)
		}
	}
}

// The message layout is the part a cluster silently rejects when it is wrong.
func TestBuildMemoMessageLayout(t *testing.T) {
	payer := make(ed25519.PublicKey, 32)
	payer[0] = 7
	program, _ := Base58Decode(solanaMemoProgram)
	blockhash := make([]byte, 32)
	blockhash[31] = 9
	memo := []byte("aasthi|v1|x|1|hash|root")

	msg, err := BuildMemoMessage(payer, program, blockhash, memo)
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	if got := msg[:3]; got[0] != 1 || got[1] != 0 || got[2] != 1 {
		t.Fatalf("header = %v, want one signer and one readonly unsigned account", got)
	}
	if msg[3] != 2 {
		t.Fatalf("account count = %d, want 2", msg[3])
	}
	if string(msg[4:36]) != string(payer) {
		t.Fatal("the payer must be the first account")
	}
	if string(msg[36:68]) != string(program) {
		t.Fatal("the memo program must be the second account")
	}
	if string(msg[68:100]) != string(blockhash) {
		t.Fatal("the recent blockhash must follow the accounts")
	}
	if !strings.HasSuffix(string(msg), string(memo)) {
		t.Fatal("the memo must be the instruction data")
	}

	if _, err := BuildMemoMessage(payer[:16], program, blockhash, memo); err == nil {
		t.Fatal("a short key must be refused rather than serialised")
	}
}

func TestSignTransactionEnvelope(t *testing.T) {
	pub, priv, _ := ed25519.GenerateKey(nil)
	program, _ := Base58Decode(solanaMemoProgram)
	msg, _ := BuildMemoMessage(pub, program, make([]byte, 32), []byte("anchor"))

	encoded, signature := SignTransaction(priv, msg)
	raw, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		t.Fatalf("the wire form must be base64: %v", err)
	}
	if raw[0] != 1 {
		t.Fatalf("signature count = %d, want 1", raw[0])
	}
	if !ed25519.Verify(pub, msg, raw[1:65]) {
		t.Fatal("the signature in the envelope does not verify against the message")
	}
	if decoded, _ := Base58Decode(signature); len(decoded) != 64 {
		t.Fatalf("the returned signature should be 64 bytes, got %d", len(decoded))
	}
}

// The memo is the entire payload, so it must carry what a verifier needs and
// nothing a verifier should not see.
func TestMemoCarriesTheDigestAndNothingElse(t *testing.T) {
	chain := NewChain()
	blk := chain.Append("TEST", []map[string]interface{}{{"secret": "investor1 bought 100 tokens"}})
	memo := MemoFor(DrunixChainID, blk)

	parts := strings.Split(memo, "|")
	if len(parts) != 6 || parts[0] != "aasthi" || parts[1] != "v1" {
		t.Fatalf("unexpected memo shape: %q", memo)
	}
	if parts[4] != blk.Hash || parts[5] != blk.TxnsRoot {
		t.Fatal("the memo must carry the block hash and the transaction root")
	}
	if strings.Contains(memo, "investor1") || strings.Contains(memo, "secret") {
		t.Fatal("transaction contents must never reach a public chain")
	}
	if MemoFor(DrunixChainID, nil) != "" {
		t.Fatal("no block means no memo")
	}
}

func TestAnchorRefusesToWriteWithoutAKey(t *testing.T) {
	chain := NewChain()
	a := NewSolanaAnchor(chain, "", "", "")
	if a == nil {
		t.Fatal("the layer should wire without a key: reads do not need one")
	}
	if a.CanWrite() {
		t.Fatal("no key must mean no write")
	}
	if _, err := a.Anchor(context.Background()); err == nil {
		t.Fatal("anchoring without a key must fail loudly rather than fake a signature")
	}
	if NewSolanaAnchor(nil, "", "", "") != nil {
		t.Fatal("no chain means the layer stays unmounted")
	}
}

func TestAnchorLoadsAKeyAndDerivesTheAddress(t *testing.T) {
	_, priv, _ := ed25519.GenerateKey(nil)
	secret := Base58Encode(priv.Seed())
	a := NewSolanaAnchor(NewChain(), "", "", secret)
	if !a.CanWrite() {
		t.Fatal("a valid secret should enable writing")
	}
	want := Base58Encode(priv.Public().(ed25519.PublicKey))
	if a.Address() != want {
		t.Fatalf("address = %q, want %q", a.Address(), want)
	}
	// CanWrite is about the key. The status goes further and asks whether
	// a write would actually succeed, so an unfunded key reports false
	// there even though the key itself is perfectly valid. Both are
	// checked, because conflating them is what produced the deployment
	// mistake the next test covers.
	st := a.Status(context.Background())
	if st["writeEnabled"] == true && st["balanceLamports"] == int64(0) {
		t.Fatal("status reported an unfunded key as able to write")
	}
}

// TestStatusWillNotCallAnEmptyKeyWritable comes from a real deployment
// mistake. SOLANA_SECRET_B58 was set to the account's ADDRESS rather than its
// secret. Both are base58 and both decode to 32 bytes, so the seed was
// accepted, it derived a different and completely empty account, and the
// status page reported writeEnabled: true. The first anchor attempt would
// have been the only way to find out.
func TestStatusWillNotCallAnEmptyKeyWritable(t *testing.T) {
	_, priv, _ := ed25519.GenerateKey(nil)
	// A stub cluster that answers every balance query with zero.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Method string `json:"method"`
		}
		_ = json.NewDecoder(r.Body).Decode(&req)
		switch req.Method {
		case "getBalance":
			_, _ = w.Write([]byte(`{"jsonrpc":"2.0","id":1,"result":{"context":{"slot":1},"value":0}}`))
		default:
			_, _ = w.Write([]byte(`{"jsonrpc":"2.0","id":1,"result":1}`))
		}
	}))
	defer srv.Close()

	a := NewSolanaAnchor(NewChain(), srv.URL, "devnet", Base58Encode(priv.Seed()))
	st := a.Status(context.Background())
	if st["writeEnabled"] != false {
		t.Fatal("a key that funds nothing was reported as able to write")
	}
	why, _ := st["writeDisabledBecause"].(string)
	if !strings.Contains(why, "holds no SOL") {
		t.Fatalf("the reason does not say the account is empty: %q", why)
	}
	// The explanation has to name the mistake, because "fund this address"
	// sends somebody to a faucet to top up an account they never meant to
	// use, and the real account stays unused with its balance intact.
	if !strings.Contains(why, "SECRET and not the public") {
		t.Fatalf("the reason does not mention the address-for-secret mix-up: %q", why)
	}
	if !strings.Contains(why, a.Address()) {
		t.Fatal("the reason does not name the address the key actually derives")
	}
}

// Live checks against a public cluster. Opt-in, because CI should not fail
// because somebody else's RPC endpoint is having a bad afternoon.
//
//	SOLANA_LIVE=1 go test -run TestSolanaLive ./...
func TestSolanaLiveCluster(t *testing.T) {
	if os.Getenv("SOLANA_LIVE") == "" {
		t.Skip("set SOLANA_LIVE=1 to run against a public cluster")
	}
	a := NewSolanaAnchor(NewChain(), "", "", "")
	slot, err := a.Slot(context.Background())
	if err != nil {
		t.Fatalf("the cluster is not reachable: %v", err)
	}
	if slot <= 0 {
		t.Fatalf("slot = %d, want a positive slot from a live cluster", slot)
	}
	res, err := a.Verify(context.Background(), "1111111111111111111111111111111111111111111111111111111111111111")
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	if res.Found || res.Matches {
		t.Fatal("a signature that does not exist must not verify")
	}
}

// Recovery: the published anchors are rebuilt from the cluster rather than
// from anything this process stored.
//
// The bug behind these tests: the hosted rail sleeps when it is idle, the
// anchor records lived in memory, and so a real published anchor vanished
// from the page while its transaction sat permanently on Solana. The screen
// then said nothing had ever been anchored, which was false, about the one
// feature whose whole purpose is to outlive this process.
func TestParseAnchorMemoAcceptsOnlyOurOwn(t *testing.T) {
	good := "[283] aasthi|v1|" + DrunixChainID + "|407|aabb|ccdd"
	rec, ok := parseAnchorMemo(good)
	if !ok {
		t.Fatal("a memo this system wrote was not recognised")
	}
	if rec.Height != 407 || rec.BlockHash != "aabb" || rec.TxnsRoot != "ccdd" {
		t.Fatalf("parsed wrongly: %+v", rec)
	}
	// The length prefix the RPC adds must not end up inside the record.
	if strings.HasPrefix(rec.Memo, "[") {
		t.Fatalf("the length prefix was kept: %q", rec.Memo)
	}
	for _, bad := range []string{
		"",
		"hello world",
		"aasthi|v1|some-other-chain|1|a|b", // ours, but not this ledger
		"aasthi|v2|" + DrunixChainID + "|1|a|b",
		"aasthi|v1|" + DrunixChainID + "|not-a-number|a|b",
		"aasthi|v1|" + DrunixChainID + "|1|a", // truncated
	} {
		if _, ok := parseAnchorMemo(bad); ok {
			t.Fatalf("accepted a memo that is not an anchor of this ledger: %q", bad)
		}
	}
}

func TestRecoverRebuildsAnchorsFromTheCluster(t *testing.T) {
	memo := "[90] aasthi|v1|" + DrunixChainID + "|407|aabb|ccdd"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Method string `json:"method"`
		}
		_ = json.NewDecoder(r.Body).Decode(&req)
		switch req.Method {
		case "getSignaturesForAddress":
			_, _ = w.Write([]byte(`{"jsonrpc":"2.0","id":1,"result":[
				{"signature":"SIG-ANCHOR","slot":514321992,"memo":` + strconv.Quote(memo) + `,"blockTime":1792000000,"err":null},
				{"signature":"SIG-FAILED","slot":514321000,"memo":` + strconv.Quote(memo) + `,"blockTime":1792000000,"err":{"InstructionError":[0,"Custom"]}},
				{"signature":"SIG-OTHER","slot":514320000,"memo":"[5] hello","blockTime":1792000000,"err":null},
				{"signature":"SIG-NOMEMO","slot":514319000,"memo":null,"blockTime":1792000000,"err":null}
			]}`))
		default:
			_, _ = w.Write([]byte(`{"jsonrpc":"2.0","id":1,"result":1}`))
		}
	}))
	defer srv.Close()

	a := NewSolanaAnchor(NewChain(), srv.URL, "devnet", "")
	a.address = "BBAZtest" // read-only recovery needs no key at all
	n, err := a.Recover(context.Background())
	if err != nil {
		t.Fatalf("recover: %v", err)
	}
	if n != 1 {
		t.Fatalf("recovered %d anchors, want 1: a failed transaction, somebody else's memo and a memoless transfer must all be skipped", n)
	}
	recs := a.Records(0)
	if len(recs) != 1 || recs[0].Signature != "SIG-ANCHOR" || recs[0].Height != 407 {
		t.Fatalf("wrong record: %+v", recs)
	}
	if !recs[0].Recovered {
		t.Fatal("a recovered anchor is not marked as recovered; found and published are different things")
	}
	if recs[0].Status != "CONFIRMED" || recs[0].Explorer == "" {
		t.Fatalf("recovered record is incomplete: %+v", recs[0])
	}

	// Running it twice must not duplicate anything: this is called at every
	// boot, and on a rail that never slept it should be a no-op.
	again, err := a.Recover(context.Background())
	if err != nil || again != 0 {
		t.Fatalf("second recovery added %d records (err %v); it should be idempotent", again, err)
	}
}
