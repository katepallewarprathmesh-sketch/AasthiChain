package drunix

// Serving side of the trained fraud model.
//
// The model is a gradient-boosted tree ensemble trained by ml/train.py and
// exported as plain arrays. Scoring walks the trees directly: no Python, no
// inference server, no ONNX runtime, ~microseconds per payment.
//
// Two details make this a faithful port rather than an approximation, and both
// are enforced by TestGoldenVectors:
//
//  1. FLOAT32 NARROWING. scikit-learn casts feature values to float32 inside
//     tree prediction and compares them against a float64 threshold. Comparing
//     in float64 flips rows whose value sits within a float32 ulp of a split
//     point — rare (2 in 2,000 during development) but wrong by ~0.74 in raw
//     score when it happens. float64(float32(x)) reproduces sklearn exactly.
//
//  2. EXPLANATION BASELINE. Per-feature contributions come from decision-path
//     attribution: the change in node value across a split is credited to the
//     feature that split there. Path deltas telescope to (leaf - root), so the
//     baseline an explanation is measured from is explain_base, which folds in
//     every tree's root value. contributions + explain_base == raw score,
//     exactly. That is what lets "why was this blocked" reconcile arithmetically
//     instead of being a plausible-sounding story.

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"math"
	"sort"
	"strings"
)

//go:embed fraudmodel/fraud_model.json
var fraudModelJSON []byte

type mlTree struct {
	Feature   []int     `json:"feature"`
	Threshold []float64 `json:"threshold"`
	Left      []int     `json:"left"`
	Right     []int     `json:"right"`
	Value     []float64 `json:"value"`
}

// FraudModel is the exported gradient-boosted ensemble.
type FraudModel struct {
	Name            string   `json:"name"`
	Kind            string   `json:"kind"`
	Explainer       string   `json:"explainer"`
	TrainedOn       string   `json:"trained_on"`
	DataCaveat      string   `json:"data_caveat"`
	Features        []string `json:"features"`
	BaseValue       float64  `json:"base_value"`
	ExplainBase     float64  `json:"explain_base"`
	LearningRate    float64  `json:"learning_rate"`
	NTrees          int      `json:"n_trees"`
	ThresholdBlock  float64  `json:"threshold_block"`
	ThresholdReview float64  `json:"threshold_review"`
	RowsTrained     int      `json:"rows_trained"`
	FraudRate       float64  `json:"fraud_rate"`
	Trees           []mlTree `json:"trees"`
}

var loadedModel *FraudModel

// Model returns the embedded model, parsed once.
func Model() *FraudModel {
	if loadedModel != nil {
		return loadedModel
	}
	m := &FraudModel{}
	if err := json.Unmarshal(fraudModelJSON, m); err != nil {
		panic("fraud model is embedded but unparseable: " + err.Error())
	}
	loadedModel = m
	return m
}

// f32 narrows to float32 and back, matching sklearn's internal cast. See note 1.
func f32(v float64) float64 { return float64(float32(v)) }

// RawScore returns the ensemble's log-odds output.
func (m *FraudModel) RawScore(x []float64) float64 {
	total := m.BaseValue
	for i := range m.Trees {
		t := &m.Trees[i]
		node := 0
		for t.Left[node] != -1 {
			if f32(x[t.Feature[node]]) <= t.Threshold[node] {
				node = t.Left[node]
			} else {
				node = t.Right[node]
			}
		}
		total += m.LearningRate * t.Value[node]
	}
	return total
}

// Probability converts the raw log-odds to a calibrated fraud probability.
func (m *FraudModel) Probability(x []float64) float64 {
	return 1.0 / (1.0 + math.Exp(-m.RawScore(x)))
}

// Contributions returns per-feature log-odds attribution. The sum plus
// ExplainBase equals RawScore exactly. See note 2.
func (m *FraudModel) Contributions(x []float64) []float64 {
	out := make([]float64, len(m.Features))
	for i := range m.Trees {
		t := &m.Trees[i]
		node := 0
		for t.Left[node] != -1 {
			f := t.Feature[node]
			var next int
			if f32(x[f]) <= t.Threshold[node] {
				next = t.Left[node]
			} else {
				next = t.Right[node]
			}
			out[f] += m.LearningRate * (t.Value[next] - t.Value[node])
			node = next
		}
	}
	return out
}

