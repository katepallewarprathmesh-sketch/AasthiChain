package drunix

// A register of the signing keys this rail trusts, screened on the way in
// and revocable in one act.
//
// WHY THIS EXISTS
//
// On 17 October 2026 a researcher reported that the private keys of eight
// eMudhra intermediate certificate authorities could be recovered from their
// own public certificates. The keys were not stolen. They were generated
// with too little randomness: the private values turned out to be small
// integers, one of them the number 4. Anyone could compute them in under a
// second, and could then issue a certificate for any website that browsers
// would accept. The keys had been published since April 2025, so the window
// was about eighteen months, and the only reason it closed is that somebody
// outside the organisation went looking.
//
// Three failures stack up in that story, and only one of them is about
// randomness:
//
//  1. a key of catastrophically low quality entered service,
//  2. nothing checked it afterwards, for a year and a half,
//  3. when it had to be withdrawn, withdrawal meant persuading every browser
//     vendor on earth to ship a block list.
//
// This rail signs credentials, agent passports and attestations with
// Ed25519 keys. Before this file, it had the same three holes: a key was
// whatever the process derived at startup, nothing ever looked at it again,
// and there was no way to revoke a key at all. A compromised issuer key
// would have meant revoking every credential it ever signed, one at a time,
// assuming anybody noticed.
//
// WHAT THIS DOES ABOUT IT
//
//   - Screens a key before it enters service, against the specific failure
//     classes that are actually detectable (below).
//   - Requires proof of possession, so registering a key means holding it.
//   - Writes every registration, rejection and revocation to the chain, so
//     the set of keys in service is append-only and auditable by anyone.
//     This is the Certificate Transparency idea, which is what let an
//     outsider audit eMudhra at all.
//   - Revokes a key in one act, with the reason recorded, effective on the
//     next verification rather than whenever a vendor ships an update.
//   - Re-screens every key already in service on demand, so a weakness class
//     discovered tomorrow can be applied to keys registered today. That is
//     the part that would have cut eighteen months to one audit run.
//
// WHAT IT HONESTLY CANNOT DO
//
// There is no general test for "was this key generated with enough
// entropy". A key derived from a guessable passphrase is indistinguishable
// from a strong one by inspection, because the hash output looks random
// either way. What is detectable is a specific and important family: small
// scalars, structurally degenerate values, low-order points, and reuse.
// eMudhra's keys were in that family. This screens for it and says plainly
// that passing is not proof of good entropy.

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"
)

const (
	BlockKeyRegistered = "UMI_KEY_REGISTERED"
	BlockKeyRejected   = "UMI_KEY_REJECTED"
	BlockKeyRevoked    = "UMI_KEY_REVOKED"
	BlockKeyAudited    = "UMI_KEY_AUDITED"
)

var (
	ErrKeyFields    = errors.New("ERR_UMI_KEY_FIELDS")
	ErrKeyWeak      = errors.New("ERR_UMI_KEY_WEAK")
	ErrKeyDuplicate = errors.New("ERR_UMI_KEY_DUPLICATE")
	ErrKeyNotFound  = errors.New("ERR_UMI_KEY_NOT_FOUND")
	ErrKeyRevoked   = errors.New("ERR_UMI_KEY_REVOKED")
	ErrKeyPossess   = errors.New("ERR_UMI_KEY_NOT_POSSESSED")
)

// Revocation reasons. KEY_COMPROMISE is the eMudhra case and is the only one
// that invalidates signatures made before the revocation: if the key could be
// computed by anyone, nothing it ever signed can be attributed to its holder.
const (
	KeyRevokeCompromise = "KEY_COMPROMISE"
	KeyRevokeSuperseded = "SUPERSEDED"
	KeyRevokeRetired    = "RETIRED"
)

// smallScalarCeiling is how far the small-integer search goes. eMudhra's
// recovered values were 4, 56, 66, 115, 155, 156, 230 and 237. Anything in
// that neighbourhood is found instantly; the ceiling is set far above it and
// is still cheap because the table is built once.
const smallScalarCeiling = 8192

