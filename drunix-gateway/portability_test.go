package drunix

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// Portability is a claim about somebody else's machine, so these tests are
// about what travels in the bundle rather than about what the registry knows.
// Anything the verifier needs that is not inside the bundle is a dependency
// on this service staying up, which is the thing the feature exists to remove.

func portabilityRegistry(t *testing.T) (*CredentialRegistry, string) {
	t.Helper()
	reg := NewCredentialRegistry(NewChain())
	rec, err := reg.IssueTitleCredential("registrar1", "investor1", "PROP-PORT", map[string]interface{}{
		"surveyNumber": "42/1B",
	})
	if err != nil {
		t.Fatalf("issue: %v", err)
	}
	return reg, rec.Credential.ID
}

func TestPresentationCarriesEverythingAVerifierNeeds(t *testing.T) {
	reg, id := portabilityRegistry(t)
	p, err := reg.Presentation(id, "https://example.test/umi/credentials/status")
	if err != nil {
		t.Fatalf("presentation: %v", err)
	}
	if p.Format != PresentationFormat {
		t.Fatalf("format = %q", p.Format)
	}
	if p.Credential == nil || p.Credential.Proof == nil {
		t.Fatalf("a bundle without the signed document verifies nothing")
	}
	if p.Issuer.PublicKeyHex == "" || p.Issuer.KeyFingerprint == "" || p.Issuer.Algorithm != "Ed25519" {
		t.Fatalf("the issuer key did not travel: %+v", p.Issuer)
	}
	if p.Anchor.Hash == "" || p.Anchor.BlockHeight == 0 {
		t.Fatalf("the ledger anchor did not travel: %+v", p.Anchor)
	}
	if p.Anchor.StatusURL == "" {
		t.Fatalf("the bundle does not say where revocation is published")
	}
	if p.Canonical.SignedOver == "" || p.Canonical.Encoding == "" {
		t.Fatalf("the canonicalisation rule did not travel, so a verifier must guess it")
	}
	if len(p.Procedure) < 4 {
		t.Fatalf("the verification procedure is not stated")
	}
	if len(p.Limits) < 2 {
		t.Fatalf("a bundle must say what it cannot prove")
	}
}

// The demo key is the single most over-trustable thing in this subsystem. Its
// caveat must be inside the artefact that travels, not in documentation that
// stays behind.
func TestDemoKeyCaveatTravelsInsideTheBundle(t *testing.T) {
	reg, id := portabilityRegistry(t)
	p, err := reg.Presentation(id, "https://example.test/status")
	if err != nil {
		t.Fatalf("presentation: %v", err)
	}
	if !p.Issuer.DemoKey {
		t.Skip("a real signing seed is configured, so there is no caveat to carry")
	}
	if !strings.Contains(strings.ToLower(p.Issuer.KeyCaveat), "integrity") {
		t.Fatalf("the demo key carries no caveat: %q", p.Issuer.KeyCaveat)
	}
}

// The hash in the bundle must be the one the chain holds, not the one the
// in-memory book happens to remember.
func TestPresentationAnchorMatchesTheChain(t *testing.T) {
	reg, id := portabilityRegistry(t)
	p, _ := reg.Presentation(id, "")
	chainHash, height, _ := reg.anchorFor(id)
	if p.Anchor.Hash != chainHash || p.Anchor.BlockHeight != height {
		t.Fatalf("bundle anchor %s@%d, chain says %s@%d",
			p.Anchor.Hash, p.Anchor.BlockHeight, chainHash, height)
	}
	if p.Anchor.BlockHash == "" {
		t.Fatalf("the bundle names a block number but not the block")
	}
}

func TestPresentationOfAnUnknownCredentialIsRefused(t *testing.T) {
	reg, _ := portabilityRegistry(t)
	if _, err := reg.Presentation("urn:aasthi:credential:nope", ""); err == nil {
		t.Fatalf("a bundle was produced for a credential that does not exist")
	}
}

