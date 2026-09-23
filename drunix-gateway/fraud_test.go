package drunix

import (
	"testing"
	"time"
)

func benign() (PaymentInput, HistorySummary) {
	return PaymentInput{
			PaymentID: "NPCI-TEST1", PayerID: "investor1",
			PayerVPA: "demo.investor@aasthichain", PayeeVPA: "originator1@aasthichain",
			AmountINR: 60000, TokenAmount: 100, AssetID: "PROP-1",
			CreatedAt: time.Now(),
		},
		HistorySummary{TxnCount10m: 1, TxnCount24h: 2, TotalINR24h: 90000,
			AccountAgeMin: 100000, KYCVerified: true}
}

func TestBenignRetailApproved(t *testing.T) {
	in, h := benign()
	r := ScorePayment(in, h, DefaultThresholds())
	if r.Decision != DecisionApprove {
		t.Fatalf("benign payment decision = %s (%d), want APPROVE", r.Decision, r.Score)
	}
	if r.Score > 39 {
		t.Fatalf("benign score %d too high", r.Score)
	}
}

func TestStructuringFlagsReview(t *testing.T) {
	in, h := benign()
	in.AmountINR = 195000
	h.RecentINR = []float64{195000, 196000, 197000}
	r := ScorePayment(in, h, DefaultThresholds())
	found := false
	for _, f := range r.Factors {
		if f.Code == "STRUCTURING_PATTERN" {
			found = true
		}
	}
	if !found {
		t.Fatal("structuring not detected")
	}
	if r.Decision == DecisionApprove {
		t.Fatalf("structuring decision = APPROVE, want REVIEW/BLOCK (score %d)", r.Score)
	}
}

func TestVelocityBurstBlocks(t *testing.T) {
	in, h := benign()
	h.TxnCount10m = 9
	r := ScorePayment(in, h, DefaultThresholds())
	if r.Decision != DecisionBlock {
		t.Fatalf("velocity burst decision = %s, want BLOCK", r.Decision)
	}
}

func TestRiskyVPA(t *testing.T) {
	in, h := benign()
	in.PayerVPA = "fraudster99@bank"
	r := ScorePayment(in, h, DefaultThresholds())
	hit := false
	for _, f := range r.Factors {
		if f.Code == "RISKY_VPA_PATTERN" {
			hit = true
		}
	}
	if !hit || r.Score < 40 {
		t.Fatalf("risky VPA not scored: %+v", r)
	}
}

func TestUnverifiedKYC(t *testing.T) {
	in, h := benign()
	h.KYCVerified = false
	r := ScorePayment(in, h, DefaultThresholds())
	if r.Score < 25 {
		t.Fatalf("unverified KYC score %d, want >= 25", r.Score)
	}
}

func TestScoreClamped(t *testing.T) {
	in, h := benign()
	in.AmountINR = 900000
	in.PayerVPA = "scam@x"
	h.TxnCount10m = 20
	h.TotalINR24h = 5000000
	h.KYCVerified = false
	r := ScorePayment(in, h, DefaultThresholds())
	if r.Score > 100 {
		t.Fatalf("score %d not clamped", r.Score)
	}
	if r.Decision != DecisionBlock || r.Band != BandHigh {
		t.Fatalf("worst-case = %s/%s, want BLOCK/HIGH", r.Decision, r.Band)
	}
}
