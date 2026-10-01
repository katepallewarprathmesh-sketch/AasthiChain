package drunix

// Serving side of the trained fraud model.
//
// The shipped model is a logistic regression trained by ml/train.py and
// exported as 22 coefficients plus an intercept. Scoring is a dot product:
// microseconds, no Python, no inference server, no ONNX runtime.
//
// WHY LOGISTIC REGRESSION. A gradient-boosted tree scores higher on held-out
// synthetic data (test PR-AUC 0.923 vs 0.888, recall 0.950 vs 0.894). The
// linear model ships anyway because for a regulated payments decision it buys
// two things worth more than four points of recall:
//
//   - an exact additive explanation. contribution_i = feature_value_i *
//     coefficient_i, and those contributions plus the intercept equal the
//     logit exactly. "Why was this blocked" has an arithmetic answer that
//     reconciles, not a post-hoc attribution that approximately does.
//   - an artifact three languages can evaluate identically with no numerical
//     subtleties. The tree export needs float32 narrowing to match sklearn;
//     a dot product does not.
//
// The tree is still exported to ml/model/gbt_comparison.json and this file can
// load and score it, so the trade-off stays measurable rather than asserted.
// Point FRAUD_MODEL_PATH at that file to serve it instead.

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"math"
	"sort"
	"strings"
	"time"
)

//go:embed fraudmodel/fraud_model.json
var fraudModelJSON []byte

// SupportedSchemaVersion is the model-artifact format this build understands.
// Loading refuses a newer artifact rather than silently misreading it.
const SupportedSchemaVersion = 3

type mlTree struct {
	Feature   []int     `json:"feature"`
	Threshold []float64 `json:"threshold"`
	Left      []int     `json:"left"`
	Right     []int     `json:"right"`
	Value     []float64 `json:"value"`
}

// FraudModel is the exported artifact. One struct covers both kinds; which
// fields are populated depends on Kind.
type FraudModel struct {
	SchemaVersion   int      `json:"schema_version"`
	Name            string   `json:"name"`
	Kind            string   `json:"kind"`
	Explainer       string   `json:"explainer"`
	TrainedOn       string   `json:"trained_on"`
	DataCaveat      string   `json:"data_caveat"`
	Features        []string `json:"features"`
	ThresholdBlock  float64  `json:"threshold_block"`
	ThresholdReview float64  `json:"threshold_review"`

	// logistic_regression
	Coefficients []float64 `json:"coefficients"`
	Intercept    float64   `json:"intercept"`

	// gradient_boosted_trees
	BaseValue    float64  `json:"base_value"`
	ExplainBase  float64  `json:"explain_base"`
	LearningRate float64  `json:"learning_rate"`
	Trees        []mlTree `json:"trees"`
}

var loadedModel *FraudModel

// Model returns the embedded model, parsed once.
func Model() *FraudModel {
	if loadedModel != nil {
		return loadedModel
	}
	m, err := LoadModel(fraudModelJSON)
	if err != nil {
		panic("embedded fraud model is unusable: " + err.Error())
	}
	loadedModel = m
	return m
}

// LoadModel parses and validates an artifact. Validation is deliberately
// strict: a half-valid model that scores every payment as 0.5 is worse than
// one that refuses to load, because the first silently disables screening.
func LoadModel(raw []byte) (*FraudModel, error) {
	m := &FraudModel{}
	if err := json.Unmarshal(raw, m); err != nil {
		return nil, fmt.Errorf("unparseable: %w", err)
	}
	if m.SchemaVersion > SupportedSchemaVersion {
		return nil, fmt.Errorf("model schema v%d is newer than supported v%d — upgrade the gateway",
			m.SchemaVersion, SupportedSchemaVersion)
	}
	if len(m.Features) == 0 {
		return nil, fmt.Errorf("no feature names")
	}
	switch m.Kind {
	case "logistic_regression":
		if len(m.Coefficients) != len(m.Features) {
			return nil, fmt.Errorf("%d coefficients for %d features",
				len(m.Coefficients), len(m.Features))
		}
	case "gradient_boosted_trees":
		if len(m.Trees) == 0 {
			return nil, fmt.Errorf("tree model carries no trees")
		}
	default:
		return nil, fmt.Errorf("unknown model kind %q", m.Kind)
	}
	if m.ThresholdBlock <= 0 || m.ThresholdBlock >= 1 {
		return nil, fmt.Errorf("block threshold %v is not a probability", m.ThresholdBlock)
	}
	if m.ThresholdReview >= m.ThresholdBlock {
		return nil, fmt.Errorf("review threshold %v must sit below block threshold %v",
			m.ThresholdReview, m.ThresholdBlock)
	}
	return m, nil
}

