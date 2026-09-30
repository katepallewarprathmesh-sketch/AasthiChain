package paymentgateway

import (
	"crypto/rand"
	"errors"
	"fmt"
	"math/big"
	"regexp"
	"strings"
	"sync"
	"time"
)

// Status mirrors UPI switch + escrow pattern PENDING→CONFIRMED→RELEASED/REFUNDED
type Status string

const (
	StatusPending            Status = "PENDING"
	StatusConfirmed          Status = "CONFIRMED"
	StatusReleased           Status = "RELEASED"
	StatusRefunded           Status = "REFUNDED"
	StatusFailedKYC          Status = "FAILED_KYC_NOT_VERIFIED"
	StatusFailedInsufficient Status = "FAILED_INSUFFICIENT_FUNDS"
	StatusExpired            Status = "EXPIRED"
	StatusDeclined           Status = "DECLINED"
	StatusFailedInvalidVPA   Status = "FAILED_INVALID_VPA"
	StatusFailedZeroAmount   Status = "FAILED_INVALID_AMOUNT"
	StatusFailedSelfTransfer Status = "FAILED_SELF_TRANSFER"
)

// Payment represents NPCI-style UPI Collect transaction
type Payment struct {
	PaymentID        string     `json:"paymentId"` // NPCI-XXXXXXXXXXXX
	UpiTxnID         string     `json:"upiTxnId"`  // AAST20260921X7K9P2Q1
	RRN              string     `json:"rrn"`       // 12-digit Retrieval Reference Number
	UTR              string     `json:"utr"`       // IMPS UTR: IMPS + RRN
	AssetID          string     `json:"assetId"`
	TokenAmount      int64      `json:"tokenAmount"`
	AmountINRPaise   int64      `json:"amountINRPaise"` // store in paise to avoid float
	AmountINR        float64    `json:"amountINR"`      // display convenience
	PayerVPA         string     `json:"payerVpa"`       // investor@aasthichain
	PayeeVPA         string     `json:"payeeVpa"`       // originator@aasthichain
	Note             string     `json:"note"`
	Status           Status     `json:"status"`
	CreatedAt        time.Time  `json:"createdAt"`
	ExpiresAt        time.Time  `json:"expiresAt"`
	ConfirmedAt      *time.Time `json:"confirmedAt,omitempty"`
	ReleasedAt       *time.Time `json:"releasedAt,omitempty"`
	DrunixTransferID string     `json:"drunixTransferId,omitempty"`
	IdempotencyKey   string     `json:"idempotencyKey,omitempty"`
	FailureReason    string     `json:"failureReason,omitempty"`
	// PayU test/live rail (additive — empty for the mock rail)
	Provider     string        `json:"provider,omitempty"`     // "", "mock", "payu"
	PayuID       string        `json:"payuId,omitempty"`       // PayU mihpayid
	PayuTestMode bool          `json:"payuTestMode,omitempty"` // true on test.payu.in (simulated settlement)
	PayuCheckout *PayUCheckout `json:"payuCheckout,omitempty"` // browser form → PayU hosted checkout
	// Simulation flags
	IsSimulation bool `json:"isSimulation"` // always true for this mock, honest labeling
}

type KYCStatus string

const (
	KYCVerified   KYCStatus = "VERIFIED"
	KYCUnverified KYCStatus = "UNVERIFIED"
)

type KYCProvider interface {
	GetKYCStatus(identityID string) (KYCStatus, error)
}

type MockKYCProvider struct {
	Records map[string]KYCStatus
}

func (m *MockKYCProvider) GetKYCStatus(id string) (KYCStatus, error) {
	if s, ok := m.Records[id]; ok {
		return s, nil
	}
	return KYCUnverified, nil
}

type BalanceProvider interface {
	GetBalance(vpa string) (int64, error) // paise
}

type MockBalanceProvider struct {
	Balances map[string]int64 // paise
}

