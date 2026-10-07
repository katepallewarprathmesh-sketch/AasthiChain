package paymentgateway

// Anchoring KYC evidence from the payment gateway.
//
// This service runs its own DigiLocker provider, separate from the Node layer,
// and a successful government ID check here left nothing behind either: the
// result lived in a map until the process exited. That is the weakest link in
// an otherwise auditable chain — the strongest evidence in the system was the
// only evidence with no record.
//
// What is sent is a DIGEST of the verification result, never the document and
// never the ID number in the clear. The reasoning is in
// docs/DOCUMENT-INTEGRITY.md: an IPFS CID is computable by anyone holding the
// source bytes, so anchoring a real Aadhaar would turn the ledger into an
// oracle for confirming somebody's Aadhaar number. A digest of a canonical
// summary proves the check happened and proves nothing else.
//
// Entirely optional and non-blocking. With UMI_GATEWAY_URL unset this is a
// no-op, and a failure never fails a KYC verification that has already
// succeeded — losing the user's verification because an anchor timed out
// would be a much worse outcome than a missing audit record.

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"strings"
	"time"
)

// kycEvidence is the canonical, deterministic summary that gets hashed.
// Field order is fixed, and nothing varies between renderings of the same
// verification, so the same check always produces the same digest.
type kycEvidence struct {
	Subject    string `json:"subject"`
	DocType    string `json:"docType"`
	Issuer     string `json:"issuer"`
	Status     string `json:"status"`
	MaskedID   string `json:"maskedId"`
	VerifiedAt string `json:"verifiedAt"`
}

// KYCEvidenceDigest renders the canonical summary and returns its SHA-256.
// Exported so the same digest can be recomputed later and checked against
// what was anchored.
func KYCEvidenceDigest(subject, docType, issuer, status, maskedID string, verifiedAt time.Time) (string, error) {
	body, err := json.Marshal(kycEvidence{
		Subject:    subject,
		DocType:    docType,
		Issuer:     issuer,
		Status:     status,
		MaskedID:   maskedID,
		VerifiedAt: verifiedAt.UTC().Format(time.RFC3339),
	})
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(body)
	return fmt.Sprintf("%x", sum), nil
}

// railURL reads the settlement rail address, trimmed.
func railURL() string {
	return strings.TrimSuffix(strings.TrimSpace(os.Getenv("UMI_GATEWAY_URL")), "/")
}

// AnchorKYCEvidence files the digest of a completed check with the document
// register. Returns the CID on success; errors are returned for logging but
// callers are expected to ignore them.
func AnchorKYCEvidence(subject, docType, issuer, status, maskedID string, verifiedAt time.Time) (string, error) {
	base := railURL()
	if base == "" {
		return "", nil // not configured: silently do nothing
	}
	digest, err := KYCEvidenceDigest(subject, docType, issuer, status, maskedID, verifiedAt)
	if err != nil {
		return "", err
	}
	payload, _ := json.Marshal(map[string]string{
		"subject":     subject,
		"docType":     "KYC_EVIDENCE",
		"title":       docType + " verified via " + issuer,
		"issuer":      issuer,
		"submittedBy": subject,
		"sha256":      digest,
	})

	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		base+"/umi/documents/digest", bytes.NewReader(payload))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := (&http.Client{Timeout: 5 * time.Second}).Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	var out struct {
		Document struct {
			CID string `json:"cid"`
		} `json:"document"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&out)
	// 409 means this exact check is already anchored, which is success.
	if resp.StatusCode != http.StatusCreated && resp.StatusCode != http.StatusConflict {
		return "", fmt.Errorf("document register returned %d", resp.StatusCode)
	}
	return out.Document.CID, nil
}

// anchorSessionEvidence files one anchor per verified document in a session.
// Called after the provider's lock is released.
func anchorSessionEvidence(session *DigiLockerSession) {
	if session == nil || railURL() == "" {
		return
	}
	for _, doc := range session.Documents {
		if doc.Status != "VERIFIED" {
			continue
		}
		at := doc.VerifiedAt
		if at.IsZero() {
			at = time.Now().UTC()
		}
		if _, err := AnchorKYCEvidence(session.IdentityID, doc.DocType, "DigiLocker",
			doc.Status, doc.IDNumber, at); err != nil {
			log.Printf("KYC evidence anchor failed for %s/%s: %v (verification itself is unaffected)",
				session.IdentityID, doc.DocType, err)
		}
	}
}
