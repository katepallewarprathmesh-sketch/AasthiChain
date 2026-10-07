package drunix

// Document integrity — a content-addressed, append-only evidence register.
//
// See docs/DOCUMENT-INTEGRITY.md for the reasoning. The short version:
//
//   - A document's identity is its IPFS CID, derived from its bytes. Changing
//     one byte changes the identity, so substitution is detectable by anyone,
//     offline, without trusting this service.
//   - Every anchor and every status change commits a block to the same
//     hash-chained ledger as settlement, so "what evidence existed when this
//     trade settled" is a comparison of two block heights.
//   - Nothing is ever deleted. A revoked document keeps its anchor and gains a
//     revocation on top, because a register that can forget is not a register.
//
// The privacy rule that shapes the code: a CID is computable by anyone holding
// the file, which makes it a confirmation oracle. KYC evidence is therefore
// anchored by digest only — the bytes are never stored, never pinned, and
// there is no code path that can serve them.

import (
	"encoding/base64"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"
)

// Document lifecycle states. Append-only: a document moves forward through
// these and its history is never rewritten.
const (
	DocStatusActive     = "ACTIVE"
	DocStatusSuperseded = "SUPERSEDED"
	DocStatusRevoked    = "REVOKED"
)

// Visibility controls who may fetch the BYTES. The proof — CID, digest, type,
// anchoring block — is always public, for every document.
const (
	// DocPublic means any caller may fetch the content.
	DocPublic = "public"
	// DocRestricted means the content is served only to the submitter, the
	// registrar or a regulator. Metadata stays public.
	DocRestricted = "restricted"
	// DocDigestOnly means the content was never stored. Used for KYC and any
	// other document whose existence may be proven but whose contents must
	// not be retrievable.
	DocDigestOnly = "digestOnly"
)

// Document types. Free-form strings are accepted too — a register that
// rejects an unfamiliar document type is a register people work around — but
// these are the ones the UI knows how to label.
const (
	DocTypeTitleDeed   = "TITLE_DEED"
	DocTypeEncumbrance = "ENCUMBRANCE_CERTIFICATE"
	DocTypeTaxReceipt  = "PROPERTY_TAX_RECEIPT"
	DocTypeOccupancy   = "OCCUPANCY_CERTIFICATE"
	DocTypeApprovedPln = "APPROVED_PLAN"
	DocTypeSaleAgmt    = "SALE_AGREEMENT"
	DocTypeNOC         = "SOCIETY_NOC"
	DocTypeValuation   = "VALUATION_REPORT"
	DocTypeBondIM      = "BOND_INFORMATION_MEMORANDUM"
	DocTypeTrustDeed   = "DEBENTURE_TRUST_DEED"
	DocTypeCouponAdv   = "COUPON_PAYMENT_ADVICE"
	DocTypeKYC         = "KYC_EVIDENCE"
)

// Block types committed by this subsystem.
const (
	BlockDocAnchored = "UMI_DOC_ANCHORED"
	BlockDocStatus   = "UMI_DOC_STATUS"
)

var (
	// ErrDocNotFound is an unknown CID.
	ErrDocNotFound = errors.New("ERR_UMI_DOC_NOT_FOUND")
	// ErrDocDuplicate is the same bytes anchored twice. The error names the
	// asset that already claims them.
	ErrDocDuplicate = errors.New("ERR_UMI_DOC_DUPLICATE")
	// ErrDocEmpty rejects an empty document.
	ErrDocEmpty = errors.New("ERR_UMI_DOC_EMPTY")
	// ErrDocTooLarge caps a single upload.
	ErrDocTooLarge = errors.New("ERR_UMI_DOC_TOO_LARGE")
	// ErrDocFields rejects a missing assetId or docType.
	ErrDocFields = errors.New("ERR_UMI_DOC_FIELDS")
	// ErrDocNotRetrievable is a fetch against a digest-only anchor. This is
	// not a permission problem that a different caller could solve — the
	// bytes do not exist anywhere in the system.
	ErrDocNotRetrievable = errors.New("ERR_UMI_DOC_NOT_RETRIEVABLE")
	// ErrDocForbidden is a fetch of restricted content by someone with no
	// claim to it.
	ErrDocForbidden = errors.New("ERR_UMI_DOC_FORBIDDEN")
	// ErrDocAlreadyClosed rejects revoking or superseding twice.
	ErrDocAlreadyClosed = errors.New("ERR_UMI_DOC_ALREADY_CLOSED")
)

