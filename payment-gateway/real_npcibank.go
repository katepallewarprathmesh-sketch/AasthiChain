package paymentgateway

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"time"
)

// RealNPCIProvider implements direct NPCI access via PSP Bank / NPCI-certified switch
// Setu (Pine Labs) is NPCI-certified switch with direct NPCI systems access
// ICICI Bank provides UPI Collect API
// Decentro, Razorpay, Cashfree are aggregators with direct switch access
//
// Why not direct NPCI?
// - NPCI's APIs on API Setu are sandbox-only: "does not provide access to production API [Updated 14 Jan 2022]"
// - Direct NPCI requires registered fintech + bank partnership + certification (StackOverflow, Reddit)
// - Real path: Your app -> PSP Bank (Setu/ICICI) -> NPCI switch -> Remitter PSP -> Customer UPI app
//
// Env toggle:
// NPCI_MODE=mock -> MockBalanceProvider + MockKYCProvider (hackathon, no creds, honest simulation)
// NPCI_MODE=real -> RealNPCIProvider + RealKYCProvider (production, requires SETU_API_KEY / ICICI_API_KEY)

type RealNPCIProvider struct {
	APIKey  string
	BaseURL string // e.g., https://api.setu.co or https://api.icicibank.com/api/v1/upi
	Client  *http.Client
	Mode    string // setu, icici, decentro, razorpay
}

func NewRealNPCIProviderFromEnv() (*RealNPCIProvider, error) {
	mode := os.Getenv("NPCI_MODE")
	if mode != "real" {
		return nil, errors.New("NPCI_MODE not real, use mock")
	}
	// Try Setu first (recommended — NPCI-certified switch)
	if key := os.Getenv("SETU_API_KEY"); key != "" {
		return &RealNPCIProvider{
			APIKey:  key,
			BaseURL: os.Getenv("SETU_BASE_URL"),
			Mode:    "setu",
			Client:  &http.Client{Timeout: 15 * time.Second},
		}, nil
	}
	if key := os.Getenv("ICICI_API_KEY"); key != "" {
		return &RealNPCIProvider{
			APIKey:  key,
			BaseURL: "https://api.icicibank.com/api/v1/upi",
			Mode:    "icici",
			Client:  &http.Client{Timeout: 15 * time.Second},
		}, nil
	}
	if key := os.Getenv("DECENTRO_CLIENT_ID"); key != "" {
		return &RealNPCIProvider{
			APIKey:  key,
			BaseURL: "https://in.decentro.tech/core_banking",
			Mode:    "decentro",
			Client:  &http.Client{Timeout: 15 * time.Second},
		}, nil
	}
	return nil, errors.New("no real NPCI credentials found: need SETU_API_KEY or ICICI_API_KEY or DECENTRO_CLIENT_ID")
}

// Setu Collect request — maps to our CollectRequest
type SetuCollectReq struct {
	Amount      int64  `json:"amount"` // paise
	UpiID       string `json:"upiId"`  // payer VPA
	PayeeName   string `json:"payeeName"`
	Note        string `json:"note"`
	Expiry      int    `json:"expiry"`      // seconds, 300 = 5 min like our simulation
	ReferenceID string `json:"referenceId"` // idempotency
}

type SetuCollectResp struct {
	PaymentLinkID string `json:"paymentLinkId"` // our paymentId
	UpiTxnID      string `json:"upiTxnId"`
	RRN           string `json:"rrn"`
	Status        string `json:"status"` // PENDING
	ExpiresAt     string `json:"expiresAt"`
}

// InitiateCollect via real bank — same interface as Mock, 1-line toggle
func (r *RealNPCIProvider) InitiateCollect(req CollectRequest) (*Payment, error) {
	if r.Mode == "setu" {
		return r.initiateSetu(req)
	}
	if r.Mode == "icici" {
		return r.initiateICICI(req)
	}
	return nil, fmt.Errorf("unsupported real mode %s", r.Mode)
}

