package drunix

import (
	"fmt"
	"strings"
	"time"
)

// AI & Fraud Detection (hackathon theme) — transparent, rule-first risk scoring
// for UPI Collect payments on the tokenization flow. Deterministic and
// explainable: every factor carries its weight so decisions are auditable by a
// regulator. The interface is ML-pluggable (FAQ 9): a trained model can replace
// ScorePayment without changing callers (Open/Closed).

// Decision constants.
const (
	DecisionApprove = "APPROVE"
	DecisionReview  = "REVIEW"
	DecisionBlock   = "BLOCK"

	BandLow    = "LOW"
	BandMedium = "MEDIUM"
	BandHigh   = "HIGH"
)

// Thresholds — exported so /fraud/config can expose them (transparency) and
// tests / operators can tune without touching logic.
type Thresholds struct {
	BlockScore        int     `json:"blockScore"`   // >= BLOCK
	ReviewScore       int     `json:"reviewScore"`  // >= REVIEW
	HighValueINR      float64 `json:"highValueINR"` // single-txn high value
	ElevatedValueINR  float64 `json:"elevatedValueINR"`
	StructuringFloor  float64 `json:"structuringFloor"` // just-below band lower edge
	StructuringCeil   float64 `json:"structuringCeil"`  // just-below band upper edge
	StructuringCount  int     `json:"structuringCount"`
	Velocity10mBlock  int     `json:"velocity10mBlock"`
	Velocity10mWarn   int     `json:"velocity10mWarn"`
	Total24hINR       float64 `json:"total24hINR"`
	NewAccountMin     int     `json:"newAccountMinutes"`
	NewAccountHighINR float64 `json:"newAccountHighINR"`
}

// DefaultThresholds are conservative so genuine retail buyers are never blocked.
func DefaultThresholds() Thresholds {
	return Thresholds{
		BlockScore:        70,
		ReviewScore:       40,
		HighValueINR:      500000, // ₹5L single transaction
		ElevatedValueINR:  200000, // ₹2L
		StructuringFloor:  180000,
		StructuringCeil:   200000,
		StructuringCount:  3,
		Velocity10mBlock:  8,
		Velocity10mWarn:   5,
		Total24hINR:       1000000, // ₹10L per day
		NewAccountMin:     30,
		NewAccountHighINR: 100000,
	}
}

// PaymentInput describes the payment being screened.
type PaymentInput struct {
	PaymentID   string    `json:"paymentId"`
	PayerID     string    `json:"payerId"`
	PayerVPA    string    `json:"payerVpa"`
	PayeeVPA    string    `json:"payeeVpa"`
	AmountINR   float64   `json:"amountINR"`
	TokenAmount int       `json:"tokenAmount"`
	AssetID     string    `json:"assetId"`
	CreatedAt   time.Time `json:"createdAt"`
}

// HistorySummary is the payer's recent activity (from the payments store).
type HistorySummary struct {
	TxnCount10m   int       `json:"txnCount10m"`
	TxnCount24h   int       `json:"txnCount24h"`
	TotalINR24h   float64   `json:"totalINR24h"`
	RecentINR     []float64 `json:"recentINR"` // amounts of last 10 txns, newest first
	AccountAgeMin int       `json:"accountAgeMin"`
	KYCVerified   bool      `json:"kycVerified"`
}

// RiskFactor is one contributing signal with its weight (explainability).
type RiskFactor struct {
	Code   string `json:"code"`
	Note   string `json:"note"`
	Weight int    `json:"weight"`
}

// RiskResult is the screening outcome attached to the payment record.
type RiskResult struct {
	Score    int          `json:"score"`
	Band     string       `json:"band"`
	Decision string       `json:"decision"`
	Factors  []RiskFactor `json:"factors"`
	Model    string       `json:"model"`
}

func clampScore(n int) int {
	if n < 0 {
		return 0
	}
	if n > 100 {
		return 100
	}
	return n
}

var riskyVpaFragments = []string{"fraud", "scam", "thief", "steal", "phish", "xxx", "darkweb"}

