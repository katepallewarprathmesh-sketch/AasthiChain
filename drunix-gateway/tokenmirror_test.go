package drunix

// Tests for the public-chain token mirror and the signer under it.
//
// The signing is checked against the EIP-155 reference vector, which is the
// only way to know the encoding is right without a public chain in the loop:
// a signature this code accepts proves nothing, a byte-identical match with
// the specification's published example proves the whole path.
//
// The mirror is driven against a stub node that speaks enough JSON-RPC to
// answer a balance, a nonce, a gas price and a raw submission. That is not a
// substitute for Sepolia, and the Sepolia run is recorded in docs/TOKEN.md,
// but it does let the refusals and the arithmetic be tested every run.

import (
	"encoding/hex"
	"encoding/json"
	"math/big"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

const (
	tokenTestKey      = "4646464646464646464646464646464646464646464646464646464646464646"
	tokenTestAddress  = "0x9d8a62f656a8d1615c1294fd71e9cfb3e4855a4f"
	tokenTestContract = "0x1a304c671307d322e7b24cd1004f436b20dece9f"
	tokenTestRegistry = "0x3535353535353535353535353535353535353535"
	tokenTestAsset    = "PROP-TOKEN-TEST-001"
	tokenTestHolder   = "investor-token-1"
	tokenTestWallet   = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8"
)

// TestSignTxMatchesEIP155Vector pins the encoding to the specification.
func TestSignTxMatchesEIP155Vector(t *testing.T) {
	key, err := ParseEVMKey(tokenTestKey)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if key.Address != tokenTestAddress {
		t.Fatalf("address derivation wrong: %s", key.Address)
	}
	value, _ := new(big.Int).SetString("1000000000000000000", 10)
	raw, hash, err := SignTx(key, EVMTx{
		Nonce: 9, GasPrice: big.NewInt(20000000000), Gas: 21000,
		To: "0x3535353535353535353535353535353535353535", Value: value, ChainID: 1,
	})
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	const want = "0xf86c098504a817c800825208943535353535353535353535353535353535353535" +
		"880de0b6b3a764000080" +
		"25a028ef61340bd939bc2195fe537567866003e1a15d3c71ff63e1590620aa636276" +
		"a067cbe9d8997f761aecb703304b3800ccf555c9f3dc64214b297fb1966a3b6d83"
	if raw != want {
		t.Fatalf("raw transaction does not match the EIP-155 vector:\n got %s\nwant %s", raw, want)
	}
	if hash != "0x33469b22e9f636356c4160a87eb19df52b7412e8eac32a4a55ffe88ea8350788" {
		t.Fatalf("transaction hash does not match the vector: %s", hash)
	}
}

// TestSignTxIsDeterministicAndLowS checks the two properties that protect the
// key itself. A repeated nonce across two different messages leaks the key by
// subtraction, and a high-s signature is rejected outright by EIP-2.
func TestSignTxIsDeterministicAndLowS(t *testing.T) {
	key, _ := ParseEVMKey(tokenTestKey)
	a, _, _ := SignTx(key, EVMTx{Nonce: 1, Gas: 21000, To: tokenTestContract, ChainID: 11155111})
	b, _, _ := SignTx(key, EVMTx{Nonce: 1, Gas: 21000, To: tokenTestContract, ChainID: 11155111})
	if a != b {
		t.Fatal("the same transaction signed twice produced different bytes; the nonce is not deterministic")
	}
	c, _, _ := SignTx(key, EVMTx{Nonce: 2, Gas: 21000, To: tokenTestContract, ChainID: 11155111})
	if a == c {
		t.Fatal("two different transactions produced the same signature")
	}
	for i := 0; i < 24; i++ {
		_, _, s, err := func() (*big.Int, *big.Int, *big.Int, error) {
			r, s, _, err := signHash(key, keccak([]byte{byte(i)}))
			return r, s, s, err
		}()
		if err != nil {
			t.Fatalf("sign: %v", err)
		}
		if s.Cmp(halfN) > 0 {
			t.Fatalf("signature %d has high s, which EIP-2 rejects", i)
		}
	}
}

func TestParseEVMKeyRefusesNonsense(t *testing.T) {
	for _, bad := range []string{"", "0x12", strings.Repeat("f", 64), "zz" + strings.Repeat("0", 62)} {
		if _, err := ParseEVMKey(bad); err == nil {
			t.Fatalf("accepted an invalid key: %q", bad)
		}
	}
}

// stubNode answers the calls a write needs, and records what it was sent.
type stubNode struct {
	balance    string // wei, hex
	tokenBal   int64
	lastRaw    string
	sent       int
	failSubmit bool
	revertCall bool // eth_call rejects, as a contract rule would
}

func (n *stubNode) server(t *testing.T) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			ID     int             `json:"id"`
			Method string          `json:"method"`
			Params []interface{}   `json:"params"`
			Raw    json.RawMessage `json:"-"`
		}
		_ = json.NewDecoder(r.Body).Decode(&req)
		reply := func(result string) {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"jsonrpc":"2.0","id":1,"result":` + result + `}`))
		}
		switch req.Method {
		case "eth_getBalance":
			reply(`"` + n.balance + `"`)
		case "eth_chainId":
			reply(`"0xaa36a7"`) // Sepolia
		case "eth_getTransactionCount":
			reply(`"0x3"`)
		case "eth_gasPrice":
			reply(`"0x59682f00"`) // 1.5 gwei
		case "eth_estimateGas":
			reply(`"0x15f90"`)
		case "eth_call":
			// Only the mint reverts. A balance read must still work, or
			// the test would pass for the wrong reason.
			call, _ := req.Params[0].(map[string]interface{})
			data, _ := call["data"].(string)
			isMint := strings.HasPrefix(strings.TrimPrefix(data, "0x"), hex.EncodeToString(selector("mint(address,uint256)")))
			if n.revertCall && isMint {
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write([]byte(`{"jsonrpc":"2.0","id":1,"error":{"code":3,"message":"execution reverted","data":"0x` +
					hex.EncodeToString(selector("ERC7943CannotTransact(address)")) + `"}}`))
				return
			}
			buf := make([]byte, 32)
			new(big.Int).SetInt64(n.tokenBal).FillBytes(buf)
			reply(`"0x` + hex.EncodeToString(buf) + `"`)
		case "eth_sendRawTransaction":
			if n.failSubmit {
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write([]byte(`{"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"insufficient funds for gas * price + value"}}`))
				return
			}
			n.sent++
			if len(req.Params) > 0 {
				n.lastRaw, _ = req.Params[0].(string)
			}
			reply(`"0xabc0000000000000000000000000000000000000000000000000000000000001"`)
		default:
			reply(`"0x0"`)
		}
	}))
}

