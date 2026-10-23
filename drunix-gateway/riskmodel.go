package drunix

// A model that was actually trained, rather than a rule sheet called AI.
//
// `fraud.go` scores a payment with hand-written rules: amount bands, velocity
// counts, structuring windows. Those rules are honest, explainable and were
// written by a person deciding what looks wrong. They are not machine
// learning, and labelling them as such is the kind of claim this repository
// exists to avoid.
//
// This file is the other thing: a logistic regression whose coefficients were
// fitted by gradient descent on a labelled dataset, evaluated on data it never
// saw, and shipped with the measurements attached. Inference is a dot product,
// so it runs in microseconds with no service to call, no key and no network.
//
// The limits are the important part, and they are carried in the model card
// inside the weights file as well as here:
//
//   - **The training data is synthetic.** Nobody has given this project real
//     labelled payment fraud, and inventing a number from real-looking data
//     would be worse than saying so. The generator is in cmd/trainrisk and is
//     documented in docs/RISK_MODEL.md. The reported accuracy therefore
//     describes performance on data from that generator, not on the world.
//   - **It is advisory.** The rules in fraud.go still decide. The model score
//     is reported alongside them, and where the two disagree the disagreement
//     is shown rather than resolved silently.
//   - **It is linear and small on purpose.** Every coefficient is readable,
//     every contribution to a score can be printed, and nothing about an
//     outcome has to be taken on faith. A bigger model would score slightly
//     better and explain itself much worse.
//   - **Retraining is reproducible.** The generator is seeded, so running the
//     trainer again produces the same weights, and a test checks that the
//     committed file is the file the trainer writes.

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"math"
	"sort"
	"strings"
	"time"
)

//go:embed riskmodel.json
var riskModelJSON []byte

// RiskFeature describes one input to the model, so the feature vector is
// self-documenting rather than a bare slice of numbers.
type RiskFeature struct {
	Name        string  `json:"name"`
	Description string  `json:"description"`
	Mean        float64 `json:"mean"`
	StdDev      float64 `json:"stdDev"`
	Weight      float64 `json:"weight"`
}

// RiskModelMetrics are measured on a held-out split, never on training data.
type RiskModelMetrics struct {
	AUC         float64 `json:"auc"`
	Accuracy    float64 `json:"accuracy"`
	Precision   float64 `json:"precision"`
	Recall      float64 `json:"recall"`
	F1          float64 `json:"f1"`
	Threshold   float64 `json:"threshold"`
	TrainRows   int     `json:"trainRows"`
	HoldoutRows int     `json:"holdoutRows"`
	Positives   float64 `json:"positiveRate"`
}

// RiskModel is the fitted classifier plus the card that makes it readable.
type RiskModel struct {
	Name      string        `json:"name"`
	Version   string        `json:"version"`
	Kind      string        `json:"kind"`
	TrainedAt string        `json:"trainedAt"`
	Seed      int64         `json:"seed"`
	Epochs    int           `json:"epochs"`
	LearnRate float64       `json:"learningRate"`
	L2        float64       `json:"l2"`
	Bias      float64       `json:"bias"`
	Features  []RiskFeature `json:"features"`

	Metrics RiskModelMetrics `json:"metrics"`

	DataSource string   `json:"dataSource"`
	Limits     []string `json:"limits"`
}

// RiskContribution is one feature's push on a single decision.
type RiskContribution struct {
	Feature      string  `json:"feature"`
	Value        float64 `json:"value"`
	Contribution float64 `json:"contribution"`
	Direction    string  `json:"direction"`
}

// ModelScore is one prediction, with the arithmetic behind it.
type ModelScore struct {
	Probability    float64            `json:"probability"`
	Score          int                `json:"score"`
	Band           string             `json:"band"`
	Model          string             `json:"model"`
	Threshold      float64            `json:"threshold"`
	AboveThreshold bool               `json:"aboveThreshold"`
	Contributions  []RiskContribution `json:"contributions"`
	Note           string             `json:"note"`
}

var loadedRiskModel *RiskModel

// LoadedRiskModel returns the embedded model, parsed once.
func LoadedRiskModel() (*RiskModel, error) {
	if loadedRiskModel != nil {
		return loadedRiskModel, nil
	}
	var m RiskModel
	if err := json.Unmarshal(riskModelJSON, &m); err != nil {
		return nil, fmt.Errorf("risk model: %w", err)
	}
	if len(m.Features) == 0 {
		return nil, fmt.Errorf("risk model: no features in the weights file")
	}
	loadedRiskModel = &m
	return loadedRiskModel, nil
}

// RiskFeatureNames fixes the order of the feature vector. The trainer and the
// server both read it from here, so the two cannot drift.
var RiskFeatureNames = []string{
	"log_amount",
	"amount_vs_recent_mean",
	"txn_count_10m",
	"txn_count_24h",
	"log_total_24h",
	"log_account_age_min",
	"kyc_verified",
	"near_threshold",
	"repeat_amount_share",
	"odd_hour",
	"kyc_tier_strength",
	"kyc_face_to_face",
	"log_kyc_age_days",
	"cap_pressure",
}