// ---------------------------------------------------------------------------
// Feature extraction — mirrors ml/features.py exactly. Order matters: it is
// aligned to the exported weight/tree feature indices.
// ---------------------------------------------------------------------------

const (
	structuringFloor = 45000.0
	structuringCeil  = 50000.0
)

func coeffVar(vals []float64) float64 {
	if len(vals) < 2 {
		return 0
	}
	var sum float64
	for _, v := range vals {
		sum += v
	}
	mean := sum / float64(len(vals))
	if mean <= 0 {
		return 0
	}
	var sq float64
	for _, v := range vals {
		sq += (v - mean) * (v - mean)
	}
	return math.Sqrt(sq/float64(len(vals))) / mean
}

// ExtractFeatures builds the model input from the same data the rules engine
// sees. hourOfDay is passed in rather than read from the clock so scoring is
// reproducible and testable.
func ExtractFeatures(in PaymentInput, h HistorySummary, hourOfDay int) []float64 {
	recent := h.RecentINR
	if len(recent) > 10 {
		recent = recent[:10]
	}
	var recentSum float64
	structCount := 0.0
	for _, a := range recent {
		recentSum += a
		if a > structuringFloor && a <= structuringCeil {
			structCount++
		}
	}
	recentMean := 0.0
	if len(recent) > 0 {
		recentMean = recentSum / float64(len(recent))
	}

	ratio := 1.0
	if recentMean > 0 {
		ratio = in.AmountINR / recentMean
	}

	amtInBand := 0.0
	if in.AmountINR > structuringFloor && in.AmountINR <= structuringCeil {
		amtInBand = 1.0
	}
	kycUnverified := 1.0
	if h.KYCVerified {
		kycUnverified = 0.0
	}
	isNight := 0.0
	if hourOfDay >= 0 && hourOfDay < 5 {
		isNight = 1.0
	}
	riskyVPA := 0.0
	vpa := strings.ToLower(in.PayerVPA)
	for _, frag := range riskyVpaFragments {
		if strings.Contains(vpa, frag) {
			riskyVPA = 1.0
			break
		}
	}
	newAcct := 0.0
	if h.AccountAgeMin < 1440 {
		newAcct = 1.0
	}
	cv := coeffVar(recent)
	tightness := cv
	if tightness > 1.0 {
		tightness = 1.0
	}

	return []float64{
		math.Log1p(math.Max(0, in.AmountINR)),  // log_amount
		amtInBand,                              // amount_in_structuring_band
		structCount,                            // recent_in_structuring_band
		cv,                                     // recent_amount_cv
		float64(h.TxnCount10m),                 // txn_count_10m
		float64(h.TxnCount24h),                 // txn_count_24h
		math.Log1p(math.Max(0, h.TotalINR24h)), // log_total_24h
		ratio,                                  // amount_vs_recent_mean
		math.Log1p(math.Max(0, float64(h.AccountAgeMin))), // log_account_age_min
		kycUnverified,                  // kyc_unverified
		isNight,                        // is_night
		riskyVPA,                       // risky_vpa_fragment
		float64(h.TxnCount10m) * ratio, // velocity_x_escalation
		float64(h.TxnCount10m) / (float64(h.TxnCount24h) + 1.0), // burstiness
		newAcct * math.Log1p(math.Max(0, in.AmountINR)),         // new_account_x_amount
		structCount * (1.0 - tightness),                         // structuring_x_tightness
	}
}

// ---------------------------------------------------------------------------
// Human-readable explanations
// ---------------------------------------------------------------------------

