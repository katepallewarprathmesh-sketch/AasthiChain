package drunix

// Anchoring this ledger on a public blockchain.
//
// Everything else in this repository is a permissioned ledger that this
// process controls. That is the right shape for settlement, and it is also
// the obvious objection: a chain whose operator can rewrite it proves
// nothing to an outsider. Replaying it from genesis only shows the history is
// internally consistent, not that it is the history that existed yesterday.
//
// So the head of the chain is published to a public blockchain: Solana, as a
// memo carrying the chain id, the block height, the block hash and the merkle
// root of its transactions. After that, anyone can take the anchor out of a
// public explorer, recompute the block from this ledger and see whether the
// two agree. Rewriting history now means rewriting a record on a network with
// no operator, which is the whole point.
//
// What is real here, stated precisely because the rest of the system is
// labelled as a simulation:
//
//   - The network is real. These are live JSON-RPC calls to a Solana cluster,
//     not a mock. Reads work out of the box with no account and no funds.
//   - The transaction is real. It is a legacy Solana transaction built,
//     serialised and signed here with ed25519, carrying a Memo instruction.
//     There is no SDK underneath this file: the message layout, the shortvec
//     encoding and the base58 are implemented below, which also means they
//     are testable without a network.
//   - Writing costs a fee, so the write path is off until a funded key is
//     configured. Off means off: the status endpoint says so rather than
//     pretending, and nothing silently falls back to a fake signature.
//   - An anchor proves a hash existed at a time. It does not prove the
//     contents are true, and it does not make the settlement itself public.
//     Only the digest leaves this process.

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"net/http"
	"strings"
	"sync"
	"time"
)

const (
	// BlockChainAnchored records that the head of this ledger was published
	// to a public chain, with the signature needed to find it again.
	BlockChainAnchored = "UMI_CHAIN_ANCHORED"

	// The SPL Memo program. A memo costs one signature fee and writes the
	// bytes into the transaction log, which is all an anchor needs.
	solanaMemoProgram = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"

	solanaDefaultRPC     = "https://api.devnet.solana.com"
	solanaDefaultCluster = "devnet"
	solanaConfirmWait    = 45 * time.Second

	// SolanaDisclaimer rides on every response from this layer.
	SolanaDisclaimer = "Anchors are real transactions on a public Solana cluster. An anchor proves a digest " +
		"existed at a point in time; it does not prove the ledger contents are true, and no settlement data " +
		"leaves this process."
)

var (
	ErrSolanaDisabled  = errors.New("ERR_UMI_ANCHOR_DISABLED")
	ErrSolanaNoKey     = errors.New("ERR_UMI_ANCHOR_NO_KEY")
	ErrSolanaRPC       = errors.New("ERR_UMI_ANCHOR_RPC")
	ErrSolanaNotFound  = errors.New("ERR_UMI_ANCHOR_NOT_FOUND")
	ErrSolanaNoBalance = errors.New("ERR_UMI_ANCHOR_NO_BALANCE")
)

/* ---------------- base58, shortvec: the two encodings Solana needs ---------------- */

const base58Alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"

// Base58Encode is Bitcoin-style base58, which is what Solana uses for every
// address and signature.
func Base58Encode(in []byte) string {
	n := new(big.Int).SetBytes(in)
	base := big.NewInt(58)
	mod := new(big.Int)
	out := make([]byte, 0, len(in)*2)
	for n.Sign() > 0 {
		n.DivMod(n, base, mod)
		out = append(out, base58Alphabet[mod.Int64()])
	}
	for _, c := range in {
		if c != 0 {
			break
		}
		out = append(out, base58Alphabet[0])
	}
	for i, j := 0, len(out)-1; i < j; i, j = i+1, j-1 {
		out[i], out[j] = out[j], out[i]
	}
	return string(out)
}

// Base58Decode reverses it, refusing a character that is not in the alphabet
// rather than quietly producing the wrong key.
func Base58Decode(s string) ([]byte, error) {
	n := big.NewInt(0)
	base := big.NewInt(58)
	for _, r := range s {
		i := strings.IndexRune(base58Alphabet, r)
		if i < 0 {
			return nil, fmt.Errorf("base58: unexpected character %q", r)
		}
		n.Mul(n, base)
		n.Add(n, big.NewInt(int64(i)))
	}
	leading := 0
	for _, r := range s {
		if r != rune(base58Alphabet[0]) {
			break
		}
		leading++
	}
	return append(make([]byte, leading), n.Bytes()...), nil
}