// f32 narrows to float32 and back, matching sklearn's internal cast inside
// tree prediction. Only used by the tree path; the linear path needs no
// narrowing. Comparing in float64 flips rows whose value sits within a float32
// ulp of a split point — rare, but wrong by ~0.74 in raw score when it happens.
func f32(v float64) float64 { return float64(float32(v)) }

// RawScore returns the model's log-odds output.
func (m *FraudModel) RawScore(x []float64) float64 {
	if m.Kind == "logistic_regression" {
		total := m.Intercept
		for i, c := range m.Coefficients {
			total += c * x[i]
		}
		return total
	}
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

// Probability converts the raw log-odds to a fraud probability.
func (m *FraudModel) Probability(x []float64) float64 {
	return 1.0 / (1.0 + math.Exp(-m.RawScore(x)))
}

// Contributions returns per-feature log-odds attribution.
//
// For logistic regression this is exactly feature_value * coefficient, and
// sum(contributions) + Intercept == RawScore. For the tree model it is
// decision-path attribution and the baseline is ExplainBase instead.
func (m *FraudModel) Contributions(x []float64) []float64 {
	out := make([]float64, len(m.Features))
	if m.Kind == "logistic_regression" {
		for i, c := range m.Coefficients {
			out[i] = c * x[i]
		}
		return out
	}
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

// ExplanationBaseline is the value contributions are measured from.
func (m *FraudModel) ExplanationBaseline() float64 {
	if m.Kind == "logistic_regression" {
		return m.Intercept
	}
	return m.ExplainBase
}

// ---------------------------------------------------------------------------
// Feature extraction — mirrors ml/features.py exactly.
// ---------------------------------------------------------------------------

const (
	structuringFloor = 45000.0
	structuringCeil  = 50000.0
	newAccountMin    = 1440
	balanceRatioCap  = 20.0
)

// balanceRatio treats a zero balance as UNKNOWN rather than as an empty
// account. Dividing by (bal+1) returned the amount itself when the balance was
// missing -- a ratio of 47000 for a 47k payment -- which is far outside
// anything seen in training and made a missing balance the loudest term in
// every explanation. The cap stops one odd input from swamping the score.
func balanceRatio(amount, bal float64) float64 {
	if bal <= 0 {
		return 0
	}
	return math.Min(amount/bal, balanceRatioCap)
}

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

// safe collapses NaN/Inf to a defined value. A malformed payment must still
// produce a score: refusing to score looks identical to scoring zero at the
// call site, but only one of them lets the payment through.
func safe(v float64) float64 {
	if math.IsNaN(v) || math.IsInf(v, 0) {
		return 0
	}
	return v
}

// ExtractFeatures builds the model input. hourOfDay and dayOfWeek are passed
// in rather than read from the clock so a decision can be reproduced later.
func ExtractFeatures(in PaymentInput, h HistorySummary, hourOfDay, dayOfWeek int) []float64 {
	amount := math.Max(0, safe(in.AmountINR))
	recent := h.RecentINR
	if len(recent) > 10 {
		recent = recent[:10]
	}
	var recentSum, structCount float64
	clean := make([]float64, 0, len(recent))
	for _, a := range recent {
		a = safe(a)
		clean = append(clean, a)
		recentSum += a
		if a > structuringFloor && a <= structuringCeil {
			structCount++
		}
	}
	recentMean := 0.0
	if len(clean) > 0 {
		recentMean = recentSum / float64(len(clean))
	}
	ratio := 1.0
	if recentMean > 0 {
		ratio = amount / recentMean
	}
	cv := coeffVar(clean)
	tightness := math.Min(1.0, cv)

	bin := 0.0
	if amount > structuringFloor && amount <= structuringCeil {
		bin = 1.0
	}
	kycUnverified := 1.0
	if h.KYCVerified {
		kycUnverified = 0.0
	}
	isNight := 0.0
	if hourOfDay >= 0 && hourOfDay < 5 {
		isNight = 1.0
	}
	isWeekend := 0.0
	if dayOfWeek == 5 || dayOfWeek == 6 {
		isWeekend = 1.0
	}
	riskyVPA := 0.0
	vpa := strings.ToLower(in.PayerVPA)
	for _, frag := range riskyVpaFragments {
		if strings.Contains(vpa, frag) {
			riskyVPA = 1.0
			break
		}
	}
	benNew := 1.0
	if h.PayeeSeenBefore {
		benNew = 0.0
	}
	newAcct := 0.0
	if h.AccountAgeMin < newAccountMin {
		newAcct = 1.0
	}
	isTransfer := 0.0
	switch strings.ToUpper(h.TxnType) {
	case "TRANSFER", "CASH_OUT":
		isTransfer = 1.0
	}
	c10 := float64(h.TxnCount10m)
	c24 := float64(h.TxnCount24h)
	bal := math.Max(0, safe(h.BalanceBeforeINR))

	return []float64{
		math.Log1p(amount),              // log_amount
		bin,                             // amount_in_structuring_band
		balanceRatio(amount, bal),       // balance_ratio
		structCount,                     // recent_in_structuring_band
		cv,                              // recent_amount_cv
		structCount * (1.0 - tightness), // structuring_x_tightness
		c10,                             // txn_count_10m
		c24,                             // txn_count_24h
		math.Log1p(math.Max(0, safe(h.TotalINR24h))), // log_total_24h
		ratio,                        // amount_vs_recent_mean
		c10 / (c24 + 1.0),            // burstiness
		c10 * ratio,                  // velocity_x_escalation
		benNew,                       // beneficiary_is_new
		float64(h.DistinctPayees24h), // distinct_payees_24h
		float64(h.PayeeFanIn24h),     // payee_fan_in_24h
		math.Log1p(math.Max(0, float64(h.AccountAgeMin))), // log_account_age_min
		kycUnverified,                // kyc_unverified
		newAcct * math.Log1p(amount), // new_account_x_amount
		isNight,                      // is_night
		isWeekend,                    // is_weekend
		isTransfer,                   // is_transfer_type
		riskyVPA,                     // risky_vpa_fragment
	}
}

// ---------------------------------------------------------------------------
// Explanations
// ---------------------------------------------------------------------------

func featurePhrase(name string, value float64) string {
	switch name {
	case "log_amount":
		return fmt.Sprintf("payment size ₹%.0f", math.Expm1(value))
	case "amount_in_structuring_band":
		if value > 0 {
			return "amount sits just under the ₹50,000 reporting line"
		}
		return "amount is not near the reporting line"
	case "balance_ratio":
		return fmt.Sprintf("payment is %.0f%% of available balance", value*100)
	case "recent_in_structuring_band":
		return fmt.Sprintf("%.0f recent payments just under the reporting line", value)
	case "recent_amount_cv":
		return fmt.Sprintf("spread of recent amounts (CV %.2f)", value)
	case "structuring_x_tightness":
		if value > 0 {
			return fmt.Sprintf("repeated near-identical amounts below the reporting line (index %.1f)", value)
		}
		return "no repeated near-threshold pattern"
	case "txn_count_10m":
		return fmt.Sprintf("%.0f payments in the last 10 minutes", value)
	case "txn_count_24h":
		return fmt.Sprintf("%.0f payments in the last 24 hours", value)
	case "log_total_24h":
		return fmt.Sprintf("₹%.0f moved in the last 24 hours", math.Expm1(value))
	case "amount_vs_recent_mean":
		return fmt.Sprintf("%.1fx the payer's recent average", value)
	case "burstiness":
		return fmt.Sprintf("%.0f%% of the day's activity is in the last 10 minutes", value*100)
	case "velocity_x_escalation":
		return fmt.Sprintf("burst activity with escalating amounts (index %.1f)", value)
	case "beneficiary_is_new":
		if value > 0 {
			return "first ever payment to this beneficiary"
		}
		return "beneficiary has been paid before"
	case "distinct_payees_24h":
		return fmt.Sprintf("%.0f distinct beneficiaries in 24h (fan-out)", value)
	case "payee_fan_in_24h":
		return fmt.Sprintf("%.0f distinct payers into this beneficiary (fan-in)", value)
	case "log_account_age_min":
		return fmt.Sprintf("account age %.0f minutes", math.Expm1(value))
	case "kyc_unverified":
		if value > 0 {
			return "payer KYC is not verified"
		}
		return "payer KYC is verified"
	case "new_account_x_amount":
		if value > 0 {
			return "large payment on an account less than a day old"
		}
		return "account is established"
	case "is_night":
		if value > 0 {
			return "payment made between 00:00 and 05:00"
		}
		return "payment made during normal hours"
	case "is_weekend":
		if value > 0 {
			return "weekend payment"
		}
		return "weekday payment"
	case "is_transfer_type":
		if value > 0 {
			return "account-to-account transfer rather than a merchant collect"
		}
		return "ordinary merchant collect"
	case "risky_vpa_fragment":
		if value > 0 {
			return "payer VPA contains a phishing-style fragment"
		}
		return "payer VPA looks ordinary"
	}
	return name
}

// ScorePaymentML screens a payment with the trained model.
//
// RiskResult keeps its existing shape so current callers are unaffected; the
// model-specific detail is added in fields they can ignore.
//
// The model decides. The rules that remain are policy overrides, not scoring:
// an unverified payer or a phishing-style VPA is never auto-approved on a low
// model score, because those are compliance positions rather than statistical
// ones, and a model should not be able to outvote them because the numbers
// happened to look calm.
func ScorePaymentML(in PaymentInput, h HistorySummary, hourOfDay, dayOfWeek int) RiskResult {
	m := Model()
	x := ExtractFeatures(in, h, hourOfDay, dayOfWeek)
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
	sort.Slice(ranked, func(a, b int) bool { return ranked[a].val > ranked[b].val })

	var pos, neg []RiskFactor
	for _, r := range ranked {
		if r.val > 0.01 && len(pos) < 5 {
			pos = append(pos, RiskFactor{strings.ToUpper(m.Features[r.idx]),
				featurePhrase(m.Features[r.idx], x[r.idx]), int(math.Round(r.val * 100))})
		}
	}
	for i := len(ranked) - 1; i >= 0; i-- {
		r := ranked[i]
		if r.val < -0.01 && len(neg) < 5 {
			neg = append(neg, RiskFactor{strings.ToUpper(m.Features[r.idx]),
				featurePhrase(m.Features[r.idx], x[r.idx]), int(math.Round(r.val * 100))})
		}
	}

	band, decision := BandLow, DecisionApprove
	switch {
	case prob >= m.ThresholdBlock:
		band, decision = BandHigh, DecisionBlock
	case prob >= m.ThresholdReview:
		band, decision = BandMedium, DecisionReview
	}

	factors := append([]RiskFactor{}, pos...)
	if !h.KYCVerified && decision == DecisionApprove {
		band, decision = BandMedium, DecisionReview
		factors = append(factors, RiskFactor{"POLICY_KYC_REQUIRED",
			"held for review: payer KYC is not verified (policy, not model)", 0})
	}
	if x[21] > 0 && decision == DecisionApprove {
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

		Probability:       prob,
		ModelVersion:      fmt.Sprintf("%s (schema v%d)", m.Name, m.SchemaVersion),
		ModelKind:         m.Kind,
		Threshold:         m.ThresholdBlock,
		Baseline:          m.ExplanationBaseline(),
		TopPositive:       pos,
		TopNegative:       neg,
		DataCaveat:        m.DataCaveat,
		ExplainerNotation: m.Explainer,
	}
}

// ScorePaymentAuto is the drop-in used by the HTTP layer: the trained model
// when it loads, the original rules engine when it does not. A fraud engine
// that silently becomes a no-op is worse than one that is loudly degraded, so
// the fallback is reported in the result rather than hidden.
func ScorePaymentAuto(in PaymentInput, h HistorySummary, t Thresholds) (res RiskResult) {
	defer func() {
		if r := recover(); r != nil {
			res = ScorePayment(in, h, t)
			res.Model = res.Model + " [fallback: trained model unavailable]"
		}
	}()
	ts := in.CreatedAt
	if ts.IsZero() {
		ts = time.Now()
	}
	return ScorePaymentML(in, h, ts.Hour(), int(ts.Weekday()+6)%7)
}