// featurePhrase turns a feature index and its input value into analyst-facing
// text. Kept next to the model so a feature can never be renamed without the
// explanation being updated with it.
func featurePhrase(name string, value float64) string {
	switch name {
	case "log_amount":
		return fmt.Sprintf("payment size ₹%.0f", math.Expm1(value))
	case "amount_in_structuring_band":
		if value > 0 {
			return "amount sits just under the ₹50,000 reporting line"
		}
		return "amount is not near the reporting line"
	case "recent_in_structuring_band":
		return fmt.Sprintf("%.0f recent payments just under the reporting line", value)
	case "recent_amount_cv":
		return fmt.Sprintf("spread of recent amounts (CV %.2f)", value)
	case "txn_count_10m":
		return fmt.Sprintf("%.0f payments in the last 10 minutes", value)
	case "txn_count_24h":
		return fmt.Sprintf("%.0f payments in the last 24 hours", value)
	case "log_total_24h":
		return fmt.Sprintf("₹%.0f moved in the last 24 hours", math.Expm1(value))
	case "amount_vs_recent_mean":
		return fmt.Sprintf("%.1fx the payer's recent average", value)
	case "log_account_age_min":
		return fmt.Sprintf("account age %.0f minutes", math.Expm1(value))
	case "kyc_unverified":
		if value > 0 {
			return "payer KYC is not verified"
		}
		return "payer KYC is verified"
	case "is_night":
		if value > 0 {
			return "payment made between 00:00 and 05:00"
		}
		return "payment made during normal hours"
	case "risky_vpa_fragment":
		if value > 0 {
			return "payer VPA contains a phishing-style fragment"
		}
		return "payer VPA looks ordinary"
	case "velocity_x_escalation":
		return fmt.Sprintf("burst activity with escalating amounts (index %.1f)", value)
	case "burstiness":
		return fmt.Sprintf("%.0f%% of the day's activity is in the last 10 minutes", value*100)
	case "new_account_x_amount":
		if value > 0 {
			return "large payment on an account less than a day old"
		}
		return "account is established"
	case "structuring_x_tightness":
		if value > 0 {
			return fmt.Sprintf("repeated near-identical amounts below the reporting line (index %.1f)", value)
		}
		return "no repeated near-threshold pattern"
	}
	return name
}

// ScorePaymentML screens a payment with the trained model.
//
// The model decides. The rules that remain are policy overrides, not scoring:
// a KYC-unverified payer or a phishing-style VPA cannot be waved through on a
// low model score, because those are compliance positions rather than
// statistical ones.
func ScorePaymentML(in PaymentInput, h HistorySummary, hourOfDay int) RiskResult {
	m := Model()
	x := ExtractFeatures(in, h, hourOfDay)
	prob := m.Probability(x)
	contribs := m.Contributions(x)

	type fc struct {
		idx int
		val float64
	}
	ranked := make([]fc, 0, len(contribs))
	for i, c := range contribs {
		ranked = append(ranked, fc{i, c})
	}
	sort.Slice(ranked, func(a, b int) bool {
		return math.Abs(ranked[a].val) > math.Abs(ranked[b].val)
	})

	factors := []RiskFactor{}
	for _, r := range ranked {
		if math.Abs(r.val) < 0.01 || len(factors) >= 5 {
			break
		}
		// Weight is the contribution in log-odds, scaled to a readable integer.
		factors = append(factors, RiskFactor{
			Code:   strings.ToUpper(m.Features[r.idx]),
			Note:   featurePhrase(m.Features[r.idx], x[r.idx]),
			Weight: int(math.Round(r.val * 100)),
		})
	}

	band, decision := BandLow, DecisionApprove
	switch {
	case prob >= m.ThresholdBlock:
		band, decision = BandHigh, DecisionBlock
	case prob >= m.ThresholdReview:
		band, decision = BandMedium, DecisionReview
	}

	// Policy overrides — compliance positions the model does not get to waive.
	if !h.KYCVerified && decision == DecisionApprove {
		band, decision = BandMedium, DecisionReview
		factors = append(factors, RiskFactor{"POLICY_KYC_REQUIRED",
			"held for review: payer KYC is not verified (policy, not model)", 0})
	}
	if x[11] > 0 && decision == DecisionApprove {
		band, decision = BandMedium, DecisionReview
		factors = append(factors, RiskFactor{"POLICY_RISKY_VPA",
			"held for review: payer VPA matches a phishing-style pattern (policy, not model)", 0})
	}

	if len(factors) == 0 {
		factors = append(factors, RiskFactor{"CLEAN",
			"no material risk signals — model probability below review threshold", 0})
	}

	return RiskResult{
		Score:    int(math.Round(prob * 100)),
		Band:     band,
		Decision: decision,
		Factors:  factors,
		Model:    m.Name,
	}
}
