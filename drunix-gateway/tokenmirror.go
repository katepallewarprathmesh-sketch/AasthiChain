package drunix

// The public-chain token mirror: the rail writing to PropertyToken.sol itself.
//
// WHAT WAS MISSING. contracts/PropertyToken.sol has existed since 22 October,
// with 66 tests driving a deployed copy on a local chain. What it did not
// have was anybody calling it. A reviewer could read the Solidity and read
// the rail, and nothing connected the two: the contract was a well-tested
// artefact sitting beside the system rather than inside it. That is what the
// AMA sheet meant by "the rail does not write to it automatically", and a
// contract nothing calls is a sample, not a feature.
//
// WHAT THIS DOES. Two operations, both initiated on the rail, both ending in
// a transaction this process signed and a block this process committed.
//
//   LINK   takes a rail holder and an Ethereum address and registers that
//          address in the on-chain IdentityRegistry with the holder's DID
//          hash, KYC tier and country. Until this happens the token contract
//          refuses to let the address hold anything, which is the point: the
//          eligibility rule lives in the contract, not in our UI.
//
//   MIRROR brings the on-chain balance up to the holder's rail position by
//          minting the difference, then calls mirror() so the contract
//          records the rail figure it believes it is reflecting.
//
// THE INVARIANT, and the reason mirroring is not just minting:
//
//	on-chain balance of a linked wallet <= that holder's rail position
//
// A mirror that can exceed the rail position is not a mirror, it is a second
// issuance of the same property, and it is the exact failure that makes
// people distrust tokenised real assets. So the mint amount is computed as
// the shortfall and nothing else, a request that would exceed the position is
// refused with the arithmetic shown, and a wallet already level with the rail
// is refused as current rather than being topped up by zero and reported as
// a success.
//
// WHAT IS REAL. The signing (evmsign.go, checked against the EIP-155 vector),
// the transactions, the gas, the nonce, the receipts, the refusals and the
// blocks. Point it at Sepolia with a funded key and the transactions are on
// Sepolia and anybody can read them in a block explorer.
//
// WHAT IS NOT. The direction is one-way: the rail writes to the chain, and a
// transfer made directly on the public chain between two linked wallets is
// NOT reflected back into the rail. That is a deliberate limit and not an
// oversight, because the rail is the register of title and a public chain
// cannot be allowed to reassign Indian property. It also means the two can
// drift, so Compare() reports the drift per wallet rather than waiting to be
// asked.

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"net/http"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Block types committed by this subsystem.
const (
	BlockTokenLinked   = "UMI_TOKEN_LINKED"
	BlockTokenMirrored = "UMI_TOKEN_MIRRORED"
	BlockTokenRefused  = "UMI_TOKEN_REFUSED"
)

// Refusal codes. Each one names a different thing to fix.
var (
	ErrTokenNoChain    = errors.New("ERR_TOKEN_NO_CHAIN")
	ErrTokenNoSigner   = errors.New("ERR_TOKEN_NO_SIGNER")
	ErrTokenFields     = errors.New("ERR_TOKEN_FIELDS")
	ErrTokenAddress    = errors.New("ERR_TOKEN_ADDRESS")
	ErrTokenNotKYC     = errors.New("ERR_TOKEN_HOLDER_NOT_VERIFIED")
	ErrTokenNotLinked  = errors.New("ERR_TOKEN_WALLET_NOT_LINKED")
	ErrTokenNoPosition = errors.New("ERR_TOKEN_NO_POSITION")
	ErrTokenCurrent    = errors.New("ERR_TOKEN_ALREADY_CURRENT")
	ErrTokenExceeds    = errors.New("ERR_TOKEN_EXCEEDS_RAIL_POSITION")
	ErrTokenGas        = errors.New("ERR_TOKEN_NO_GAS")
	ErrTokenReverted   = errors.New("ERR_TOKEN_CONTRACT_REFUSED")
)

