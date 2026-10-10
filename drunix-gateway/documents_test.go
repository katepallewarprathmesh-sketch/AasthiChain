package drunix

import (
	"bytes"
	"crypto/sha256"
	"encoding/base32"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// --------------------------------------------------------------------------
// CID correctness
// --------------------------------------------------------------------------

// The point of using IPFS addressing is interoperability: our CID must be the
// CID a real IPFS node produces, or a third party cannot verify anything. This
// checks a published vector — `echo -n "hello world" | ipfs add --cid-version=1
// --raw-leaves=true` — rather than checking our implementation against itself.
func TestCIDMatchesPublishedIPFSVector(t *testing.T) {
	const want = "bafkreifzjut3te2nhyekklss27nh3k72ysco7y32koao5eei66wof36n5e"
	got, shaHex := CIDFor([]byte("hello world"))
	if got != want {
		t.Errorf("CID for \"hello world\"\n got  %s\n want %s", got, want)
	}
	// And the companion digest is the plain SHA-256 the chaincode speaks.
	sum := sha256.Sum256([]byte("hello world"))
	if shaHex != hex.EncodeToString(sum[:]) {
		t.Errorf("sha256 = %s", shaHex)
	}
}

// Decoding must recover exactly the bytes the envelope promises: CIDv1, raw
// codec, sha2-256, and the digest of the content.
func TestCIDEnvelopeIsWellFormed(t *testing.T) {
	content := []byte("a title deed")
	cid, _ := CIDFor(content)
	codec, digest, err := DecodeCID(cid)
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if codec != codecRaw {
		t.Errorf("codec = 0x%x, want raw 0x55", codec)
	}
	sum := sha256.Sum256(content)
	if !bytes.Equal(digest, sum[:]) {
		t.Error("the digest inside the CID is not the hash of the content")
	}
	if !strings.HasPrefix(cid, "bafkrei") {
		t.Errorf("a raw sha2-256 CIDv1 should start with bafkrei, got %s", cid)
	}
}

// One flipped byte must produce a completely different name. This is the
// tamper detection property, stated as a test.
func TestOneByteChangeChangesTheCID(t *testing.T) {
	original := []byte("Sale consideration: INR 50,00,000")
	tampered := []byte("Sale consideration: INR 90,00,000")
	a, _ := CIDFor(original)
	b, _ := CIDFor(tampered)
	if a == b {
		t.Fatal("two different documents produced the same CID")
	}
	if VerifyCID(a, tampered) {
		t.Error("a tampered document verified against the original CID")
	}
	if !VerifyCID(a, original) {
		t.Error("the original document failed to verify against its own CID")
	}
}

// A file bigger than one chunk goes through the UnixFS path, which must still
// produce a well-formed, deterministic, dag-pb CID.
func TestLargeFileUsesChunkedUnixFSAddressing(t *testing.T) {
	big := bytes.Repeat([]byte("scanned deed page content "), 40000) // ~1 MB
	if len(big) <= ipfsChunkSize {
		t.Fatalf("test fixture is too small: %d bytes", len(big))
	}
	cid, _ := CIDFor(big)
	codec, _, err := DecodeCID(cid)
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if codec != codecDagPB {
		t.Errorf("a multi-chunk file must be dag-pb (0x70), got 0x%x", codec)
	}
	if !strings.HasPrefix(cid, "bafybei") {
		t.Errorf("a dag-pb CIDv1 should start with bafybei, got %s", cid)
	}
	again, _ := CIDFor(big)
	if cid != again {
		t.Error("CID computation is not deterministic")
	}
	// Changing a byte in the LAST chunk must still change the root.
	mutated := append([]byte{}, big...)
	mutated[len(mutated)-1] ^= 0xFF
	if m, _ := CIDFor(mutated); m == cid {
		t.Error("a change in the final chunk did not change the root CID")
	}
}

func TestMalformedCIDsAreRejected(t *testing.T) {
	for _, bad := range []string{"", "x", "QmNotV1", "bafkrei!!!", strings.Repeat("b", 80)} {
		if _, _, err := DecodeCID(bad); err == nil {
			t.Errorf("accepted a malformed CID: %q", bad)
		}
	}
}

// A CID is standard multibase base32 — a third-party tool must be able to
// decode it without our code.
func TestCIDIsStandardMultibaseBase32(t *testing.T) {
	cid, _ := CIDFor([]byte("interop"))
	raw, err := base32.NewEncoding("abcdefghijklmnopqrstuvwxyz234567").
		WithPadding(base32.NoPadding).DecodeString(cid[1:])
	if err != nil {
		t.Fatalf("a standard base32 decoder could not read our CID: %v", err)
	}
	if len(raw) != 36 || raw[0] != 0x01 || raw[1] != 0x55 || raw[2] != 0x12 || raw[3] != 0x20 {
		t.Errorf("unexpected CID prefix: %x", raw[:4])
	}
}

// --------------------------------------------------------------------------
// Register behaviour
// --------------------------------------------------------------------------

func newDocRegistry() (*DocumentRegistry, *DrunixChain) {
	chain := NewChain()
	return NewDocumentRegistry(chain, NewMemoryPinStore()), chain
}

func anchorTestDoc(t *testing.T, dr *DocumentRegistry, assetID, docType string, content []byte) *Document {
	t.Helper()
	doc, _, err := dr.Anchor(AnchorRequest{
		AssetID: assetID, DocType: docType, SubmittedBy: "originator1",
		Visibility: DocPublic, Content: content,
	})
	if err != nil {
		t.Fatalf("anchor: %v", err)
	}
	return doc
}

// Anchoring must commit a block, because "when did this evidence exist" is
// only answerable if it is on the chain alongside the settlements.
func TestAnchoringCommitsABlock(t *testing.T) {
	dr, chain := newDocRegistry()
	before := len(chain.Snapshot())
	doc, block, err := dr.Anchor(AnchorRequest{
		AssetID: "PROP-A", DocType: DocTypeTitleDeed, SubmittedBy: "originator1",
		Visibility: DocPublic, Content: []byte("THE TITLE DEED"),
	})
	if err != nil {
		t.Fatalf("anchor: %v", err)
	}
	if block == nil {
		t.Fatal("no block committed")
	}
	if block.Type != BlockDocAnchored {
		t.Errorf("block type = %s", block.Type)
	}
	if len(chain.Snapshot()) != before+1 {
		t.Errorf("chain height %d -> %d", before, len(chain.Snapshot()))
	}
	if doc.BlockHeight != block.Height {
		t.Errorf("document records height %d, block is %d", doc.BlockHeight, block.Height)
	}
	if !chain.Verify().Valid {
		t.Error("the chain no longer verifies after anchoring")
	}
}

// The same bytes cannot back two assets — the protection the chaincode gives
// deeds, extended to every document type.
func TestTheSameDocumentCannotBeAnchoredTwice(t *testing.T) {
	dr, _ := newDocRegistry()
	content := []byte("ENCUMBRANCE CERTIFICATE 2026")
	anchorTestDoc(t, dr, "PROP-A", DocTypeEncumbrance, content)

	_, _, err := dr.Anchor(AnchorRequest{
		AssetID: "PROP-B", DocType: DocTypeEncumbrance, SubmittedBy: "originator2",
		Visibility: DocPublic, Content: content,
	})
	if err == nil {
		t.Fatal("the same certificate was accepted for a second property")
	}
	if !strings.Contains(err.Error(), "PROP-A") {
		t.Errorf("the rejection should name the asset that already claims it: %v", err)
	}
}

// Verification by content is the real test: hand it a doctored file and it
// must fail even though everything else about the submission looks right.
func TestTamperedContentFailsVerification(t *testing.T) {
	dr, _ := newDocRegistry()
	original := []byte("Consideration: INR 50,00,000. Khasra 112/4.")
	anchorTestDoc(t, dr, "PROP-A", DocTypeTitleDeed, original)

	if res := dr.VerifyContent(original); !res.Anchored || res.Verdict != "anchored and current" {
		t.Errorf("the genuine document did not verify: %+v", res)
	}
	tampered := []byte("Consideration: INR 90,00,000. Khasra 112/4.")
	res := dr.VerifyContent(tampered)
	if res.Anchored {
		t.Fatal("a tampered document was reported as anchored")
	}
	if !strings.Contains(res.Verdict, "altered") {
		t.Errorf("the verdict should say the document may have been altered, got %q", res.Verdict)
	}
}

// Revocation is additive: the anchor survives, the withdrawal sits on top.
func TestRevocationIsAdditiveNotDestructive(t *testing.T) {
	dr, chain := newDocRegistry()
	doc := anchorTestDoc(t, dr, "PROP-A", DocTypeTitleDeed, []byte("deed v1"))
	heightAtAnchor := len(chain.Snapshot())

	revoked, block, err := dr.Revoke(doc.CID, "registrar found a forged attestation", "registrar1")
	if err != nil {
		t.Fatalf("revoke: %v", err)
	}
	if block == nil || block.Type != BlockDocStatus {
		t.Fatalf("revocation did not commit a status block: %+v", block)
	}
	if len(chain.Snapshot()) <= heightAtAnchor {
		t.Error("revocation replaced the anchor instead of adding to it")
	}
	if revoked.Status != DocStatusRevoked {
		t.Errorf("status = %s", revoked.Status)
	}
	// Still findable, still carrying its original anchor height.
	res := dr.VerifyCID(doc.CID)
	if !res.Anchored {
		t.Fatal("a revoked document disappeared from the register")
	}
	if res.BlockHeight != doc.BlockHeight {
		t.Error("the original anchoring height was rewritten")
	}
	if !strings.Contains(res.Verdict, "REVOKED") {
		t.Errorf("verdict = %q", res.Verdict)
	}
	if !chain.Verify().Valid {
		t.Error("chain broken after revocation")
	}
	// And it cannot be revoked twice.
	if _, _, err := dr.Revoke(doc.CID, "again", "registrar1"); err == nil {
		t.Error("a revoked document was revoked a second time")
	}
}

// A rectification deed replaces the original in one operation, so the register
// is never ambiguous about which version is current.
func TestSupersedingInOneStep(t *testing.T) {
	dr, _ := newDocRegistry()
	v1 := anchorTestDoc(t, dr, "PROP-A", DocTypeTitleDeed, []byte("deed v1"))

	v2, _, err := dr.Anchor(AnchorRequest{
		AssetID: "PROP-A", DocType: DocTypeTitleDeed, SubmittedBy: "originator1",
		Visibility: DocPublic, Content: []byte("deed v2 rectified"),
		Supersedes: v1.CID,
	})
	if err != nil {
		t.Fatalf("anchor v2: %v", err)
	}
	old := dr.VerifyCID(v1.CID)
	if old.Status != DocStatusSuperseded {
		t.Errorf("v1 status = %s, want SUPERSEDED", old.Status)
	}
	if old.SupersededBy != v2.CID {
		t.Errorf("v1 does not point at its replacement: %q", old.SupersededBy)
	}
	if cur := dr.VerifyCID(v2.CID); cur.Status != DocStatusActive {
		t.Errorf("v2 status = %s", cur.Status)
	}
}

// Expiry is a fact about the calendar, distinct from revocation.
func TestExpiredDocumentIsFlaggedButNotRevoked(t *testing.T) {
	dr, _ := newDocRegistry()
	past := time.Now().UTC().AddDate(0, -2, 0)
	older := past.AddDate(0, -1, 0)
	doc, _, err := dr.Anchor(AnchorRequest{
		AssetID: "PROP-A", DocType: DocTypeEncumbrance, SubmittedBy: "originator1",
		Visibility: DocPublic, Content: []byte("EC valid to two months ago"),
		ValidFrom: &older, ValidTo: &past,
	})
	if err != nil {
		t.Fatalf("anchor: %v", err)
	}
	res := dr.VerifyCID(doc.CID)
	if !res.Expired {
		t.Error("an out-of-date certificate was not flagged as expired")
	}
	if res.Status != DocStatusActive {
		t.Errorf("expiry must not change status, got %s", res.Status)
	}
	if !strings.Contains(res.Verdict, "validity period") {
		t.Errorf("verdict = %q", res.Verdict)
	}
}

// --------------------------------------------------------------------------
// Privacy rules
// --------------------------------------------------------------------------

// KYC evidence must be provable and unretrievable. There must be no code path
// that returns the bytes, whoever is asking.
func TestKYCEvidenceIsNeverRetrievable(t *testing.T) {
	dr, _ := newDocRegistry()
	aadhaar := []byte("<AadhaarXML uid=\"9999-8888-7777\" name=\"Real Person\"/>")
	doc, block, err := dr.AnchorKYC("investor1", "AADHAAR", "DigiLocker", aadhaar)
	if err != nil {
		t.Fatalf("anchor kyc: %v", err)
	}
	if block == nil {
		t.Fatal("KYC evidence was not anchored to the chain")
	}
	if doc.Visibility != DocDigestOnly {
		t.Errorf("visibility = %s, want digestOnly", doc.Visibility)
	}
	if doc.Pinned {
		t.Error("KYC content was pinned — it must never be stored")
	}
	// Nobody can fetch it: not a stranger, not the subject, not a regulator.
	for _, who := range [][2]string{{"stranger", ""}, {"investor1", "Investor"}, {"regulator1", "Regulator"}} {
		if _, _, err := dr.Fetch(doc.CID, who[0], who[1]); err == nil {
			t.Errorf("%s was able to retrieve KYC content", who[0])
		}
	}
	// But the proof works: the subject can still demonstrate it was them.
	if res := dr.VerifyContent(aadhaar); !res.Anchored {
		t.Error("the holder of the original document cannot prove it was anchored")
	}
	// And no personal data leaked into the block.
	raw, _ := json.Marshal(block)
	for _, leak := range []string{"9999-8888-7777", "Real Person", "AadhaarXML"} {
		if bytes.Contains(raw, []byte(leak)) {
			t.Errorf("personal data %q leaked into the ledger block", leak)
		}
	}
}

// A document type that is obviously KYC cannot be made public by asking.
func TestKYCCannotBeMadePublicByRequest(t *testing.T) {
	dr, _ := newDocRegistry()
	doc, _, err := dr.Anchor(AnchorRequest{
		Subject: "investor1", DocType: DocTypeKYC, SubmittedBy: "investor1",
		Visibility: DocPublic, Content: []byte("PAN ABCDE1234F"),
	})
	if err != nil {
		t.Fatalf("anchor: %v", err)
	}
	if doc.Visibility != DocDigestOnly {
		t.Fatalf("a public KYC anchor was accepted: %s", doc.Visibility)
	}
}

// Restricted content is for the submitter, a registrar or a regulator.
func TestRestrictedContentRespectsRole(t *testing.T) {
	dr, _ := newDocRegistry()
	doc, _, err := dr.Anchor(AnchorRequest{
		AssetID: "PROP-A", DocType: DocTypeSaleAgmt, SubmittedBy: "originator1",
		Visibility: DocRestricted, Content: []byte("names, addresses, signatures"),
	})
	if err != nil {
		t.Fatalf("anchor: %v", err)
	}
	if _, _, err := dr.Fetch(doc.CID, "nosy1", "Investor"); err == nil {
		t.Error("a stranger read a restricted document")
	}
	for _, who := range [][2]string{{"originator1", "Originator"}, {"anyone", "Registrar"}, {"anyone", "Regulator"}} {
		if _, _, err := dr.Fetch(doc.CID, who[0], who[1]); err != nil {
			t.Errorf("%s/%s was denied a restricted document: %v", who[0], who[1], err)
		}
	}
	// Metadata stays public regardless.
	if res := dr.VerifyCID(doc.CID); !res.Anchored {
		t.Error("a restricted document is invisible even as metadata")
	}
}

// Visibility defaults to restricted: a document nobody classified should not
// be world-readable.
func TestVisibilityDefaultsToRestricted(t *testing.T) {
	dr, _ := newDocRegistry()
	doc, _, err := dr.Anchor(AnchorRequest{
		AssetID: "PROP-A", DocType: DocTypeValuation, SubmittedBy: "originator1",
		Content: []byte("valuation report"),
	})
	if err != nil {
		t.Fatalf("anchor: %v", err)
	}
	if doc.Visibility != DocRestricted {
		t.Errorf("default visibility = %s, want restricted", doc.Visibility)
	}
}

// Storage is not trusted. If the bytes coming back do not hash to the name
// they were stored under, serving them would hand out an unverifiable file.
func TestCorruptedStorageIsRefusedNotServed(t *testing.T) {
	chain := NewChain()
	pins := NewMemoryPinStore()
	dr := NewDocumentRegistry(chain, pins)
	doc := anchorTestDoc(t, dr, "PROP-A", DocTypeTitleDeed, []byte("genuine deed"))

	// Simulate a compromised or buggy storage layer.
	if err := pins.Pin(doc.CID, []byte("swapped deed")); err != nil {
		t.Fatalf("pin: %v", err)
	}
	if _, _, err := dr.Fetch(doc.CID, "originator1", "Registrar"); err == nil {
		t.Fatal("the registry served bytes that do not match their CID")
	}
}

// --------------------------------------------------------------------------
// HTTP surface
// --------------------------------------------------------------------------

func newDocServer(t *testing.T) *Server {
	t.Helper()
	s := newTestServerWithUMI(t)
	s.Docs = NewDocumentRegistry(s.Pipeline.CP.Ledger, NewMemoryPinStore())
	return s
}

func TestDocumentEndpointsRoundTrip(t *testing.T) {
	s := newDocServer(t)
	h := s.Router()

	body := `{"assetId":"PROP-A","docType":"TITLE_DEED","submittedBy":"originator1",
	          "visibility":"public","mediaType":"text/plain","content":"THE DEED"}`
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/umi/documents", strings.NewReader(body))
	// Anchoring is limited to holders, registrars and supervisors.
	req.Header.Set("X-Fabric-Identity", "registrar1")
	req.Header.Set("X-Identity-Role", "Registrar")
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("anchor returned %d: %s", rec.Code, rec.Body.String())
	}
	var created struct {
		Document Document `json:"document"`
		Block    struct {
			Height int64 `json:"height"`
		} `json:"block"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &created); err != nil {
		t.Fatalf("response is not JSON: %v", err)
	}
	cid := created.Document.CID
	if cid == "" || created.Block.Height == 0 {
		t.Fatalf("missing cid or block: %+v", created)
	}

	// Listing by asset.
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/umi/documents/PROP-A", nil))
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), cid) {
		t.Errorf("asset listing missing the document: %d %s", rec.Code, rec.Body.String())
	}

	// Metadata by CID.
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/umi/documents/cid/"+cid, nil))
	if rec.Code != http.StatusOK {
		t.Errorf("cid lookup returned %d", rec.Code)
	}

	// Fetch the bytes, and confirm the CID header lets the caller re-verify.
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/umi/documents/fetch/"+cid, nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("fetch returned %d: %s", rec.Code, rec.Body.String())
	}
	if rec.Body.String() != "THE DEED" {
		t.Errorf("fetched %q", rec.Body.String())
	}
	if !VerifyCID(rec.Header().Get("X-Document-CID"), rec.Body.Bytes()) {
		t.Error("the served bytes do not match the CID header")
	}

	// Verify by content through the API.
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/umi/documents/verify",
		strings.NewReader(`{"content":"THE DEED"}`)))
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "anchored and current") {
		t.Errorf("verify returned %d: %s", rec.Code, rec.Body.String())
	}

	// And a tampered copy must not verify.
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/umi/documents/verify",
		strings.NewReader(`{"content":"THE DEED (altered)"}`)))
	if strings.Contains(rec.Body.String(), `"anchored":true`) {
		t.Errorf("a tampered document verified: %s", rec.Body.String())
	}
}

func TestDocumentUploadAcceptsBase64AndDataURLs(t *testing.T) {
	s := newDocServer(t)
	h := s.Router()
	// "PDFBYTES" as a data URL, the shape a browser FileReader produces.
	body := `{"assetId":"PROP-B","docType":"APPROVED_PLAN","submittedBy":"originator1",
	          "visibility":"public","contentBase64":"data:application/pdf;base64,UERGQllURVM="}`
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, docAnchorReq(body))
	if rec.Code != http.StatusCreated {
		t.Fatalf("anchor returned %d: %s", rec.Code, rec.Body.String())
	}
	want, _ := CIDFor([]byte("PDFBYTES"))
	if !strings.Contains(rec.Body.String(), want) {
		t.Errorf("a data URL did not decode to the expected bytes: %s", rec.Body.String())
	}
}

func TestDuplicateAnchorIsA409(t *testing.T) {
	s := newDocServer(t)
	h := s.Router()
	body := `{"assetId":"PROP-A","docType":"TITLE_DEED","submittedBy":"o1","content":"same bytes"}`
	for i, wantCode := range []int{http.StatusCreated, http.StatusConflict} {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, docAnchorReq(body))
		if rec.Code != wantCode {
			t.Errorf("attempt %d returned %d, want %d: %s", i+1, rec.Code, wantCode, rec.Body.String())
		}
	}
}

func TestKYCFetchOverHTTPIsGone(t *testing.T) {
	s := newDocServer(t)
	doc, _, err := s.Docs.AnchorKYC("investor1", "AADHAAR", "DigiLocker", []byte("sensitive"))
	if err != nil {
		t.Fatalf("anchor: %v", err)
	}
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/umi/documents/fetch/"+doc.CID, nil)
	req.Header.Set("X-Identity-Id", "regulator1")
	req.Header.Set("X-Identity-Role", "Regulator")
	s.Router().ServeHTTP(rec, req)
	if rec.Code != http.StatusGone {
		t.Errorf("KYC fetch returned %d, want 410 Gone: %s", rec.Code, rec.Body.String())
	}
}

// No CID may become a metric label — a CID is derived from content and is
// therefore unbounded.
func TestDocumentPathsAreTemplatedForMetrics(t *testing.T) {
	cid, _ := CIDFor([]byte("anything"))
	cases := map[string]string{
		"/umi/documents":                    "/umi/documents",
		"/umi/documents/verify":             "/umi/documents/verify",
		"/umi/documents/fetch/" + cid:       "/umi/documents/fetch/{cid}",
		"/umi/documents/cid/" + cid:         "/umi/documents/cid/{cid}",
		"/umi/documents/" + cid + "/revoke": "/umi/documents/{cid}/revoke",
		"/umi/documents/subject/investor1":  "/umi/documents/subject/{id}",
		"/umi/documents/PROP-GREEN-VALLEY":  "/umi/documents/{id}",
	}
	for path, want := range cases {
		if got := routeFor(path); got != want {
			t.Errorf("routeFor(%s) = %s, want %s", path, got, want)
		}
	}
}

// A sanity check that the register's own summary adds up.
func TestRegisterStats(t *testing.T) {
	dr, _ := newDocRegistry()
	anchorTestDoc(t, dr, "PROP-A", DocTypeTitleDeed, []byte("one"))
	d2 := anchorTestDoc(t, dr, "PROP-A", DocTypeEncumbrance, []byte("two"))
	if _, _, err := dr.AnchorKYC("investor1", "PAN", "DigiLocker", []byte("three")); err != nil {
		t.Fatalf("kyc: %v", err)
	}
	if _, _, err := dr.Revoke(d2.CID, "stale", "registrar1"); err != nil {
		t.Fatalf("revoke: %v", err)
	}
	st := dr.Stats()
	if st.Total != 3 {
		t.Errorf("total = %d, want 3", st.Total)
	}
	if st.Revoked != 1 {
		t.Errorf("revoked = %d, want 1", st.Revoked)
	}
	if st.DigestOnly != 1 {
		t.Errorf("digestOnly = %d, want 1", st.DigestOnly)
	}
	if st.Pinned != 2 {
		t.Errorf("pinned = %d, want 2", st.Pinned)
	}
	if st.ByType[DocTypeTitleDeed] != 1 {
		t.Errorf("byType = %v", st.ByType)
	}
}

// The register must not be able to wedge the rail: anchoring takes its own
// lock and never the rail's.
func TestConcurrentAnchoringIsSafe(t *testing.T) {
	dr, _ := newDocRegistry()
	const n = 50
	done := make(chan error, n)
	for i := 0; i < n; i++ {
		go func(i int) {
			_, _, err := dr.Anchor(AnchorRequest{
				AssetID: "PROP-A", DocType: DocTypeTaxReceipt, SubmittedBy: "o1",
				Visibility: DocPublic, Content: []byte(fmt.Sprintf("receipt %d", i)),
			})
			done <- err
		}(i)
	}
	for i := 0; i < n; i++ {
		if err := <-done; err != nil {
			t.Fatalf("concurrent anchor failed: %v", err)
		}
	}
	if st := dr.Stats(); st.Total != n {
		t.Errorf("anchored %d of %d", st.Total, n)
	}
}

// --------------------------------------------------------------------------
// Anchoring without the file: legacy deeds and KYC
// --------------------------------------------------------------------------

// The claim that a CID can be derived from a SHA-256 alone has to be exactly
// true, or every legacy deed upgraded this way would be unverifiable. The CID
// derived from the digest must equal the CID computed from the bytes.
func TestCIDDerivedFromDigestMatchesCIDFromBytes(t *testing.T) {
	content := []byte("a genuine deed file")
	fromBytes, shaHex := CIDFor(content)
	fromDigest, err := CIDFromSHA256(shaHex)
	if err != nil {
		t.Fatalf("derive: %v", err)
	}
	if fromDigest != fromBytes {
		t.Errorf("derived %s, bytes give %s", fromDigest, fromBytes)
	}
	// Uppercase and surrounding whitespace are normal in copied hashes.
	if spaced, err := CIDFromSHA256("  " + strings.ToUpper(shaHex) + "\n"); err != nil || spaced != fromBytes {
		t.Errorf("a padded uppercase digest did not normalise: %q %v", spaced, err)
	}
	for _, bad := range []string{"", "abc", strings.Repeat("z", 64)} {
		if _, err := CIDFromSHA256(bad); err == nil {
			t.Errorf("accepted a bad digest: %q", bad)
		}
	}
}

// A deed registered before the register existed can be anchored from its
// stored hash, and then verified by someone who has the actual file.
func TestLegacyDeedHashCanBeUpgradedAndThenVerifiedWithTheFile(t *testing.T) {
	dr, chain := newDocRegistry()
	theFile := []byte("TITLE DEED, Survey 112/4, registered 2019")
	_, legacyHash := CIDFor(theFile) // what the Fabric chain already stores

	doc, block, err := dr.AnchorDigest(AnchorRequest{
		AssetID: "PROP-LEGACY", DocType: DocTypeTitleDeed, SubmittedBy: "originator1",
	}, legacyHash)
	if err != nil {
		t.Fatalf("anchor by digest: %v", err)
	}
	if block == nil {
		t.Fatal("no block committed for a digest anchor")
	}
	if doc.Visibility != DocDigestOnly || doc.Pinned {
		t.Errorf("a digest anchor must not claim to hold content: %+v", doc)
	}
	// The holder of the original file can now prove it is the registered one,
	// even though the rail has never seen it.
	if res := dr.VerifyContent(theFile); !res.Anchored || res.CID != doc.CID {
		t.Errorf("the real file did not verify against the upgraded anchor: %+v", res)
	}
	// And a doctored copy still fails.
	if res := dr.VerifyContent([]byte("TITLE DEED, Survey 999/9, registered 2019")); res.Anchored {
		t.Error("a different deed verified against the upgraded anchor")
	}
	if !chain.Verify().Valid {
		t.Error("chain broken")
	}
}

// Anchoring the same deed twice — once from the hash, once from the file —
// must not create two records.
func TestDigestAnchorAndContentAnchorCollide(t *testing.T) {
	dr, _ := newDocRegistry()
	content := []byte("one deed, two routes")
	_, shaHex := CIDFor(content)

	if _, _, err := dr.AnchorDigest(AnchorRequest{
		AssetID: "PROP-A", DocType: DocTypeTitleDeed, SubmittedBy: "o1",
	}, shaHex); err != nil {
		t.Fatalf("digest anchor: %v", err)
	}
	_, _, err := dr.Anchor(AnchorRequest{
		AssetID: "PROP-A", DocType: DocTypeTitleDeed, SubmittedBy: "o1",
		Visibility: DocPublic, Content: content,
	})
	if err == nil {
		t.Fatal("the same document was anchored twice through two different routes")
	}
	if st := dr.Stats(); st.Total != 1 {
		t.Errorf("register holds %d records for one document", st.Total)
	}
}

// docAnchorReq builds an anchor request from someone allowed to anchor.
func docAnchorReq(body string) *http.Request {
	req := httptest.NewRequest(http.MethodPost, "/umi/documents", strings.NewReader(body))
	req.Header.Set("X-Fabric-Identity", "registrar1")
	req.Header.Set("X-Identity-Role", "Registrar")
	return req
}