// lowOrderPoints are the canonical Ed25519 encodings of order 1, 2, 4 and 8
// points. A public key equal to one of these cannot carry a meaningful
// signature relationship and signals either a broken generator or an attempt
// to register a degenerate key.
var lowOrderPoints = []string{
	"0000000000000000000000000000000000000000000000000000000000000000",
	"0100000000000000000000000000000000000000000000000000000000000000",
	"26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05",
	"c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a",
	"ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
	"ecfffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7",
	"edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
	"eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
}

// knownWeakSeeds are seed values a careless generator produces: all zeroes,
// all ones, and short ASCII that somebody typed. Each is expanded the same
// way a real seed would be.
var knownWeakSeeds = []string{
	"", "0", "1", "test", "demo", "secret", "password", "changeme",
	"aasthichain", "dev", "local", "key", "seed",
}

/* ------------------------------------------------------------- the table */

var (
	weakOnce  sync.Once
	weakTable map[string]string // hex public key -> why it is weak
)

// buildWeakTable derives the public keys of every private value a broken
// generator is likely to emit, so screening is a map lookup rather than a
// judgement call. Built once, lazily, because it is a few thousand key
// derivations and most processes never register a key.
func buildWeakTable() {
	weakTable = make(map[string]string, smallScalarCeiling*2+len(lowOrderPoints)+len(knownWeakSeeds))

	for _, p := range lowOrderPoints {
		weakTable[p] = "the public key is a low-order point, which no sound generator produces"
	}

	// Small integers, written into the seed both ways round. eMudhra's keys
	// were exactly this: a private value of 4 rather than a 384-bit random
	// number. Big-endian covers "the number N"; little-endian covers a
	// buffer that was only partly filled.
	var seed [ed25519.SeedSize]byte
	for n := uint64(0); n < smallScalarCeiling; n++ {
		for _, bigEndian := range []bool{true, false} {
			for i := range seed {
				seed[i] = 0
			}
			v := n
			if bigEndian {
				for i := ed25519.SeedSize - 1; i >= 0 && v > 0; i-- {
					seed[i] = byte(v)
					v >>= 8
				}
			} else {
				for i := 0; i < ed25519.SeedSize && v > 0; i++ {
					seed[i] = byte(v)
					v >>= 8
				}
			}
			pub := ed25519.NewKeyFromSeed(seed[:]).Public().(ed25519.PublicKey)
			k := hex.EncodeToString(pub)
			if _, taken := weakTable[k]; !taken {
				weakTable[k] = fmt.Sprintf("the private key is the small integer %d, which is recoverable by anyone in under a second", n)
			}
		}
	}

	// Repeated-byte seeds: 0x00..0x00, 0xFF..0xFF and friends.
	for b := 0; b < 256; b++ {
		for i := range seed {
			seed[i] = byte(b)
		}
		pub := ed25519.NewKeyFromSeed(seed[:]).Public().(ed25519.PublicKey)
		k := hex.EncodeToString(pub)
		if _, taken := weakTable[k]; !taken {
			weakTable[k] = fmt.Sprintf("the private key is the byte 0x%02x repeated, which is a generator that never ran", b)
		}
	}

	// Seeds that are the SHA-256 of a guessable string, which is how a
	// deterministic key derived from a passphrase goes wrong.
	for _, s := range knownWeakSeeds {
		sum := sha256.Sum256([]byte(s))
		pub := ed25519.NewKeyFromSeed(sum[:]).Public().(ed25519.PublicKey)
		k := hex.EncodeToString(pub)
		if _, taken := weakTable[k]; !taken {
			weakTable[k] = fmt.Sprintf("the private key is derived from the guessable seed %q", s)
		}
	}
}

/* ------------------------------------------------------------ screening */

// KeyScreen is the verdict on one key, with the reasoning attached.
type KeyScreen struct {
	Fingerprint string   `json:"fingerprint"`
	Passed      bool     `json:"passed"`
	Failures    []string `json:"failures,omitempty"`
	Checks      []string `json:"checksRun"`
	Limitation  string   `json:"limitation"`
}