func tokenRig(t *testing.T, node *stubNode) (*TokenMirror, *UMIRail, *DrunixChain) {
	t.Helper()
	chain := NewChain()
	rail := NewUMIRail(NewMemorySecurities(), chain)
	kyc := NewKYCDesk(chain, nil)
	m := OpenTokenMirrorFromEnv(chain, rail, kyc)
	srv := node.server(t)
	t.Cleanup(srv.Close)
	key, err := ParseEVMKey(tokenTestKey)
	if err != nil {
		t.Fatalf("key: %v", err)
	}
	m.SetSignerForTest(srv.URL, tokenTestContract, tokenTestRegistry, 11155111, key)
	return m, rail, chain
}

// TestMirrorRefusesWalletThatWasNeverLinked is the refusal case the standard
// requires. The token contract would revert anyway; refusing here means not
// paying gas to be told something the rail already knew.
func TestMirrorRefusesWalletThatWasNeverLinked(t *testing.T) {
	node := &stubNode{balance: "0xde0b6b3a7640000", tokenBal: 0}
	m, rail, chain := tokenRig(t, node)
	if _, err := rail.SeedPosition(tokenTestAsset, tokenTestHolder, 100, 1000); err != nil {
		t.Fatalf("seed: %v", err)
	}
	before := len(chain.Snapshot())
	_, err := m.Mirror(tokenTestAsset, tokenTestHolder, "regulator1")
	if err == nil {
		t.Fatal("mirrored to a wallet that was never registered on chain")
	}
	if !strings.Contains(err.Error(), "ERR_TOKEN_WALLET_NOT_LINKED") {
		t.Fatalf("wrong refusal: %v", err)
	}
	if node.sent != 0 {
		t.Fatal("a transaction was signed and sent despite the refusal")
	}
	// The refusal has to be on the ledger, not only in the response.
	found := false
	for _, b := range chain.Snapshot() {
		if b.Type == BlockTokenRefused {
			found = true
		}
	}
	if !found || len(chain.Snapshot()) <= before {
		t.Fatal("the refusal was not written to the chain")
	}
}

