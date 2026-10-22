package drunix

// The screen is only worth having if it catches the real thing, so the
// fixture is the real thing: the eight private values recovered from
// eMudhra's intermediate certificate authorities in October 2026, reported
// publicly as 4, 56, 66, 115, 155, 156, 230 and 237.

import (
	"crypto/ed25519"
	"encoding/hex"
	"strings"
	"testing"
)

// The values researchers recovered from the eMudhra intermediates.
var eMudhraPrivateValues = []uint64{4, 56, 66, 115, 155, 156, 230, 237}

func newKeyRegistry(t testing.TB) *KeyRegistry {
	t.Helper()
	r := NewKeyRegistry(NewChain())
	if r == nil {
		t.Fatal("key registry did not wire")
	}
	return r
}

// register is the happy path, done properly: challenge, sign, register.
func registerKey(t *testing.T, r *KeyRegistry, holder, use string) (*RegisteredKey, ed25519.PrivateKey) {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	nonce, _, err := r.Challenge(holder)
	if err != nil {
		t.Fatalf("challenge: %v", err)
	}
	sig := ed25519.Sign(priv, []byte(nonce))
	rec, err := r.Register(holder, use, hex.EncodeToString(pub), hex.EncodeToString(sig), holder)
	if err != nil {
		t.Fatalf("register: %v", err)
	}
	return rec, priv
}

func TestScreenCatchesTheRealEMudhraKeys(t *testing.T) {
	for _, n := range eMudhraPrivateValues {
		pub, _ := weakKeyExample(n)
		s := ScreenPublicKey(pub)
		if s.Passed {
			t.Fatalf("a private key of %d passed the screen; this is the exact failure the screen exists for", n)
		}
		if len(s.Failures) == 0 || !strings.Contains(s.Failures[0], "small integer") {
			t.Fatalf("n=%d: the reason must name the failure, got %v", n, s.Failures)
		}
	}
}

func TestScreenPassesARealKeyAndSaysWhatItCannotProve(t *testing.T) {
	pub, _, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	s := ScreenPublicKey(pub)
	if !s.Passed {
		t.Fatalf("a key from crypto/rand must pass: %v", s.Failures)
	}
	if len(s.Checks) < 5 {
		t.Fatal("the screen must publish what it checked")
	}
	// The limitation is not decoration. A screen that implies it proves
	// entropy is worse than no screen.
	if !strings.Contains(s.Limitation, "cannot prove") {
		t.Fatalf("the verdict must state what it cannot establish, got %q", s.Limitation)
	}
}

func TestScreenCatchesDegenerateKeys(t *testing.T) {
	cases := map[string]ed25519.PublicKey{
		"all zero bytes": make([]byte, ed25519.PublicKeySize),
		"wrong length":   make([]byte, 16),
	}
	for name, pub := range cases {
		if s := ScreenPublicKey(pub); s.Passed {
			t.Fatalf("%s passed the screen", name)
		}
	}
	// A repeated-byte private seed, the "generator never ran" case.
	seed := make([]byte, ed25519.SeedSize)
	for i := range seed {
		seed[i] = 0xAA
	}
	pub := ed25519.NewKeyFromSeed(seed).Public().(ed25519.PublicKey)
	if s := ScreenPublicKey(pub); s.Passed {
		t.Fatal("a seed of one repeated byte passed the screen")
	}
}

func TestRegisterRefusesAWeakKeyAndRecordsTheRefusal(t *testing.T) {
	r := newKeyRegistry(t)
	pub, priv := weakKeyExample(4)
	nonce, _, _ := r.Challenge("originator1")
	sig := ed25519.Sign(priv, []byte(nonce))

	_, err := r.Register("originator1", "credential-issuer", hex.EncodeToString(pub), hex.EncodeToString(sig), "originator1")
	if err == nil {
		t.Fatal("a key with private value 4 must never enter service")
	}
	if !strings.Contains(err.Error(), "ERR_UMI_KEY_WEAK") {
		t.Fatalf("wrong error: %v", err)
	}
	// Possession was genuinely proved here, which is the point: holding the
	// key is not the same as the key being sound.
	if len(r.Keys()) != 0 {
		t.Fatal("a refused key must not appear in the register")
	}
	// The refusal itself has to be auditable.
	found := false
	for _, b := range r.chain.Blocks {
		if b.Type == BlockKeyRejected {
			found = true
		}
	}
	if !found {
		t.Fatal("a refusal must be written to the chain; a register that only records successes cannot be audited")
	}
}

func TestRegisterRequiresProofOfPossession(t *testing.T) {
	r := newKeyRegistry(t)
	pub, _, _ := ed25519.GenerateKey(nil)

	// No challenge at all.
	if _, err := r.Register("investor1", "attestor", hex.EncodeToString(pub), "", "investor1"); err == nil {
		t.Fatal("registering without a challenge must be refused")
	}

	// Challenge, but signed by a different key: the copy-somebody-else's-
	// public-key case.
	_, other, _ := ed25519.GenerateKey(nil)
	nonce, _, _ := r.Challenge("investor1")
	badSig := ed25519.Sign(other, []byte(nonce))
	_, err := r.Register("investor1", "attestor", hex.EncodeToString(pub), hex.EncodeToString(badSig), "investor1")
	if err == nil || !strings.Contains(err.Error(), "ERR_UMI_KEY_NOT_POSSESSED") {
		t.Fatalf("a signature from another key must be refused, got %v", err)
	}
}