// RiskFeatureDescriptions explain each one in a sentence, for the model card
// and for anybody reading a score.
var RiskFeatureDescriptions = map[string]string{
	"log_amount":            "log of the payment amount in rupees",
	"amount_vs_recent_mean": "this amount divided by the payer's recent average, capped at 10",
	"txn_count_10m":         "payments by this payer in the last ten minutes",
	"txn_count_24h":         "payments by this payer in the last day",
	"log_total_24h":         "log of the payer's rupee total over the last day",
	"log_account_age_min":   "log of the account age in minutes",
	"kyc_verified":          "1 when KYC is complete, 0 otherwise",
	"near_threshold":        "how close the amount sits under a reporting threshold, 0 to 1",
	"repeat_amount_share":   "share of recent payments within 5 percent of this amount",
	"odd_hour":              "1 when the payment lands between midnight and five in the morning",
	"kyc_tier_strength":     "0 unknown or expired, 0.5 minimum KYC, 1 full KYC",
	"kyc_face_to_face":      "1 when the route that granted the tier was face-to-face equivalent",
	"log_kyc_age_days":      "log of the days since the identity was verified",
	"cap_pressure":          "this amount against the tier's per-payment ceiling, capped at 2",
}

// ExtractRiskFeatures turns a payment and the payer's history into the vector
// the model consumes. Exported because the trainer uses exactly this function:
// a feature computed one way in training and another way in production is the
// most common way a model quietly stops working.
func ExtractRiskFeatures(in PaymentInput, h HistorySummary) []float64 {
	amount := in.AmountINR
	if amount < 0 {
		amount = 0
	}

	recentMean := 0.0
	if len(h.RecentINR) > 0 {
		sum := 0.0
		for _, v := range h.RecentINR {
			sum += v
		}
		recentMean = sum / float64(len(h.RecentINR))
	}
	ratio := 1.0
	if recentMean > 0 {
		ratio = amount / recentMean
	}
	if ratio > 10 {
		ratio = 10
	}

	// Structuring: payments deliberately parked just under a reporting
	// threshold. One is nothing; it is the shape of a pattern that matters,
	// which is why repeat_amount_share sits next to it.
	near := 0.0
	for _, threshold := range []float64{50000, 200000, 1000000} {
		if amount > threshold*0.85 && amount <= threshold {
			if d := 1 - (threshold-amount)/(threshold*0.15); d > near {
				near = d
			}
		}
	}

	repeat := 0.0
	if len(h.RecentINR) > 0 && amount > 0 {
		same := 0
		for _, v := range h.RecentINR {
			if math.Abs(v-amount) <= amount*0.05 {
				same++
			}
		}
		repeat = float64(same) / float64(len(h.RecentINR))
	}

	kyc := 0.0
	if h.KYCVerified {
		kyc = 1
	}

	odd := 0.0
	if !in.CreatedAt.IsZero() {
		// Indian business hours: the payer's local clock is the one that
		// makes three in the morning unusual.
		hour := in.CreatedAt.In(indiaTZ()).Hour()
		if hour >= 0 && hour < 5 {
			odd = 1
		}
	}

	// Identity. The tier is the output of a verification route, so it
	// carries more than a yes or no: the route that produced it, how long
	// ago, and the ceiling it implies. A payment pressed hard against that
	// ceiling is the shape of someone using the whole of a small tier,
	// which is why cap_pressure is a feature rather than only a rule.
	tier := 0.0
	switch h.KYCTier {
	case KYCFull:
		tier = 1
	case KYCMinimal:
		tier = 0.5
	default:
		if h.KYCVerified {
			// An older caller that knows only the boolean. Treat it as the
			// weaker tier rather than the stronger one.
			tier = 0.5
		}
	}
	if h.KYCExpired {
		// A lapsed verification is not a weaker verification, it is none.
		tier = 0
	}

	f2f := 0.0
	if h.FaceToFace && !h.KYCExpired {
		f2f = 1
	}

	cap := h.PerPaymentCapINR
	if cap <= 0 {
		switch {
		case tier >= 1:
			cap = float64(fullKYCTransferCapPaise) / 100
		case tier > 0:
			cap = float64(minKYCTransferCapPaise) / 100
		}
	}
	pressure := 0.0
	if cap > 0 {
		pressure = amount / cap
		if pressure > 2 {
			pressure = 2
		}
	}

	return []float64{
		math.Log1p(amount),
		ratio,
		float64(h.TxnCount10m),
		float64(h.TxnCount24h),
		math.Log1p(h.TotalINR24h),
		math.Log1p(float64(h.AccountAgeMin)),
		kyc,
		near,
		repeat,
		odd,
		tier,
		f2f,
		math.Log1p(float64(h.KYCAgeDays)),
		pressure,
	}
}