// TestMirrorMintsExactlyTheShortfall is the invariant: the mint is the gap
// between the chain and the rail, never the whole position.
func TestMirrorMintsExactlyTheShortfall(t *testing.T) {
	node := &stubNode{balance: "0xde0b6b3a7640000", tokenBal: 40}
	m, rail, chain := tokenRig(t, node)
	if _, err := rail.SeedPosition(tokenTestAsset, tokenTestHolder, 100, 1000); err != nil {
		t.Fatalf("seed: %v", err)
	}
	m.links[tokenTestHolder] = tokenTestWallet

	rec, err := m.Mirror(tokenTestAsset, tokenTestHolder, "regulator1")
	if err != nil {
		t.Fatalf("mirror: %v", err)
	}
	if rec.Tokens != 60 {
		t.Fatalf("minted %d, the shortfall between 40 on chain and 100 on the rail is 60", rec.Tokens)
	}
	if node.sent != 1 {
		t.Fatalf("expected one transaction, got %d", node.sent)
	}
	// The call data must be mint(address,uint256) with the shortfall, not
	// the position. Checking the response alone would not catch a bug that
	// reports 60 and sends 100.
	want := hex.EncodeToString(selector("mint(address,uint256)"))
	if !strings.Contains(node.lastRaw, want) {
		t.Fatal("the transaction does not call mint(address,uint256)")
	}
	if !strings.Contains(node.lastRaw, strings.TrimLeft(hex.EncodeToString(uint64Word(60)), "0")) {
		t.Fatalf("the transaction does not carry the shortfall: %s", node.lastRaw)
	}
	if rec.Explorer == "" || !strings.Contains(rec.Explorer, "sepolia") {
		t.Fatalf("a Sepolia write should carry an explorer link, got %q", rec.Explorer)
	}
	mirrored := 0
	for _, b := range chain.Snapshot() {
		if b.Type == BlockTokenMirrored {
			mirrored++
		}
	}
	if mirrored != 1 {
		t.Fatalf("expected one %s block, got %d", BlockTokenMirrored, mirrored)
	}
}

// TestMirrorRefusesWhenTheChainIsAhead is the one that matters most. A chain
// balance above the rail position means the same property exists twice, and
// the correct response is to stop, not to reconcile.
func TestMirrorRefusesWhenTheChainIsAhead(t *testing.T) {
	node := &stubNode{balance: "0xde0b6b3a7640000", tokenBal: 250}
	m, rail, _ := tokenRig(t, node)
	if _, err := rail.SeedPosition(tokenTestAsset, tokenTestHolder, 100, 1000); err != nil {
		t.Fatalf("seed: %v", err)
	}
	m.links[tokenTestHolder] = tokenTestWallet

	_, err := m.Mirror(tokenTestAsset, tokenTestHolder, "regulator1")
	if err == nil || !strings.Contains(err.Error(), "ERR_TOKEN_EXCEEDS_RAIL_POSITION") {
		t.Fatalf("expected a refusal when the chain is ahead, got %v", err)
	}
	if node.sent != 0 {
		t.Fatal("minted more supply while the chain was already ahead of the register")
	}
}

// TestMirrorRefusesWhenAlreadyLevel keeps a no-op from being reported as a
// write, which would make the records a poor audit trail.
func TestMirrorRefusesWhenAlreadyLevel(t *testing.T) {
	node := &stubNode{balance: "0xde0b6b3a7640000", tokenBal: 100}
	m, rail, _ := tokenRig(t, node)
	_, _ = rail.SeedPosition(tokenTestAsset, tokenTestHolder, 100, 1000)
	m.links[tokenTestHolder] = tokenTestWallet
	if _, err := m.Mirror(tokenTestAsset, tokenTestHolder, "regulator1"); err == nil ||
		!strings.Contains(err.Error(), "ERR_TOKEN_ALREADY_CURRENT") {
		t.Fatalf("expected ERR_TOKEN_ALREADY_CURRENT, got %v", err)
	}
}

// TestMirrorRefusesBeforeSpendingAnUnfundedNonce. An unfunded signer must be
// caught before signing: a transaction that can never mine still consumes the
// nonce locally and confuses every write after it.
func TestMirrorRefusesWhenTheSignerCannotPayGas(t *testing.T) {
	node := &stubNode{balance: "0x1", tokenBal: 0} // 1 wei
	m, rail, _ := tokenRig(t, node)
	_, _ = rail.SeedPosition(tokenTestAsset, tokenTestHolder, 100, 1000)
	m.links[tokenTestHolder] = tokenTestWallet
	_, err := m.Mirror(tokenTestAsset, tokenTestHolder, "regulator1")
	if err == nil || !strings.Contains(err.Error(), "ERR_TOKEN_NO_GAS") {
		t.Fatalf("expected ERR_TOKEN_NO_GAS, got %v", err)
	}
	if node.sent != 0 {
		t.Fatal("a transaction was submitted that the signer could not pay for")
	}
}