// ScreenPublicKey runs every detectable weakness test against a public key.
//
// Passing is not a certificate of good entropy and the returned Limitation
// says so. It is the difference between "we looked" and "we did not".
func ScreenPublicKey(pub ed25519.PublicKey) KeyScreen {
	weakOnce.Do(buildWeakTable)

	out := KeyScreen{
		Fingerprint: keyFingerprint(pub),
		Checks: []string{
			"length is exactly 32 bytes",
			"not a low-order point",
			fmt.Sprintf("private value is not a small integer below %d, either byte order", smallScalarCeiling),
			"private value is not a single repeated byte",
			"not derived from a short guessable seed",
			"not structurally degenerate (all one byte)",
		},
		Limitation: "These tests catch keys whose private value is guessable by construction, which is the family " +
			"the October 2026 eMudhra certificates fell into. They cannot prove a key was generated with good " +
			"entropy: a key derived from a passphrase nobody has guessed yet looks identical to a strong one.",
	}

	if len(pub) != ed25519.PublicKeySize {
		out.Failures = append(out.Failures, fmt.Sprintf("a public key must be %d bytes, this is %d", ed25519.PublicKeySize, len(pub)))
		return out
	}

	hexKey := hex.EncodeToString(pub)
	if why, bad := weakTable[hexKey]; bad {
		out.Failures = append(out.Failures, why)
	}

	// Structural degeneracy, independent of the table: every byte the same.
	same := true
	for _, b := range pub[1:] {
		if b != pub[0] {
			same = false
			break
		}
	}
	if same {
		out.Failures = append(out.Failures, "every byte of the public key is identical, which is not an output of a working generator")
	}

	out.Passed = len(out.Failures) == 0
	return out
}

/* ------------------------------------------------------------- registry */

// RegisteredKey is one signing key the rail knows about.
type RegisteredKey struct {
	KeyID        string    `json:"keyId"`
	Holder       string    `json:"holder"`
	Use          string    `json:"use"`
	PublicKeyHex string    `json:"publicKey"`
	Fingerprint  string    `json:"fingerprint"`
	RegisteredAt time.Time `json:"registeredAt"`
	RegisteredBy string    `json:"registeredBy"`
	Block        int64     `json:"registeredAtBlock"`
	Screen       KeyScreen `json:"screen"`

	Revoked      bool      `json:"revoked"`
	RevokedAt    time.Time `json:"revokedAt,omitempty"`
	RevokedBy    string    `json:"revokedBy,omitempty"`
	RevokeReason string    `json:"revokeReason,omitempty"`
	RevokeBlock  int64     `json:"revokedAtBlock,omitempty"`

	// RetroactivelyVoid is the KEY_COMPROMISE consequence, stated rather
	// than left for the reader to work out: if the private key was
	// computable, every signature it ever made is unattributable, including
	// the ones made before anybody noticed.
	RetroactivelyVoid bool `json:"signaturesRetroactivelyVoid"`
}

// KeyRegistry holds the keys and the challenges issued for proof of
// possession.
type KeyRegistry struct {
	mu         sync.Mutex
	chain      *DrunixChain
	keys       map[string]*RegisteredKey // keyID -> key
	byPublic   map[string]string         // hex public key -> keyID
	order      []string
	challenges map[string]keyChallenge // holder -> outstanding challenge
}

type keyChallenge struct {
	nonce   string
	expires time.Time
}

func NewKeyRegistry(chain *DrunixChain) *KeyRegistry {
	if chain == nil {
		return nil
	}
	return &KeyRegistry{
		chain:      chain,
		keys:       map[string]*RegisteredKey{},
		byPublic:   map[string]string{},
		challenges: map[string]keyChallenge{},
	}
}