func indiaTZ() *time.Location {
	if loc, err := time.LoadLocation("Asia/Kolkata"); err == nil {
		return loc
	}
	return time.FixedZone("IST", 5*3600+1800)
}

// PredictRisk scores one payment with the trained model and shows the three
// features that pushed hardest in each direction.
func PredictRisk(in PaymentInput, h HistorySummary) (*ModelScore, error) {
	m, err := LoadedRiskModel()
	if err != nil {
		return nil, err
	}
	x := ExtractRiskFeatures(in, h)
	if len(x) != len(m.Features) {
		return nil, fmt.Errorf("risk model: feature vector has %d values, the model expects %d",
			len(x), len(m.Features))
	}

	z := m.Bias
	contribs := make([]RiskContribution, 0, len(x))
	for i, f := range m.Features {
		sd := f.StdDev
		if sd == 0 {
			sd = 1
		}
		scaled := (x[i] - f.Mean) / sd
		c := scaled * f.Weight
		z += c
		dir := "lowers the score"
		if c > 0 {
			dir = "raises the score"
		}
		contribs = append(contribs, RiskContribution{
			Feature: f.Name, Value: x[i], Contribution: c, Direction: dir,
		})
	}
	p := 1 / (1 + math.Exp(-z))

	sort.SliceStable(contribs, func(i, j int) bool {
		return math.Abs(contribs[i].Contribution) > math.Abs(contribs[j].Contribution)
	})
	if len(contribs) > 4 {
		contribs = contribs[:4]
	}

	band := BandLow
	switch {
	case p >= 0.75:
		band = BandHigh
	case p >= 0.4:
		band = BandMedium
	}

	return &ModelScore{
		Probability:    math.Round(p*10000) / 10000,
		Score:          int(math.Round(p * 100)),
		Band:           band,
		Model:          m.Name + " " + m.Version,
		Threshold:      m.Metrics.Threshold,
		AboveThreshold: p >= m.Metrics.Threshold,
		Contributions:  contribs,
		Note: "Trained on synthetic data from a documented generator. The score is advisory: the " +
			"published rules decide, and this number is reported beside them.",
	}, nil
}

// RiskAssessment puts the rules and the model side by side, including when
// they disagree, which is the case a reviewer most needs to see.
type RiskAssessment struct {
	Rules      RiskResult  `json:"rules"`
	Model      *ModelScore `json:"model,omitempty"`
	Agreement  string      `json:"agreement"`
	Decision   string      `json:"decision"`
	DecidedBy  string      `json:"decidedBy"`
	ModelError string      `json:"modelError,omitempty"`
}

// AssessPayment runs both. The rules keep the decision: a model trained on
// synthetic data does not get to block anybody's money.
func AssessPayment(in PaymentInput, h HistorySummary, t Thresholds) RiskAssessment {
	rules := ScorePayment(in, h, t)
	out := RiskAssessment{
		Rules:     rules,
		Decision:  rules.Decision,
		DecidedBy: "published rules (fraud.go). The model is advisory and does not decide.",
	}
	model, err := PredictRisk(in, h)
	if err != nil {
		out.Agreement = "UNAVAILABLE"
		out.ModelError = err.Error()
		return out
	}
	out.Model = model

	rulesFlag := rules.Decision != DecisionApprove
	modelFlag := model.AboveThreshold
	switch {
	case rulesFlag && modelFlag:
		out.Agreement = "AGREE_RISKY"
	case !rulesFlag && !modelFlag:
		out.Agreement = "AGREE_CLEAN"
	case modelFlag && !rulesFlag:
		out.Agreement = "MODEL_ONLY"
	default:
		out.Agreement = "RULES_ONLY"
	}
	return out
}

// RiskModelCard is the published description of the model, for an endpoint
// and for anybody who wants to know what they are being scored by.
func RiskModelCard() map[string]interface{} {
	m, err := LoadedRiskModel()
	if err != nil {
		return map[string]interface{}{"available": false, "error": err.Error()}
	}
	weights := make([]map[string]interface{}, 0, len(m.Features))
	for _, f := range m.Features {
		weights = append(weights, map[string]interface{}{
			"feature":     f.Name,
			"means":       f.Description,
			"coefficient": math.Round(f.Weight*10000) / 10000,
		})
	}
	return map[string]interface{}{
		"available":  true,
		"name":       m.Name,
		"version":    m.Version,
		"kind":       m.Kind,
		"trainedAt":  m.TrainedAt,
		"dataSource": m.DataSource,
		"metrics":    m.Metrics,
		"weights":    weights,
		"limits":     m.Limits,
		"retrain":    "go run ./cmd/trainrisk writes drunix-gateway/riskmodel.json. The generator is seeded, so the result is reproducible.",
		"summary": fmt.Sprintf("%s, %d features, fitted by gradient descent. Held-out AUC %.3f on %d rows it never saw. %s",
			m.Kind, len(m.Features), m.Metrics.AUC, m.Metrics.HoldoutRows, strings.Join(m.Limits[:1], "")),
	}
}