// shortvec is Solana's compact-u16 length prefix: seven bits per byte, high
// bit set while more bytes follow.
func shortvec(n int) []byte {
	out := make([]byte, 0, 3)
	for {
		b := byte(n & 0x7f)
		n >>= 7
		if n == 0 {
			return append(out, b)
		}
		out = append(out, b|0x80)
	}
}

/* ---------------- the transaction ---------------- */

// BuildMemoMessage serialises a legacy Solana message with one signer and one
// Memo instruction. Separated from signing and sending so the byte layout can
// be tested without a network or a key.
func BuildMemoMessage(payer ed25519.PublicKey, programID, recentBlockhash, memo []byte) ([]byte, error) {
	if len(payer) != 32 || len(programID) != 32 || len(recentBlockhash) != 32 {
		return nil, fmt.Errorf("solana: key, program id and blockhash must be 32 bytes")
	}
	var msg bytes.Buffer
	// Header: one required signature, no readonly signed accounts, one
	// readonly unsigned account (the memo program).
	msg.Write([]byte{1, 0, 1})
	msg.Write(shortvec(2))
	msg.Write(payer)
	msg.Write(programID)
	msg.Write(recentBlockhash)
	msg.Write(shortvec(1)) // one instruction
	msg.WriteByte(1)       // program id is account index 1
	msg.Write(shortvec(0)) // the memo instruction touches no accounts
	msg.Write(shortvec(len(memo)))
	msg.Write(memo)
	return msg.Bytes(), nil
}

// SignTransaction wraps a signed message in the transaction envelope and
// returns it base64 encoded, ready for sendTransaction.
func SignTransaction(priv ed25519.PrivateKey, message []byte) (string, string) {
	sig := ed25519.Sign(priv, message)
	var tx bytes.Buffer
	tx.Write(shortvec(1))
	tx.Write(sig)
	tx.Write(message)
	return base64.StdEncoding.EncodeToString(tx.Bytes()), Base58Encode(sig)
}

/* ---------------- the client ---------------- */

type solanaRPCError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

// SolanaAnchor publishes ledger heads to a public cluster and reads them back.
type SolanaAnchor struct {
	mu      sync.RWMutex
	chain   *DrunixChain
	rpcURL  string
	cluster string
	http    *http.Client

	priv    ed25519.PrivateKey
	address string

	records []AnchorRecord
}

// AnchorRecord is one published head.
type AnchorRecord struct {
	Signature   string `json:"signature"`
	Cluster     string `json:"cluster"`
	Height      int64  `json:"height"`
	BlockHash   string `json:"blockHash"`
	TxnsRoot    string `json:"txnsRoot"`
	Memo        string `json:"memo"`
	Slot        int64  `json:"slot,omitempty"`
	Status      string `json:"status"`
	SentAt      string `json:"sentAt"`
	ConfirmedAt string `json:"confirmedAt,omitempty"`
	Explorer    string `json:"explorer"`
}

// NewSolanaAnchor wires the layer. A nil chain disables it. Without a secret
// key the layer still runs: reads and verification are live, writing is not.
func NewSolanaAnchor(chain *DrunixChain, rpcURL, cluster, secretB58 string) *SolanaAnchor {
	if chain == nil {
		return nil
	}
	if strings.TrimSpace(rpcURL) == "" {
		rpcURL = solanaDefaultRPC
	}
	if strings.TrimSpace(cluster) == "" {
		cluster = solanaDefaultCluster
	}
	a := &SolanaAnchor{
		chain:   chain,
		rpcURL:  rpcURL,
		cluster: cluster,
		http:    &http.Client{Timeout: 20 * time.Second},
	}
	if s := strings.TrimSpace(secretB58); s != "" {
		if seed, err := Base58Decode(s); err == nil && len(seed) >= ed25519.SeedSize {
			a.priv = ed25519.NewKeyFromSeed(seed[:ed25519.SeedSize])
			a.address = Base58Encode(a.priv.Public().(ed25519.PublicKey))
		}
	}
	return a
}