// maxDocBytes caps one upload at 25 MB — comfortably above a scanned deed and
// well below anything that would wedge the process.
const maxDocBytes = 25 << 20

// Document is one piece of evidence attached to an asset or a participant.
type Document struct {
	CID         string `json:"cid"`
	SHA256      string `json:"sha256"`
	AssetID     string `json:"assetId,omitempty"`
	Subject     string `json:"subject,omitempty"` // participant, for KYC evidence
	DocType     string `json:"docType"`
	Title       string `json:"title,omitempty"`
	Issuer      string `json:"issuer,omitempty"`
	SubmittedBy string `json:"submittedBy"`

	SizeBytes  int    `json:"sizeBytes"`
	MediaType  string `json:"mediaType,omitempty"`
	Visibility string `json:"visibility"`
	Status     string `json:"status"`

	ValidFrom *time.Time `json:"validFrom,omitempty"`
	ValidTo   *time.Time `json:"validTo,omitempty"`

	AnchoredAt  time.Time `json:"anchoredAt"`
	BlockHeight int64     `json:"blockHeight"`
	BlockHash   string    `json:"blockHash,omitempty"`
	GatewayURL  string    `json:"gatewayUrl,omitempty"`
	Pinned      bool      `json:"pinned"`

	// Lifecycle, append-only.
	SupersededBy string     `json:"supersededBy,omitempty"`
	Supersedes   string     `json:"supersedes,omitempty"`
	StatusReason string     `json:"statusReason,omitempty"`
	StatusAt     *time.Time `json:"statusChangedAt,omitempty"`
	StatusBlock  int64      `json:"statusBlockHeight,omitempty"`
}

// Expired reports whether the document's validity window has closed. Kept
// separate from Status on purpose: expiry is a fact about the calendar, not a
// decision somebody made, and a stale encumbrance certificate is not the same
// thing as a revoked one.
func (d *Document) Expired(now time.Time) bool {
	return d.ValidTo != nil && now.After(*d.ValidTo)
}

// PinStore is where document bytes live. The default keeps them in process;
// a deployment swaps in an IPFS node or a pinning service without touching
// any verification logic, because verification never consults the store — it
// re-derives the CID from whatever bytes it is given.
type PinStore interface {
	Pin(cid string, content []byte) error
	Fetch(cid string) ([]byte, bool)
	Name() string
}

// memoryPinStore is the default: self-contained, no network, enough for the
// demo and for tests.
type memoryPinStore struct {
	mu   sync.RWMutex
	blob map[string][]byte
}

// NewMemoryPinStore returns an in-process pin store.
func NewMemoryPinStore() PinStore {
	return &memoryPinStore{blob: map[string][]byte{}}
}

func (m *memoryPinStore) Pin(cid string, content []byte) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	cp := make([]byte, len(content))
	copy(cp, content)
	m.blob[cid] = cp
	return nil
}

func (m *memoryPinStore) Fetch(cid string) ([]byte, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	b, ok := m.blob[cid]
	return b, ok
}

func (m *memoryPinStore) Name() string { return "in-process (set IPFS_API_URL to pin to a node)" }

// DocumentRegistry is the evidence register. It holds its own lock so
// anchoring a document can never block a settlement.
type DocumentRegistry struct {
	mu      sync.RWMutex
	docs    map[string]*Document // cid -> document
	byAsset map[string][]string  // assetId -> cids, oldest first
	bySubj  map[string][]string  // participant -> cids (KYC evidence)
	bySHA   map[string]string    // sha256 hex -> cid, for the legacy hash path
	order   []string             // every cid, anchoring order
	pins    PinStore
	chain   *DrunixChain
}

// NewDocumentRegistry wires the register to the ledger and a pin store.
// chain may be nil (anchoring still records, but commits no block).
func NewDocumentRegistry(chain *DrunixChain, pins PinStore) *DocumentRegistry {
	if pins == nil {
		pins = NewMemoryPinStore()
	}
	return &DocumentRegistry{
		docs:    map[string]*Document{},
		byAsset: map[string][]string{},
		bySubj:  map[string][]string{},
		bySHA:   map[string]string{},
		pins:    pins,
		chain:   chain,
	}
}

