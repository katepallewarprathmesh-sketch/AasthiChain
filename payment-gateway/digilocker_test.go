package paymentgateway

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestDigiLocker_Init(t *testing.T) {
	provider := NewDigiLockerProvider(DigiLockerMock, "mock-client", "https://example.com/callback")

	session, err := provider.Init("investor1")
	assert.NoError(t, err)
	assert.NotNil(t, session)
	assert.Equal(t, "investor1", session.IdentityID)
	assert.NotEmpty(t, session.State)
	assert.NotEmpty(t, session.AuthURL)
	assert.Contains(t, session.AuthURL, "mock-digilocker")
}

func TestDigiLocker_Callback(t *testing.T) {
	provider := NewDigiLockerProvider(DigiLockerMock, "mock-client", "https://example.com/callback")

	initSession, _ := provider.Init("investor1")

	session, err := provider.Callback("investor1", "mock-code-123", initSession.State)
	assert.NoError(t, err)
	assert.NotNil(t, session)
	assert.Equal(t, "investor1", session.IdentityID)
	assert.Len(t, session.Documents, 2)
	assert.Equal(t, "AADHAAR", session.Documents[0].DocType)
	assert.Equal(t, "PAN", session.Documents[1].DocType)

	// Check KYC status
	status, _ := provider.GetKYCStatus("investor1")
	assert.Equal(t, KYCVerified, status)
}

func TestDigiLocker_PullDocument(t *testing.T) {
	provider := NewDigiLockerProvider(DigiLockerMock, "mock-client", "https://example.com/callback")

	_, _ = provider.Init("investor1")
	_, _ = provider.Callback("investor1", "mock-code", "")

	doc, err := provider.PullDocument("investor1", "AADHAAR")
	assert.NoError(t, err)
	assert.NotNil(t, doc)
	assert.Equal(t, "AADHAAR", doc.DocType)
	assert.Equal(t, "VERIFIED", doc.Status)

	doc2, err := provider.PullDocument("investor1", "PAN")
	assert.NoError(t, err)
	assert.Equal(t, "PAN", doc2.DocType)

	// Not found case
	doc3, err := provider.PullDocument("investor1", "UNKNOWN_DOC")
	assert.NoError(t, err)
	assert.Equal(t, "NOT_FOUND", doc3.Status)
}

func TestDigiLocker_KYCProviderInterface(t *testing.T) {
	provider := NewDigiLockerProvider(DigiLockerMock, "mock-client", "")

	// Unverified initially
	status, _ := provider.GetKYCStatus("unverified_user")
	assert.Equal(t, KYCUnverified, status)

	// Mock verified identities
	status, _ = provider.GetKYCStatus("originator1")
	assert.Equal(t, KYCVerified, status)

	// After callback, should be verified
	provider.Init("newuser")
	provider.Callback("newuser", "code", "")
	status, _ = provider.GetKYCStatus("newuser")
	assert.Equal(t, KYCVerified, status)
}

func TestDigiLocker_RealMode(t *testing.T) {
	provider := NewDigiLockerProvider(DigiLockerReal, "real-client-id", "https://aasthi-chain.vercel.app/api/kyc/digilocker/callback")

	session, err := provider.Init("investor1")
	assert.NoError(t, err)
	assert.Contains(t, session.AuthURL, "api.digitallocker.gov.in")
	assert.Equal(t, DigiLockerReal, session.Mode)
}
