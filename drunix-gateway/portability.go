package drunix

// Credential portability: proving something to a venue that is not us.
//
// WHY THIS EXISTS
// The registry already issues signed credentials, anchors their hash on the
// chain and verifies them. All of that works only if the verifier calls our
// API. That is not portability, it is a login with extra steps: if this
// deployment is offline, mistaken or gone, every credential it ever issued
// becomes unverifiable, and the holder is back to re-onboarding at the next
// venue exactly as they would without any of it.
//
// A credential is portable when a stranger can check it with no dependency
// on the issuer's uptime and no account with the issuer. That needs three
// things travelling together, which is what this file adds:
//
//  1. PRESENTATION BUNDLE (Presentation): the credential, the issuer's public
//     key and its fingerprint, the ledger anchor it was sealed into, and the
//     exact rule for recomputing the hash. Everything required to check the
//     signature arithmetic offline, in one file the holder keeps.
//
//  2. STATUS LIST (StatusList): the one thing a bundle cannot carry, because
//     it changes after issuance. Revocation is a fact about now, so it is
//     published separately as a small, cacheable, monotonic list with the
//     ledger height it was read at. A second venue polls this and nothing
//     else.
//
//  3. A STATED PROCEDURE (VerificationProcedure): the steps in order, with
//     what each one proves and what it does not. A verifier who has to guess
//     the canonicalisation rule cannot verify anything, and a verifier who is
//     not told that the demo key proves integrity rather than authority will
//     over-trust the result.
//
// WHAT A BUNDLE DOES NOT PROVE
// Offline verification establishes that a named issuer signed this exact
// document and that its hash was sealed into a ledger at a stated height. It
// cannot establish that the issuer is who they claim to be in the world, and
// while the signing seed is the published demo seed it cannot establish
// authority at all. Both facts are carried inside the bundle rather than left
// in documentation, because a bundle travels and documentation does not.

import (
	"crypto/ed25519"
	"encoding/hex"
	"sort"
	"strings"
	"time"
)

// PresentationAnchor is the ledger evidence a bundle carries.
type PresentationAnchor struct {
	Ledger      string `json:"ledger"`
	Hash        string `json:"credentialHash"`
	BlockHeight int64  `json:"blockHeight"`
	BlockHash   string `json:"blockHash,omitempty"`
	StatusURL   string `json:"statusListUrl"`
}

// PresentationIssuer is everything needed to check the signature without
// asking us for anything.
type PresentationIssuer struct {
	ID             string `json:"id"`
	PublicKeyHex   string `json:"publicKeyHex"`
	KeyFingerprint string `json:"keyFingerprint"`
	Algorithm      string `json:"algorithm"`
	DemoKey        bool   `json:"keyIsPublicDemoKey"`
	KeyCaveat      string `json:"keyCaveat,omitempty"`
}

// Presentation is the portable artefact. A holder downloads it, a verifier
// checks it with scripts/verify-credential.mjs or any Ed25519 library.
type Presentation struct {
	Format      string                 `json:"format"`
	Credential  *Credential            `json:"credential"`
	Issuer      PresentationIssuer     `json:"issuer"`
	Anchor      PresentationAnchor     `json:"anchor"`
	Canonical   CanonicalisationRule   `json:"canonicalisation"`
	Procedure   []VerificationStep     `json:"verificationProcedure"`
	Limits      []string               `json:"whatThisDoesNotProve"`
	GeneratedAt time.Time              `json:"generatedAt"`
	Extra       map[string]interface{} `json:"-"`
}

// CanonicalisationRule states exactly how to rebuild the signed bytes. A
// verifier that guesses this will reject valid credentials, which is the
// most common way an interoperable format turns out not to be.
type CanonicalisationRule struct {
	Rule       string `json:"rule"`
	SignedOver string `json:"signedOver"`
	HashedOver string `json:"hashedOver"`
	Encoding   string `json:"signatureEncoding"`
}

// VerificationStep is one check, with what passing it actually means.
type VerificationStep struct {
	Step   int    `json:"step"`
	Check  string `json:"check"`
	Proves string `json:"proves"`
}

// PresentationFormat identifies the bundle shape, so a consumer can refuse a
// version it does not understand rather than misreading it.
const PresentationFormat = "aasthichain-credential-presentation/1"

// StatusListFormat identifies the revocation list shape.
const StatusListFormat = "aasthichain-credential-status/1"

// StatusEntry is one credential's standing right now.
type StatusEntry struct {
	CredentialID string `json:"credentialId"`
	Revoked      bool   `json:"revoked"`
	Hash         string `json:"credentialHash"`
	IssuedBlock  int64  `json:"issuedBlock"`
	RevokedBlock int64  `json:"revokedBlock,omitempty"`
	Reason       string `json:"revokedReason,omitempty"`
}

// StatusList is the pollable half of portability.
//
// It is deliberately a whole list rather than a per-credential lookup: asking
// "is credential X revoked" tells us which credential a verifier is looking
// at, every time they look. A list leaks nothing about who is checking what,
// caches well, and works from a copy taken minutes ago.
type StatusList struct {
	Format      string        `json:"format"`
	Ledger      string        `json:"ledger"`
	AsOfHeight  int64         `json:"asOfBlockHeight"`
	AsOf        time.Time     `json:"asOf"`
	Count       int           `json:"count"`
	RevokedOnly bool          `json:"revokedOnly"`
	Entries     []StatusEntry `json:"entries"`
	Note        string        `json:"note"`
}