// ScorePayment screens one payment. Pure function — no I/O, fully testable.
func ScorePayment(in PaymentInput, h HistorySummary, t Thresholds) RiskResult {
	factors := []RiskFactor{}
	score := 0

	// 1. Value anomaly
	switch {
	case in.AmountINR > t.HighValueINR:
		score += 30
		factors = append(factors, RiskFactor{"HIGH_VALUE", fmt.Sprintf("₹%.0f exceeds high-value threshold ₹%.0f", in.AmountINR, t.HighValueINR), 30})
	case in.AmountINR > t.ElevatedValueINR:
		score += 15
		factors = append(factors, RiskFactor{"ELEVATED_VALUE", fmt.Sprintf("₹%.0f above usual retail band", in.AmountINR), 15})
	}

	// 2. Structuring — repeated just-below-threshold amounts (AML signal)
	band := 0
	for _, a := range h.RecentINR {
		if a > t.StructuringFloor && a <= t.StructuringCeil {
			band++
		}
	}
	if in.AmountINR > t.StructuringFloor && in.AmountINR <= t.StructuringCeil {
		band++
	}
	if band >= t.StructuringCount {
		score += 40
		factors = append(factors, RiskFactor{"STRUCTURING_PATTERN", fmt.Sprintf("%d transactions just below ₹%.0f reporting band", band, t.StructuringCeil), 40})
	}

	// 3. Velocity — burst activity
	if h.TxnCount10m >= t.Velocity10mBlock {
		score += 70
		factors = append(factors, RiskFactor{"VELOCITY_BURST", fmt.Sprintf("%d payments in 10 minutes", h.TxnCount10m), 70})
	} else if h.TxnCount10m >= t.Velocity10mWarn {
		score += 40
		factors = append(factors, RiskFactor{"VELOCITY_ELEVATED", fmt.Sprintf("%d payments in 10 minutes", h.TxnCount10m), 40})
	}

	// 4. Daily exposure
	if h.TotalINR24h+in.AmountINR > t.Total24hINR {
		score += 20
		factors = append(factors, RiskFactor{"DAILY_EXPOSURE", fmt.Sprintf("24h total ₹%.0f would exceed ₹%.0f", h.TotalINR24h+in.AmountINR, t.Total24hINR), 20})
	}

	// 5. Risky VPA pattern (phishing-style handles)
	vpa := strings.ToLower(in.PayerVPA)
	for _, frag := range riskyVpaFragments {
		if strings.Contains(vpa, frag) {
			score += 40
			factors = append(factors, RiskFactor{"RISKY_VPA_PATTERN", "payer VPA contains a known phishing-style fragment: " + frag, 40})
			break
		}
	}

	// 6. Handle mimicry — same local part, different bank (lookalike handle)
	if i := strings.Index(in.PayeeVPA, "@"); i > 0 {
		local := strings.ToLower(in.PayeeVPA[:i])
		payerLocal := vpa
		if j := strings.Index(vpa, "@"); j > 0 {
			payerLocal = vpa[:j]
		}
		if local == payerLocal && !strings.EqualFold(in.PayerVPA, in.PayeeVPA) {
			score += 15
			factors = append(factors, RiskFactor{"HANDLE_MIMIC", "payer and payee share a lookalike handle on different banks", 15})
		}
	}

	// 7. New account + high value
	if !h.KYCVerified {
		score += 25
		factors = append(factors, RiskFactor{"KYC_NOT_VERIFIED", "payer KYC is not verified", 25})
	}
	if h.AccountAgeMin > 0 && h.AccountAgeMin < t.NewAccountMin && in.AmountINR > t.NewAccountHighINR {
		score += 20
		factors = append(factors, RiskFactor{"NEW_ACCOUNT_HIGH_VALUE", fmt.Sprintf("account age %d min with ₹%.0f payment", h.AccountAgeMin, in.AmountINR), 20})
	}

	// 8. Odd hours + elevated value
	hour := time.Now().Hour()
	if hour >= 0 && hour < 5 && in.AmountINR > t.ElevatedValueINR {
		score += 10
		factors = append(factors, RiskFactor{"ODD_HOURS", "high-value payment between 00:00-05:00", 10})
	}

	score = clampScore(score)
	riskBand, decision := BandLow, DecisionApprove
	switch {
	case score >= t.BlockScore:
		riskBand, decision = BandHigh, DecisionBlock
	case score >= t.ReviewScore:
		riskBand, decision = BandMedium, DecisionReview
	}
	if len(factors) == 0 {
		factors = append(factors, RiskFactor{"CLEAN", "no risk signals — pattern matches genuine retail purchase", 0})
	}
	return RiskResult{Score: score, Band: riskBand, Decision: decision, Factors: factors, Model: "aasthichain-rules-v1 (ML-pluggable)"}
}