// AnchorRequest describes a document being placed on the register.
type AnchorRequest struct {
	AssetID     string
	Subject     string // for KYC evidence, the participant it concerns
	DocType     string
	Title       string
	Issuer      string
	SubmittedBy string
	MediaType   string
	Visibility  string
	Content     []byte
	ValidFrom   *time.Time
	ValidTo     *time.Time
	// Supersedes, when set, closes an existing document as replaced by this
	// one in the same operation, so the register is never briefly ambiguous
	// about which version is current.
	Supersedes string
}

// Anchor records a document, pins its bytes if it is retrievable, and commits
// the evidence to the ledger.
//
// Duplicate rejection is the rule worth noting: the same bytes cannot be
// anchored twice anywhere on the rail. This is the same protection the
// chaincode already gives deeds through its `hash~` index, extended to every
// document type, and it is what stops one encumbrance certificate being
// recycled across several listings.
func (dr *DocumentRegistry) Anchor(req AnchorRequest) (*Document, *DrunixBlock, error) {
	if len(req.Content) == 0 {
		return nil, nil, ErrDocEmpty
	}
	if len(req.Content) > maxDocBytes {
		return nil, nil, fmt.Errorf("%w: %d bytes, limit %d", ErrDocTooLarge, len(req.Content), maxDocBytes)
	}
	if strings.TrimSpace(req.DocType) == "" {
		return nil, nil, fmt.Errorf("%w: docType is required", ErrDocFields)
	}
	if strings.TrimSpace(req.AssetID) == "" && strings.TrimSpace(req.Subject) == "" {
		return nil, nil, fmt.Errorf("%w: one of assetId or subject is required", ErrDocFields)
	}

	cid, shaHex := CIDFor(req.Content)
	visibility := normaliseVisibility(req.DocType, req.Visibility)

	dr.mu.Lock()
	if existing, ok := dr.docs[cid]; ok {
		dr.mu.Unlock()
		where := existing.AssetID
		if where == "" {
			where = existing.Subject
		}
		return nil, nil, fmt.Errorf("%w: these exact bytes are already anchored to %s as %s",
			ErrDocDuplicate, where, existing.DocType)
	}
	var prior *Document
	if req.Supersedes != "" {
		p, ok := dr.docs[req.Supersedes]
		if !ok {
			dr.mu.Unlock()
			return nil, nil, fmt.Errorf("%w: %s", ErrDocNotFound, req.Supersedes)
		}
		if p.Status != DocStatusActive {
			dr.mu.Unlock()
			return nil, nil, fmt.Errorf("%w: %s is already %s", ErrDocAlreadyClosed, p.CID, p.Status)
		}
		prior = p
	}

	now := time.Now().UTC()
	doc := &Document{
		CID: cid, SHA256: shaHex,
		AssetID: req.AssetID, Subject: req.Subject,
		DocType: req.DocType, Title: req.Title, Issuer: req.Issuer,
		SubmittedBy: req.SubmittedBy,
		SizeBytes:   len(req.Content),
		MediaType:   req.MediaType,
		Visibility:  visibility,
		Status:      DocStatusActive,
		ValidFrom:   req.ValidFrom, ValidTo: req.ValidTo,
		AnchoredAt: now,
		Supersedes: req.Supersedes,
	}

	// Digest-only evidence is never written anywhere. The check is here, at
	// the single point where bytes could be stored, so no later code path can
	// accidentally persist it.
	if visibility != DocDigestOnly {
		if err := dr.pins.Pin(cid, req.Content); err == nil {
			doc.Pinned = true
			doc.GatewayURL = IPFSGatewayURL(cid)
		}
	}

	dr.docs[cid] = doc
	dr.order = append(dr.order, cid)
	dr.bySHA[shaHex] = cid
	if req.AssetID != "" {
		dr.byAsset[req.AssetID] = append(dr.byAsset[req.AssetID], cid)
	}
	if req.Subject != "" {
		dr.bySubj[req.Subject] = append(dr.bySubj[req.Subject], cid)
	}
	if prior != nil {
		prior.Status = DocStatusSuperseded
		prior.SupersededBy = cid
		prior.StatusReason = "replaced by a newer version"
		prior.StatusAt = &now
	}
	dr.mu.Unlock()

	// The block is committed outside the lock: a ledger append must never be
	// able to stall a read of the register.
	block := dr.commit(BlockDocAnchored, map[string]interface{}{
		"kind":        "umi-document-anchor",
		"cid":         cid,
		"sha256":      shaHex,
		"assetId":     req.AssetID,
		"subject":     req.Subject,
		"docType":     req.DocType,
		"issuer":      req.Issuer,
		"submittedBy": req.SubmittedBy,
		"sizeBytes":   len(req.Content),
		"visibility":  visibility,
		"retrievable": visibility != DocDigestOnly,
		"supersedes":  req.Supersedes,
		"contract":    "aasthi.umi-documents-v1",
		"note":        "Content-addressed evidence. The CID is derived from the bytes, so the document cannot be altered without changing its name.",
	})
	dr.mu.Lock()
	if block != nil {
		doc.BlockHeight, doc.BlockHash = block.Height, block.Hash
		if prior != nil {
			prior.StatusBlock = block.Height
		}
	}
	out := *doc
	dr.mu.Unlock()
	return &out, block, nil
}

