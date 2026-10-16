package drunix

import (
	"encoding/json"
	"strings"
	"testing"
)

func newCredRegistry(t *testing.T) (*CredentialRegistry, *DrunixChain) {
	t.Helper()
	chain := NewChain()
	return NewCredentialRegistry(chain), chain
}

func issueOne(t *testing.T, reg *CredentialRegistry) *credentialRecord {
	t.Helper()
	rec, err := reg.IssueTitleCredential("registrar1", "originator1", "PROP-1", map[string]interface{}{
		"titleValidated": true,
		"pincode":        "411045",
	})
	if err != nil {
		t.Fatalf("issue: %v", err)
	}
	return rec
}

func TestCredentialIssueAndVerify(t *testing.T) {
	reg, _ := newCredRegistry(t)
	rec := issueOne(t, reg)

	if rec.Credential.Proof == nil || rec.Credential.Proof.ProofValue == "" {
		t.Fatal("credential was issued without a proof")
	}
	if rec.Hash == "" || rec.IssuedBlock == 0 {
		t.Fatalf("credential was not anchored: hash=%q block=%d", rec.Hash, rec.IssuedBlock)
	}

	v, err := reg.VerifyStored(rec.Credential.ID)
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	if !v.SignatureValid {
		t.Error("signature did not verify on a freshly issued credential")
	}
	if !v.AnchorMatches {
		t.Errorf("anchor did not match: anchored=%s presented=%s", v.AnchoredHash, v.PresentedHash)
	}
	if v.Revoked {
		t.Error("a new credential reported as revoked")
	}
}

// The issuance date must come from the block, not the local clock, or two
// renderings of the same credential differ and the signature is worthless.
func TestCredentialIssuanceDateComesFromTheBlock(t *testing.T) {
	reg, chain := newCredRegistry(t)
	rec := issueOne(t, reg)

	found := false
	for _, b := range chain.Snapshot() {
		if b.Timestamp == rec.Credential.IssuanceDate {
			found = true
		}
	}
	if !found {
		t.Errorf("issuanceDate %q does not match any block timestamp", rec.Credential.IssuanceDate)
	}
}

// The whole point of the signature: altering any field has to break it.
func TestCredentialTamperingBreaksVerification(t *testing.T) {
	reg, _ := newCredRegistry(t)
	rec := issueOne(t, reg)

	raw, err := json.Marshal(rec.Credential)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	for _, change := range []struct {
		name string
		edit func(*Credential)
	}{
		{"subject claim", func(c *Credential) { c.CredentialSubject["titleValidated"] = false }},
		{"asset id", func(c *Credential) { c.CredentialSubject["assetId"] = "PROP-OTHER" }},
		{"issuer", func(c *Credential) { c.Issuer = "did:aasthi:someoneelse" }},
		{"issuance date", func(c *Credential) { c.IssuanceDate = "2020-01-01T00:00:00Z" }},
	} {
		t.Run(change.name, func(t *testing.T) {
			var copyOf Credential
			if err := json.Unmarshal(raw, &copyOf); err != nil {
				t.Fatalf("unmarshal: %v", err)
			}
			change.edit(&copyOf)

			v, err := reg.VerifyPresented(&copyOf)
			if err != nil {
				t.Fatalf("verify: %v", err)
			}
			// Changing the issuer changes which key is checked, so the
			// signature fails. Changing anything else changes the signed
			// bytes. Either way it must not come back clean.
			if v.SignatureValid && v.AnchorMatches {
				t.Errorf("a tampered credential verified clean: %+v", v)
			}
		})
	}
}

// A re-encoded credential must produce the same bytes, otherwise verification
// only works on the exact object we happen to hold in memory.
func TestCredentialSurvivesARoundTripThroughJSON(t *testing.T) {
	reg, _ := newCredRegistry(t)
	rec := issueOne(t, reg)

	raw, _ := json.Marshal(rec.Credential)
	var again Credential
	if err := json.Unmarshal(raw, &again); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	v, err := reg.VerifyPresented(&again)
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	if !v.SignatureValid || !v.AnchorMatches {
		t.Errorf("a credential that went through JSON no longer verifies: %+v", v)
	}
}

