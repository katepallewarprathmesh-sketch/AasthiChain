package drunix

// Mirroring document anchors onto an EVM chain.
//
// Why this exists: the Drunix ledger is ours. A counterparty who distrusts us
// has to take our word that a block was never rewritten. Writing the same CID
// and digest to a public EVM chain removes that last piece of trust — the
// anchor then lives somewhere we do not control and cannot edit.
//
// What is sent: a CID string and two 32-byte hashes. Never file contents,
// never anything derived from personal data. KYC anchors are excluded here
// as well as everywhere else.
//
// This is strictly opt-in. With EVM_RPC_URL unset the mirror is nil and every
// call is a no-op, so the default build behaves exactly as before. Mirroring
// also never fails an anchor: the Drunix block is the system of record and a
// chain that is down must not stop a property being registered.

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"math/big"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/sha3"
)

// EVMMirror writes document anchors to a DocumentRegistry.sol deployment.
type EVMMirror struct {
	rpcURL   string
	contract string // 0x-prefixed address
	from     string // 0x-prefixed sender, must be a registrar on the contract
	client   *http.Client

	mu   sync.Mutex
	seq  int
	fail int // consecutive failures, for log throttling
}

// OpenEVMMirrorFromEnv returns a mirror when the operator has configured one.
//
//	EVM_RPC_URL          JSON-RPC endpoint (ganache, anvil, a testnet node)
//	EVM_REGISTRY_ADDRESS deployed DocumentRegistry.sol address
//	EVM_SENDER_ADDRESS   unlocked account that holds the registrar role
//
// Returns nil when unset, which is the normal case.
func OpenEVMMirrorFromEnv() *EVMMirror {
	rpc := strings.TrimSpace(os.Getenv("EVM_RPC_URL"))
	addr := strings.TrimSpace(os.Getenv("EVM_REGISTRY_ADDRESS"))
	from := strings.TrimSpace(os.Getenv("EVM_SENDER_ADDRESS"))
	if rpc == "" || addr == "" {
		return nil
	}
	return &EVMMirror{
		rpcURL:   rpc,
		contract: addr,
		from:     from,
		client:   &http.Client{Timeout: 8 * time.Second},
	}
}

// Describe is what the startup banner prints.
func (m *EVMMirror) Describe() string {
	if m == nil {
		return "public-chain mirror: off — set EVM_RPC_URL and EVM_REGISTRY_ADDRESS to also anchor on an EVM chain"
	}
	return fmt.Sprintf("public-chain mirror: %s at %s — document anchors are written to a chain we do not control", m.rpcURL, m.contract)
}

// ---------------------------------------------------------------- JSON-RPC

type rpcReq struct {
	JSONRPC string        `json:"jsonrpc"`
	ID      int           `json:"id"`
	Method  string        `json:"method"`
	Params  []interface{} `json:"params"`
}