func (m *MockBalanceProvider) GetBalance(vpa string) (int64, error) {
	if b, ok := m.Balances[vpa]; ok {
		return b, nil
	}
	// default high balance: 10L INR = 100,000,000 paise
	// Also allow demo.investor@aasthichain fictitious test handle, NOT real mobile number — e.g., demo.investor@aasthichain
	if vpa == "demo.investor@aasthichain" || vpa == "demo.investor@fakebank" || vpa == "demo.owner@fakebank" {
		return 100000000, nil
	}
	return 100000000, nil
}

var vpaRegex = regexp.MustCompile(`^[a-z0-9._-]{2,64}@[a-z0-9]{2,64}$`)

func ValidateVPA(vpa string) error {
	vpa = strings.ToLower(strings.TrimSpace(vpa))
	if !vpaRegex.MatchString(vpa) {
		return errors.New("invalid VPA format, expected handle@psp like investor@aasthichain")
	}
	parts := strings.Split(vpa, "@")
	if len(parts) != 2 {
		return errors.New("invalid VPA")
	}
	if parts[0] == parts[1] {
		// not really invalid, but check self
	}
	return nil
}

func generateRandomString(n int, charset string) string {
	b := make([]byte, n)
	for i := range b {
		idx, _ := rand.Int(rand.Reader, big.NewInt(int64(len(charset))))
		b[i] = charset[idx.Int64()]
	}
	return string(b)
}

func GeneratePaymentID() string {
	return "NPCI-" + strings.ToUpper(generateRandomString(12, "0123456789ABCDEF"))
}

func GenerateUpiTxnID() string {
	now := time.Now()
	date := now.Format("20060102")
	randPart := strings.ToUpper(generateRandomString(8, "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"))
	return fmt.Sprintf("AAST%s%s", date, randPart) // e.g., AAST20260921X7K9P2Q1
}

func GenerateRRN() string {
	// 12-digit, start with 418 for test range
	suffix := generateRandomString(9, "0123456789")
	return "418" + suffix
}

func GenerateUTR(rrn string) string {
	return "IMPS" + rrn + generateRandomString(4, "0123456789")
}

type CollectRequest struct {
	AssetID        string
	TokenAmount    int64
	AmountINR      float64 // in INR
	PayerVPA       string
	PayeeVPA       string
	Note           string
	IdempotencyKey string
	PayerID        string // identityId for KYC lookup, e.g., investor1
	PayeeID        string // originator1
}

type Gateway struct {
	mu          sync.RWMutex
	payments    map[string]*Payment
	idempotency map[string]*Payment // idempotencyKey -> payment
	kycProvider KYCProvider
	balProvider BalanceProvider
}

func NewGateway(kyc KYCProvider, bal BalanceProvider) *Gateway {
	if kyc == nil {
		kyc = &MockKYCProvider{Records: map[string]KYCStatus{
			"originator1": KYCVerified,
			"investor1":   KYCVerified,
			"investor2":   KYCVerified,
			"registrar1":  KYCVerified,
			"regulator1":  KYCVerified,
		}}
	}
	if bal == nil {
		bal = &MockBalanceProvider{Balances: map[string]int64{}}
	}
	return &Gateway{
		payments:    make(map[string]*Payment),
		idempotency: make(map[string]*Payment),
		kycProvider: kyc,
		balProvider: bal,
	}
}

