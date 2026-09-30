package paymentgateway

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"math/big"
	"sync"
	"time"
)

// UTR handling — realistic 12-digit numeric for IMPS, plus legacy IMPS+RRN
// Real bank assigns UTR on CONFIRMED, not at collect time

func GenerateUTR12() string {
	// 12-digit numeric starting with 4 for IMPS realism
	// Use crypto/rand for security
	n, err := rand.Int(rand.Reader, big.NewInt(1e11))
	if err != nil {
		return fmt.Sprintf("4%011d", time.Now().UnixNano()%1e11)
	}
	return fmt.Sprintf("4%011d", n.Int64())
}

type UTRBundle struct {
	RRN     string // 12-digit RRN starting 418
	UTR12   string // 12-digit numeric primary (real)
	UTRImps string // IMPS+RRN+4digit legacy
	UTR     string // primary = UTR12 for real bank reconciliation
}

func GenerateUTRRealistic() UTRBundle {
	rrn := GenerateRRN()
	utr12 := GenerateUTR12()
	utrImps := GenerateUTR(rrn)
	return UTRBundle{
		RRN:     rrn,
		UTR12:   utr12,
		UTRImps: utrImps,
		UTR:     utr12, // primary is 12-digit for real
	}
}

// Webhook payload from Setu/ICICI/Decentro
type WebhookPayload struct {
	PaymentID     string  `json:"paymentId"`
	ReferenceID   string  `json:"referenceId"` // Setu uses referenceId
	MerchantTxnID string  `json:"merchantTxnId"`
	TransactionID string  `json:"transactionId"`
	Status        string  `json:"status"`        // SUCCESS, FAILED, etc
	TxnStatus     string  `json:"txnStatus"`     // Setu
	PaymentStatus string  `json:"paymentStatus"` // ICICI
	RRN           string  `json:"rrn"`
	BankRRN       string  `json:"bankRRN"`
	UTR           string  `json:"utr"`
	BankUTR       string  `json:"bankUTR"`
	UpiUTR        string  `json:"upiUTR"`
	UTR12         string  `json:"utr12"`
	Amount        float64 `json:"amount"`
	AmountPaise   int64   `json:"amountPaise"`
	TxnAmount     float64 `json:"txnAmount"`
	Provider      string  `json:"provider"` // setu, icici, decentro
	Signature     string  `json:"signature"`
	Timestamp     string  `json:"timestamp"`
	FailureReason string  `json:"failureReason"`
	Raw           map[string]interface{} `json:"-"`
}

func (w *WebhookPayload) GetPaymentID() string {
	if w.PaymentID != "" {
		return w.PaymentID
	}
	if w.ReferenceID != "" {
		return w.ReferenceID
	}
	if w.MerchantTxnID != "" {
		return w.MerchantTxnID
	}
	return w.TransactionID
}

func (w *WebhookPayload) GetStatus() string {
	if w.Status != "" {
		return w.Status
	}
	if w.TxnStatus != "" {
		return w.TxnStatus
	}
	return w.PaymentStatus
}

func (w *WebhookPayload) GetRRN() string {
	if w.RRN != "" {
		return w.RRN
	}
	return w.BankRRN
}

func (w *WebhookPayload) GetUTR() string {
	if w.UTR != "" {
		return w.UTR
	}
	if w.BankUTR != "" {
		return w.BankUTR
	}
	if w.UpiUTR != "" {
		return w.UpiUTR
	}
	return w.UTR12
}

func (w *WebhookPayload) GetAmount() *float64 {
	if w.Amount != 0 {
		return &w.Amount
	}
	if w.TxnAmount != 0 {
		return &w.TxnAmount
	}
	if w.AmountPaise != 0 {
		f := float64(w.AmountPaise) / 100
		return &f
	}
	return nil
}