// CanWrite reports whether a key is loaded. Balance is a separate question,
// answered live by Status.
func (a *SolanaAnchor) CanWrite() bool {
	a.mu.RLock()
	defer a.mu.RUnlock()
	return a.priv != nil
}

// Address is the funding address, empty when no key is configured.
func (a *SolanaAnchor) Address() string {
	a.mu.RLock()
	defer a.mu.RUnlock()
	return a.address
}

func (a *SolanaAnchor) call(ctx context.Context, method string, params interface{}, out interface{}) error {
	payload, err := json.Marshal(map[string]interface{}{
		"jsonrpc": "2.0", "id": 1, "method": method, "params": params,
	})
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, a.rpcURL, bytes.NewReader(payload))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := a.http.Do(req)
	if err != nil {
		return fmt.Errorf("%w: %s", ErrSolanaRPC, err.Error())
	}
	defer resp.Body.Close()
	var envelope struct {
		Result json.RawMessage `json:"result"`
		Error  *solanaRPCError `json:"error"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&envelope); err != nil {
		return fmt.Errorf("%w: %s", ErrSolanaRPC, err.Error())
	}
	if envelope.Error != nil {
		return fmt.Errorf("%w: %s", ErrSolanaRPC, envelope.Error.Message)
	}
	if out == nil {
		return nil
	}
	return json.Unmarshal(envelope.Result, out)
}

// Slot is the cluster's current slot: the cheapest proof that the network is
// actually reachable from this process.
func (a *SolanaAnchor) Slot(ctx context.Context) (int64, error) {
	var slot int64
	err := a.call(ctx, "getSlot", []interface{}{}, &slot)
	return slot, err
}

// Balance in lamports for the configured address.
func (a *SolanaAnchor) Balance(ctx context.Context) (int64, error) {
	addr := a.Address()
	if addr == "" {
		return 0, ErrSolanaNoKey
	}
	var out struct {
		Value int64 `json:"value"`
	}
	if err := a.call(ctx, "getBalance", []interface{}{addr}, &out); err != nil {
		return 0, err
	}
	return out.Value, nil
}

// MemoFor is the anchor payload: version, chain, height, block hash and the
// merkle root over that block's transactions. Short on purpose; a memo is
// charged by the byte and the digest is the part that matters.
func MemoFor(chainID string, b *DrunixBlock) string {
	if b == nil {
		return ""
	}
	return fmt.Sprintf("aasthi|v1|%s|%d|%s|%s", chainID, b.Height, b.Hash, b.TxnsRoot)
}

// Anchor publishes the current head and waits for confirmation.
func (a *SolanaAnchor) Anchor(ctx context.Context) (*AnchorRecord, error) {
	a.mu.RLock()
	priv := a.priv
	cluster := a.cluster
	a.mu.RUnlock()
	if priv == nil {
		return nil, fmt.Errorf("%w: no signing key is configured, so this node can read the cluster but "+
			"cannot write to it", ErrSolanaNoKey)
	}

	head := a.chain.Head()
	if head == nil {
		return nil, fmt.Errorf("%w: the ledger has no blocks to anchor", ErrSolanaDisabled)
	}
	memo := MemoFor(DrunixChainID, head)

	var bh struct {
		Value struct {
			Blockhash string `json:"blockhash"`
		} `json:"value"`
	}
	if err := a.call(ctx, "getLatestBlockhash",
		[]interface{}{map[string]string{"commitment": "finalized"}}, &bh); err != nil {
		return nil, err
	}
	recent, err := Base58Decode(bh.Value.Blockhash)
	if err != nil {
		return nil, fmt.Errorf("%w: the cluster returned a blockhash this node could not decode", ErrSolanaRPC)
	}
	program, err := Base58Decode(solanaMemoProgram)
	if err != nil {
		return nil, err
	}
	msg, err := BuildMemoMessage(priv.Public().(ed25519.PublicKey), program, recent, []byte(memo))
	if err != nil {
		return nil, err
	}
	encoded, signature := SignTransaction(priv, msg)

	var returned string
	if err := a.call(ctx, "sendTransaction", []interface{}{
		encoded, map[string]interface{}{"encoding": "base64", "preflightCommitment": "confirmed"},
	}, &returned); err != nil {
		if strings.Contains(err.Error(), "no record of a prior credit") {
			return nil, fmt.Errorf("%w: the anchor account %s holds no %s SOL, so the fee cannot be paid",
				ErrSolanaNoBalance, a.Address(), cluster)
		}
		return nil, err
	}
	if returned != "" {
		signature = returned
	}

	rec := AnchorRecord{
		Signature: signature,
		Cluster:   cluster,
		Height:    head.Height,
		BlockHash: head.Hash,
		TxnsRoot:  head.TxnsRoot,
		Memo:      memo,
		Status:    "SENT",
		SentAt:    time.Now().UTC().Format(time.RFC3339),
		Explorer:  explorerURL(signature, cluster),
	}

	if slot, ok := a.awaitConfirmation(ctx, signature); ok {
		rec.Status = "CONFIRMED"
		rec.Slot = slot
		rec.ConfirmedAt = time.Now().UTC().Format(time.RFC3339)
	}

	a.mu.Lock()
	a.records = append(a.records, rec)
	a.mu.Unlock()

	a.chain.Append(BlockChainAnchored, []map[string]interface{}{{
		"kind":        "public-chain-anchor",
		"network":     "solana",
		"cluster":     cluster,
		"signature":   rec.Signature,
		"anchoredTo":  rec.Height,
		"blockHash":   rec.BlockHash,
		"txnsRoot":    rec.TxnsRoot,
		"status":      rec.Status,
		"explorerURL": rec.Explorer,
	}})
	return &rec, nil
}

func (a *SolanaAnchor) awaitConfirmation(ctx context.Context, signature string) (int64, bool) {
	deadline := time.Now().Add(solanaConfirmWait)
	for time.Now().Before(deadline) {
		var out struct {
			Value []*struct {
				Slot               int64   `json:"slot"`
				ConfirmationStatus string  `json:"confirmationStatus"`
				Err                *string `json:"err"`
			} `json:"value"`
		}
		err := a.call(ctx, "getSignatureStatuses", []interface{}{
			[]string{signature}, map[string]bool{"searchTransactionHistory": true},
		}, &out)
		if err == nil && len(out.Value) > 0 && out.Value[0] != nil {
			st := out.Value[0]
			if st.ConfirmationStatus == "confirmed" || st.ConfirmationStatus == "finalized" {
				return st.Slot, true
			}
		}
		select {
		case <-ctx.Done():
			return 0, false
		case <-time.After(2 * time.Second):
		}
	}
	return 0, false
}

// AnchorVerification is the answer to "does the public record still match this
// ledger?", including when it does not.
type AnchorVerification struct {
	Signature   string `json:"signature"`
	Found       bool   `json:"foundOnChain"`
	Cluster     string `json:"cluster"`
	Slot        int64  `json:"slot,omitempty"`
	Memo        string `json:"memoOnChain,omitempty"`
	Height      int64  `json:"height,omitempty"`
	LocalHash   string `json:"localBlockHash,omitempty"`
	AnchorHash  string `json:"anchoredBlockHash,omitempty"`
	Matches     bool   `json:"matches"`
	Explanation string `json:"explanation"`
	Explorer    string `json:"explorer,omitempty"`
}

// Verify reads a transaction back off the cluster and compares the memo it
// carries with the block this ledger holds at that height. A mismatch is
// reported, not hidden: that is the entire value of anchoring.
func (a *SolanaAnchor) Verify(ctx context.Context, signature string) (*AnchorVerification, error) {
	signature = strings.TrimSpace(signature)
	if signature == "" {
		return nil, ErrSolanaNotFound
	}
	res := &AnchorVerification{Signature: signature, Cluster: a.cluster, Explorer: explorerURL(signature, a.cluster)}

	var tx *struct {
		Slot int64 `json:"slot"`
		Meta *struct {
			LogMessages []string `json:"logMessages"`
		} `json:"meta"`
	}
	if err := a.call(ctx, "getTransaction", []interface{}{
		signature,
		map[string]interface{}{"encoding": "json", "commitment": "confirmed", "maxSupportedTransactionVersion": 0},
	}, &tx); err != nil {
		return nil, err
	}
	if tx == nil {
		res.Explanation = "The cluster has no transaction with that signature."
		return res, nil
	}
	res.Found = true
	res.Slot = tx.Slot
	if tx.Meta != nil {
		for _, line := range tx.Meta.LogMessages {
			if i := strings.Index(line, `Memo (len`); i >= 0 {
				if j := strings.Index(line, `): "`); j >= 0 {
					res.Memo = strings.TrimSuffix(line[j+4:], `"`)
				}
			}
		}
	}
	if res.Memo == "" {
		res.Explanation = "That transaction exists but carries no memo, so it is not one of this ledger's anchors."
		return res, nil
	}

	parts := strings.Split(res.Memo, "|")
	if len(parts) < 5 || parts[0] != "aasthi" {
		res.Explanation = "The memo is not in this ledger's anchor format."
		return res, nil
	}
	var height int64
	fmt.Sscanf(parts[3], "%d", &height)
	res.Height = height
	res.AnchorHash = parts[4]

	local := a.chain.BlockAt(height)
	if local == nil {
		res.Explanation = fmt.Sprintf("This ledger has no block at height %d, so the anchor cannot be "+
			"checked against it here.", height)
		return res, nil
	}
	res.LocalHash = local.Hash
	res.Matches = local.Hash == res.AnchorHash
	if res.Matches {
		res.Explanation = fmt.Sprintf("Block %d on this ledger hashes to the value published on %s at slot %d. "+
			"The history has not been rewritten since it was anchored.", height, a.cluster, tx.Slot)
	} else {
		res.Explanation = fmt.Sprintf("The anchor published for block %d does not match the block this ledger "+
			"now holds at that height. Either the ledger was rewritten or the anchor belongs to a different "+
			"instance.", height)
	}
	return res, nil
}