func TestTheSameKeyCannotBeRegisteredTwice(t *testing.T) {
	r := newKeyRegistry(t)
	rec, priv := registerKey(t, r, "originator1", "credential-issuer")

	nonce, _, _ := r.Challenge("investor1")
	sig := ed25519.Sign(priv, []byte(nonce))
	_, err := r.Register("investor1", "attestor", rec.PublicKeyHex, hex.EncodeToString(sig), "investor1")
	if err == nil || !strings.Contains(err.Error(), "ERR_UMI_KEY_DUPLICATE") {
		t.Fatalf("two holders sharing one key must be refused, got %v", err)
	}
}

func TestRevocationIsOneActAndSaysWhatItMeans(t *testing.T) {
	r := newKeyRegistry(t)
	rec, _ := registerKey(t, r, "originator1", "credential-issuer")

	if st := r.Status(rec.PublicKeyHex); st["usable"] != true {
		t.Fatal("a freshly registered key must be usable")
	}

	out, err := r.Revoke(rec.KeyID, KeyRevokeCompromise, "regulator1")
	if err != nil {
		t.Fatalf("revoke: %v", err)
	}
	if !out.RetroactivelyVoid {
		t.Fatal("KEY_COMPROMISE must void earlier signatures: if the key was computable, nothing it signed is attributable")
	}
	st := r.Status(rec.PublicKeyHex)
	if st["usable"] != false || st["signaturesRetroactivelyVoid"] != true {
		t.Fatalf("status must report the consequence, got %v", st)
	}
	if _, err := r.Revoke(rec.KeyID, KeyRevokeCompromise, "regulator1"); err == nil {
		t.Fatal("revoking twice must be refused")
	}
}

// An orderly rotation is not a compromise, and conflating them would make
// every key change look like an incident.
func TestSupersedingDoesNotVoidEarlierSignatures(t *testing.T) {
	r := newKeyRegistry(t)
	rec, _ := registerKey(t, r, "originator1", "credential-issuer")
	out, err := r.Revoke(rec.KeyID, KeyRevokeSuperseded, "originator1")
	if err != nil {
		t.Fatal(err)
	}
	if out.RetroactivelyVoid {
		t.Fatal("an orderly rotation must leave earlier signatures standing")
	}
}

func TestRevokeRejectsAnInventedReason(t *testing.T) {
	r := newKeyRegistry(t)
	rec, _ := registerKey(t, r, "originator1", "credential-issuer")
	if _, err := r.Revoke(rec.KeyID, "BECAUSE", "regulator1"); err == nil {
		t.Fatal("the reason must be one of the three, because the reason decides whether earlier signatures stand")
	}
}

func TestAnUnknownKeyIsNotTrusted(t *testing.T) {
	r := newKeyRegistry(t)
	pub, _, _ := ed25519.GenerateKey(nil)
	st := r.Status(hex.EncodeToString(pub))
	if st["registered"] != false || st["usable"] != false {
		t.Fatal("a key nobody registered must not be usable")
	}
	if st["reason"] == nil {
		t.Fatal("the refusal must explain itself")
	}
}

// The eighteen-month problem: a key sound at registration time must be
// re-checkable later against tests that did not exist then.
func TestAuditReScreensKeysAlreadyInService(t *testing.T) {
	r := newKeyRegistry(t)
	registerKey(t, r, "originator1", "credential-issuer")
	registerKey(t, r, "registrar1", "attestor")

	out := r.Audit("regulator1")
	if out["audited"].(int) != 2 {
		t.Fatalf("want 2 keys audited, got %v", out["audited"])
	}
	if out["failed"].(int) != 0 {
		t.Fatalf("sound keys must not fail: %v", out["findings"])
	}
	if !strings.Contains(out["verdict"].(string), "not proof of good entropy") {
		t.Fatalf("a clean audit must not overclaim, got %q", out["verdict"])
	}

	// The run itself is recorded, so "no finding" is evidence the check ran
	// rather than evidence nobody looked.
	found := false
	for _, b := range r.chain.Blocks {
		if b.Type == BlockKeyAudited {
			found = true
		}
	}
	if !found {
		t.Fatal("an audit run must be written to the chain")
	}
}

// Registration, rejection and revocation all have to be on the chain: the
// transparency log is the part that let an outsider catch eMudhra at all.
func TestTheRegisterIsOnTheChain(t *testing.T) {
	r := newKeyRegistry(t)
	rec, _ := registerKey(t, r, "originator1", "credential-issuer")
	if rec.Block <= 0 {
		t.Fatal("a registration must carry the block it was written at")
	}
	if _, err := r.Revoke(rec.KeyID, KeyRevokeCompromise, "regulator1"); err != nil {
		t.Fatal(err)
	}
	seen := map[string]bool{}
	for _, b := range r.chain.Blocks {
		seen[b.Type] = true
	}
	for _, want := range []string{BlockKeyRegistered, BlockKeyRevoked} {
		if !seen[want] {
			t.Fatalf("the chain is missing %s", want)
		}
	}
}

// The posture report has to be honest about the demo seed rather than
// quietly presenting a public key as if it were a secret one.
func TestPostureDeclaresTheDemoKey(t *testing.T) {
	r := newKeyRegistry(t)
	chain := NewChain()
	cred := NewCredentialRegistry(chain)
	out := r.SelfReport(cred)
	if out["credentialIssuerSeedIsPublic"] != true {
		t.Skip("CREDENTIAL_SIGNING_SEED is set in this environment")
	}
	if out["posture"] != "DEMO_KEY_IN_USE" {
		t.Fatalf("the demo posture must be named, got %v", out["posture"])
	}
	if w, _ := out["warning"].(string); !strings.Contains(w, "forge") {
		t.Fatalf("the warning must say plainly what an attacker could do, got %q", w)
	}
}
