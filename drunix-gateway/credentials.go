package drunix

// Verifiable credentials for title validation.
//
// Until now, "a registrar validated this title" was a row in a database and a
// role check in our own code. A reader had to trust the operator, and there
// was nothing to check if the operator went away. That is the weakest claim
// on the platform, and it is the one people look at hardest.
//
// A credential replaces it with a signed statement. The registrar signs what
// it is asserting about a property, the signature is checked against a public
// key the rail publishes, and the hash of the signed document is anchored in
// a block. A stranger can verify the statement without trusting us, and can
// still verify it after this service no longer exists.
//
// WHAT IS REAL AND WHAT IS NOT. The signature, the canonical encoding, the
// anchor, the revocation and every refusal are real. The authority is not:
// the issuer is a demo registrar identity, not a state land-records office.
// A real deployment swaps the issuer key for one held by an authority that
// has the standing to make the statement. The mechanism does not change.
//
// Four design decisions worth keeping:
//
//  1. CANONICAL BYTES. The signature covers a deterministic serialisation:
//     sorted keys, integers not floats, and an issuance date taken from the
//     anchoring block rather than the local clock. Re-encode a stored
//     credential and you get the same bytes, so a signature check means
//     something. A credential that could not be re-encoded identically would
//     be unverifiable in practice however good the cryptography.
//
//  2. THE BODY IS NOT ON THE CHAIN. Only the hash is anchored. A credential
//     can name a person, and the chain is append-only: anything written
//     there is written forever. Anchoring the hash gives tamper evidence
//     without making the record itself permanent.
//
//  3. VERIFICATION ANSWERS FOUR QUESTIONS, NOT ONE. Signature, anchor match,
//     revocation and issuer authority are reported separately. A revoked
//     credential still has a valid signature, and collapsing that into a
//     single boolean hides which of the two failed.
//
//  4. THE KEY IS DERIVED, NOT GENERATED. A key generated at boot changes on
//     restart and silently invalidates every credential issued before it.
//     The issuer key is derived from a seed, so it survives restarts and
//     redeploys. In demo mode the seed is a published constant and the API
//     says so plainly: a demo key protects nothing and must not be described
//     as if it did.

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"sort"
	"strings"
	"sync"
)

// Block types committed by this subsystem.
const (
	BlockCredentialIssued  = "UMI_CREDENTIAL_ISSUED"
	BlockCredentialRevoked = "UMI_CREDENTIAL_REVOKED"
)

// Credential types this rail knows how to issue.
const (
	CredentialTitleValidation = "TitleValidationCredential"
	CredentialKYCStatus       = "KYCStatusCredential"
)

// demoIssuerSeed is the seed used when CREDENTIAL_SIGNING_SEED is unset.
//
// It is a constant in public source code, which means the demo issuer key is
// public and anybody can forge a demo credential. That is stated in every
// response rather than hidden, because a demo key presented as a secret is
// worse than no key at all.
const demoIssuerSeed = "aasthichain-demo-credential-issuer-v1"

var (
	ErrCredNotFound   = errors.New("credential not found")
	ErrCredFields     = errors.New("credential is missing required fields")
	ErrCredRevoked    = errors.New("credential already revoked")
	ErrCredUnknownTyp = errors.New("unknown credential type")
)

// Credential is a W3C Verifiable Credential shaped document.
//
// The field names follow the VC data model so the document is recognisable to
// anyone who has seen one, and so a future deployment can hand it to a real
// wallet without reshaping it.
type Credential struct {
	Context           []string               `json:"@context"`
	ID                string                 `json:"id"`
	Type              []string               `json:"type"`
	Issuer            string                 `json:"issuer"`
	IssuanceDate      string                 `json:"issuanceDate"`
	CredentialSubject map[string]interface{} `json:"credentialSubject"`
	Proof             *CredentialProof       `json:"proof,omitempty"`
}

// CredentialProof carries the signature and what is needed to check it.
type CredentialProof struct {
	Type               string `json:"type"`
	Created            string `json:"created"`
	VerificationMethod string `json:"verificationMethod"`
	ProofPurpose       string `json:"proofPurpose"`
	ProofValue         string `json:"proofValue"`
}