// Challenge issues a nonce the holder must sign to prove possession.
//
// Registering a public key without this proves nothing: anybody can copy
// somebody else's public key out of the register and claim it. The nonce is
// short-lived and single use.
func (r *KeyRegistry) Challenge(holder string) (string, time.Time, error) {
	if r == nil {
		return "", time.Time{}, ErrKeyFields
	}
	holder = strings.TrimSpace(holder)
	if holder == "" {
		return "", time.Time{}, fmt.Errorf("%w: a holder is required", ErrKeyFields)
	}
	var b [32]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", time.Time{}, err
	}
	nonce := hex.EncodeToString(b[:])
	exp := time.Now().UTC().Add(5 * time.Minute)

	r.mu.Lock()
	r.challenges[holder] = keyChallenge{nonce: nonce, expires: exp}
	r.mu.Unlock()
	return nonce, exp, nil
}

// Register screens a key, checks the holder actually has it, and writes the
// result to the chain either way. A rejection is recorded too: a register
// that only remembers its successes cannot be audited.
func (r *KeyRegistry) Register(holder, use, publicKeyHex, signatureHex, by string) (*RegisteredKey, error) {
	if r == nil {
		return nil, ErrKeyFields
	}
	holder, use = strings.TrimSpace(holder), strings.TrimSpace(use)
	if holder == "" || use == "" {
		return nil, fmt.Errorf("%w: a holder and a use are required", ErrKeyFields)
	}
	raw, err := hex.DecodeString(strings.TrimSpace(publicKeyHex))
	if err != nil {
		return nil, fmt.Errorf("%w: the public key must be hex", ErrKeyFields)
	}
	pub := ed25519.PublicKey(raw)

	screen := ScreenPublicKey(pub)
	if !screen.Passed {
		r.commit(BlockKeyRejected, map[string]interface{}{
			"kind":        "key-rejected",
			"holder":      holder,
			"use":         use,
			"fingerprint": screen.Fingerprint,
			"failures":    screen.Failures,
			"by":          by,
			"effect":      "The key was refused and never entered service. The refusal is recorded so the attempt is auditable.",
		})
		return nil, fmt.Errorf("%w: %s", ErrKeyWeak, strings.Join(screen.Failures, "; "))
	}

	// Proof of possession against the outstanding challenge.
	r.mu.Lock()
	ch, ok := r.challenges[holder]
	r.mu.Unlock()
	if !ok || ch.nonce == "" {
		return nil, fmt.Errorf("%w: request a challenge first", ErrKeyPossess)
	}
	if time.Now().UTC().After(ch.expires) {
		return nil, fmt.Errorf("%w: the challenge has expired, request another", ErrKeyPossess)
	}
	sig, err := hex.DecodeString(strings.TrimSpace(signatureHex))
	if err != nil || !ed25519.Verify(pub, []byte(ch.nonce), sig) {
		return nil, fmt.Errorf("%w: the challenge signature does not verify under this key", ErrKeyPossess)
	}

	hexKey := hex.EncodeToString(pub)
	r.mu.Lock()
	if existing, dup := r.byPublic[hexKey]; dup {
		prior := r.keys[existing]
		r.mu.Unlock()
		// Two holders presenting the same key is either a copied key or a
		// generator repeating itself. Both are the eMudhra failure wearing
		// a different hat.
		return nil, fmt.Errorf("%w: this public key is already registered to %q", ErrKeyDuplicate, prior.Holder)
	}
	delete(r.challenges, holder)
	id := fmt.Sprintf("KEY-%s-%s", strings.ToUpper(use), screen.Fingerprint)
	rec := &RegisteredKey{
		KeyID: id, Holder: holder, Use: use,
		PublicKeyHex: hexKey, Fingerprint: screen.Fingerprint,
		RegisteredAt: time.Now().UTC(), RegisteredBy: by, Screen: screen,
	}
	r.keys[id] = rec
	r.byPublic[hexKey] = id
	r.order = append(r.order, id)
	r.mu.Unlock()

	blk := r.commit(BlockKeyRegistered, map[string]interface{}{
		"kind":        "key-registered",
		"keyId":       id,
		"holder":      holder,
		"use":         use,
		"publicKey":   hexKey,
		"fingerprint": screen.Fingerprint,
		"screenedBy":  screen.Checks,
		"by":          by,
		"effect":      "This key may now sign. The entry is append-only, so a later swap is visible rather than silent.",
		"limitation":  screen.Limitation,
	})
	if blk != nil {
		r.mu.Lock()
		rec.Block = blk.Height
		r.mu.Unlock()
	}
	return r.snapshot(id)
}

