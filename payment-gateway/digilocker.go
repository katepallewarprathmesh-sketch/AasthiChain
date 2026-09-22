package paymentgateway

import (
	"errors"
	"fmt"
	"sync"
	"time"
)

// DigiLocker KYC — Government ID verification via digilocker.gov.in
// Real flow: OAuth 2.0 -> DigiLocker login -> user consent -> callback with code -> exchange for access_token -> pull document
// Mock for hackathon, real toggle via DIGILOCKER_CLIENT_ID

type DigiLockerMode string

const (
	DigiLockerMock DigiLockerMode = "mock"
	DigiLockerReal DigiLockerMode = "real"
)

type DigiLockerDocument struct {
	DocType    string    `json:"docType"` // AADHAAR, PAN, VOTERID, etc
	Status     string    `json:"status"`  // VERIFIED, NOT_FOUND
	Name       string    `json:"name,omitempty"`
	DOB        string    `json:"dob,omitempty"`
	IDNumber   string    `json:"idNumber,omitempty"`
	Address    string    `json:"address,omitempty"`
	IssuedBy   string    `json:"issuedBy,omitempty"`
	PulledAt   time.Time `json:"pulledAt"`
	VerifiedAt time.Time `json:"verifiedAt"`
}

type DigiLockerSession struct {
	IdentityID  string    `json:"identityId"`
	State       string    `json:"state"`
	AuthURL     string    `json:"authUrl"`
	AccessToken string    `json:"accessToken,omitempty"`
	Documents   []DigiLockerDocument `json:"documents"`
	CreatedAt   time.Time `json:"createdAt"`
	VerifiedAt  *time.Time `json:"verifiedAt,omitempty"`
	Mode        DigiLockerMode `json:"mode"`
}

type DigiLockerProvider struct {
	mu       sync.RWMutex
	sessions map[string]*DigiLockerSession // state -> session
	kyc      map[string]KYCStatus          // identityId -> KYC status (for integration with existing MockKYCProvider)
	records  map[string]*DigiLockerSession // identityId -> session
	mode     DigiLockerMode
	clientID string
	redirectURI string
}

func NewDigiLockerProvider(mode DigiLockerMode, clientID, redirectURI string) *DigiLockerProvider {
	if mode == "" {
		mode = DigiLockerMock
	}
	return &DigiLockerProvider{
		sessions:    make(map[string]*DigiLockerSession),
		kyc:         make(map[string]KYCStatus),
		records:     make(map[string]*DigiLockerSession),
		mode:        mode,
		clientID:    clientID,
		redirectURI: redirectURI,
	}
}

// Init — starts DigiLocker OAuth flow
// Real: https://api.digitallocker.gov.in/public/oauth2/1/authorize?response_type=code&client_id=...&redirect_uri=...&state=...
func (d *DigiLockerProvider) Init(identityID string) (*DigiLockerSession, error) {
	if identityID == "" {
		return nil, errors.New("identityId required")
	}

	d.mu.Lock()
	defer d.mu.Unlock()

	state := "digi-" + GenerateRandomString(8)
	var authURL string

	if d.mode == DigiLockerReal {
		// Real DigiLocker OAuth
		redirect := d.redirectURI
		if redirect == "" {
			redirect = "https://aasthi-chain.vercel.app/api/kyc/digilocker/callback"
		}
		authURL = fmt.Sprintf("https://api.digitallocker.gov.in/public/oauth2/1/authorize?response_type=code&client_id=%s&redirect_uri=%s&state=%s",
			d.clientID, redirect, state)
	} else {
		// Mock for hackathon
		authURL = fmt.Sprintf("https://mock-digilocker.aasthichain.demo/oauth?client_id=%s&state=%s&identityId=%s",
			d.clientID, state, identityID)
	}

	session := &DigiLockerSession{
		IdentityID: identityID,
		State:      state,
		AuthURL:    authURL,
		CreatedAt:  time.Now(),
		Mode:       d.mode,
		Documents:  []DigiLockerDocument{},
	}

	d.sessions[state] = session
	return session, nil
}