func (r *RealNPCIProvider) initiateSetu(req CollectRequest) (*Payment, error) {
	if r.APIKey == "" {
		return nil, errors.New("SETU_API_KEY required")
	}
	// Map to Setu API
	setuReq := SetuCollectReq{
		Amount:      int64(req.AmountINR * 100), // INR to paise, same as our simulation
		UpiID:       req.PayerVPA,
		PayeeName:   "Green Valley Villas - AasthiChain",
		Note:        req.Note,
		Expiry:      300,
		ReferenceID: req.IdempotencyKey,
	}
	body, _ := json.Marshal(setuReq)
	httpReq, _ := http.NewRequest("POST", r.BaseURL+"/api/payment-links", bytes.NewBuffer(body))
	httpReq.Header.Set("x-api-key", r.APIKey)
	httpReq.Header.Set("Content-Type", "application/json")

	resp, err := r.Client.Do(httpReq)
	if err != nil {
		return nil, fmt.Errorf("setu api call failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 && resp.StatusCode != 201 {
		return nil, fmt.Errorf("setu collect failed: %d", resp.StatusCode)
	}

	var setuResp SetuCollectResp
	if err := json.NewDecoder(resp.Body).Decode(&setuResp); err != nil {
		return nil, err
	}

	// Map to our Payment struct — same fields as simulation
	now := time.Now()
	p := &Payment{
		PaymentID:        setuResp.PaymentLinkID,
		UpiTxnID:         setuResp.UpiTxnID,
		RRN:              setuResp.RRN,
		UTR:              GenerateUTR(setuResp.RRN), // UTR = IMPS+RRN+4-digit, same as simulation
		AssetID:          req.AssetID,
		TokenAmount:      req.TokenAmount,
		AmountINRPaise:   setuReq.Amount,
		AmountINR:        req.AmountINR,
		PayerVPA:         req.PayerVPA,
		PayeeVPA:         req.PayeeVPA,
		Note:             req.Note,
		Status:           StatusPending,
		CreatedAt:        now,
		ExpiresAt:        now.Add(5 * time.Minute),
		IdempotencyKey:   req.IdempotencyKey,
		IsSimulation:     false, // real!
	}
	return p, nil
}

func (r *RealNPCIProvider) initiateICICI(req CollectRequest) (*Payment, error) {
	// ICICI UPI Collect API — https://developer.icicibank.com
	type ICICIReq struct {
		PayerVPA      string `json:"payerVpa"`
		PayeeVPA      string `json:"payeeVpa"`
		Amount        string `json:"amount"`
		Note          string `json:"note"`
		MerchantTxnID string `json:"merchantTxnId"`
		Expiry        int    `json:"expiry"`
	}
	iciciReq := ICICIReq{
		PayerVPA:      req.PayerVPA,
		PayeeVPA:      req.PayeeVPA, // merchant VPA with ICICI, e.g., aasthichain@icici
		Amount:        fmt.Sprintf("%.2f", req.AmountINR),
		Note:          req.Note,
		MerchantTxnID: req.IdempotencyKey,
		Expiry:        5,
	}
	body, _ := json.Marshal(iciciReq)
	httpReq, _ := http.NewRequest("POST", r.BaseURL+"/collect", bytes.NewBuffer(body))
	httpReq.Header.Set("apikey", r.APIKey)
	httpReq.Header.Set("Content-Type", "application/json")

	resp, err := r.Client.Do(httpReq)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	var iciciResp struct {
		UpiTxnID string `json:"upiTxnId"`
		RRN      string `json:"rrn"`
		Status   string `json:"status"`
	}
	json.NewDecoder(resp.Body).Decode(&iciciResp)

	now := time.Now()
	return &Payment{
		PaymentID:      GeneratePaymentID(),
		UpiTxnID:       iciciResp.UpiTxnID,
		RRN:            iciciResp.RRN,
		UTR:            GenerateUTR(iciciResp.RRN),
		AssetID:        req.AssetID,
		TokenAmount:    req.TokenAmount,
		AmountINR:      req.AmountINR,
		AmountINRPaise: int64(req.AmountINR * 100),
		PayerVPA:       req.PayerVPA,
		PayeeVPA:       req.PayeeVPA,
		Status:         StatusPending,
		CreatedAt:      now,
		ExpiresAt:      now.Add(5 * time.Minute),
		IsSimulation:   false,
	}, nil
}

// GetPayment via real bank — check status by RRN or paymentId
func (r *RealNPCIProvider) GetPayment(paymentID string) (*Payment, error) {
	// Real implementation would call bank's status API
	// GET /api/payment-links/{id} or /upi/payments/{id}
	// For demo, return not implemented — would need webhook to update status
	return nil, errors.New("real GetPayment requires webhook — see /api/npci/callback handling")
}

// Webhook handler for real bank callbacks — same as our simulation callback
// Setu/ICICI will POST to https://aasthi-chain.vercel.app/api/npci/callback with RRN, UTR, status
// We update payment status and trigger Drunix Transfer

// Factory — toggle via env, same interface
func NewBalanceProviderFromEnv() BalanceProvider {
	if os.Getenv("NPCI_MODE") == "real" {
		// In real mode, balance check would call bank's account balance API
		// For now, return mock with high balance to allow demo — replace with real bank balance API
		return &MockBalanceProvider{Balances: map[string]int64{}}
	}
	return &MockBalanceProvider{Balances: map[string]int64{}}
}

// Example env for Vercel:
// NPCI_MODE=mock (default, hackathon, no creds)
// NPCI_MODE=real + SETU_API_KEY=xxx + SETU_BASE_URL=https://api.setu.co (production, requires business KYC)