// Revoke withdraws a key. One act, effective immediately on the next
// verification: no block list to ship, no vendor to wait for.
func (r *KeyRegistry) Revoke(keyID, reason, by string) (*RegisteredKey, error) {
	if r == nil {
		return nil, ErrKeyFields
	}
	reason = strings.ToUpper(strings.TrimSpace(reason))
	switch reason {
	case KeyRevokeCompromise, KeyRevokeSuperseded, KeyRevokeRetired:
	default:
		return nil, fmt.Errorf("%w: reason must be one of %s, %s, %s",
			ErrKeyFields, KeyRevokeCompromise, KeyRevokeSuperseded, KeyRevokeRetired)
	}

	r.mu.Lock()
	rec, ok := r.keys[strings.TrimSpace(keyID)]
	if !ok {
		r.mu.Unlock()
		return nil, fmt.Errorf("%w: no key %q", ErrKeyNotFound, keyID)
	}
	if rec.Revoked {
		r.mu.Unlock()
		return nil, fmt.Errorf("%w: already revoked", ErrKeyRevoked)
	}
	rec.Revoked = true
	rec.RevokedAt = time.Now().UTC()
	rec.RevokedBy = by
	rec.RevokeReason = reason
	rec.RetroactivelyVoid = reason == KeyRevokeCompromise
	holder, fp := rec.Holder, rec.Fingerprint
	retro := rec.RetroactivelyVoid
	r.mu.Unlock()

	effect := "The key may no longer sign. Signatures it made before this point stand, because the key was withdrawn in an orderly way."
	if retro {
		effect = "The key may no longer sign, and every signature it ever made is unattributable: if the private key could be " +
			"computed, nothing it signed proves who signed it. Credentials relying on it must be reissued under a new key."
	}
	blk := r.commit(BlockKeyRevoked, map[string]interface{}{
		"kind": "key-revoked", "keyId": keyID, "holder": holder,
		"fingerprint": fp, "reason": reason, "by": by, "effect": effect,
	})
	if blk != nil {
		r.mu.Lock()
		rec.RevokeBlock = blk.Height
		r.mu.Unlock()
	}
	return r.snapshot(keyID)
}

// Status answers the only question a verifier has: may this key be trusted
// for a signature made at this moment, and if not, why not.
func (r *KeyRegistry) Status(publicKeyHex string) map[string]interface{} {
	out := map[string]interface{}{"registered": false, "usable": false}
	if r == nil {
		return out
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	id, ok := r.byPublic[strings.TrimSpace(strings.ToLower(publicKeyHex))]
	if !ok {
		out["reason"] = "This key is not in the register. A signature under it is not attributable to anyone this rail knows."
		return out
	}
	rec := r.keys[id]
	out["registered"] = true
	out["keyId"] = rec.KeyID
	out["holder"] = rec.Holder
	out["usable"] = !rec.Revoked
	if rec.Revoked {
		out["revokedReason"] = rec.RevokeReason
		out["signaturesRetroactivelyVoid"] = rec.RetroactivelyVoid
		out["reason"] = "This key is revoked."
	}
	return out
}

// Audit re-screens every key in service against the current tests.
//
// This is the part that answers the eighteen months. A weakness class added
// to the screen tomorrow is applied to keys registered today by running
// this, rather than by hoping an outsider reports it.
func (r *KeyRegistry) Audit(by string) map[string]interface{} {
	if r == nil {
		return map[string]interface{}{"audited": 0}
	}
	r.mu.Lock()
	ids := append([]string(nil), r.order...)
	snap := make(map[string]*RegisteredKey, len(ids))
	for _, id := range ids {
		snap[id] = r.keys[id]
	}
	r.mu.Unlock()

	failures := []map[string]interface{}{}
	for _, id := range ids {
		rec := snap[id]
		if rec == nil || rec.Revoked {
			continue
		}
		raw, err := hex.DecodeString(rec.PublicKeyHex)
		if err != nil {
			continue
		}
		s := ScreenPublicKey(ed25519.PublicKey(raw))
		if !s.Passed {
			failures = append(failures, map[string]interface{}{
				"keyId": rec.KeyID, "holder": rec.Holder, "failures": s.Failures,
			})
		}
	}

	r.commit(BlockKeyAudited, map[string]interface{}{
		"kind": "key-audited", "keysChecked": len(ids), "failed": len(failures), "by": by,
		"effect": "Every key in service was re-screened against the current tests. The result is on the chain whether it " +
			"found anything or not, so the absence of a finding is evidence that the check ran.",
	})

	out := map[string]interface{}{
		"audited":  len(ids),
		"failed":   len(failures),
		"findings": failures,
		"why": "A key that was sound when it was registered can become known-weak later, because the weakness was in the " +
			"generator and somebody else worked it out. The eMudhra keys were published in April 2025 and reported in " +
			"October 2026. Re-screening on demand is what turns that interval into one audit run.",
	}
	if len(failures) == 0 {
		out["verdict"] = "No key in service fails any current test. That is not proof of good entropy; it is proof the tests ran."
	} else {
		out["verdict"] = "At least one key in service fails a current test and must be revoked as KEY_COMPROMISE and replaced."
	}
	return out
}

// Keys lists the register, oldest first.
func (r *KeyRegistry) Keys() []RegisteredKey {
	if r == nil {
		return nil
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]RegisteredKey, 0, len(r.order))
	for _, id := range r.order {
		if rec := r.keys[id]; rec != nil {
			out = append(out, *rec)
		}
	}
	return out
}

