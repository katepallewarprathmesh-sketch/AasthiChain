package drunix

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"os"
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
	if a.Status(context.Background())["writeEnabled"] != true {
		t.Fatal("status should report the write path as enabled")
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