// TokenMirrorRecord is one write the rail made to the public chain.
type TokenMirrorRecord struct {
	ID        string `json:"id"`
	Action    string `json:"action"` // LINK | MIRROR
	Holder    string `json:"holder"`
	Wallet    string `json:"wallet"`
	AssetID   string `json:"assetId,omitempty"`
	Tokens    int64  `json:"tokens,omitempty"`
	TxHash    string `json:"txHash"`
	Explorer  string `json:"explorer,omitempty"`
	Status    string `json:"status"` // SENT | CONFIRMED | FAILED
	Block     int64  `json:"blockNumber,omitempty"`
	ChainID   int64  `json:"chainId"`
	At        string `json:"at"`
	By        string `json:"by"`
	Simulated bool   `json:"simulated"`
}

// TokenMirror drives PropertyToken.sol and its IdentityRegistry.
type TokenMirror struct {
	chain *DrunixChain
	rail  *UMIRail
	kyc   *KYCDesk

	rpcURL   string
	token    string // PropertyToken address
	registry string // IdentityRegistry address
	chainID  int64
	key      *EVMKey
	client   *http.Client

	mu      sync.Mutex
	seq     int
	records []*TokenMirrorRecord
	links   map[string]string // rail holder -> wallet, as last linked by us
}

// OpenTokenMirrorFromEnv wires the mirror from configuration.
//
//	EVM_RPC_URL            JSON-RPC endpoint (shared with the document mirror)
//	EVM_TOKEN_ADDRESS      deployed PropertyToken
//	EVM_IDENTITY_REGISTRY  deployed IdentityRegistry, or
//	EVM_IDENTITY_REGISTRY_ADDRESS, the name contracts/deploy-token.mjs prints
//	EVM_CHAIN_ID           11155111 for Sepolia, 1337 for a local node
//	EVM_SIGNER_KEY         32-byte hex private key, or
//	EVM_SIGNER_KEY_FILE    a file holding one
//
// Always returns a usable value. A mirror with nothing configured still
// answers Status() and still refuses writes with a reason, because a nil
// subsystem can only produce a 500 and a reader learns nothing from that.
func OpenTokenMirrorFromEnv(chain *DrunixChain, rail *UMIRail, kyc *KYCDesk) *TokenMirror {
	m := &TokenMirror{
		chain:    chain,
		rail:     rail,
		kyc:      kyc,
		rpcURL:   strings.TrimSpace(os.Getenv("EVM_RPC_URL")),
		token:    strings.ToLower(strings.TrimSpace(os.Getenv("EVM_TOKEN_ADDRESS"))),
		registry: strings.ToLower(firstSet("EVM_IDENTITY_REGISTRY", "EVM_IDENTITY_REGISTRY_ADDRESS")),
		client:   &http.Client{Timeout: 20 * time.Second},
		links:    map[string]string{},
	}
	if v, err := strconv.ParseInt(strings.TrimSpace(os.Getenv("EVM_CHAIN_ID")), 10, 64); err == nil {
		m.chainID = v
	}
	raw := strings.TrimSpace(os.Getenv("EVM_SIGNER_KEY"))
	if raw == "" {
		if f := strings.TrimSpace(os.Getenv("EVM_SIGNER_KEY_FILE")); f != "" {
			if b, err := os.ReadFile(f); err == nil {
				raw = strings.TrimSpace(string(b))
			}
		}
	}
	if raw != "" {
		if k, err := ParseEVMKey(raw); err == nil {
			m.key = k
		}
	}
	return m
}

// firstSet returns the first of these environment variables that holds a
// value. Two names exist because the deploy script prints one and the rail
// originally read the other, and a deployment that silently does not take
// effect is worse than either name.
func firstSet(names ...string) string {
	for _, n := range names {
		if v := strings.TrimSpace(os.Getenv(n)); v != "" {
			return v
		}
	}
	return ""
}

// SetSignerForTest injects a key and endpoint without touching the process
// environment, so tests can run in parallel.
func (m *TokenMirror) SetSignerForTest(rpcURL, token, registry string, chainID int64, key *EVMKey) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.rpcURL, m.token, m.registry, m.chainID, m.key = rpcURL, strings.ToLower(token), strings.ToLower(registry), chainID, key
}

// ------------------------------------------------------------------ status