// normaliseVisibility applies the privacy rule. KYC evidence is forced to
// digest-only regardless of what the caller asked for — the one place in this
// file where a caller's request is overridden, and deliberately so.
func normaliseVisibility(docType, requested string) string {
	if strings.EqualFold(docType, DocTypeKYC) {
		return DocDigestOnly
	}
	switch strings.ToLower(strings.TrimSpace(requested)) {
	case DocPublic:
		return DocPublic
	case strings.ToLower(DocDigestOnly):
		return DocDigestOnly
	case DocRestricted:
		return DocRestricted
	default:
		// Default to restricted. A document whose visibility nobody thought
		// about should not be world-readable.
		return DocRestricted
	}
}

// AnchorKYC records that a participant passed a document check, without the
// document. This is the DigiLocker path: the evidence is a digest and a
// timestamp, and the Aadhaar never enters the system.
func (dr *DocumentRegistry) AnchorKYC(subject, docType, issuer string, evidence []byte) (*Document, *DrunixBlock, error) {
	return dr.Anchor(AnchorRequest{
		Subject:     subject,
		DocType:     DocTypeKYC,
		Title:       docType + " verified via " + issuer,
		Issuer:      issuer,
		SubmittedBy: subject,
		Visibility:  DocDigestOnly,
		Content:     evidence,
	})
}

// VerifyResult answers "is this document on the register, and is it current?"
type VerifyResult struct {
	Anchored     bool       `json:"anchored"`
	CID          string     `json:"cid,omitempty"`
	SHA256       string     `json:"sha256,omitempty"`
	Status       string     `json:"status,omitempty"`
	Expired      bool       `json:"expired"`
	AssetID      string     `json:"assetId,omitempty"`
	Subject      string     `json:"subject,omitempty"`
	DocType      string     `json:"docType,omitempty"`
	BlockHeight  int64      `json:"blockHeight,omitempty"`
	BlockHash    string     `json:"blockHash,omitempty"`
	AnchoredAt   *time.Time `json:"anchoredAt,omitempty"`
	SupersededBy string     `json:"supersededBy,omitempty"`
	Reason       string     `json:"reason,omitempty"`
	Verdict      string     `json:"verdict"`
}

// VerifyContent is the strongest check: hand it the file and it re-derives the
// CID, so it detects a tampered copy even when the metadata looks right.
func (dr *DocumentRegistry) VerifyContent(content []byte) VerifyResult {
	if len(content) == 0 {
		return VerifyResult{Verdict: "no content supplied"}
	}
	cid, _ := CIDFor(content)
	res := dr.VerifyCID(cid)
	if !res.Anchored {
		res.CID = cid
		res.Verdict = "these bytes are not on the register — either the document was never anchored, or it has been altered since it was"
	}
	return res
}

// VerifyCID checks a CID that someone already holds.
func (dr *DocumentRegistry) VerifyCID(cid string) VerifyResult {
	dr.mu.RLock()
	doc, ok := dr.docs[strings.TrimSpace(cid)]
	dr.mu.RUnlock()
	if !ok {
		return VerifyResult{CID: cid, Verdict: "not anchored"}
	}
	return describe(doc)
}

// VerifySHA256 supports the hash the existing chaincode and
// /verify-document already speak, so the new register answers the old
// question too.
func (dr *DocumentRegistry) VerifySHA256(hex string) VerifyResult {
	dr.mu.RLock()
	cid, ok := dr.bySHA[strings.ToLower(strings.TrimSpace(hex))]
	dr.mu.RUnlock()
	if !ok {
		return VerifyResult{SHA256: hex, Verdict: "not anchored"}
	}
	return dr.VerifyCID(cid)
}