// Callback — exchange code for access_token, verify
// Real: POST https://api.digitallocker.gov.in/public/oauth2/1/token { code, client_id, client_secret, redirect_uri, grant_type=authorization_code }
func (d *DigiLockerProvider) Callback(identityID, code, state string) (*DigiLockerSession, error) {
	if identityID == "" || code == "" {
		return nil, errors.New("identityId and code required")
	}

	d.mu.Lock()
	defer d.mu.Unlock()

	// Verify state if present
	if state != "" {
		if sess, ok := d.sessions[state]; ok {
			if sess.IdentityID != identityID {
				return nil, errors.New("state mismatch")
			}
		}
	}

	// Mock token exchange — in real, call DigiLocker token endpoint
	accessToken := "mock-access-token-" + GenerateRandomString(12)

	// Mock documents — Aadhaar, PAN
	now := time.Now()
	docs := []DigiLockerDocument{
		{
			DocType:    "AADHAAR",
			Status:     "VERIFIED",
			Name:       fmt.Sprintf("%s Kumar", identityID),
			DOB:        "1990-01-15",
			IDNumber:   "XXXX-XXXX-1234",
			Address:    "Pune, Maharashtra",
			IssuedBy:   "UIDAI",
			PulledAt:   now,
			VerifiedAt: now,
		},
		{
			DocType:  "PAN",
			Status:   "VERIFIED",
			Name:     fmt.Sprintf("%s Kumar", identityID),
			IDNumber: "ABCDE1234F",
			DOB:      "1990-01-15",
			IssuedBy: "Income Tax Dept",
			PulledAt:   now,
			VerifiedAt: now,
		},
	}

	session := &DigiLockerSession{
		IdentityID:  identityID,
		State:       state,
		AccessToken: accessToken,
		Documents:   docs,
		CreatedAt:   time.Now(),
		VerifiedAt:  &now,
		Mode:        d.mode,
	}

	d.records[identityID] = session
	d.kyc[identityID] = KYCVerified

	return session, nil
}

// PullDocument — pull specific document from DigiLocker
// Real: GET https://api.digitallocker.gov.in/public/oauth2/2/files/{uri} with access_token
func (d *DigiLockerProvider) PullDocument(identityID, docType string) (*DigiLockerDocument, error) {
	if identityID == "" || docType == "" {
		return nil, errors.New("identityId and docType required")
	}

	d.mu.RLock()
	session, ok := d.records[identityID]
	d.mu.RUnlock()

	if !ok {
		return nil, errors.New("KYC not verified yet — call /init and /callback first")
	}

	// Find document
	for _, doc := range session.Documents {
		if doc.DocType == docType {
			cp := doc
			return &cp, nil
		}
	}

	// Mock additional docs
	now := time.Now()
	docMap := map[string]DigiLockerDocument{
		"AADHAAR": {
			DocType:    "AADHAAR",
			Status:     "VERIFIED",
			Name:       fmt.Sprintf("%s Kumar", identityID),
			DOB:        "1990-01-15",
			IDNumber:   "XXXX-XXXX-1234",
			Address:    "Pune, Maharashtra",
			IssuedBy:   "UIDAI",
			PulledAt:   now,
			VerifiedAt: now,
		},
		"PAN": {
			DocType:    "PAN",
			Status:     "VERIFIED",
			Name:       fmt.Sprintf("%s Kumar", identityID),
			IDNumber:   "ABCDE1234F",
			DOB:        "1990-01-15",
			IssuedBy:   "Income Tax Dept",
			PulledAt:   now,
			VerifiedAt: now,
		},
		"VOTERID": {
			DocType:  "VOTERID",
			Status:   "VERIFIED",
			Name:     fmt.Sprintf("%s Kumar", identityID),
			IDNumber: "ABC1234567",
			PulledAt: now,
		},
	}

	if doc, ok := docMap[docType]; ok {
		return &doc, nil
	}

	return &DigiLockerDocument{
		DocType: docType,
		Status:  "NOT_FOUND",
	}, nil
}

// GetKYCStatus — implements KYCProvider interface for integration with Gateway
func (d *DigiLockerProvider) GetKYCStatus(identityID string) (KYCStatus, error) {
	d.mu.RLock()
	defer d.mu.RUnlock()

	if status, ok := d.kyc[identityID]; ok {
		return status, nil
	}
	// Fallback to mock verified for demo identities
	if identityID == "originator1" || identityID == "investor1" || identityID == "investor2" || identityID == "registrar1" || identityID == "regulator1" {
		return KYCVerified, nil
	}
	return KYCUnverified, nil
}

func (d *DigiLockerProvider) GetSession(identityID string) (*DigiLockerSession, bool) {
	d.mu.RLock()
	defer d.mu.RUnlock()
	s, ok := d.records[identityID]
	return s, ok
}

func (d *DigiLockerProvider) ListSessions() []*DigiLockerSession {
	d.mu.RLock()
	defer d.mu.RUnlock()
	list := make([]*DigiLockerSession, 0, len(d.records))
	for _, s := range d.records {
		list = append(list, s)
	}
	return list
}

// Helper
func GenerateRandomString(n int) string {
	return generateRandomString(n, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789")
}