type rpcResp struct {
	Result json.RawMessage `json:"result"`
	Error  *struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

func (m *EVMMirror) call(method string, params ...interface{}) (json.RawMessage, error) {
	m.mu.Lock()
	m.seq++
	id := m.seq
	m.mu.Unlock()

	if params == nil {
		params = []interface{}{}
	}
	body, err := json.Marshal(rpcReq{JSONRPC: "2.0", ID: id, Method: method, Params: params})
	if err != nil {
		return nil, err
	}
	resp, err := m.client.Post(m.rpcURL, "application/json", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	var out rpcResp
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, err
	}
	if out.Error != nil {
		return nil, fmt.Errorf("%s: %s", method, out.Error.Message)
	}
	return out.Result, nil
}

// ------------------------------------------------------------ ABI encoding

func keccak(b []byte) []byte {
	h := sha3.NewLegacyKeccak256()
	h.Write(b)
	return h.Sum(nil)
}

func selector(sig string) []byte { return keccak([]byte(sig))[:4] }

// pad32 right-pads dynamic data to a 32-byte boundary.
func pad32(b []byte) []byte {
	if n := len(b) % 32; n != 0 {
		b = append(b, make([]byte, 32-n)...)
	}
	return b
}

// word left-pads a value into a 32-byte slot, the layout for all static types.
func word(b []byte) []byte {
	out := make([]byte, 32)
	copy(out[32-len(b):], b)
	return out
}

func uint64Word(v uint64) []byte { return word(new(big.Int).SetUint64(v).Bytes()) }

// bytes32FromHex accepts a 64-char hex digest, with or without 0x.
func bytes32FromHex(h string) ([]byte, error) {
	h = strings.TrimPrefix(strings.TrimSpace(h), "0x")
	if len(h) != 64 {
		return nil, fmt.Errorf("expected 64 hex chars, got %d", len(h))
	}
	return hex.DecodeString(h)
}

// encodeString produces the (length, data) tail of a dynamic string.
func encodeString(s string) []byte {
	return append(uint64Word(uint64(len(s))), pad32([]byte(s))...)
}

// encodeAnchor builds the calldata for
// anchor(bytes32,string,bytes32,string,uint64,uint64).
//
// Layout is six head words; the two strings are dynamic, so their head slots
// hold offsets measured from the start of the argument block.
func encodeAnchor(assetID []byte, cid string, digest []byte, docType string, validFrom, validTo uint64) []byte {
	const headSize = 6 * 32

	cidTail := encodeString(cid)
	typeTail := encodeString(docType)

	out := selector("anchor(bytes32,string,bytes32,string,uint64,uint64)")
	out = append(out, word(assetID)...)
	out = append(out, uint64Word(headSize)...)
	out = append(out, word(digest)...)
	out = append(out, uint64Word(uint64(headSize+len(cidTail)))...)
	out = append(out, uint64Word(validFrom)...)
	out = append(out, uint64Word(validTo)...)
	out = append(out, cidTail...)
	out = append(out, typeTail...)
	return out
}

// ------------------------------------------------------------------ writes

// AnchorDocument mirrors one document. Errors are returned for tests but
// callers in the request path ignore them deliberately.
func (m *EVMMirror) AnchorDocument(d *Document) (string, error) {
	if m == nil || d == nil {
		return "", nil
	}
	// A digest-only record has no retrievable bytes, and KYC evidence must not
	// gain a public-chain footprint that outlives our own retention rules.
	if d.Visibility == "digestOnly" || d.Subject != "" {
		return "", nil
	}

	digest, err := bytes32FromHex(d.SHA256)
	if err != nil {
		return "", fmt.Errorf("digest: %w", err)
	}
	// The asset id is hashed rather than sent, so the chain carries no
	// readable identifier while still being queryable by anyone who knows it.
	assetKey := keccak([]byte(d.AssetID))

	var from, to uint64
	if d.ValidFrom != nil {
		from = uint64(d.ValidFrom.Unix())
	}
	if d.ValidTo != nil {
		to = uint64(d.ValidTo.Unix())
	}

	data := encodeAnchor(assetKey, d.CID, digest, d.DocType, from, to)

	sender := m.from
	if sender == "" {
		if sender, err = m.defaultAccount(); err != nil {
			return "", err
		}
	}

	tx := map[string]string{
		"from": sender,
		"to":   m.contract,
		"data": "0x" + hex.EncodeToString(data),
		"gas":  "0x7a120", // 500k, comfortably above the ~200k this costs
	}
	res, err := m.call("eth_sendTransaction", tx)
	if err != nil {
		return "", err
	}
	var txHash string
	if err := json.Unmarshal(res, &txHash); err != nil {
		return "", err
	}
	return txHash, nil
}

// MirrorInBackground anchors without blocking the caller, and without letting
// a mirror failure surface as a failed document registration.
func (m *EVMMirror) MirrorInBackground(d *Document) {
	if m == nil || d == nil {
		return
	}
	go func() {
		txHash, err := m.AnchorDocument(d)
		m.mu.Lock()
		defer m.mu.Unlock()
		if err != nil {
			m.fail++
			// Log the first failure and then every tenth, so an outage does
			// not drown the log.
			if m.fail == 1 || m.fail%10 == 0 {
				log.Printf("public-chain mirror: %s not mirrored (%d consecutive failures): %v", shortCID(d.CID), m.fail, err)
			}
			return
		}
		m.fail = 0
		log.Printf("public-chain mirror: %s anchored on EVM, tx %s", shortCID(d.CID), txHash)
	}()
}

func shortCID(cid string) string {
	if len(cid) > 14 {
		return cid[:14] + "…"
	}
	return cid
}

// ------------------------------------------------------------------- reads

// VerifyDigestOnChain asks the contract, not us. This is the call a regulator
// or counterparty would make directly; we expose it so the gateway can show
// that the independent answer agrees with ours.
func (m *EVMMirror) VerifyDigestOnChain(sha256hex string) (anchored bool, status uint8, err error) {
	if m == nil {
		return false, 0, nil
	}
	digest, err := bytes32FromHex(sha256hex)
	if err != nil {
		return false, 0, err
	}
	data := append(selector("verifyDigest(bytes32)"), word(digest)...)

	res, err := m.call("eth_call", map[string]string{
		"to":   m.contract,
		"data": "0x" + hex.EncodeToString(data),
	}, "latest")
	if err != nil {
		return false, 0, err
	}
	var raw string
	if err := json.Unmarshal(res, &raw); err != nil {
		return false, 0, err
	}
	out, err := hex.DecodeString(strings.TrimPrefix(raw, "0x"))
	if err != nil || len(out) < 64 {
		return false, 0, fmt.Errorf("short return data")
	}
	// (bool anchored, Status status, Document doc) — doc is dynamic, so the
	// first two words are all we need and the third is an offset.
	return out[31] == 1, out[63], nil
}

// Total is the document count the contract itself reports — a cheap liveness
// check that also proves the address really holds our contract.
func (m *EVMMirror) Total() (uint64, error) {
	if m == nil {
		return 0, nil
	}
	res, err := m.call("eth_call", map[string]string{
		"to":   m.contract,
		"data": "0x" + hex.EncodeToString(selector("total()")),
	}, "latest")
	if err != nil {
		return 0, err
	}
	var raw string
	if err := json.Unmarshal(res, &raw); err != nil {
		return 0, err
	}
	b, err := hex.DecodeString(strings.TrimPrefix(raw, "0x"))
	if err != nil || len(b) < 32 {
		return 0, fmt.Errorf("short return data")
	}
	return new(big.Int).SetBytes(b[:32]).Uint64(), nil
}

func (m *EVMMirror) defaultAccount() (string, error) {
	res, err := m.call("eth_accounts")
	if err != nil {
		return "", err
	}
	var accs []string
	if err := json.Unmarshal(res, &accs); err != nil {
		return "", err
	}
	if len(accs) == 0 {
		return "", fmt.Errorf("no unlocked accounts; set EVM_SENDER_ADDRESS")
	}
	return accs[0], nil
}