func describe(doc *Document) VerifyResult {
	now := time.Now().UTC()
	at := doc.AnchoredAt
	res := VerifyResult{
		Anchored: true, CID: doc.CID, SHA256: doc.SHA256,
		Status: doc.Status, Expired: doc.Expired(now),
		AssetID: doc.AssetID, Subject: doc.Subject, DocType: doc.DocType,
		BlockHeight: doc.BlockHeight, BlockHash: doc.BlockHash,
		AnchoredAt: &at, SupersededBy: doc.SupersededBy, Reason: doc.StatusReason,
	}
	switch {
	case doc.Status == DocStatusRevoked:
		res.Verdict = "anchored but REVOKED — do not rely on this document"
	case doc.Status == DocStatusSuperseded:
		res.Verdict = "anchored but superseded by a newer version"
	case res.Expired:
		res.Verdict = "anchored and unaltered, but its validity period has ended"
	default:
		res.Verdict = "anchored and current"
	}
	return res
}

// Revoke withdraws a document. The anchor stays; the revocation is added on
// top of it, so the record of what was once relied upon survives.
func (dr *DocumentRegistry) Revoke(cid, reason, by string) (*Document, *DrunixBlock, error) {
	return dr.close(cid, DocStatusRevoked, reason, by, "")
}

// Supersede marks a document as replaced by one already on the register.
func (dr *DocumentRegistry) Supersede(cid, replacementCID, reason, by string) (*Document, *DrunixBlock, error) {
	dr.mu.RLock()
	_, ok := dr.docs[replacementCID]
	dr.mu.RUnlock()
	if !ok {
		return nil, nil, fmt.Errorf("%w: replacement %s is not anchored", ErrDocNotFound, replacementCID)
	}
	return dr.close(cid, DocStatusSuperseded, reason, by, replacementCID)
}

func (dr *DocumentRegistry) close(cid, status, reason, by, replacement string) (*Document, *DrunixBlock, error) {
	dr.mu.Lock()
	doc, ok := dr.docs[cid]
	if !ok {
		dr.mu.Unlock()
		return nil, nil, fmt.Errorf("%w: %s", ErrDocNotFound, cid)
	}
	if doc.Status != DocStatusActive {
		dr.mu.Unlock()
		return nil, nil, fmt.Errorf("%w: %s is already %s", ErrDocAlreadyClosed, cid, doc.Status)
	}
	now := time.Now().UTC()
	doc.Status = status
	doc.StatusReason = reason
	doc.StatusAt = &now
	if replacement != "" {
		doc.SupersededBy = replacement
	}
	dr.mu.Unlock()

	block := dr.commit(BlockDocStatus, map[string]interface{}{
		"kind":         "umi-document-status",
		"cid":          cid,
		"assetId":      doc.AssetID,
		"docType":      doc.DocType,
		"status":       status,
		"reason":       reason,
		"by":           by,
		"supersededBy": replacement,
		"contract":     "aasthi.umi-documents-v1",
		"note":         "The original anchor is untouched. Withdrawal is recorded on top of it, never in place of it.",
	})
	dr.mu.Lock()
	if block != nil {
		doc.StatusBlock = block.Height
	}
	out := *doc
	dr.mu.Unlock()
	return &out, block, nil
}

// Fetch returns the bytes, enforcing visibility. It re-verifies the CID before
// handing anything back: if what came out of storage does not hash to the name
// it was stored under, the storage layer is compromised and the read fails
// rather than returning a document that would not verify.
func (dr *DocumentRegistry) Fetch(cid, requester, role string) ([]byte, *Document, error) {
	dr.mu.RLock()
	doc, ok := dr.docs[cid]
	dr.mu.RUnlock()
	if !ok {
		return nil, nil, fmt.Errorf("%w: %s", ErrDocNotFound, cid)
	}
	if doc.Visibility == DocDigestOnly {
		return nil, nil, fmt.Errorf("%w: %s was anchored by digest only; its contents were never stored", ErrDocNotRetrievable, cid)
	}
	if doc.Visibility == DocRestricted && !maySeeRestricted(doc, requester, role) {
		return nil, nil, fmt.Errorf("%w: %s is restricted to the submitter, a registrar or a regulator", ErrDocForbidden, cid)
	}
	content, ok := dr.pins.Fetch(cid)
	if !ok {
		return nil, nil, fmt.Errorf("%w: %s is anchored but its bytes are not pinned here", ErrDocNotFound, cid)
	}
	if !VerifyCID(cid, content) {
		// Storage returned something that is not this document.
		return nil, nil, fmt.Errorf("%w: stored bytes for %s do not match the CID — refusing to serve them", ErrDocNotFound, cid)
	}
	out := *doc
	return content, &out, nil
}

