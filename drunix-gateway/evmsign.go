package drunix

// Signing an Ethereum transaction here, in the rail, with no new dependency.
//
// WHY THIS FILE EXISTS. The EVM mirror in evm_mirror.go writes by calling
// eth_sendTransaction, which asks the node to sign on our behalf out of an
// account it has unlocked. That works against ganache or anvil and against
// nothing else. No public chain holds your keys: Sepolia, and every provider
// in front of it, accepts eth_sendRawTransaction only. So a rail that cannot
// build and sign a raw transaction cannot write to a public chain at all,
// whatever its configuration file says.
//
// That gap is the whole of what was left open in AMA item 27: "not deployed
// to a public testnet, and the rail does not write to it automatically". The
// first half is a funded key. The second half is this file.
//
// WHAT IS IMPLEMENTED. secp256k1 scalar multiplication and ECDSA signing over
// it, RFC 6979 deterministic nonces, the low-s normalisation Ethereum
// requires, recovery-id computation, minimal RLP, and EIP-155 legacy
// transaction encoding. Legacy rather than EIP-1559 because it is the shorter
// thing to get exactly right and every chain still accepts it; the cost is
// paying gasPrice rather than a tip, which on a testnet is not a cost.
//
// WHY NOT A LIBRARY. go-ethereum pulls in a very large dependency tree for
// what is, at this scale, four operations. The arithmetic below is the
// textbook form, double-and-add on affine coordinates with big.Int, which is
// slower than a field-specialised implementation and entirely fast enough for
// one signature per transaction.
//
// WHAT THIS IS NOT. Not constant-time, and it makes no attempt to be. It is
// unsuitable for a key holding real value, which is stated again where the
// key is loaded and on the screen that uses it. The intended key is a
// testnet key funded from a faucet. A production deployment signs in an HSM
// or a KMS and this file is the thing it replaces.

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"math/big"
	"strings"
)

// secp256k1 domain parameters.
var (
	secpP  = mustBig("fffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2f")
	secpN  = mustBig("fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141")
	secpGx = mustBig("79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798")
	secpGy = mustBig("483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8")
	secpB  = big.NewInt(7)

	// halfN is the boundary for low-s normalisation. A signature is
	// malleable because (r, s) and (r, n-s) both verify; Ethereum rejects
	// the high half outright (EIP-2) rather than accepting either.
	halfN = new(big.Int).Rsh(secpN, 1)
)

func mustBig(h string) *big.Int {
	v, ok := new(big.Int).SetString(h, 16)
	if !ok {
		panic("evmsign: bad constant " + h)
	}
	return v
}

// ErrEVMNoSigner is returned when a write is attempted with no key loaded.
// It is deliberately distinct from a transport failure: "we cannot sign" and
// "the chain did not answer" are different problems with different fixes,
// and collapsing them is how a system ends up reporting that a public chain
// is down when in fact it was never configured to write to one.
var ErrEVMNoSigner = errors.New("ERR_EVM_NO_SIGNER")

// --------------------------------------------------------- curve arithmetic

type point struct{ x, y *big.Int } // nil x and y means the point at infinity

func (p point) isInf() bool { return p.x == nil }

func modP(v *big.Int) *big.Int { return new(big.Int).Mod(v, secpP) }

func pointDouble(p point) point {
	if p.isInf() || p.y.Sign() == 0 {
		return point{}
	}
	// lambda = 3x^2 / 2y   (a = 0 for this curve, which drops a term)
	num := modP(new(big.Int).Mul(big.NewInt(3), new(big.Int).Mul(p.x, p.x)))
	den := new(big.Int).ModInverse(modP(new(big.Int).Lsh(p.y, 1)), secpP)
	if den == nil {
		return point{}
	}
	lam := modP(new(big.Int).Mul(num, den))
	x := modP(new(big.Int).Sub(new(big.Int).Mul(lam, lam), new(big.Int).Lsh(p.x, 1)))
	y := modP(new(big.Int).Sub(new(big.Int).Mul(lam, new(big.Int).Sub(p.x, x)), p.y))
	return point{x, y}
}

func pointAdd(a, b point) point {
	if a.isInf() {
		return b
	}
	if b.isInf() {
		return a
	}
	if a.x.Cmp(b.x) == 0 {
		if a.y.Cmp(b.y) == 0 {
			return pointDouble(a)
		}
		return point{} // mutually inverse
	}
	den := new(big.Int).ModInverse(modP(new(big.Int).Sub(b.x, a.x)), secpP)
	if den == nil {
		return point{}
	}
	lam := modP(new(big.Int).Mul(modP(new(big.Int).Sub(b.y, a.y)), den))
	x := modP(new(big.Int).Sub(new(big.Int).Sub(new(big.Int).Mul(lam, lam), a.x), b.x))
	y := modP(new(big.Int).Sub(new(big.Int).Mul(lam, new(big.Int).Sub(a.x, x)), a.y))
	return point{x, y}
}