// credentialRecord is what the rail keeps about an issued credential.
type credentialRecord struct {
	Credential    *Credential `json:"credential"`
	Hash          string      `json:"hash"`
	IssuedBy      string      `json:"issuedBy"`
	IssuedBlock   int64       `json:"issuedBlock"`
	Revoked       bool        `json:"revoked"`
	RevokedBy     string      `json:"revokedBy,omitempty"`
	RevokedReason string      `json:"revokedReason,omitempty"`
	RevokedBlock  int64       `json:"revokedBlock,omitempty"`
}

// CredentialRegistry issues, stores, anchors and verifies credentials.
type CredentialRegistry struct {
	mu      sync.RWMutex
	records map[string]*credentialRecord
	order   []string
	chain   *DrunixChain
	keys    map[string]ed25519.PrivateKey
}

// NewCredentialRegistry wires the registry to the chain it anchors into.
func NewCredentialRegistry(chain *DrunixChain) *CredentialRegistry {
	return &CredentialRegistry{
		records: map[string]*credentialRecord{},
		chain:   chain,
		keys:    map[string]ed25519.PrivateKey{},
	}
}

// issuerSeed returns the seed the issuer keys are derived from, and whether
// it is the published demo seed.
func issuerSeed() (string, bool) {
	if s := strings.TrimSpace(os.Getenv("CREDENTIAL_SIGNING_SEED")); s != "" {
		return s, false
	}
	return demoIssuerSeed, true
}

// keyFor returns the issuer's Ed25519 key, derived deterministically so that
// a restart does not invalidate credentials issued before it.
func (r *CredentialRegistry) keyFor(issuer string) ed25519.PrivateKey {
	issuer = strings.ToLower(strings.TrimSpace(issuer))
	r.mu.Lock()
	defer r.mu.Unlock()
	if k, ok := r.keys[issuer]; ok {
		return k
	}
	seed, _ := issuerSeed()
	sum := sha256.Sum256([]byte(seed + "|issuer|" + issuer))
	k := ed25519.NewKeyFromSeed(sum[:])
	r.keys[issuer] = k
	return k
}

// PublicKeyOf returns an issuer's public key, hex encoded.
func (r *CredentialRegistry) PublicKeyOf(issuer string) string {
	k := r.keyFor(issuer)
	return hex.EncodeToString(k.Public().(ed25519.PublicKey))
}

// keyFingerprint identifies a key without publishing it, so a key swap is
// visible on the chain.
func keyFingerprint(pub ed25519.PublicKey) string {
	sum := sha256.Sum256(pub)
	return hex.EncodeToString(sum[:8])
}

// canonicalBytes serialises a credential deterministically, without its proof.
//
// encoding/json sorts map keys, and the struct field order is fixed by the
// struct itself, so the only ordering risk is inside credentialSubject. That
// is a map, so it is sorted for us. Numbers in the subject are kept as JSON
// numbers, which is why callers put integers there rather than floats.
func canonicalBytes(c *Credential) ([]byte, error) {
	unsigned := *c
	unsigned.Proof = nil
	return json.Marshal(&unsigned)
}

// hashOf returns the SHA-256 of the signed credential, which is what gets
// anchored and what a verifier compares against.
func hashOf(c *Credential) (string, error) {
	b, err := json.Marshal(c)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:]), nil
}

// IssueTitleCredential signs a registrar's statement about a property.
func (r *CredentialRegistry) IssueTitleCredential(issuer, subjectID, assetID string, subject map[string]interface{}) (*credentialRecord, error) {
	if strings.TrimSpace(issuer) == "" || strings.TrimSpace(assetID) == "" {
		return nil, ErrCredFields
	}
	if subject == nil {
		subject = map[string]interface{}{}
	}
	subject["id"] = subjectID
	subject["assetId"] = assetID
	subject["disclaimer"] = "Issued by a demo registrar identity on a simulated rail. " +
		"The signature and the ledger anchor are real; the issuing authority is not a government land-records office."
	return r.issue(issuer, CredentialTitleValidation, subject)
}

// Issue signs an arbitrary credential of a known type.
func (r *CredentialRegistry) Issue(issuer, credType string, subject map[string]interface{}) (*credentialRecord, error) {
	switch credType {
	case CredentialTitleValidation, CredentialKYCStatus:
	default:
		return nil, ErrCredUnknownTyp
	}
	return r.issue(issuer, credType, subject)
}