// TestStatusNamesWhatIsMissing. "Not configured" sends a reader to the
// source; naming the variable does not.
func TestTokenStatusNamesTheMissingConfiguration(t *testing.T) {
	chain := NewChain()
	m := OpenTokenMirrorFromEnv(chain, NewUMIRail(NewMemorySecurities(), chain), nil)
	st := m.Status()
	if st["configured"] == true {
		t.Fatal("reported configured with nothing set")
	}
	missing, _ := st["missing"].([]string)
	for _, want := range []string{"EVM_RPC_URL", "EVM_TOKEN_ADDRESS", "EVM_SIGNER_KEY"} {
		found := false
		for _, m := range missing {
			if m == want {
				found = true
			}
		}
		if !found {
			t.Fatalf("status does not name %s as missing: %v", want, missing)
		}
	}
	if st["whatIsNotReal"] == nil {
		t.Fatal("status does not state its own boundary")
	}
}

// TestCompareReportsDriftRatherThanHidingIt. The mirror is one-way, so drift
// is possible by construction and must be visible.
func TestCompareReportsDrift(t *testing.T) {
	node := &stubNode{balance: "0xde0b6b3a7640000", tokenBal: 70}
	m, rail, _ := tokenRig(t, node)
	_, _ = rail.SeedPosition(tokenTestAsset, tokenTestHolder, 100, 1000)
	m.links[tokenTestHolder] = tokenTestWallet

	out := m.Compare(tokenTestAsset)
	if out["agrees"] == true {
		t.Fatal("reported agreement with 70 on chain against 100 on the rail")
	}
	rows, _ := out["wallets"].([]map[string]interface{})
	if len(rows) != 1 {
		t.Fatalf("expected one wallet, got %d", len(rows))
	}
	if rows[0]["drift"] != int64(-30) {
		t.Fatalf("drift should be -30, got %v", rows[0]["drift"])
	}
	if out["whatThisDoesNotProve"] == nil {
		t.Fatal("the comparison does not state its limit")
	}
}

// TestMirrorRefusesWhatTheContractWouldReject is here because of a real bug.
//
// Before the preflight existed, a mint that violated the offering's
// per-holder cap was accepted into the pool, mined as a revert, and reported
// to the caller as a success with a transaction hash. The balance never
// moved. A write path that cannot tell a mined transaction from a mined
// revert produces confident wrong answers, which is worse than having no
// write path at all.
func TestMirrorRefusesWhatTheContractWouldReject(t *testing.T) {
	node := &stubNode{balance: "0xde0b6b3a7640000", tokenBal: 0, revertCall: true}
	m, rail, chain := tokenRig(t, node)
	_, _ = rail.SeedPosition(tokenTestAsset, tokenTestHolder, 100, 1000)
	m.links[tokenTestHolder] = tokenTestWallet

	_, err := m.Mirror(tokenTestAsset, tokenTestHolder, "regulator1")
	if err == nil || !strings.Contains(err.Error(), "ERR_TOKEN_CONTRACT_REFUSED") {
		t.Fatalf("expected the simulated call to stop the write, got %v", err)
	}
	if node.sent != 0 {
		t.Fatal("gas was spent to be told something eth_call already said")
	}
	// The refusal should name the contract rule, not just say "reverted".
	if !strings.Contains(err.Error(), "ERC7943CannotTransact") {
		t.Fatalf("the custom error was not decoded: %v", err)
	}
	found := false
	for _, b := range chain.Snapshot() {
		if b.Type == BlockTokenRefused {
			found = true
		}
	}
	if !found {
		t.Fatal("the contract's refusal was not recorded on our own ledger")
	}
}

// TestDecodeRevertReadsErrorStrings covers the other revert shape.
func TestDecodeRevertReadsErrorStrings(t *testing.T) {
	msg := "only an agent may mint"
	data := append([]byte{}, selector("Error(string)")...)
	data = append(data, uint64Word(32)...)
	data = append(data, uint64Word(uint64(len(msg)))...)
	data = append(data, pad32([]byte(msg))...)
	if got := decodeRevert(data); got != msg {
		t.Fatalf("decoded %q, want %q", got, msg)
	}
	if got := decodeRevert(selector("NotAuthorised()")); !strings.Contains(got, "not an agent") {
		t.Fatalf("custom error not explained: %q", got)
	}
}