// Revocation must not be reported as a broken signature. They are different
// facts and a verifier needs to tell them apart.
func TestCredentialRevocationKeepsTheSignatureValid(t *testing.T) {
	reg, _ := newCredRegistry(t)
	rec := issueOne(t, reg)

	if _, err := reg.Revoke(rec.Credential.ID, "regulator1", "title dispute"); err != nil {
		t.Fatalf("revoke: %v", err)
	}
	v, err := reg.VerifyStored(rec.Credential.ID)
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	if !v.SignatureValid {
		t.Error("revocation broke the signature, which should be independent of it")
	}
	if !v.Revoked {
		t.Error("a revoked credential did not report as revoked")
	}
	if !strings.Contains(v.Summary, "revoked") {
		t.Errorf("summary does not mention revocation: %q", v.Summary)
	}

	if _, err := reg.Revoke(rec.Credential.ID, "regulator1", "again"); err == nil {
		t.Error("revoking twice was allowed")
	}
}

// The issuer key must not change across restarts, or every credential issued
// before the restart silently stops verifying.
func TestIssuerKeyIsStableAcrossRegistries(t *testing.T) {
	a, _ := newCredRegistry(t)
	b, _ := newCredRegistry(t)
	if a.PublicKeyOf("registrar1") != b.PublicKeyOf("registrar1") {
		t.Error("two registries derived different keys for the same issuer")
	}
	if a.PublicKeyOf("registrar1") == a.PublicKeyOf("registrar2") {
		t.Error("two issuers share a key")
	}
}

// A credential issued before a restart must still verify after one. The
// document is held by its holder; the chain supplies the anchor.
func TestCredentialAnchorSurvivesRestart(t *testing.T) {
	reg, chain := newCredRegistry(t)
	rec := issueOne(t, reg)

	// A fresh registry over the same chain is what a restart looks like.
	restarted := NewCredentialRegistry(chain)
	if n := restarted.RestoreFromChain(); n != 1 {
		t.Fatalf("restored %d credentials, want 1", n)
	}
	v, err := restarted.VerifyPresented(rec.Credential)
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	if !v.SignatureValid || !v.AnchorMatches {
		t.Errorf("a credential stopped verifying across a restart: %+v", v)
	}
}

// A credential the chain has never seen must not pass, however well signed.
func TestUnanchoredCredentialDoesNotVerify(t *testing.T) {
	reg, _ := newCredRegistry(t)
	rec := issueOne(t, reg)

	// Same registry, different chain: the signature is genuine, the anchor
	// is absent. This is the forgery case where someone replays a real
	// issuer's signature against a ledger that never recorded it.
	other := NewCredentialRegistry(NewChain())
	v, err := other.VerifyPresented(rec.Credential)
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	if !v.SignatureValid {
		t.Error("the signature should still be genuine")
	}
	if v.AnchorMatches {
		t.Error("a credential with no anchor on this chain reported as anchored")
	}
	if !strings.Contains(v.Summary, "no anchor") {
		t.Errorf("summary does not say the anchor is missing: %q", v.Summary)
	}
}

func TestCredentialRegistryRejectsEmptyIssue(t *testing.T) {
	reg, _ := newCredRegistry(t)
	if _, err := reg.IssueTitleCredential("", "someone", "PROP-1", nil); err == nil {
		t.Error("issuing with no issuer was allowed")
	}
	if _, err := reg.IssueTitleCredential("registrar1", "someone", "", nil); err == nil {
		t.Error("issuing with no asset was allowed")
	}
	if _, err := reg.Issue("registrar1", "SomethingElseCredential", map[string]interface{}{"id": "x"}); err == nil {
		t.Error("an unknown credential type was accepted")
	}
}

// The demo key is public. The API must say so rather than implying authority
// it does not have.
func TestDemoKeyIsDisclosed(t *testing.T) {
	reg, _ := newCredRegistry(t)
	sum := reg.Summary()
	if demo, _ := sum["demoIssuerKey"].(bool); !demo {
		t.Skip("CREDENTIAL_SIGNING_SEED is set in this environment")
	}
	disclosure, _ := sum["disclosure"].(string)
	if !strings.Contains(disclosure, "public") {
		t.Errorf("the demo key is not disclosed as public: %q", disclosure)
	}
	rec := issueOne(t, reg)
	v, _ := reg.VerifyStored(rec.Credential.ID)
	if !v.DemoKey || !strings.Contains(v.Summary, "not authority") {
		t.Errorf("verification does not disclose the demo key: %+v", v)
	}
}