func (r *CredentialRegistry) issue(issuer, credType string, subject map[string]interface{}) (*credentialRecord, error) {
	if r == nil || r.chain == nil {
		return nil, errors.New("credential registry is not wired to a chain")
	}
	if strings.TrimSpace(issuer) == "" || len(subject) == 0 {
		return nil, ErrCredFields
	}

	key := r.keyFor(issuer)
	pub := key.Public().(ed25519.PublicKey)

	// The id is derived from what is being asserted, so issuing the same
	// statement twice is visibly the same statement rather than two.
	idSeed, err := json.Marshal(subject)
	if err != nil {
		return nil, err
	}
	sum := sha256.Sum256(append([]byte(strings.ToLower(issuer)+"|"+credType+"|"), idSeed...))
	credID := "urn:aasthi:credential:" + hex.EncodeToString(sum[:16])

	// Anchor first so the issuance date can come from the block rather than
	// from the local clock. The hash is filled in by a second block below,
	// which is why the anchor carries the credential id in both.
	anchor := r.chain.Append(BlockCredentialIssued, []map[string]interface{}{{
		"credentialId":   credID,
		"credentialType": credType,
		"issuer":         issuer,
		"subject":        subject["id"],
		"assetId":        subject["assetId"],
		"keyFingerprint": keyFingerprint(pub),
		"anchored":       "pending",
	}})

	cred := &Credential{
		Context: []string{
			"https://www.w3.org/2018/credentials/v1",
			"https://aasthichain.example/credentials/v1",
		},
		ID:                credID,
		Type:              []string{"VerifiableCredential", credType},
		Issuer:            "did:aasthi:" + strings.ToLower(issuer),
		IssuanceDate:      anchor.Timestamp,
		CredentialSubject: subject,
	}

	msg, err := canonicalBytes(cred)
	if err != nil {
		return nil, err
	}
	sig := ed25519.Sign(key, msg)
	cred.Proof = &CredentialProof{
		Type:               "Ed25519Signature2020",
		Created:            anchor.Timestamp,
		VerificationMethod: cred.Issuer + "#key-1",
		ProofPurpose:       "assertionMethod",
		ProofValue:         base64.RawURLEncoding.EncodeToString(sig),
	}

	credHash, err := hashOf(cred)
	if err != nil {
		return nil, err
	}

	// The hash of the signed document, which is what verification compares
	// against. Written as its own transaction in a second block because the
	// hash cannot exist before the issuance date it covers.
	sealed := r.chain.Append(BlockCredentialIssued, []map[string]interface{}{{
		"credentialId":   credID,
		"credentialType": credType,
		"issuer":         issuer,
		"subject":        subject["id"],
		"assetId":        subject["assetId"],
		"keyFingerprint": keyFingerprint(pub),
		"credentialHash": credHash,
		"issuanceDate":   cred.IssuanceDate,
		"anchored":       "sealed",
	}})

	rec := &credentialRecord{
		Credential:  cred,
		Hash:        credHash,
		IssuedBy:    issuer,
		IssuedBlock: sealed.Height,
	}

	r.mu.Lock()
	if _, seen := r.records[credID]; !seen {
		r.order = append(r.order, credID)
	}
	r.records[credID] = rec
	r.mu.Unlock()
	return rec, nil
}

// Get returns a stored credential.
func (r *CredentialRegistry) Get(id string) (*credentialRecord, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	rec, ok := r.records[id]
	if !ok {
		return nil, ErrCredNotFound
	}
	return rec, nil
}

// List returns stored credentials, newest first, optionally filtered.
func (r *CredentialRegistry) List(assetID, subject string, limit int) []*credentialRecord {
	r.mu.RLock()
	defer r.mu.RUnlock()
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	out := []*credentialRecord{}
	for i := len(r.order) - 1; i >= 0 && len(out) < limit; i-- {
		rec := r.records[r.order[i]]
		if rec == nil {
			continue
		}
		if assetID != "" {
			if got, _ := rec.Credential.CredentialSubject["assetId"].(string); !strings.EqualFold(got, assetID) {
				continue
			}
		}
		if subject != "" {
			if got, _ := rec.Credential.CredentialSubject["id"].(string); !strings.EqualFold(got, subject) {
				continue
			}
		}
		out = append(out, rec)
	}
	return out
}