// Records returns the anchors this process published, newest first.
func (a *SolanaAnchor) Records(limit int) []AnchorRecord {
	a.mu.RLock()
	defer a.mu.RUnlock()
	out := make([]AnchorRecord, 0, len(a.records))
	for i := len(a.records) - 1; i >= 0; i-- {
		out = append(out, a.records[i])
		if limit > 0 && len(out) >= limit {
			break
		}
	}
	return out
}

// Status is a live answer, not a cached one: it calls the cluster.
func (a *SolanaAnchor) Status(ctx context.Context) map[string]interface{} {
	out := map[string]interface{}{
		"network":      "solana",
		"cluster":      a.cluster,
		"rpc":          a.rpcURL,
		"reads":        "live",
		"writeEnabled": a.CanWrite(),
		"address":      a.Address(),
		"memoProgram":  solanaMemoProgram,
		"anchors":      len(a.Records(0)),
		"disclaimer":   SolanaDisclaimer,
	}
	if slot, err := a.Slot(ctx); err == nil {
		out["clusterSlot"] = slot
		out["reachable"] = true
	} else {
		out["reachable"] = false
		out["error"] = err.Error()
	}
	if !a.CanWrite() {
		out["writeDisabledBecause"] = "No signing key is configured. Set SOLANA_SECRET_B58 to a funded " +
			a.cluster + " key to publish anchors. Reads and verification work without one."
		return out
	}
	if bal, err := a.Balance(ctx); err == nil {
		out["balanceLamports"] = bal
		out["balanceSOL"] = float64(bal) / 1e9
		if bal == 0 {
			// A key that is loaded but funds nothing cannot write, and
			// saying writeEnabled: true here would be a lie that only
			// comes apart when somebody presses the button.
			out["writeEnabled"] = false
			out["writeDisabledBecause"] = "A signing key is loaded and it derives " + a.Address() +
				", which holds no SOL on " + a.cluster + ", so the fee cannot be paid. Either fund " +
				"that address, or check that SOLANA_SECRET_B58 holds the SECRET and not the public " +
				"address: both are base58 and both are 32 bytes, so pasting the address is accepted " +
				"and silently derives a different, empty account."
		}
	}
	return out
}

func explorerURL(signature, cluster string) string {
	if signature == "" {
		return ""
	}
	return "https://explorer.solana.com/tx/" + signature + "?cluster=" + cluster
}
