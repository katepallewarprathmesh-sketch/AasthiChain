package drunix

// HTTP surface for the document register (documents.go).
//
// Anchoring accepts base64 in a JSON body rather than multipart. The rail
// speaks JSON everywhere else, the Node layer in front of it is a JSON proxy
// that would have to be special-cased for multipart, and a browser's
// FileReader produces a data URL anyway. The 25 MB cap keeps a base64 body
// (which inflates by a third) well inside what the proxy will carry.

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"
)

// registerDocumentRoutes mounts /umi/documents*.
func (s *Server) registerDocumentRoutes(mux *http.ServeMux) {
	if s.Docs == nil {
		return
	}
	mux.HandleFunc("/umi/documents", s.handleDocuments)
	mux.HandleFunc("/umi/documents/", s.handleDocumentPath)
}

// docStatusFor maps a registry error onto an HTTP status. Kept in one place so
// the same failure never gets two different codes.
func docStatusFor(err error) (int, string) {
	switch {
	case errors.Is(err, ErrDocNotFound):
		return http.StatusNotFound, "ERR_UMI_DOC_NOT_FOUND"
	case errors.Is(err, ErrDocDuplicate):
		return http.StatusConflict, "ERR_UMI_DOC_DUPLICATE"
	case errors.Is(err, ErrDocEmpty):
		return http.StatusBadRequest, "ERR_UMI_DOC_EMPTY"
	case errors.Is(err, ErrDocTooLarge):
		return http.StatusRequestEntityTooLarge, "ERR_UMI_DOC_TOO_LARGE"
	case errors.Is(err, ErrDocFields):
		return http.StatusBadRequest, "ERR_UMI_DOC_FIELDS"
	case errors.Is(err, ErrDocNotRetrievable):
		return http.StatusGone, "ERR_UMI_DOC_NOT_RETRIEVABLE"
	case errors.Is(err, ErrDocForbidden):
		return http.StatusForbidden, "ERR_UMI_DOC_FORBIDDEN"
	case errors.Is(err, ErrDocAlreadyClosed):
		return http.StatusConflict, "ERR_UMI_DOC_ALREADY_CLOSED"
	case errors.Is(err, ErrBadCID):
		return http.StatusBadRequest, "ERR_BAD_CID"
	default:
		return http.StatusBadRequest, "ERR_UMI_DOC_REJECTED"
	}
}

func writeDocErr(w http.ResponseWriter, err error) {
	code, sentinel := docStatusFor(err)
	writeJSON(w, code, map[string]interface{}{
		"error":   sentinel,
		"message": err.Error(),
	})
}

type anchorBody struct {
	AssetID       string `json:"assetId"`
	Subject       string `json:"subject"`
	DocType       string `json:"docType"`
	Title         string `json:"title"`
	Issuer        string `json:"issuer"`
	SubmittedBy   string `json:"submittedBy"`
	MediaType     string `json:"mediaType"`
	Visibility    string `json:"visibility"`
	Content       string `json:"content"`       // plain text, for a demo or a short certificate
	ContentBase64 string `json:"contentBase64"` // a real file, or a data: URL
	ValidFrom     string `json:"validFrom"`
	ValidTo       string `json:"validTo"`
	Supersedes    string `json:"supersedes"`
}

func parseDay(s string) *time.Time {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil
	}
	for _, layout := range []string{time.RFC3339, "2006-01-02"} {
		if t, err := time.Parse(layout, s); err == nil {
			u := t.UTC()
			return &u
		}
	}
	return nil
}

// handleDocuments: GET the register summary, POST to anchor.
func (s *Server) handleDocuments(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"stats": s.Docs.Stats(),
			"note":  "Documents are identified by their IPFS CID. Verify any of them yourself: POST /umi/documents/verify with the file, or fetch the CID from any IPFS gateway and hash it.",
		})
	case http.MethodPost:
		var body anchorBody
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxDocBytes*2)).Decode(&body); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{
				"error": "ERR_UMI_DOC_FIELDS", "message": "body must be JSON: " + err.Error()})
			return
		}
		content := []byte(body.Content)
		if body.ContentBase64 != "" {
			decoded, err := DecodeBase64Content(body.ContentBase64)
			if err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]string{
					"error": "ERR_UMI_DOC_FIELDS", "message": "contentBase64 is not valid base64"})
				return
			}
			content = decoded
		}
		doc, block, err := s.Docs.Anchor(AnchorRequest{
			AssetID: body.AssetID, Subject: body.Subject, DocType: body.DocType,
			Title: body.Title, Issuer: body.Issuer, SubmittedBy: body.SubmittedBy,
			MediaType: body.MediaType, Visibility: body.Visibility,
			Content:   content,
			ValidFrom: parseDay(body.ValidFrom), ValidTo: parseDay(body.ValidTo),
			Supersedes: body.Supersedes,
		})
		if err != nil {
			writeDocErr(w, err)
			return
		}
		resp := map[string]interface{}{
			"document": doc,
			"note":     "Anchored. The CID is derived from the bytes, so any later change to this document produces a different CID and fails verification.",
		}
		if block != nil {
			resp["block"] = map[string]interface{}{"height": block.Height, "hash": block.Hash, "type": block.Type}
		}
		writeJSON(w, http.StatusCreated, resp)
	default:
		umiErr(w, http.StatusMethodNotAllowed, "ERR_METHOD", "GET or POST")
	}
}