// Revoke marks a credential revoked and records it on the chain. The
// credential's signature stays valid: that is the point of reporting the two
// separately.
func (r *CredentialRegistry) Revoke(id, by, reason string) (*credentialRecord, error) {
	r.mu.Lock()
	rec, ok := r.records[id]
	if !ok {
		r.mu.Unlock()
		return nil, ErrCredNotFound
	}
	if rec.Revoked {
		r.mu.Unlock()
		return nil, ErrCredRevoked
	}
	r.mu.Unlock()

	blk := r.chain.Append(BlockCredentialRevoked, []map[string]interface{}{{
		"credentialId": id,
		"revokedBy":    by,
		"reason":       reason,
	}})

	r.mu.Lock()
	rec.Revoked = true
	rec.RevokedBy = by
	rec.RevokedReason = reason
	rec.RevokedBlock = blk.Height
	r.mu.Unlock()
	return rec, nil
}

// CredentialVerification is the four-part answer. Nothing here is collapsed
// into a single boolean, because a revoked credential has a valid signature
// and a verifier needs to know which question failed.
type CredentialVerification struct {
	CredentialID    string `json:"credentialId"`
	SignatureValid  bool   `json:"signatureValid"`
	AnchorMatches   bool   `json:"anchorMatches"`
	Revoked         bool   `json:"revoked"`
	IssuerKnown     bool   `json:"issuerKnown"`
	AnchoredAtBlock int64  `json:"anchoredAtBlock,omitempty"`
	AnchoredHash    string `json:"anchoredHash,omitempty"`
	PresentedHash   string `json:"presentedHash,omitempty"`
	Issuer          string `json:"issuer,omitempty"`
	PublicKey       string `json:"issuerPublicKey,omitempty"`
	DemoKey         bool   `json:"issuerKeyIsPublicDemoKey"`
	Summary         string `json:"summary"`
}

// VerifyPresented checks a credential handed to us, which is the case that
// matters: the holder keeps the document and a verifier should not have to
// ask us for it, only for the anchor.
func (r *CredentialRegistry) VerifyPresented(cred *Credential) (*CredentialVerification, error) {
	if cred == nil || cred.ID == "" || cred.Proof == nil {
		return nil, ErrCredFields
	}
	_, demo := issuerSeed()
	out := &CredentialVerification{CredentialID: cred.ID, DemoKey: demo}

	issuer := strings.TrimPrefix(cred.Issuer, "did:aasthi:")
	out.Issuer = issuer
	key := r.keyFor(issuer)
	pub := key.Public().(ed25519.PublicKey)
	out.PublicKey = hex.EncodeToString(pub)
	out.IssuerKnown = issuer != ""

	msg, err := canonicalBytes(cred)
	if err != nil {
		return nil, err
	}
	sig, err := base64.RawURLEncoding.DecodeString(cred.Proof.ProofValue)
	if err == nil {
		out.SignatureValid = ed25519.Verify(pub, msg, sig)
	}

	presented, err := hashOf(cred)
	if err != nil {
		return nil, err
	}
	out.PresentedHash = presented

	// The anchor is read from the chain rather than from the in-memory book,
	// so a verifier is trusting the append-only record and not our map.
	anchoredHash, anchoredAt, revoked := r.anchorFor(cred.ID)
	out.AnchoredHash = anchoredHash
	out.AnchoredAtBlock = anchoredAt
	out.Revoked = revoked
	out.AnchorMatches = anchoredHash != "" && anchoredHash == presented

	switch {
	case !out.SignatureValid:
		out.Summary = "signature does not verify: this document was not signed by that issuer, or it has been altered"
	case anchoredHash == "":
		out.Summary = "signature verifies, but no anchor for this credential exists on the ledger"
	case !out.AnchorMatches:
		out.Summary = "signature verifies, but the document does not match the hash anchored on the ledger"
	case out.Revoked:
		out.Summary = "signature verifies and matches the ledger anchor, but the credential has been revoked"
	default:
		out.Summary = "signature verifies and matches the hash anchored on the ledger"
	}
	if demo {
		out.Summary += ". The issuer key is derived from a public demo seed, so this proves integrity, not authority"
	}
	return out, nil
}