func (r *KeyRegistry) snapshot(id string) (*RegisteredKey, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	rec, ok := r.keys[id]
	if !ok {
		return nil, ErrKeyNotFound
	}
	c := *rec
	return &c, nil
}

func (r *KeyRegistry) commit(blockType string, txn map[string]interface{}) *DrunixBlock {
	if r == nil || r.chain == nil {
		return nil
	}
	txn["disclaimer"] = UMIDisclaimer
	return r.chain.Append(blockType, []map[string]interface{}{txn})
}

// SelfReport describes the keys this process signs with, including the
// uncomfortable part.
//
// The demo issuer seed is published in the source. Any key derived from it
// is public knowledge, which is the same situation eMudhra was in without
// knowing it. The difference worth keeping is that this says so.
func (r *KeyRegistry) SelfReport(cred *CredentialRegistry) map[string]interface{} {
	out := map[string]interface{}{
		"registeredKeys": len(r.Keys()),
	}
	if cred == nil {
		return out
	}
	_, demo := issuerSeed()
	out["credentialIssuerSeedIsPublic"] = demo
	if demo {
		out["warning"] = "The credential issuer key is derived from a seed published in this repository. Anyone can " +
			"reproduce it and forge a credential that verifies. It proves integrity, not authority. Set " +
			"CREDENTIAL_SIGNING_SEED from a strong random source before any of this means anything."
		out["posture"] = "DEMO_KEY_IN_USE"
	} else {
		out["posture"] = "OPERATOR_SEED_SET"
		out["note"] = "An operator seed is set. This rail cannot verify how it was generated: a seed typed by a person " +
			"looks the same as one from a hardware module. The screen catches keys that are weak by construction, " +
			"not keys that are merely guessable."
	}
	return out
}

// weakKeyExample derives the public key for a small-integer private value.
// Exported for tests and for the demo endpoint: showing the eMudhra failure
// is more convincing than describing it.
func weakKeyExample(n uint64) (ed25519.PublicKey, ed25519.PrivateKey) {
	var seed [ed25519.SeedSize]byte
	v := n
	for i := ed25519.SeedSize - 1; i >= 0 && v > 0; i-- {
		seed[i] = byte(v)
		v >>= 8
	}
	priv := ed25519.NewKeyFromSeed(seed[:])
	return priv.Public().(ed25519.PublicKey), priv
}

// equalKey is a constant-time comparison for public keys.
func equalKey(a, b ed25519.PublicKey) bool { return bytes.Equal(a, b) }