// handleDocumentPath routes everything under /umi/documents/.
//
//	/umi/documents/verify                POST
//	/umi/documents/cid/{cid}             GET   metadata
//	/umi/documents/fetch/{cid}           GET   bytes, subject to visibility
//	/umi/documents/subject/{participant} GET   KYC evidence digests
//	/umi/documents/{cid}/revoke          POST
//	/umi/documents/{cid}/supersede       POST
//	/umi/documents/{assetId}             GET   every document for an asset
func (s *Server) handleDocumentPath(w http.ResponseWriter, r *http.Request) {
	rest := strings.Trim(strings.TrimPrefix(r.URL.Path, "/umi/documents/"), "/")
	if rest == "" {
		s.handleDocuments(w, r)
		return
	}
	parts := strings.Split(rest, "/")

	switch {
	case parts[0] == "verify":
		s.handleDocVerify(w, r)
		return
	case parts[0] == "cid" && len(parts) == 2:
		doc, ok := s.Docs.Get(parts[1])
		if !ok {
			writeJSON(w, http.StatusNotFound, map[string]string{
				"error": "ERR_UMI_DOC_NOT_FOUND", "message": "no document anchored under " + parts[1]})
			return
		}
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"document": doc, "verification": describePtr(doc)})
		return
	case parts[0] == "fetch" && len(parts) == 2:
		s.handleDocFetch(w, r, parts[1])
		return
	case parts[0] == "subject" && len(parts) == 2:
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"subject":   parts[1],
			"documents": s.Docs.ForSubject(parts[1]),
			"note":      "KYC evidence is anchored by digest only. There are no contents to retrieve, by design.",
		})
		return
	case len(parts) == 2 && (parts[1] == "revoke" || parts[1] == "supersede"):
		s.handleDocStatusChange(w, r, parts[0], parts[1])
		return
	}

	// Anything else is an asset id.
	docs := s.Docs.ForAsset(parts[0])
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"assetId":   parts[0],
		"documents": docs,
		"count":     len(docs),
	})
}

func describePtr(d *Document) VerifyResult { return describe(d) }

func (s *Server) handleDocVerify(w http.ResponseWriter, r *http.Request) {
	if !requirePost(w, r) {
		return
	}
	var body struct {
		CID           string `json:"cid"`
		SHA256        string `json:"sha256"`
		Content       string `json:"content"`
		ContentBase64 string `json:"contentBase64"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxDocBytes*2)).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"error": "ERR_UMI_DOC_FIELDS", "message": "body must be JSON"})
		return
	}
	var res VerifyResult
	switch {
	case body.ContentBase64 != "":
		content, err := DecodeBase64Content(body.ContentBase64)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{
				"error": "ERR_UMI_DOC_FIELDS", "message": "contentBase64 is not valid base64"})
			return
		}
		res = s.Docs.VerifyContent(content)
	case body.Content != "":
		res = s.Docs.VerifyContent([]byte(body.Content))
	case body.CID != "":
		res = s.Docs.VerifyCID(body.CID)
	case body.SHA256 != "":
		res = s.Docs.VerifySHA256(body.SHA256)
	default:
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"error":   "ERR_UMI_DOC_FIELDS",
			"message": "send one of: contentBase64 (strongest — proves the bytes), content, cid, sha256",
		})
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"verification": res,
		"note":         "Verification by content re-derives the CID from the bytes supplied, so a tampered copy fails even when its metadata looks correct.",
	})
}

func (s *Server) handleDocFetch(w http.ResponseWriter, r *http.Request, cid string) {
	if !requireGet(w, r) {
		return
	}
	// The rail has no session of its own; the proxy in front of it passes the
	// caller's identity and role through these headers.
	requester := r.Header.Get("X-Identity-Id")
	role := r.Header.Get("X-Identity-Role")
	content, doc, err := s.Docs.Fetch(cid, requester, role)
	if err != nil {
		writeDocErr(w, err)
		return
	}
	mediaType := doc.MediaType
	if mediaType == "" {
		mediaType = "application/octet-stream"
	}
	w.Header().Set("Content-Type", mediaType)
	w.Header().Set("X-Document-CID", doc.CID)
	w.Header().Set("X-Document-SHA256", doc.SHA256)
	w.Header().Set("X-Document-Status", doc.Status)
	// Content addressing makes this safe to cache hard: the URL cannot ever
	// point at different bytes.
	w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(content)
}

func (s *Server) handleDocStatusChange(w http.ResponseWriter, r *http.Request, cid, action string) {
	if !requirePost(w, r) {
		return
	}
	var body struct {
		Reason         string `json:"reason"`
		By             string `json:"by"`
		ReplacementCID string `json:"replacementCid"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)

	var (
		doc   *Document
		block *DrunixBlock
		err   error
	)
	if action == "revoke" {
		doc, block, err = s.Docs.Revoke(cid, body.Reason, body.By)
	} else {
		doc, block, err = s.Docs.Supersede(cid, body.ReplacementCID, body.Reason, body.By)
	}
	if err != nil {
		writeDocErr(w, err)
		return
	}
	resp := map[string]interface{}{
		"document": doc,
		"note":     "The original anchor is still on the chain. This records the withdrawal on top of it.",
	}
	if block != nil {
		resp["block"] = map[string]interface{}{"height": block.Height, "hash": block.Hash, "type": block.Type}
	}
	writeJSON(w, http.StatusOK, resp)
}