// Presentation builds the portable bundle for one issued credential.
func (r *CredentialRegistry) Presentation(id, statusURL string) (*Presentation, error) {
	rec, err := r.Get(id)
	if err != nil {
		return nil, err
	}
	cred := rec.Credential
	issuer := strings.TrimPrefix(cred.Issuer, "did:aasthi:")
	key := r.keyFor(issuer)
	pub := key.Public().(ed25519.PublicKey)
	_, demo := issuerSeed()

	anchoredHash, height, _ := r.anchorFor(id)
	if anchoredHash == "" {
		anchoredHash = rec.Hash
		height = rec.IssuedBlock
	}

	p := &Presentation{
		Format:     PresentationFormat,
		Credential: cred,
		Issuer: PresentationIssuer{
			ID:             issuer,
			PublicKeyHex:   hex.EncodeToString(pub),
			KeyFingerprint: keyFingerprint(pub),
			Algorithm:      "Ed25519",
			DemoKey:        demo,
		},
		Anchor: PresentationAnchor{
			Ledger:      "drunix",
			Hash:        anchoredHash,
			BlockHeight: height,
			BlockHash:   r.blockHashAt(height),
			StatusURL:   statusURL,
		},
		Canonical: CanonicalisationRule{
			Rule: "Serialise the credential object with encoding/json field order and sorted map keys. " +
				"Remove the proof member entirely before signing; keep it when hashing.",
			SignedOver: "JSON of the credential with \"proof\" omitted",
			HashedOver: "SHA-256 of the JSON of the credential including \"proof\"",
			Encoding:   "proof.proofValue is base64url without padding",
		},
		Procedure: []VerificationStep{
			{1, "Rebuild the signed bytes using the canonicalisation rule above.",
				"Nothing on its own. This is the step everyone gets wrong, so it is stated rather than implied."},
			{2, "Verify proof.proofValue against issuer.publicKeyHex with Ed25519.",
				"The holder of that key signed this exact document, and nothing in it has been altered."},
			{3, "SHA-256 the full credential including its proof and compare to anchor.credentialHash.",
				"The document matches the hash that was sealed into the ledger."},
			{4, "Fetch anchor.statusListUrl and look for this credential id.",
				"Whether the credential has been revoked since it was issued. This is the only step that needs a network."},
		},
		Limits: []string{
			"It does not prove the issuer is who they claim to be in the world. That is a question about registries and law, not about signatures.",
			"It does not prove the subject of the credential is true. A correctly signed statement can still be wrong.",
			"Steps 1 to 3 work with no network and no account here. Only revocation is a fact about now, which is why it is a separate list.",
		},
		GeneratedAt: time.Now().UTC(),
	}
	if demo {
		p.Issuer.KeyCaveat = "This key is derived from a seed published in this repository. It proves integrity, " +
			"not authority: anyone can produce a signature that verifies against it. Set CREDENTIAL_SIGNING_SEED " +
			"to make the key meaningful."
	}
	return p, nil
}

// blockHashAt returns the hash of a block by height, so a bundle names the
// block rather than only its number.
func (r *CredentialRegistry) blockHashAt(height int64) string {
	if r.chain == nil || height <= 0 {
		return ""
	}
	for _, b := range r.chain.Snapshot() {
		if b.Height == height {
			return b.Hash
		}
	}
	return ""
}

// StatusList publishes the standing of every issued credential, read from
// the chain rather than from the in-memory book.
func (r *CredentialRegistry) StatusList(revokedOnly bool) *StatusList {
	r.mu.RLock()
	ids := make([]string, 0, len(r.records))
	byID := make(map[string]*credentialRecord, len(r.records))
	for id, rec := range r.records {
		ids = append(ids, id)
		byID[id] = rec
	}
	r.mu.RUnlock()
	sort.Strings(ids)

	out := &StatusList{
		Format:      StatusListFormat,
		Ledger:      "drunix",
		AsOf:        time.Now().UTC(),
		RevokedOnly: revokedOnly,
		Entries:     []StatusEntry{},
		Note: "Revocation is the one fact a presentation bundle cannot carry, because it changes after " +
			"issuance. Poll this list; it is a whole list rather than a per-credential lookup so that " +
			"checking a credential does not tell us which credential you are checking.",
	}
	if r.chain != nil {
		snap := r.chain.Snapshot()
		if n := len(snap); n > 0 {
			out.AsOfHeight = snap[n-1].Height
		}
	}
	for _, id := range ids {
		hash, issued, revoked := r.anchorFor(id)
		rec := byID[id]
		if hash == "" && rec != nil {
			hash, issued = rec.Hash, rec.IssuedBlock
		}
		if rec != nil && rec.Revoked {
			revoked = true
		}
		if revokedOnly && !revoked {
			continue
		}
		e := StatusEntry{CredentialID: id, Revoked: revoked, Hash: hash, IssuedBlock: issued}
		if rec != nil && revoked {
			e.RevokedBlock, e.Reason = rec.RevokedBlock, rec.RevokedReason
		}
		out.Entries = append(out.Entries, e)
	}
	out.Count = len(out.Entries)
	return out
}