// InitiateCollect simulates UPI Collect: payee requests money from payer
func (g *Gateway) InitiateCollect(req CollectRequest) (*Payment, error) {
	// Validations mirroring chaincode edge cases
	if req.AmountINR <= 0 {
		return nil, errors.New(string(StatusFailedZeroAmount) + ": amount must be > 0")
	}
	if strings.ToLower(strings.TrimSpace(req.PayerVPA)) == strings.ToLower(strings.TrimSpace(req.PayeeVPA)) {
		return nil, errors.New(string(StatusFailedSelfTransfer) + ": payer and payee VPA cannot be same")
	}
	if err := ValidateVPA(req.PayerVPA); err != nil {
		return nil, fmt.Errorf("%s: payer %w", StatusFailedInvalidVPA, err)
	}
	if err := ValidateVPA(req.PayeeVPA); err != nil {
		return nil, fmt.Errorf("%s: payee %w", StatusFailedInvalidVPA, err)
	}
	if req.AssetID == "" {
		return nil, errors.New("assetId required")
	}
	if req.TokenAmount <= 0 {
		return nil, errors.New("tokenAmount must be > 0")
	}

	// Idempotency check
	g.mu.Lock()
	defer g.mu.Unlock()

	if req.IdempotencyKey != "" {
		if existing, ok := g.idempotency[req.IdempotencyKey]; ok {
			return existing, nil // return same payment, idempotent
		}
	}

	// KYC check at initiation (payee must be verified to request)
	if req.PayeeID != "" {
		status, _ := g.kycProvider.GetKYCStatus(req.PayeeID)
		if status != KYCVerified {
			p := &Payment{
				PaymentID:      GeneratePaymentID(),
				UpiTxnID:       GenerateUpiTxnID(),
				RRN:            GenerateRRN(),
				AssetID:        req.AssetID,
				TokenAmount:    req.TokenAmount,
				AmountINR:      req.AmountINR,
				AmountINRPaise: int64(req.AmountINR * 100),
				PayerVPA:       strings.ToLower(req.PayerVPA),
				PayeeVPA:       strings.ToLower(req.PayeeVPA),
				Note:           req.Note,
				Status:         StatusFailedKYC,
				CreatedAt:      time.Now(),
				ExpiresAt:      time.Now().Add(5 * time.Minute),
				FailureReason:  fmt.Sprintf("payee %s KYC not verified", req.PayeeID),
				IsSimulation:   true,
			}
			p.UTR = GenerateUTR(p.RRN)
			g.payments[p.PaymentID] = p
			if req.IdempotencyKey != "" {
				g.idempotency[req.IdempotencyKey] = p
			}
			return p, errors.New(string(StatusFailedKYC) + ": payee KYC not verified")
		}
	}

	now := time.Now()
	p := &Payment{
		PaymentID:      GeneratePaymentID(),
		UpiTxnID:       GenerateUpiTxnID(),
		RRN:            GenerateRRN(),
		AssetID:        req.AssetID,
		TokenAmount:    req.TokenAmount,
		AmountINR:      req.AmountINR,
		AmountINRPaise: int64(req.AmountINR * 100),
		PayerVPA:       strings.ToLower(req.PayerVPA),
		PayeeVPA:       strings.ToLower(req.PayeeVPA),
		Note:           req.Note,
		Status:         StatusPending,
		CreatedAt:      now,
		ExpiresAt:      now.Add(5 * time.Minute),
		IdempotencyKey: req.IdempotencyKey,
		IsSimulation:   true,
	}
	p.UTR = GenerateUTR(p.RRN)

	g.payments[p.PaymentID] = p
	if req.IdempotencyKey != "" {
		g.idempotency[req.IdempotencyKey] = p
	}
	return p, nil
}

func (g *Gateway) GetPayment(paymentID string) (*Payment, error) {
	g.mu.RLock()
	defer g.mu.RUnlock()
	p, ok := g.payments[paymentID]
	if !ok {
		return nil, errors.New("payment not found")
	}
	// check expiry
	if p.Status == StatusPending && time.Now().After(p.ExpiresAt) {
		// copy and mark expired
		cp := *p
		cp.Status = StatusExpired
		cp.FailureReason = "collect request expired after 5 min"
		return &cp, nil
	}
	cp := *p
	return &cp, nil
}