// Webhook signature verification — Setu/ICICI HMAC SHA256
func VerifyWebhookSignature(rawBody []byte, signature, secret, provider string) bool {
	if secret == "" {
		// Mock mode — allow all, but log in real mode would fail
		return true
	}
	if signature == "" {
		return false
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(rawBody)
	expected := hex.EncodeToString(mac.Sum(nil))
	// Constant-time compare
	return hmac.Equal([]byte(expected), []byte(signature))
}

// Webhook audit event for Regulator
type WebhookEvent struct {
	WebhookID     string    `json:"webhookId"`
	PaymentID     string    `json:"paymentId"`
	Status        string    `json:"status"`
	RRN           string    `json:"rrn"`
	UTR           string    `json:"utr"`
	Provider      string    `json:"provider"`
	Amount        float64   `json:"amount"`
	ExpectedAmount float64  `json:"expectedAmount,omitempty"`
	Timestamp     time.Time `json:"timestamp"`
	Result        string    `json:"result"` // SUCCESS, AMOUNT_MISMATCH, INVALID_SIGNATURE, etc
	FailureReason string    `json:"failureReason,omitempty"`
	Raw           interface{} `json:"raw,omitempty"`
	Test          bool      `json:"test,omitempty"`
	Simulated     bool      `json:"simulated,omitempty"`
}

// Reconciliation dashboard for Regulator/Admin
type ReconciliationReport struct {
	Summary struct {
		TotalPayments   int     `json:"totalPayments"`
		SuccessCount    int     `json:"successCount"`
		PendingCount    int     `json:"pendingCount"`
		FailedCount     int     `json:"failedCount"`
		TotalVolumeINR  float64 `json:"totalVolumeINR"`
		SuccessRate     string  `json:"successRate"`
		UTRCoverage     string  `json:"utrCoverage"`
		WebhookCount    int     `json:"webhookCount"`
		UTRIndexCount   int     `json:"utrIndexCount"`
	} `json:"summary"`
	Issues struct {
		PendingWithoutUTR []PaymentSummary `json:"pendingWithoutUTR"`
		AmountMismatches  []PaymentSummary `json:"amountMismatches"`
		PendingTooLong    []PaymentSummary `json:"pendingTooLong"`
		FailedProvider    []PaymentSummary `json:"failedProvider"`
	} `json:"issues"`
	RecentWebhooks []WebhookEvent `json:"recentWebhooks"`
	UTRIndexSample []UTRSample    `json:"utrIndexSample"`
}

type PaymentSummary struct {
	PaymentID     string    `json:"paymentId"`
	AssetID       string    `json:"assetId"`
	AmountINR     float64   `json:"amountINR"`
	CreatedAt     time.Time `json:"createdAt"`
	AgeMinutes    int       `json:"ageMin,omitempty"`
	FailureReason string    `json:"failureReason,omitempty"`
	ExpectedAmount float64  `json:"expected,omitempty"`
	Provider      string    `json:"provider,omitempty"`
}

type UTRSample struct {
	UTR       string `json:"utr"`
	PaymentID string `json:"paymentId"`
}

// Extended Gateway with webhook + UTR reconciliation
type GatewayWithWebhook struct {
	*Gateway
	mu          sync.RWMutex
	utrIndex    map[string]string // UTR -> PaymentID
	webhooks    []WebhookEvent
	webhookIdem map[string]*Payment // webhookId -> payment for idempotency
}

func NewGatewayWithWebhook(kyc KYCProvider, bal BalanceProvider) *GatewayWithWebhook {
	gw := NewGateway(kyc, bal)
	return &GatewayWithWebhook{
		Gateway:     gw,
		utrIndex:    make(map[string]string),
		webhooks:    make([]WebhookEvent, 0, 100),
		webhookIdem: make(map[string]*Payment),
	}
}

// ProcessWebhook — main webhook handler for Setu/ICICI
func (g *GatewayWithWebhook) ProcessWebhook(payload WebhookPayload, rawBody []byte, signature, secret string) (*Payment, error) {
	paymentID := payload.GetPaymentID()
	if paymentID == "" {
		return nil, errors.New("paymentId or referenceId required in webhook payload")
	}

	g.mu.Lock()
	defer g.mu.Unlock()

	// Find payment
	p, ok := g.payments[paymentID]
	if !ok {
		// Log audit and return 404 — in production, create if bank-initiated
		g.addWebhookAudit(WebhookEvent{
			WebhookID: fmt.Sprintf("wh-%d-%s", time.Now().UnixNano(), paymentID),
			PaymentID: paymentID,
			Status:    payload.GetStatus(),
			RRN:       payload.GetRRN(),
			UTR:       payload.GetUTR(),
			Provider:  payload.Provider,
			Timestamp: time.Now(),
			Result:    "PAYMENT_NOT_FOUND",
			Raw:       payload,
		})
		return nil, errors.New("payment not found for webhook")
	}

	// Idempotency: same paymentId + status + utr
	utr := payload.GetUTR()
	rrn := payload.GetRRN()
	webhookID := fmt.Sprintf("%s~%s~%s", paymentID, payload.GetStatus(), utr)
	if utr == "" {
		webhookID = fmt.Sprintf("%s~%s~%s", paymentID, payload.GetStatus(), rrn)
	}
	if _, exists := g.webhookIdem[webhookID]; exists {
		// Idempotent — already processed
		cp := *p
		return &cp, nil
	}

	// Signature verification
	if !VerifyWebhookSignature(rawBody, signature, secret, payload.Provider) && secret != "" {
		g.addWebhookAudit(WebhookEvent{
			WebhookID: webhookID,
			PaymentID: paymentID,
			Status:    payload.GetStatus(),
			RRN:       rrn,
			UTR:       utr,
			Provider:  payload.Provider,
			Timestamp: time.Now(),
			Result:    "INVALID_SIGNATURE",
		})
		return nil, errors.New("invalid webhook signature")
	}

	// Amount reconciliation — critical for DvP
	if amtPtr := payload.GetAmount(); amtPtr != nil {
		amt := *amtPtr
		if diff := amt - p.AmountINR; diff < -0.01 || diff > 0.01 {
			// Amount mismatch — mark FAILED_AMOUNT_MISMATCH, no auto-release
			p.Status = "FAILED_AMOUNT_MISMATCH"
			p.FailureReason = fmt.Sprintf("Amount mismatch: expected ₹%.2f got ₹%.2f — manual review required", p.AmountINR, amt)
			now := time.Now()
			// Add custom field via failure reason, in real would have separate field
			g.addWebhookAudit(WebhookEvent{
				WebhookID:      webhookID,
				PaymentID:      paymentID,
				Status:         "FAILED_AMOUNT_MISMATCH",
				RRN:            rrn,
				UTR:            utr,
				Provider:       payload.Provider,
				Amount:         amt,
				ExpectedAmount: p.AmountINR,
				Timestamp:      now,
				Result:         "AMOUNT_MISMATCH",
				Raw:            payload,
			})
			g.webhookIdem[webhookID] = p
			return p, fmt.Errorf("amount mismatch: expected %.2f got %.2f", p.AmountINR, amt)
		}
	}

	// Update UTR and RRN
	if rrn != "" {
		p.RRN = rrn
		g.utrIndex[rrn] = paymentID
	}
	if utr != "" {
		p.UTR = utr
		g.utrIndex[utr] = paymentID
	} else if p.UTR == "" {
		// Generate if provider didn't send but status is success
		gen := GenerateUTRRealistic()
		if p.RRN == "" {
			p.RRN = gen.RRN
			g.utrIndex[gen.RRN] = paymentID
		}
		p.UTR = gen.UTR
		g.utrIndex[gen.UTR] = paymentID
		g.utrIndex[gen.UTR12] = paymentID
		g.utrIndex[gen.UTRImps] = paymentID
	}

	// Map provider status to our status
	newStatus := p.Status
	statusUpper := payload.GetStatus()
	switch statusUpper {
	case "SUCCESS", "COMPLETED", "CONFIRMED", "PAYMENT_SUCCESS", "TXN_SUCCESS":
		newStatus = StatusConfirmed
	case "FAILED", "FAILURE", "TXN_FAILED", "PAYMENT_FAILED":
		newStatus = "FAILED_PROVIDER"
	case "PENDING", "INITIATED":
		newStatus = StatusPending
	default:
		if statusUpper != "" {
			newStatus = Status(statusUpper)
		}
	}

	// Allow only forward transitions
	allowed := map[Status][]Status{
		StatusPending:   {StatusConfirmed, "FAILED_PROVIDER", StatusDeclined, StatusExpired, "FAILED_AMOUNT_MISMATCH"},
		StatusConfirmed: {StatusReleased, StatusRefunded},
		"FAILED_PROVIDER": {StatusRefunded},
		StatusDeclined:  {StatusRefunded},
		StatusExpired:   {StatusRefunded},
	}
	if p.Status != newStatus {
		if allowedList, ok := allowed[p.Status]; ok {
			allowedMap := make(map[Status]bool)
			for _, s := range allowedList {
				allowedMap[s] = true
			}
			if !allowedMap[newStatus] {
				// Invalid transition — log but return 200 to avoid retry storm
				g.addWebhookAudit(WebhookEvent{
					WebhookID: webhookID,
					PaymentID: paymentID,
					Status:    string(newStatus),
					RRN:       p.RRN,
					UTR:       p.UTR,
					Provider:  payload.Provider,
					Timestamp: time.Now(),
					Result:    "INVALID_TRANSITION",
					FailureReason: fmt.Sprintf("Invalid transition %s -> %s ignored", p.Status, newStatus),
					Raw:       payload,
				})
				cp := *p
				return &cp, nil
			}
		}
		p.Status = newStatus
		if newStatus == StatusConfirmed {
			now := time.Now()
			p.ConfirmedAt = &now
		}
	}

	// Mark webhook received
	// In real Payment struct, we'd have webhookReceivedAt, provider fields — add via audit
	g.webhookIdem[webhookID] = p
	g.addWebhookAudit(WebhookEvent{
		WebhookID: webhookID,
		PaymentID: paymentID,
		Status:    string(p.Status),
		RRN:       p.RRN,
		UTR:       p.UTR,
		Provider:  payload.Provider,
		Amount:    p.AmountINR,
		Timestamp: time.Now(),
		Result:    "SUCCESS",
		Raw:       payload,
	})

	cp := *p
	return &cp, nil
}

func (g *GatewayWithWebhook) addWebhookAudit(event WebhookEvent) {
	g.webhooks = append(g.webhooks, event)
	if len(g.webhooks) > 500 {
		g.webhooks = g.webhooks[len(g.webhooks)-500:]
	}
}

// Lookup by UTR — O(1) via index
func (g *GatewayWithWebhook) GetPaymentByUTR(utr string) (*Payment, error) {
	g.mu.RLock()
	defer g.mu.RUnlock()

	paymentID, ok := g.utrIndex[utr]
	if !ok {
		// Try search directly in payments for legacy
		for _, p := range g.payments {
			if p.UTR == utr || p.RRN == utr {
				cp := *p
				return &cp, nil
			}
		}
		return nil, errors.New("UTR not found")
	}

	p, ok := g.payments[paymentID]
	if !ok {
		return nil, errors.New("paymentId from UTR index not found")
	}
	cp := *p
	return &cp, nil
}

// Reconciliation report for Regulator
func (g *GatewayWithWebhook) GetReconciliationReport() ReconciliationReport {
	g.mu.RLock()
	defer g.mu.RUnlock()

	var report ReconciliationReport
	now := time.Now()

	all := make([]*Payment, 0, len(g.payments))
	for _, p := range g.payments {
		all = append(all, p)
	}

	report.Summary.TotalPayments = len(all)
	report.Summary.WebhookCount = len(g.webhooks)
	report.Summary.UTRIndexCount = len(g.utrIndex)

	var successCount, pendingCount, failedCount int
	var totalVolume float64
	var paymentsWithUTR int

	for _, p := range all {
		switch p.Status {
		case StatusConfirmed, StatusReleased:
			successCount++
			totalVolume += p.AmountINR
		case StatusPending:
			pendingCount++
		default:
			if len(p.Status) >= 6 && (p.Status[0:6] == "FAILED" || p.Status == StatusExpired || p.Status == StatusDeclined) {
				failedCount++
			}
		}

		if p.UTR != "" {
			paymentsWithUTR++
		}

		// Issues
		if p.Status == StatusConfirmed && p.UTR == "" {
			report.Issues.PendingWithoutUTR = append(report.Issues.PendingWithoutUTR, PaymentSummary{
				PaymentID: p.PaymentID,
				AssetID:   p.AssetID,
				AmountINR: p.AmountINR,
				CreatedAt: p.CreatedAt,
				AgeMinutes: int(now.Sub(p.CreatedAt).Minutes()),
			})
		}
		if p.Status == "FAILED_AMOUNT_MISMATCH" {
			report.Issues.AmountMismatches = append(report.Issues.AmountMismatches, PaymentSummary{
				PaymentID:     p.PaymentID,
				FailureReason: p.FailureReason,
				CreatedAt:     p.CreatedAt,
			})
		}
		if p.Status == StatusPending && now.Sub(p.CreatedAt) > 5*time.Minute {
			report.Issues.PendingTooLong = append(report.Issues.PendingTooLong, PaymentSummary{
				PaymentID:  p.PaymentID,
				AssetID:    p.AssetID,
				AmountINR:  p.AmountINR,
				CreatedAt:  p.CreatedAt,
				AgeMinutes: int(now.Sub(p.CreatedAt).Minutes()),
			})
		}
		if p.Status == "FAILED_PROVIDER" {
			report.Issues.FailedProvider = append(report.Issues.FailedProvider, PaymentSummary{
				PaymentID:     p.PaymentID,
				FailureReason: p.FailureReason,
				CreatedAt:     p.CreatedAt,
			})
		}
	}

	report.Summary.SuccessCount = successCount
	report.Summary.PendingCount = pendingCount
	report.Summary.FailedCount = failedCount
	report.Summary.TotalVolumeINR = totalVolume
	if len(all) > 0 {
		report.Summary.SuccessRate = fmt.Sprintf("%.1f%%", float64(successCount)/float64(len(all))*100)
	} else {
		report.Summary.SuccessRate = "0%"
	}
	report.Summary.UTRCoverage = fmt.Sprintf("%d/%d payments have UTR (%d in index)", paymentsWithUTR, len(all), len(g.utrIndex))

	// Recent webhooks last 20
	start := 0
	if len(g.webhooks) > 20 {
		start = len(g.webhooks) - 20
	}
	for i := len(g.webhooks) - 1; i >= start && i >= 0; i-- {
		report.RecentWebhooks = append(report.RecentWebhooks, g.webhooks[i])
	}

	// UTR index sample last 10
	count := 0
	for utr, pid := range g.utrIndex {
		if count >= 10 {
			break
		}
		report.UTRIndexSample = append(report.UTRIndexSample, UTRSample{UTR: utr, PaymentID: pid})
		count++
	}

	return report
}

func (g *GatewayWithWebhook) ListWebhooks(limit int) []WebhookEvent {
	g.mu.RLock()
	defer g.mu.RUnlock()

	if limit <= 0 || limit > len(g.webhooks) {
		limit = len(g.webhooks)
	}
	start := len(g.webhooks) - limit
	if start < 0 {
		start = 0
	}
	// Return reverse (newest first)
	result := make([]WebhookEvent, 0, limit)
	for i := len(g.webhooks) - 1; i >= start; i-- {
		result = append(result, g.webhooks[i])
	}
	return result
}

// Test helper — simulate webhook from Setu for local testing
func (g *GatewayWithWebhook) SimulateWebhook(paymentID, scenario string) (*Payment, WebhookPayload, error) {
	g.mu.RLock()
	p, ok := g.payments[paymentID]
	g.mu.RUnlock()

	if !ok {
		return nil, WebhookPayload{}, errors.New("payment not found")
	}

	gen := GenerateUTRRealistic()
	var payload WebhookPayload

	switch scenario {
	case "success":
		payload = WebhookPayload{
			PaymentID: paymentID,
			Status:    "SUCCESS",
			RRN:       gen.RRN,
			UTR:       gen.UTR,
			Amount:    p.AmountINR,
			Provider:  "setu",
			Timestamp: time.Now().Format(time.RFC3339),
		}
	case "amount_mismatch":
		payload = WebhookPayload{
			PaymentID: paymentID,
			Status:    "SUCCESS",
			RRN:       gen.RRN,
			UTR:       gen.UTR,
			Amount:    p.AmountINR + 1000, // mismatch
			Provider:  "setu",
		}
	case "failed":
		payload = WebhookPayload{
			PaymentID:     paymentID,
			Status:        "FAILED",
			FailureReason: "Insufficient funds in payer account per bank",
			Provider:      "icici",
		}
	default:
		payload = WebhookPayload{
			PaymentID: paymentID,
			Status:    "SUCCESS",
			RRN:       gen.RRN,
			UTR:       gen.UTR,
			Amount:    p.AmountINR,
			Provider:  "setu",
		}
	}

	// Process
	result, err := g.ProcessWebhook(payload, []byte(fmt.Sprintf(`{"paymentId":"%s","status":"%s"}`, paymentID, payload.Status)), "", "")
	return result, payload, err
}