func maySeeRestricted(doc *Document, requester, role string) bool {
	switch strings.ToLower(role) {
	case "registrar", "regulator":
		return true
	}
	return requester != "" && (requester == doc.SubmittedBy || requester == doc.Subject)
}

// ForAsset lists every document attached to an asset, newest first.
func (dr *DocumentRegistry) ForAsset(assetID string) []Document {
	dr.mu.RLock()
	defer dr.mu.RUnlock()
	cids := dr.byAsset[assetID]
	out := make([]Document, 0, len(cids))
	for i := len(cids) - 1; i >= 0; i-- {
		if d, ok := dr.docs[cids[i]]; ok {
			out = append(out, *d)
		}
	}
	return out
}

// ForSubject lists a participant's KYC evidence (digests, never content).
func (dr *DocumentRegistry) ForSubject(subject string) []Document {
	dr.mu.RLock()
	defer dr.mu.RUnlock()
	cids := dr.bySubj[subject]
	out := make([]Document, 0, len(cids))
	for i := len(cids) - 1; i >= 0; i-- {
		if d, ok := dr.docs[cids[i]]; ok {
			out = append(out, *d)
		}
	}
	return out
}

// Get returns one document by CID.
func (dr *DocumentRegistry) Get(cid string) (*Document, bool) {
	dr.mu.RLock()
	defer dr.mu.RUnlock()
	d, ok := dr.docs[cid]
	if !ok {
		return nil, false
	}
	out := *d
	return &out, true
}

// DocumentStats summarises the register for the dashboard.
type DocumentStats struct {
	Total      int            `json:"total"`
	Active     int            `json:"active"`
	Superseded int            `json:"superseded"`
	Revoked    int            `json:"revoked"`
	Expired    int            `json:"expired"`
	Pinned     int            `json:"pinned"`
	DigestOnly int            `json:"digestOnly"`
	ByType     map[string]int `json:"byType"`
	Assets     int            `json:"assetsWithDocuments"`
	PinStore   string         `json:"pinStore"`
}

// Stats reports the register's shape.
func (dr *DocumentRegistry) Stats() DocumentStats {
	dr.mu.RLock()
	defer dr.mu.RUnlock()
	now := time.Now().UTC()
	st := DocumentStats{ByType: map[string]int{}, Assets: len(dr.byAsset), PinStore: dr.pins.Name()}
	for _, d := range dr.docs {
		st.Total++
		st.ByType[d.DocType]++
		switch d.Status {
		case DocStatusActive:
			st.Active++
		case DocStatusSuperseded:
			st.Superseded++
		case DocStatusRevoked:
			st.Revoked++
		}
		if d.Expired(now) {
			st.Expired++
		}
		if d.Pinned {
			st.Pinned++
		}
		if d.Visibility == DocDigestOnly {
			st.DigestOnly++
		}
	}
	return st
}

// commit appends to the ledger, tolerating a nil chain.
func (dr *DocumentRegistry) commit(blockType string, payload map[string]interface{}) *DrunixBlock {
	if dr.chain == nil {
		return nil
	}
	return dr.chain.Append(blockType, []map[string]interface{}{payload})
}

// DecodeBase64Content accepts either plain base64 or a data: URL, which is
// what a browser FileReader produces. Saves every caller from stripping the
// prefix themselves and getting it subtly wrong.
func DecodeBase64Content(s string) ([]byte, error) {
	s = strings.TrimSpace(s)
	if i := strings.Index(s, "base64,"); i >= 0 {
		s = s[i+len("base64,"):]
	}
	s = strings.ReplaceAll(strings.ReplaceAll(s, "\n", ""), "\r", "")
	b, err := base64.StdEncoding.DecodeString(s)
	if err != nil {
		if b2, err2 := base64.RawStdEncoding.DecodeString(s); err2 == nil {
			return b2, nil
		}
		return nil, err
	}
	return b, nil
}