// scalarMul is plain double-and-add. Not constant-time; see the file header.
func scalarMul(k *big.Int, p point) point {
	acc := point{}
	add := p
	for i := 0; i < k.BitLen(); i++ {
		if k.Bit(i) == 1 {
			acc = pointAdd(acc, add)
		}
		add = pointDouble(add)
	}
	return acc
}

func basePoint() point { return point{new(big.Int).Set(secpGx), new(big.Int).Set(secpGy)} }

// ------------------------------------------------------------------- keys

// EVMKey is a secp256k1 private key and the address derived from it.
type EVMKey struct {
	d       *big.Int
	Address string // 0x-prefixed, lowercase
}

// ParseEVMKey reads a 32-byte private key in hex, with or without 0x.
func ParseEVMKey(h string) (*EVMKey, error) {
	h = strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(h), "0x"))
	raw, err := hex.DecodeString(h)
	if err != nil {
		return nil, fmt.Errorf("ERR_EVM_KEY_FORMAT: the key is not hexadecimal")
	}
	if len(raw) != 32 {
		return nil, fmt.Errorf("ERR_EVM_KEY_FORMAT: a secp256k1 key is 32 bytes, this one is %d", len(raw))
	}
	d := new(big.Int).SetBytes(raw)
	// Rejecting zero and anything at or above the group order is not
	// pedantry: both produce a key that signs but cannot be verified, and
	// the failure would surface much later as an unexplained rejection
	// from the chain.
	if d.Sign() == 0 || d.Cmp(secpN) >= 0 {
		return nil, fmt.Errorf("ERR_EVM_KEY_RANGE: the key is not a valid secp256k1 scalar")
	}
	pub := scalarMul(d, basePoint())
	// The address is the last 20 bytes of the keccak of the uncompressed
	// public key with its 0x04 prefix removed.
	buf := make([]byte, 64)
	pub.x.FillBytes(buf[:32])
	pub.y.FillBytes(buf[32:])
	sum := keccak(buf)
	return &EVMKey{d: d, Address: "0x" + hex.EncodeToString(sum[12:])}, nil
}

// --------------------------------------------------------------- signing

// rfc6979 derives the nonce deterministically from the key and the message.
//
// A random nonce is correct in theory and catastrophic in practice: repeat
// one across two signatures and the private key falls out by subtraction,
// which is how several well-publicised wallet compromises happened. The
// deterministic construction removes the entropy source from the attack
// surface entirely, and has the side benefit that a signature is reproducible
// in a test.
func rfc6979(d *big.Int, hash []byte) *big.Int {
	x := make([]byte, 32)
	d.FillBytes(x)
	k := make([]byte, 32)
	v := make([]byte, 32)
	for i := range v {
		v[i] = 0x01
	}
	mac := func(key, data []byte) []byte {
		h := hmac.New(sha256.New, key)
		h.Write(data)
		return h.Sum(nil)
	}
	k = mac(k, append(append(append([]byte{}, v...), 0x00), append(x, hash...)...))
	v = mac(k, v)
	k = mac(k, append(append(append([]byte{}, v...), 0x01), append(x, hash...)...))
	v = mac(k, v)
	for {
		v = mac(k, v)
		cand := new(big.Int).SetBytes(v)
		if cand.Sign() != 0 && cand.Cmp(secpN) < 0 {
			return cand
		}
		k = mac(k, append(append([]byte{}, v...), 0x00))
		v = mac(k, v)
	}
}