// The status list is the half a bundle cannot carry.
func TestStatusListReportsRevocationAndItsReason(t *testing.T) {
	reg, id := portabilityRegistry(t)
	list := reg.StatusList(false)
	if list.Format != StatusListFormat || list.AsOfHeight == 0 {
		t.Fatalf("status list is not identifiable: %+v", list)
	}
	if list.Count != len(list.Entries) || list.Count != 1 {
		t.Fatalf("count %d, entries %d", list.Count, len(list.Entries))
	}
	if list.Entries[0].Revoked {
		t.Fatalf("a freshly issued credential is reported revoked")
	}

	if _, err := reg.Revoke(id, "registrar1", "superseded"); err != nil {
		t.Fatalf("revoke: %v", err)
	}
	after := reg.StatusList(false)
	e := after.Entries[0]
	if !e.Revoked || e.Reason == "" || e.RevokedBlock == 0 {
		t.Fatalf("revocation is not fully reported: %+v", e)
	}

	only := reg.StatusList(true)
	if only.Count != 1 || !only.RevokedOnly {
		t.Fatalf("revokedOnly filter does not work: %+v", only)
	}
}

// A revoked credential is still a genuinely signed document. The registry
// must not pretend otherwise, because a verifier that cannot distinguish
// "forged" from "withdrawn" cannot tell a holder what went wrong.
func TestRevocationDoesNotInvalidateTheSignature(t *testing.T) {
	reg, id := portabilityRegistry(t)
	if _, err := reg.Revoke(id, "registrar1", "superseded"); err != nil {
		t.Fatalf("revoke: %v", err)
	}
	v, err := reg.VerifyStored(id)
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	if !v.SignatureValid || !v.AnchorMatches {
		t.Fatalf("revocation broke the cryptography: %+v", v)
	}
	if !v.Revoked {
		t.Fatalf("a revoked credential does not report itself revoked")
	}
}

// --- HTTP surface -------------------------------------------------------

func portabilityServer(t *testing.T) (*Server, string) {
	t.Helper()
	s := newTestServerWithUMI(t)
	s.Credentials = NewCredentialRegistry(s.Pipeline.CP.Ledger)
	rec, err := s.Credentials.IssueTitleCredential("registrar1", "investor1", "PROP-PORT", nil)
	if err != nil {
		t.Fatalf("issue: %v", err)
	}
	return s, rec.Credential.ID
}

func portabilityGet(t *testing.T, s *Server, path string) (int, map[string]interface{}, http.Header) {
	t.Helper()
	rec := httptest.NewRecorder()
	s.Router().ServeHTTP(rec, httptest.NewRequest("GET", path, nil))
	var out map[string]interface{}
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	return rec.Code, out, rec.Header()
}

// Both routes are public on purpose. A credential whose verification needs
// our permission is not a credential.
func TestBundleAndStatusListArePublic(t *testing.T) {
	s, id := portabilityServer(t)
	code, body, hdr := portabilityGet(t, s, "/umi/credentials/"+id+"/presentation")
	if code != http.StatusOK {
		t.Fatalf("anonymous bundle fetch got %d", code)
	}
	if body["format"] != PresentationFormat {
		t.Fatalf("format = %v", body["format"])
	}
	if !strings.Contains(hdr.Get("Content-Disposition"), "attachment; filename=") {
		t.Fatalf("the bundle is not served as a named download: %q", hdr.Get("Content-Disposition"))
	}

	code, list, _ := portabilityGet(t, s, "/umi/credentials/status")
	if code != http.StatusOK || list["format"] != StatusListFormat {
		t.Fatalf("status list got %d %v", code, list["format"])
	}
}

// The status URL inside a bundle has to be one the holder can actually
// reach, which means it is built from the request and not from a constant.
func TestStatusURLFollowsTheRequest(t *testing.T) {
	s, id := portabilityServer(t)
	req := httptest.NewRequest("GET", "/umi/credentials/"+id+"/presentation", nil)
	req.Host = "rail.example.test"
	req.Header.Set("X-Forwarded-Proto", "https")
	rec := httptest.NewRecorder()
	s.Router().ServeHTTP(rec, req)
	var body map[string]interface{}
	_ = json.Unmarshal(rec.Body.Bytes(), &body)
	anchor := body["anchor"].(map[string]interface{})
	want := "https://rail.example.test/umi/credentials/status"
	if anchor["statusListUrl"] != want {
		t.Fatalf("statusListUrl = %v, want %s", anchor["statusListUrl"], want)
	}
}

// A credential id ends up in a Content-Disposition header, so it must not be
// able to carry a quote, a newline or a path into it.
func TestFilenameIsSanitised(t *testing.T) {
	for _, in := range []string{`a"b`, "a\r\nb", "../../etc/passwd", ""} {
		got := safeFilename(in)
		if strings.ContainsAny(got, `"`+"\r\n/\\") || got == "" {
			t.Fatalf("safeFilename(%q) = %q", in, got)
		}
	}
}