// Approve simulates payer approving UPI Collect in UPI app
func (g *Gateway) ApprovePayment(paymentID string, payerID string) (*Payment, error) {
	g.mu.Lock()
	defer g.mu.Unlock()

	p, ok := g.payments[paymentID]
	if !ok {
		return nil, errors.New("payment not found")
	}
	if p.Status != StatusPending {
		return nil, fmt.Errorf("payment not in PENDING state, current %s", p.Status)
	}
	if time.Now().After(p.ExpiresAt) {
		p.Status = StatusExpired
		p.FailureReason = "expired"
		return p, errors.New(string(StatusExpired) + ": collect request expired")
	}

	// KYC check payer
	if payerID != "" {
		status, _ := g.kycProvider.GetKYCStatus(payerID)
		if status != KYCVerified {
			p.Status = StatusFailedKYC
			p.FailureReason = fmt.Sprintf("payer %s KYC not verified", payerID)
			return p, errors.New(string(StatusFailedKYC) + ": payer KYC not verified")
		}
	}

	// Balance check (mock)
	bal, _ := g.balProvider.GetBalance(p.PayerVPA)
	if bal < p.AmountINRPaise {
		p.Status = StatusFailedInsufficient
		p.FailureReason = fmt.Sprintf("insufficient funds: have %d paise need %d", bal, p.AmountINRPaise)
		return p, errors.New(string(StatusFailedInsufficient) + ": insufficient funds")
	}

	now := time.Now()
	p.Status = StatusConfirmed
	p.ConfirmedAt = &now
	return p, nil
}

func (g *Gateway) DeclinePayment(paymentID string, reason string) (*Payment, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	p, ok := g.payments[paymentID]
	if !ok {
		return nil, errors.New("payment not found")
	}
	if p.Status != StatusPending {
		return nil, fmt.Errorf("not pending")
	}
	p.Status = StatusDeclined
	p.FailureReason = reason
	return p, nil
}

func (g *Gateway) ExpirePayment(paymentID string) (*Payment, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	p, ok := g.payments[paymentID]
	if !ok {
		return nil, errors.New("payment not found")
	}
	p.Status = StatusExpired
	p.FailureReason = "timeout after 5 min"
	return p, nil
}

// Release simulates IMPS settlement after Drunix transfer confirmed — atomic DvP
func (g *Gateway) ReleasePayment(paymentID string, drunixTransferID string) (*Payment, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	p, ok := g.payments[paymentID]
	if !ok {
		return nil, errors.New("payment not found")
	}
	if p.Status != StatusConfirmed {
		return nil, fmt.Errorf("payment must be CONFIRMED before release, current %s", p.Status)
	}
	if drunixTransferID == "" {
		return nil, errors.New("drunixTransferId required for atomic DvP")
	}
	now := time.Now()
	p.Status = StatusReleased
	p.ReleasedAt = &now
	p.DrunixTransferID = drunixTransferID
	return p, nil
}

// Refund simulates refund if Drunix transfer fails — keeps atomicity
func (g *Gateway) RefundPayment(paymentID string, reason string) (*Payment, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	p, ok := g.payments[paymentID]
	if !ok {
		return nil, errors.New("payment not found")
	}
	// EXPIRED is refundable — the documented timeout→refund path (README payment tests):
	// a late-approved collect must return the payer's money, not strand it in escrow.
	if p.Status != StatusPending && p.Status != StatusConfirmed && p.Status != StatusExpired && p.Status != StatusFailedInsufficient && p.Status != StatusFailedKYC {
		return nil, fmt.Errorf("cannot refund from %s", p.Status)
	}
	p.Status = StatusRefunded
	p.FailureReason = reason
	return p, nil
}

func (g *Gateway) ListPayments() []*Payment {
	g.mu.RLock()
	defer g.mu.RUnlock()
	list := make([]*Payment, 0, len(g.payments))
	for _, p := range g.payments {
		cp := *p
		list = append(list, &cp)
	}
	return list
}
