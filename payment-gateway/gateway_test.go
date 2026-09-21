package paymentgateway

import (
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func newTestGateway() *Gateway {
	kyc := &MockKYCProvider{Records: map[string]KYCStatus{
		"originator1": KYCVerified,
		"investor1":   KYCVerified,
		"investor2":   KYCVerified,
		"registrar1":  KYCVerified,
		"regulator1":  KYCVerified,
	}}
	bal := &MockBalanceProvider{Balances: map[string]int64{
		"investor1@aasthichain":  100000000, // ₹10,00,000 (10L)
		"investor2@aasthichain":  50000000,  // ₹5,00,000
		"investor@aasthichain":   100000000, // ₹10L
		"poor@aasthichain":       100,       // ₹1
		"originator@aasthichain": 100000000, // high
		"80105301033@axl":        100000000, // testing VPA per user request
		"80105301033@okaxis":     100000000,
		"80105301033@okhdfcbank": 100000000,
	}}
	return NewGateway(kyc, bal)
}

// 1. successful payment→transfer
func TestSuccessfulPaymentToTransfer(t *testing.T) {
	gw := newTestGateway()
	req := CollectRequest{
		AssetID:        "PROP-123",
		TokenAmount:    500,
		AmountINR:      250000, // ₹2.5L
		PayerVPA:       "investor1@aasthichain",
		PayeeVPA:       "originator@aasthichain",
		Note:           "Green Valley Villas 500 tokens",
		IdempotencyKey: "idem-success-1",
		PayerID:        "investor1",
		PayeeID:        "originator1",
	}
	p, err := gw.InitiateCollect(req)
	require.NoError(t, err)
	assert.Equal(t, StatusPending, p.Status)
	assert.NotEmpty(t, p.PaymentID)
	assert.True(t, len(p.PaymentID) > 5)
	assert.Contains(t, p.PaymentID, "NPCI-")
	assert.NotEmpty(t, p.UpiTxnID)
	assert.Contains(t, p.UpiTxnID, "AAST")
	assert.NotEmpty(t, p.RRN)
	assert.Equal(t, 12, len(p.RRN))
	assert.NotEmpty(t, p.UTR)
	assert.Contains(t, p.UTR, "IMPS")
	assert.Equal(t, true, p.IsSimulation)
	assert.Equal(t, int64(250000*100), p.AmountINRPaise)

	// Approve (payer approves in UPI app)
	confirmed, err := gw.ApprovePayment(p.PaymentID, "investor1")
	require.NoError(t, err)
	assert.Equal(t, StatusConfirmed, confirmed.Status)
	assert.NotNil(t, confirmed.ConfirmedAt)

	// Release after Drunix TransferTokens succeeds — atomic DvP
	released, err := gw.ReleasePayment(p.PaymentID, "TXN-abc123")
	require.NoError(t, err)
	assert.Equal(t, StatusReleased, released.Status)
	assert.Equal(t, "TXN-abc123", released.DrunixTransferID)
	assert.NotNil(t, released.ReleasedAt)
}

// 2. payment timeout→refund
func TestPaymentTimeoutToRefund(t *testing.T) {
	gw := newTestGateway()
	req := CollectRequest{
		AssetID:     "PROP-123",
		TokenAmount: 100,
		AmountINR:   50000,
		PayerVPA:    "investor1@aasthichain",
		PayeeVPA:    "originator@aasthichain",
		Note:        "timeout test",
		PayerID:     "investor1",
		PayeeID:     "originator1",
	}
	p, err := gw.InitiateCollect(req)
	require.NoError(t, err)

	// Simulate expiry by setting expiresAt in past
	gw.mu.Lock()
	p.ExpiresAt = time.Now().Add(-1 * time.Minute)
	gw.mu.Unlock()

	_, err = gw.ApprovePayment(p.PaymentID, "investor1")
	assert.Error(t, err)
	assert.Contains(t, err.Error(), string(StatusExpired))

	// Should be refundable after timeout
	refunded, err := gw.RefundPayment(p.PaymentID, "collect expired")
	require.NoError(t, err)
	assert.Equal(t, StatusRefunded, refunded.Status)

	// Also test explicit ExpirePayment
	req2 := CollectRequest{
		AssetID:     "PROP-123",
		TokenAmount: 100,
		AmountINR:   50000,
		PayerVPA:    "investor1@aasthichain",
		PayeeVPA:    "originator@aasthichain",
		PayerID:     "investor1",
		PayeeID:     "originator1",
	}
	p2, err := gw.InitiateCollect(req2)
	require.NoError(t, err)
	expired, err := gw.ExpirePayment(p2.PaymentID)
	require.NoError(t, err)
	assert.Equal(t, StatusExpired, expired.Status)

	refunded2, err := gw.RefundPayment(p2.PaymentID, "user did not approve within 5 min")
	require.NoError(t, err)
	assert.Equal(t, StatusRefunded, refunded2.Status)
}

// 3. duplicate payment idempotency
func TestDuplicatePaymentIdempotency(t *testing.T) {
	gw := newTestGateway()
	req := CollectRequest{
		AssetID:        "PROP-123",
		TokenAmount:    200,
		AmountINR:      100000,
		PayerVPA:       "investor1@aasthichain",
		PayeeVPA:       "originator@aasthichain",
		IdempotencyKey: "idem-duplicate-test",
		PayerID:        "investor1",
		PayeeID:        "originator1",
	}
	p1, err := gw.InitiateCollect(req)
	require.NoError(t, err)

	// Second call with same idempotency key should return same payment, not create new
	p2, err := gw.InitiateCollect(req)
	require.NoError(t, err)
	assert.Equal(t, p1.PaymentID, p2.PaymentID)
	assert.Equal(t, p1.UpiTxnID, p2.UpiTxnID)
	assert.Equal(t, p1.RRN, p2.RRN)

	// Different key should create new payment
	req.IdempotencyKey = "idem-different-key"
	p3, err := gw.InitiateCollect(req)
	require.NoError(t, err)
	assert.NotEqual(t, p1.PaymentID, p3.PaymentID)

	// List should have 2 payments (p1/p2 same, p3 new)
	list := gw.ListPayments()
	assert.Equal(t, 2, len(list))
}

// 4. KYC-gate rejection
func TestKYCGateRejection(t *testing.T) {
	// Unverified payee
	kyc := &MockKYCProvider{Records: map[string]KYCStatus{
		"originator1": KYCUnverified, // not verified
		"investor1":   KYCVerified,
	}}
	gw := NewGateway(kyc, nil)
	req := CollectRequest{
		AssetID:     "PROP-123",
		TokenAmount: 100,
		AmountINR:   50000,
		PayerVPA:    "investor1@aasthichain",
		PayeeVPA:    "originator@aasthichain",
		PayerID:     "investor1",
		PayeeID:     "originator1",
	}
	p, err := gw.InitiateCollect(req)
	assert.Error(t, err)
	assert.Contains(t, err.Error(), string(StatusFailedKYC))
	assert.Equal(t, StatusFailedKYC, p.Status)

	// Unverified payer at approve time
	kyc2 := &MockKYCProvider{Records: map[string]KYCStatus{
		"originator1": KYCVerified,
		"investor1":   KYCUnverified,
	}}
	gw2 := NewGateway(kyc2, nil)
	req2 := CollectRequest{
		AssetID:     "PROP-123",
		TokenAmount: 100,
		AmountINR:   50000,
		PayerVPA:    "investor1@aasthichain",
		PayeeVPA:    "originator@aasthichain",
		PayerID:     "investor1",
		PayeeID:     "originator1",
	}
	p2, err := gw2.InitiateCollect(req2)
	require.NoError(t, err)
	assert.Equal(t, StatusPending, p2.Status)

	_, err = gw2.ApprovePayment(p2.PaymentID, "investor1")
	assert.Error(t, err)
	assert.Contains(t, err.Error(), string(StatusFailedKYC))
	got, _ := gw2.GetPayment(p2.PaymentID)
	assert.Equal(t, StatusFailedKYC, got.Status)
}

// Additional: insufficient funds
func TestInsufficientFunds(t *testing.T) {
	gw := newTestGateway()
	req := CollectRequest{
		AssetID:     "PROP-123",
		TokenAmount: 100,
		AmountINR:   1000000, // ₹10L, but poor has ₹1
		PayerVPA:    "poor@aasthichain",
		PayeeVPA:    "originator@aasthichain",
		PayerID:     "investor1", // KYC ok, but balance low
		PayeeID:     "originator1",
	}
	p, err := gw.InitiateCollect(req)
	require.NoError(t, err)

	_, err = gw.ApprovePayment(p.PaymentID, "investor1")
	assert.Error(t, err)
	assert.Contains(t, err.Error(), string(StatusFailedInsufficient))

	got, _ := gw.GetPayment(p.PaymentID)
	assert.Equal(t, StatusFailedInsufficient, got.Status)

	// Refund path
	refunded, err := gw.RefundPayment(p.PaymentID, "insufficient funds")
	require.NoError(t, err)
	assert.Equal(t, StatusRefunded, refunded.Status)
}

// Additional: invalid VPA
func TestInvalidVPA(t *testing.T) {
	gw := newTestGateway()
	tests := []struct {
		payer string
		payee string
	}{
		{"invalidvpa", "originator@aasthichain"},
		{"investor@aasthichain", "invalid"},
		{"investor@aasthichain", "investor@aasthichain"}, // self
		{"@aasthichain", "originator@aasthichain"},
	}
	for _, tt := range tests {
		req := CollectRequest{
			AssetID:     "PROP-123",
			TokenAmount: 10,
			AmountINR:   5000,
			PayerVPA:    tt.payer,
			PayeeVPA:    tt.payee,
			PayerID:     "investor1",
			PayeeID:     "originator1",
		}
		_, err := gw.InitiateCollect(req)
		assert.Error(t, err, "should fail for %s -> %s", tt.payer, tt.payee)
	}
}

// Additional: zero amount
func TestZeroAmount(t *testing.T) {
	gw := newTestGateway()
	req := CollectRequest{
		AssetID:     "PROP-123",
		TokenAmount: 10,
		AmountINR:   0,
		PayerVPA:    "investor1@aasthichain",
		PayeeVPA:    "originator@aasthichain",
		PayerID:     "investor1",
		PayeeID:     "originator1",
	}
	_, err := gw.InitiateCollect(req)
	assert.Error(t, err)
	assert.Contains(t, err.Error(), string(StatusFailedZeroAmount))
}

// Test UPI ID formats
func TestUPIIDFormats(t *testing.T) {
	paymentID := GeneratePaymentID()
	assert.True(t, len(paymentID) >= 10)
	assert.Contains(t, paymentID, "NPCI-")

	upiTxnID := GenerateUpiTxnID()
	assert.Contains(t, upiTxnID, "AAST")
	assert.True(t, len(upiTxnID) >= 16)

	rrn := GenerateRRN()
	assert.Equal(t, 12, len(rrn))
	assert.True(t, len(rrn) == 12)
	// should be numeric
	for _, c := range rrn {
		assert.True(t, c >= '0' && c <= '9', "RRN should be numeric")
	}

	utr := GenerateUTR(rrn)
	assert.Contains(t, utr, "IMPS")
	assert.Contains(t, utr, rrn)
}

// Test full DvP happy path with list
func TestFullDvPHappyPath(t *testing.T) {
	gw := newTestGateway()
	req := CollectRequest{
		AssetID:        "PROP-999",
		TokenAmount:    1000,
		AmountINR:      500000,
		PayerVPA:       "investor2@aasthichain",
		PayeeVPA:       "originator@aasthichain",
		Note:           "Full DvP test",
		IdempotencyKey: "full-dvp-test",
		PayerID:        "investor2",
		PayeeID:        "originator1",
	}
	p, err := gw.InitiateCollect(req)
	require.NoError(t, err)
	assert.Equal(t, StatusPending, p.Status)

	// Approve
	p, err = gw.ApprovePayment(p.PaymentID, "investor2")
	require.NoError(t, err)
	assert.Equal(t, StatusConfirmed, p.Status)

	// Simulate Drunix TransferTokens success
	drunixTransferID := "TXN-" + GeneratePaymentID()
	p, err = gw.ReleasePayment(p.PaymentID, drunixTransferID)
	require.NoError(t, err)
	assert.Equal(t, StatusReleased, p.Status)
	assert.Equal(t, drunixTransferID, p.DrunixTransferID)

	// Get
	got, err := gw.GetPayment(p.PaymentID)
	require.NoError(t, err)
	assert.Equal(t, StatusReleased, got.Status)
}

// Test VPA with numeric PSP — realistic UPI handles like investor1@aastbank123, ensures regex ^[a-z0-9._-]{2,64}@[a-z0-9]{2,64}$ matches numbers in PSP
func TestVPAWithNumericPSP(t *testing.T) {
	gw := newTestGateway()
	validVPAs := []string{
		"investor1@aastbank123",
		"investor1@okaxis123",
		"originator@aastbank",
		"investor@aasthichain",
		"investor1@aasthichain",
		"investor_1@okhdfcbank",
		"investor.1@okicici",
	}
	for _, vpa := range validVPAs {
		err := ValidateVPA(vpa)
		assert.NoError(t, err, "should accept valid VPA %s with current regex ^[a-z0-9._-]{2,64}@[a-z0-9]{2,64}$", vpa)
	}
	// Test full collect with numeric PSP
	req := CollectRequest{
		AssetID:     "PROP-123",
		TokenAmount: 100,
		AmountINR:   50000,
		PayerVPA:    "investor1@aastbank123",
		PayeeVPA:    "originator@aastbank123",
		PayerID:     "investor1",
		PayeeID:     "originator1",
	}
	p, err := gw.InitiateCollect(req)
	require.NoError(t, err, "collect with numeric PSP VPA should succeed — regex must allow a-z0-9 in PSP")
	assert.Equal(t, StatusPending, p.Status)
	assert.Equal(t, "investor1@aastbank123", p.PayerVPA)
}

// Test decline
func TestDeclineFlow(t *testing.T) {
	gw := newTestGateway()
	req := CollectRequest{
		AssetID:     "PROP-123",
		TokenAmount: 50,
		AmountINR:   25000,
		PayerVPA:    "investor1@aasthichain",
		PayeeVPA:    "originator@aasthichain",
		PayerID:     "investor1",
		PayeeID:     "originator1",
	}
	p, err := gw.InitiateCollect(req)
	require.NoError(t, err)

	declined, err := gw.DeclinePayment(p.PaymentID, "user declined in UPI app")
	require.NoError(t, err)
	assert.Equal(t, StatusDeclined, declined.Status)

	// After decline, cannot approve
	_, err = gw.ApprovePayment(p.PaymentID, "investor1")
	assert.Error(t, err)
}