// signHash produces (r, s, recoveryID) over a 32-byte digest.
func signHash(key *EVMKey, hash []byte) (r, s *big.Int, rec byte, err error) {
	if key == nil {
		return nil, nil, 0, ErrEVMNoSigner
	}
	if len(hash) != 32 {
		return nil, nil, 0, fmt.Errorf("ERR_EVM_SIGN: a digest is 32 bytes, got %d", len(hash))
	}
	z := new(big.Int).SetBytes(hash)
	k := rfc6979(key.d, hash)
	for attempt := 0; attempt < 16; attempt++ {
		p := scalarMul(k, basePoint())
		if p.isInf() {
			k = new(big.Int).Add(k, big.NewInt(1))
			continue
		}
		r = new(big.Int).Mod(p.x, secpN)
		if r.Sign() == 0 {
			k = new(big.Int).Add(k, big.NewInt(1))
			continue
		}
		kInv := new(big.Int).ModInverse(k, secpN)
		s = new(big.Int).Mod(new(big.Int).Mul(kInv,
			new(big.Int).Add(z, new(big.Int).Mul(r, key.d))), secpN)
		if s.Sign() == 0 {
			k = new(big.Int).Add(k, big.NewInt(1))
			continue
		}
		// Recovery id: the parity of the y coordinate of kG, plus a bit
		// for the rare case where the x coordinate exceeded the group
		// order and wrapped.
		rec = byte(p.y.Bit(0))
		if p.x.Cmp(r) != 0 {
			rec |= 2
		}
		// Low-s normalisation flips the parity with it.
		if s.Cmp(halfN) > 0 {
			s = new(big.Int).Sub(secpN, s)
			rec ^= 1
		}
		return r, s, rec, nil
	}
	return nil, nil, 0, fmt.Errorf("ERR_EVM_SIGN: no valid nonce found")
}

// ------------------------------------------------------------------- RLP

func rlpBytes(b []byte) []byte {
	if len(b) == 1 && b[0] < 0x80 {
		return b
	}
	return append(rlpLenPrefix(len(b), 0x80), b...)
}

func rlpList(items ...[]byte) []byte {
	var body []byte
	for _, it := range items {
		body = append(body, it...)
	}
	return append(rlpLenPrefix(len(body), 0xc0), body...)
}

func rlpLenPrefix(n int, offset byte) []byte {
	if n <= 55 {
		return []byte{offset + byte(n)}
	}
	var be []byte
	for v := n; v > 0; v >>= 8 {
		be = append([]byte{byte(v)}, be...)
	}
	return append([]byte{offset + 55 + byte(len(be))}, be...)
}

// rlpUint encodes an integer with no leading zero bytes, which is what makes
// zero encode as the empty string rather than as a zero byte.
func rlpUint(v *big.Int) []byte {
	if v == nil || v.Sign() == 0 {
		return rlpBytes(nil)
	}
	return rlpBytes(v.Bytes())
}

// ------------------------------------------------------- transaction build

// EVMTx is a legacy (type 0) Ethereum transaction.
type EVMTx struct {
	Nonce    uint64
	GasPrice *big.Int
	Gas      uint64
	To       string // empty for contract creation
	Value    *big.Int
	Data     []byte
	ChainID  int64
}

func hexToAddrBytes(s string) ([]byte, error) {
	s = strings.TrimPrefix(strings.TrimSpace(s), "0x")
	if s == "" {
		return nil, nil
	}
	b, err := hex.DecodeString(s)
	if err != nil || len(b) != 20 {
		return nil, fmt.Errorf("ERR_EVM_ADDRESS: %q is not a 20-byte address", s)
	}
	return b, nil
}

// SignTx returns the raw RLP of a signed EIP-155 transaction, 0x-prefixed,
// ready for eth_sendRawTransaction, and its transaction hash.
//
// EIP-155 is the replay protection: the chain id goes into the digest, so a
// transaction signed for Sepolia cannot be replayed onto another chain by
// anyone who sees it. Omitting it is a real hazard when the same key is used
// on more than one network, which on a testnet key it very often is.
func SignTx(key *EVMKey, tx EVMTx) (raw string, txHash string, err error) {
	if key == nil {
		return "", "", ErrEVMNoSigner
	}
	to, err := hexToAddrBytes(tx.To)
	if err != nil {
		return "", "", err
	}
	gasPrice := tx.GasPrice
	if gasPrice == nil {
		gasPrice = big.NewInt(0)
	}
	value := tx.Value
	if value == nil {
		value = big.NewInt(0)
	}
	base := []([]byte){
		rlpUint(new(big.Int).SetUint64(tx.Nonce)),
		rlpUint(gasPrice),
		rlpUint(new(big.Int).SetUint64(tx.Gas)),
		rlpBytes(to),
		rlpUint(value),
		rlpBytes(tx.Data),
	}
	signing := rlpList(append(base,
		rlpUint(big.NewInt(tx.ChainID)), rlpBytes(nil), rlpBytes(nil))...)

	r, s, rec, err := signHash(key, keccak(signing))
	if err != nil {
		return "", "", err
	}
	v := big.NewInt(int64(rec) + 35 + tx.ChainID*2)
	signed := rlpList(append(base, rlpUint(v), rlpUint(r), rlpUint(s))...)
	return "0x" + hex.EncodeToString(signed), "0x" + hex.EncodeToString(keccak(signed)), nil
}