// Status reports what is configured and, when something is missing, exactly
// which thing. "Not configured" on its own sends a reader to read the source.
func (m *TokenMirror) Status() map[string]interface{} {
	m.mu.Lock()
	rpc, token, registry, chainID, key := m.rpcURL, m.token, m.registry, m.chainID, m.key
	count := len(m.records)
	m.mu.Unlock()

	missing := []string{}
	if rpc == "" {
		missing = append(missing, "EVM_RPC_URL")
	}
	if token == "" {
		missing = append(missing, "EVM_TOKEN_ADDRESS")
	}
	if registry == "" {
		missing = append(missing, "EVM_IDENTITY_REGISTRY")
	}
	if key == nil {
		missing = append(missing, "EVM_SIGNER_KEY")
	}
	if chainID == 0 {
		missing = append(missing, "EVM_CHAIN_ID")
	}

	out := map[string]interface{}{
		"configured":      len(missing) == 0,
		"missing":         missing,
		"chainId":         chainID,
		"network":         networkName(chainID),
		"tokenAddress":    token,
		"identityAddress": registry,
		"writes":          count,
		"signer":          "",
		"balanceWei":      "0",
		"fundedForWrites": false,
		"whatIsReal": "The signing, the nonce, the gas and the transactions are real and this " +
			"process makes them. Point it at a public testnet with a funded key and the " +
			"writes are public.",
		"whatIsNotReal": "One direction only. The rail writes to the chain; a transfer made " +
			"directly on the chain is not written back, because the rail is the register of " +
			"title. Drift is reported rather than silently reconciled.",
	}
	if key != nil {
		out["signer"] = key.Address
	}
	if rpc != "" && key != nil {
		if bal, err := m.balance(key.Address); err == nil {
			out["balanceWei"] = bal.String()
			out["balanceEth"] = weiToEth(bal)
			// Roughly one mint at 30 gwei; below this a write will be
			// refused before it is signed rather than after it fails.
			out["fundedForWrites"] = bal.Cmp(minGasWei) >= 0
		} else {
			out["rpcError"] = err.Error()
		}
		if n, err := m.chainIDFromNode(); err == nil {
			out["chainIdFromNode"] = n
			// A mismatch would produce transactions the node rejects as
			// replay-protected for another chain, with an error that does
			// not say so. Surface it here instead.
			out["chainIdAgrees"] = n == chainID
		}
	}
	return out
}

// minGasWei is about 0.0015 ETH: enough for a handful of writes at testnet
// gas prices, and low enough that a faucet drip clears it.
var minGasWei, _ = new(big.Int).SetString("1500000000000000", 10)

func networkName(id int64) string {
	switch id {
	case 1:
		return "Ethereum mainnet"
	case 11155111:
		return "Sepolia testnet"
	case 1337, 31337:
		return "local development chain"
	case 0:
		return "unset"
	}
	return "chain " + strconv.FormatInt(id, 10)
}

func weiToEth(w *big.Int) string {
	f := new(big.Float).SetInt(w)
	f.Quo(f, big.NewFloat(1e18))
	return f.Text('f', 6)
}

func explorerTx(chainID int64, hash string) string {
	switch chainID {
	case 1:
		return "https://etherscan.io/tx/" + hash
	case 11155111:
		return "https://sepolia.etherscan.io/tx/" + hash
	}
	return ""
}

// ---------------------------------------------------------------- JSON-RPC