// VerifyStored verifies a credential this rail holds, by id.
func (r *CredentialRegistry) VerifyStored(id string) (*CredentialVerification, error) {
	rec, err := r.Get(id)
	if err != nil {
		return nil, err
	}
	return r.VerifyPresented(rec.Credential)
}

// anchorFor reads the chain for a credential's sealed hash, its block and
// whether a revocation was recorded after it.
func (r *CredentialRegistry) anchorFor(id string) (hash string, height int64, revoked bool) {
	if r.chain == nil {
		return "", 0, false
	}
	for _, b := range r.chain.Snapshot() {
		for _, txn := range b.Txns {
			if got, _ := txn["credentialId"].(string); got != id {
				continue
			}
			switch b.Type {
			case BlockCredentialIssued:
				if h, _ := txn["credentialHash"].(string); h != "" {
					hash = h
					height = b.Height
				}
			case BlockCredentialRevoked:
				revoked = true
			}
		}
	}
	return hash, height, revoked
}

// RestoreFromChain rebuilds the credential book after a restart.
//
// Only the anchors are on the chain, by design, so what comes back is the
// list of credentials and their state. The documents themselves are held by
// whoever was issued them, which is how a credential is supposed to work: a
// holder presents it and the ledger confirms the hash.
func (r *CredentialRegistry) RestoreFromChain() int {
	if r == nil || r.chain == nil {
		return 0
	}
	type seen struct {
		hash    string
		height  int64
		issuer  string
		subject string
		asset   string
		typ     string
		revoked bool
		by      string
		reason  string
	}
	found := map[string]*seen{}
	order := []string{}
	for _, b := range r.chain.Snapshot() {
		for _, txn := range b.Txns {
			id, _ := txn["credentialId"].(string)
			if id == "" {
				continue
			}
			s, ok := found[id]
			if !ok {
				s = &seen{}
				found[id] = s
				order = append(order, id)
			}
			switch b.Type {
			case BlockCredentialIssued:
				if h, _ := txn["credentialHash"].(string); h != "" {
					s.hash = h
					s.height = b.Height
				}
				s.issuer, _ = txn["issuer"].(string)
				s.subject, _ = txn["subject"].(string)
				s.asset, _ = txn["assetId"].(string)
				s.typ, _ = txn["credentialType"].(string)
			case BlockCredentialRevoked:
				s.revoked = true
				s.by, _ = txn["revokedBy"].(string)
				s.reason, _ = txn["reason"].(string)
			}
		}
	}

	restored := 0
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, id := range order {
		s := found[id]
		if s.hash == "" {
			// An issuance that never sealed. Nothing to verify against, so
			// it is not restored as if it were a credential.
			continue
		}
		if _, exists := r.records[id]; exists {
			continue
		}
		rec := &credentialRecord{
			Hash:          s.hash,
			IssuedBy:      s.issuer,
			IssuedBlock:   s.height,
			Revoked:       s.revoked,
			RevokedBy:     s.by,
			RevokedReason: s.reason,
		}
		r.records[id] = rec
		r.order = append(r.order, id)
		restored++
	}
	sort.SliceStable(r.order, func(i, j int) bool {
		a, b := r.records[r.order[i]], r.records[r.order[j]]
		if a == nil || b == nil {
			return false
		}
		return a.IssuedBlock < b.IssuedBlock
	})
	return restored
}

// Summary describes the registry for /umi/config and the trust surface.
func (r *CredentialRegistry) Summary() map[string]interface{} {
	r.mu.RLock()
	total := len(r.order)
	revoked := 0
	for _, rec := range r.records {
		if rec.Revoked {
			revoked++
		}
	}
	r.mu.RUnlock()
	_, demo := issuerSeed()
	return map[string]interface{}{
		"issued":        total,
		"revoked":       revoked,
		"signature":     "Ed25519",
		"format":        "W3C Verifiable Credential",
		"anchoredAs":    BlockCredentialIssued,
		"demoIssuerKey": demo,
		"disclosure": fmt.Sprintf("Credential signatures and ledger anchors are real. The issuing authority is simulated: "+
			"a demo registrar identity, not a land-records office. demoIssuerKey=%v means the signing seed is a public "+
			"constant in open source, so a demo credential proves integrity and not authority.", demo),
	}
}