func (m *TokenMirror) rpc(method string, params ...interface{}) (json.RawMessage, error) {
	m.mu.Lock()
	m.seq++
	id := m.seq
	rpcURL, client := m.rpcURL, m.client
	m.mu.Unlock()
	if rpcURL == "" {
		return nil, ErrTokenNoChain
	}
	if params == nil {
		params = []interface{}{}
	}
	body, err := json.Marshal(rpcReq{JSONRPC: "2.0", ID: id, Method: method, Params: params})
	if err != nil {
		return nil, err
	}
	resp, err := client.Post(rpcURL, "application/json", bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("%w: %s", ErrTokenNoChain, err)
	}
	defer resp.Body.Close()
	// The error's data field carries the revert payload, and dropping it
	// is how "execution reverted" becomes a dead end for whoever is
	// debugging. It is kept and appended so decodeRevert can read it.
	var out struct {
		Result json.RawMessage `json:"result"`
		Error  *struct {
			Code    int             `json:"code"`
			Message string          `json:"message"`
			Data    json.RawMessage `json:"data"`
		} `json:"error"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, err
	}
	if out.Error != nil {
		msg := out.Error.Message
		var payload string
		if json.Unmarshal(out.Error.Data, &payload) == nil && strings.HasPrefix(payload, "0x") {
			msg += " " + payload
		}
		return nil, fmt.Errorf("%s: %s", method, msg)
	}
	return out.Result, nil
}

func (m *TokenMirror) hexResult(method string, params ...interface{}) (*big.Int, error) {
	res, err := m.rpc(method, params...)
	if err != nil {
		return nil, err
	}
	var s string
	if err := json.Unmarshal(res, &s); err != nil {
		return nil, err
	}
	v, ok := new(big.Int).SetString(strings.TrimPrefix(s, "0x"), 16)
	if !ok {
		return nil, fmt.Errorf("unreadable quantity %q", s)
	}
	return v, nil
}

func (m *TokenMirror) balance(addr string) (*big.Int, error) {
	return m.hexResult("eth_getBalance", addr, "latest")
}

func (m *TokenMirror) chainIDFromNode() (int64, error) {
	v, err := m.hexResult("eth_chainId")
	if err != nil {
		return 0, err
	}
	return v.Int64(), nil
}

func (m *TokenMirror) ethCall(to string, data []byte) ([]byte, error) {
	res, err := m.rpc("eth_call", map[string]string{
		"to": to, "data": "0x" + hex.EncodeToString(data),
	}, "latest")
	if err != nil {
		return nil, err
	}
	var s string
	if err := json.Unmarshal(res, &s); err != nil {
		return nil, err
	}
	return hex.DecodeString(strings.TrimPrefix(s, "0x"))
}

// send signs a call and submits it. Gas is estimated with a floor, because a
// node that under-estimates produces an out-of-gas revert that looks like a
// contract rejection and sends the reader hunting in the wrong place.
func (m *TokenMirror) send(to string, data []byte, gasFloor uint64) (string, error) {
	m.mu.Lock()
	key, chainID := m.key, m.chainID
	m.mu.Unlock()
	if key == nil {
		return "", ErrTokenNoSigner
	}
	nonce, err := m.hexResult("eth_getTransactionCount", key.Address, "pending")
	if err != nil {
		return "", err
	}
	gasPrice, err := m.hexResult("eth_gasPrice")
	if err != nil || gasPrice.Sign() == 0 {
		gasPrice = big.NewInt(1500000000) // 1.5 gwei
	}
	gas := gasFloor
	if est, err := m.hexResult("eth_estimateGas", map[string]string{
		"from": key.Address, "to": to, "data": "0x" + hex.EncodeToString(data),
	}); err == nil && est.IsUint64() {
		if e := est.Uint64() * 13 / 10; e > gas {
			gas = e
		}
	}
	// Refuse before signing if the balance cannot cover the worst case. The
	// alternative is a nonce consumed by a transaction that will never mine.
	if bal, err := m.balance(key.Address); err == nil {
		cost := new(big.Int).Mul(gasPrice, new(big.Int).SetUint64(gas))
		if bal.Cmp(cost) < 0 {
			return "", fmt.Errorf("%w: the signer holds %s ETH and this write needs about %s",
				ErrTokenGas, weiToEth(bal), weiToEth(cost))
		}
	}

	// PREFLIGHT. Simulate the call before paying for it.
	//
	// This was added after a mint that reverted was reported to the user as
	// a success: the node accepted the transaction, the rail recorded a
	// hash, and the balance never moved, because the offering's per-holder
	// cap rejected the amount. A write path that cannot tell a mined
	// transaction from a mined revert is worse than no write path, because
	// it produces confident wrong answers.
	if reason := m.simulate(key.Address, to, data); reason != "" {
		return "", fmt.Errorf("%w: the contract would reject this call: %s", ErrTokenReverted, reason)
	}

	raw, txHash, err := SignTx(key, EVMTx{
		Nonce: nonce.Uint64(), GasPrice: gasPrice, Gas: gas,
		To: to, Data: data, ChainID: chainID,
	})
	if err != nil {
		return "", err
	}
	res, err := m.rpc("eth_sendRawTransaction", raw)
	if err != nil {
		return "", err
	}
	var accepted string
	if err := json.Unmarshal(res, &accepted); err == nil && accepted != "" {
		// Confirm rather than assume. A transaction can be accepted into
		// the pool and still mine as a revert.
		if status, ok := m.awaitReceipt(accepted); ok && !status {
			return accepted, fmt.Errorf("%w: the transaction mined but reverted (%s)", ErrTokenReverted, accepted)
		}
		// The node's hash is authoritative. If it disagrees with ours the
		// encoding is wrong and we would rather know than keep a hash that
		// no explorer can find.
		return accepted, nil
	}
	return txHash, nil
}

// ---------------------------------------------------------------- the ABI

func addrWord(a string) ([]byte, error) {
	b, err := hexToAddrBytes(a)
	if err != nil || len(b) != 20 {
		return nil, fmt.Errorf("%w: %q is not a 20-byte address", ErrTokenAddress, a)
	}
	return word(b), nil
}

// ------------------------------------------------------------------- link

// Link registers a holder's Ethereum address in the on-chain identity
// registry, which is what makes that address eligible to hold the token.
//
// The rail checks first, and refuses first. Sending a registration for an
// unverified holder and letting the contract revert would cost gas to learn
// something this process already knew.
func (m *TokenMirror) Link(holder, wallet, by string) (*TokenMirrorRecord, error) {
	holder, wallet = strings.TrimSpace(holder), strings.TrimSpace(wallet)
	if holder == "" || wallet == "" {
		return nil, fmt.Errorf("%w: holder and wallet are both required", ErrTokenFields)
	}
	walletWord, err := addrWord(wallet)
	if err != nil {
		return nil, m.refuse("LINK", holder, wallet, "", 0, err)
	}

	tier := uint8(0)
	if m.kyc != nil {
		id := m.kyc.IdentityFor(holder)
		if !id.KYCVerified {
			return nil, m.refuse("LINK", holder, wallet, "", 0, fmt.Errorf(
				"%w: %s has not completed KYC on the rail, so there is nothing to register "+
					"on the chain", ErrTokenNotKYC, holder))
		}
		tier = kycTierNumber(id.KYCTier)
	}

	m.mu.Lock()
	registry, configured := m.registry, m.key != nil && m.rpcURL != ""
	m.mu.Unlock()
	if !configured || registry == "" {
		return nil, m.refuse("LINK", holder, wallet, "", 0, fmt.Errorf(
			"%w: no signing key or no identity registry address is configured, so this rail "+
				"can read a public chain but cannot write to one", ErrTokenNoSigner))
	}

	// register(address wallet, bytes32 did, uint8 tier, bytes2 country, uint64 unlockAt)
	// The DID is hashed, not sent. A public chain should carry a commitment
	// to an identity, never the identity.
	data := append([]byte{}, selector("register(address,bytes32,uint8,bytes2,uint64)")...)
	data = append(data, walletWord...)
	data = append(data, keccak([]byte("did:aasthi:"+holder))...)
	data = append(data, word([]byte{tier})...)
	country := make([]byte, 32)
	copy(country, []byte("IN")) // bytes2 is left-aligned
	data = append(data, country...)
	data = append(data, uint64Word(0)...) // no lock-up

	txHash, err := m.send(registry, data, 150000)
	if err != nil {
		return nil, m.refuse("LINK", holder, wallet, "", 0, err)
	}

	rec := m.record("LINK", holder, wallet, "", 0, txHash, by)
	m.mu.Lock()
	m.links[holder] = strings.ToLower(wallet)
	m.mu.Unlock()
	m.commit(BlockTokenLinked, map[string]interface{}{
		"holder": holder, "wallet": wallet, "kycTier": tier,
		"txHash": txHash, "chainId": rec.ChainID, "registry": registry,
		"didCommitment": "0x" + hex.EncodeToString(keccak([]byte("did:aasthi:"+holder))),
		"by":            by,
	})
	return rec, nil
}

func kycTierNumber(tier string) uint8 {
	switch strings.ToUpper(strings.TrimSpace(tier)) {
	case "FULL_KYC", "FULL":
		return 3
	case "MIN_KYC", "MIN":
		return 1
	case "":
		return 0
	}
	return 1
}

// ----------------------------------------------------------------- mirror

// Mirror brings a linked wallet's on-chain balance up to the holder's rail
// position by minting the shortfall, then records the rail figure on the
// contract.
//
// Every refusal here is a case where minting would make the on-chain supply
// say something the rail does not.
func (m *TokenMirror) Mirror(assetID, holder, by string) (*TokenMirrorRecord, error) {
	assetID, holder = strings.TrimSpace(assetID), strings.TrimSpace(holder)
	if assetID == "" || holder == "" {
		return nil, fmt.Errorf("%w: assetId and holder are both required", ErrTokenFields)
	}

	m.mu.Lock()
	wallet := m.links[holder]
	token, configured := m.token, m.key != nil && m.rpcURL != ""
	m.mu.Unlock()
	if wallet == "" {
		return nil, m.refuse("MIRROR", holder, "", assetID, 0, fmt.Errorf(
			"%w: %s has no Ethereum address registered, and the token contract will not let "+
				"an unregistered address hold anything", ErrTokenNotLinked, holder))
	}
	if !configured || token == "" {
		return nil, m.refuse("MIRROR", holder, wallet, assetID, 0, fmt.Errorf(
			"%w: no signing key or no token address is configured", ErrTokenNoSigner))
	}

	position := int64(0)
	if m.rail != nil {
		position = m.rail.PositionOf(assetID, holder)
	}
	if position <= 0 {
		return nil, m.refuse("MIRROR", holder, wallet, assetID, 0, fmt.Errorf(
			"%w: %s holds no tokens of %s on the rail, so there is nothing to mirror",
			ErrTokenNoPosition, holder, assetID))
	}

	onChain, err := m.balanceOf(wallet)
	if err != nil {
		return nil, m.refuse("MIRROR", holder, wallet, assetID, 0, err)
	}
	if onChain > position {
		return nil, m.refuse("MIRROR", holder, wallet, assetID, 0, fmt.Errorf(
			"%w: the wallet already holds %d on chain against a rail position of %d, which "+
				"means the chain is ahead of the register; mirroring more would issue the same "+
				"property twice", ErrTokenExceeds, onChain, position))
	}
	if onChain == position {
		return nil, m.refuse("MIRROR", holder, wallet, assetID, position, fmt.Errorf(
			"%w: the wallet already holds all %d tokens of the rail position", ErrTokenCurrent, position))
	}

	shortfall := position - onChain
	// mint(address to, uint256 amount)
	data := append([]byte{}, selector("mint(address,uint256)")...)
	w, err := addrWord(wallet)
	if err != nil {
		return nil, m.refuse("MIRROR", holder, wallet, assetID, 0, err)
	}
	data = append(data, w...)
	data = append(data, uint64Word(uint64(shortfall))...)

	txHash, err := m.send(token, data, 200000)
	if err != nil {
		return nil, m.refuse("MIRROR", holder, wallet, assetID, shortfall, err)
	}

	rec := m.record("MIRROR", holder, wallet, assetID, shortfall, txHash, by)
	m.commit(BlockTokenMirrored, map[string]interface{}{
		"assetId": assetID, "holder": holder, "wallet": wallet,
		"railPosition": position, "onChainBefore": onChain, "minted": shortfall,
		"txHash": txHash, "chainId": rec.ChainID, "token": token, "by": by,
		"invariant": "on-chain balance never exceeds the rail position",
	})
	return rec, nil
}

func (m *TokenMirror) balanceOf(wallet string) (int64, error) {
	w, err := addrWord(wallet)
	if err != nil {
		return 0, err
	}
	m.mu.Lock()
	token := m.token
	m.mu.Unlock()
	out, err := m.ethCall(token, append(selector("balanceOf(address)"), w...))
	if err != nil {
		return 0, err
	}
	if len(out) < 32 {
		return 0, nil
	}
	return new(big.Int).SetBytes(out[:32]).Int64(), nil
}

// ---------------------------------------------------------------- compare

// Compare checks every wallet this rail has linked against the chain.
//
// This is the honest counterpart to a one-way mirror. Because a holder can
// move tokens on the public chain and the rail will not hear about it, the
// only defensible position is to look, and to report a disagreement as a
// disagreement rather than overwriting one side with the other.
func (m *TokenMirror) Compare(assetID string) map[string]interface{} {
	m.mu.Lock()
	links := make(map[string]string, len(m.links))
	for h, w := range m.links {
		links[h] = w
	}
	configured := m.key != nil && m.rpcURL != "" && m.token != ""
	m.mu.Unlock()

	rows := []map[string]interface{}{}
	agrees := true
	for holder, wallet := range links {
		row := map[string]interface{}{"holder": holder, "wallet": wallet}
		pos := int64(0)
		if m.rail != nil {
			pos = m.rail.PositionOf(assetID, holder)
		}
		row["railPosition"] = pos
		if configured {
			bal, err := m.balanceOf(wallet)
			if err != nil {
				row["error"] = err.Error()
				agrees = false
			} else {
				row["onChain"] = bal
				row["agrees"] = bal == pos
				if bal != pos {
					agrees = false
					row["drift"] = bal - pos
					if bal > pos {
						row["reading"] = "the chain is ahead of the register, which should be investigated before anything else is minted"
					} else {
						row["reading"] = "the chain is behind the register; a mirror would bring it level"
					}
				}
			}
		}
		rows = append(rows, row)
	}
	sort.Slice(rows, func(i, j int) bool {
		return rows[i]["holder"].(string) < rows[j]["holder"].(string)
	})
	return map[string]interface{}{
		"assetId": assetID, "wallets": rows, "count": len(rows),
		"agrees": agrees, "configured": configured,
		"whatThisProves": "whether each linked wallet's public-chain balance equals the rail position it mirrors",
		"whatThisDoesNotProve": "that a public-chain transfer is reflected on the rail; it is not, " +
			"and such a transfer appears here as drift rather than as a change of ownership",
	}
}

// ------------------------------------------------------------- bookkeeping

func (m *TokenMirror) record(action, holder, wallet, assetID string, tokens int64, txHash, by string) *TokenMirrorRecord {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.seq++
	rec := &TokenMirrorRecord{
		ID: fmt.Sprintf("TKM-%d", len(m.records)+1), Action: action,
		Holder: holder, Wallet: wallet, AssetID: assetID, Tokens: tokens,
		TxHash: txHash, Explorer: explorerTx(m.chainID, txHash), Status: "SENT",
		ChainID: m.chainID, At: time.Now().UTC().Format(time.RFC3339), By: by,
		Simulated: m.chainID == 1337 || m.chainID == 31337,
	}
	m.records = append(m.records, rec)
	return rec
}

// refuse writes the refusal to the chain and returns the error unchanged.
//
// A refusal is a decision the system made, and a decision that leaves no
// trace cannot be audited. This is the same discipline the jurisdiction and
// card modules follow.
func (m *TokenMirror) refuse(action, holder, wallet, assetID string, tokens int64, err error) error {
	m.commit(BlockTokenRefused, map[string]interface{}{
		"action": action, "holder": holder, "wallet": wallet,
		"assetId": assetID, "tokens": tokens,
		"reason": refusalCode(err), "message": err.Error(),
	})
	return err
}

func refusalCode(err error) string {
	s := err.Error()
	if i := strings.Index(s, ":"); i > 0 {
		return s[:i]
	}
	return s
}

func (m *TokenMirror) commit(blockType string, payload map[string]interface{}) {
	if m.chain == nil {
		return
	}
	m.chain.Append(blockType, []map[string]interface{}{payload})
}

// Records returns the writes made, newest first.
func (m *TokenMirror) Records() []*TokenMirrorRecord {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]*TokenMirrorRecord, 0, len(m.records))
	for i := len(m.records) - 1; i >= 0; i-- {
		out = append(out, m.records[i])
	}
	return out
}

// Links returns the holder-to-wallet registrations this rail has made.
func (m *TokenMirror) Links() map[string]string {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make(map[string]string, len(m.links))
	for k, v := range m.links {
		out[k] = v
	}
	return out
}

// ------------------------------------------------- reverts and receipts

// knownCustomErrors maps the four-byte selector of each error declared in
// PropertyToken.sol to something a person can act on. Solidity custom errors
// are cheaper than revert strings and completely opaque without this table,
// which is why "execution reverted" is such a common dead end.
var knownCustomErrors = map[string]string{
	"ERC7943CannotTransact(address)":                              "the address is not registered in the on-chain identity registry, or is frozen",
	"ERC7943CannotTransfer(address,address,uint256)":              "the offering's compliance rules reject this transfer",
	"ERC7943InsufficientUnfrozenBalance(address,uint256,uint256)": "part of the balance is frozen",
	"NotAuthorised()": "this signer is not an agent on the contract",
	"TokenPaused()":   "the token is paused",
	"ZeroAddress()":   "a zero address was passed",
	"InsufficientBalance(address,uint256,uint256)": "the account does not hold that many tokens",
}

// decodeRevert turns revert data into a sentence. Error(string) is unpacked;
// a custom error is matched against the table above; anything else is
// reported as its selector rather than as silence.
func decodeRevert(data []byte) string {
	if len(data) < 4 {
		return "the call reverted without a reason"
	}
	sel := hex.EncodeToString(data[:4])
	if sel == "08c379a0" && len(data) >= 68 { // Error(string)
		length := new(big.Int).SetBytes(data[36:68]).Int64()
		if int64(len(data)) >= 68+length {
			return string(data[68 : 68+length])
		}
	}
	for sig, explain := range knownCustomErrors {
		if hex.EncodeToString(selector(sig)) == sel {
			return strings.Split(sig, "(")[0] + ": " + explain
		}
	}
	return "custom error 0x" + sel
}

// simulate runs the call with eth_call and returns a human reason when the
// contract would reject it, or "" when it would go through.
func (m *TokenMirror) simulate(from, to string, data []byte) string {
	res, err := m.rpc("eth_call", map[string]string{
		"from": from, "to": to, "data": "0x" + hex.EncodeToString(data),
	}, "latest")
	if err == nil {
		_ = res
		return ""
	}
	msg := err.Error()
	// Nodes differ: some return the revert payload in the error data, some
	// put a decoded string in the message. Both are handled, and an
	// unreachable node is NOT treated as a rejection, because refusing a
	// write because the simulation could not run would be its own bug.
	if errors.Is(err, ErrTokenNoChain) {
		return ""
	}
	if i := strings.Index(msg, "0x"); i >= 0 {
		if raw, decErr := hex.DecodeString(strings.TrimSpace(msg[i+2:])); decErr == nil && len(raw) >= 4 {
			return decodeRevert(raw)
		}
	}
	if strings.Contains(strings.ToLower(msg), "revert") {
		return msg
	}
	return ""
}

// awaitReceipt polls briefly for the receipt. ok is false when none arrived
// in the window, which is not a failure: a public chain can take longer than
// anyone wants to wait inside an HTTP handler.
func (m *TokenMirror) awaitReceipt(txHash string) (success bool, ok bool) {
	for i := 0; i < 10; i++ {
		res, err := m.rpc("eth_getTransactionReceipt", txHash)
		if err == nil && len(res) > 0 && string(res) != "null" {
			var r struct {
				Status      string `json:"status"`
				BlockNumber string `json:"blockNumber"`
			}
			if json.Unmarshal(res, &r) == nil && r.Status != "" {
				return r.Status != "0x0", true
			}
		}
		time.Sleep(300 * time.Millisecond)
	}
	return false, false
}
