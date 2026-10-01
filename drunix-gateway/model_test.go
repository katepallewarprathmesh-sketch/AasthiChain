package drunix

import (
	_ "embed"
	"encoding/json"
	"math"
	"testing"
	"time"
)

//go:embed fraudmodel/golden_vectors.json
var goldenJSON []byte

type goldenVector struct {
	Features              []float64 `json:"features"`
	ExpectedLogit         float64   `json:"expected_logit"`
	ExpectedProbability   float64   `json:"expected_probability"`
	ExpectedContributions []float64 `json:"expected_contributions"`
}

type goldenFile struct {
	Model         string         `json:"model"`
	SchemaVersion int            `json:"schema_version"`
	Tolerance     float64        `json:"tolerance"`
	Vectors       []goldenVector `json:"vectors"`
}

func loadGolden(t *testing.T) goldenFile {
	t.Helper()
	var g goldenFile
	if err := json.Unmarshal(goldenJSON, &g); err != nil {
		t.Fatalf("golden vectors unreadable: %v", err)
	}
	if len(g.Vectors) == 0 {
		t.Fatal("no golden vectors")
	}
	return g
}

// TestGoldenVectors is the test that matters. The others check behaviour; this
// one checks identity. 200 held-out inputs scored by scikit-learn at training
// time, and Go must reproduce every logit, probability and per-feature
// contribution. Without it, "we ported the model to Go" is unverified: a port
// that is 99.9% right is a different model that usually agrees.
func TestGoldenVectors(t *testing.T) {
	g := loadGolden(t)
	m := Model()
	if g.Model != m.Name {
		t.Fatalf("golden vectors are for %q but the embedded model is %q — re-export", g.Model, m.Name)
	}
	tol := g.Tolerance
	if tol == 0 {
		tol = 1e-9
	}
	var worstP, worstC, worstL float64
	for i, v := range g.Vectors {
		if len(v.Features) != len(m.Features) {
			t.Fatalf("vector %d has %d features, model expects %d", i, len(v.Features), len(m.Features))
		}
		if d := math.Abs(m.RawScore(v.Features) - v.ExpectedLogit); d > worstL {
			worstL = d
		}
		p := m.Probability(v.Features)
		if d := math.Abs(p - v.ExpectedProbability); d > worstP {
			worstP = d
		}
		if math.Abs(p-v.ExpectedProbability) > tol {
			t.Errorf("vector %d: probability %.17g, sklearn said %.17g", i, p, v.ExpectedProbability)
		}
		for j, c := range m.Contributions(v.Features) {
			if d := math.Abs(c - v.ExpectedContributions[j]); d > worstC {
				worstC = d
			}
			if math.Abs(c-v.ExpectedContributions[j]) > tol {
				t.Errorf("vector %d feature %s: contribution %.17g, sklearn said %.17g",
					i, m.Features[j], c, v.ExpectedContributions[j])
			}
		}
	}
	t.Logf("%d vectors | worst logit %.3g, probability %.3g, contribution %.3g",
		len(g.Vectors), worstL, worstP, worstC)
}

// TestContributionsReconcile pins the property that makes the explanation
// trustworthy: the numbers shown to an analyst must add up to the score that
// was acted on. For logistic regression that identity is exact.
func TestContributionsReconcile(t *testing.T) {
	g := loadGolden(t)
	m := Model()
	for i, v := range g.Vectors {
		sum := m.ExplanationBaseline()
		for _, c := range m.Contributions(v.Features) {
			sum += c
		}
		if d := math.Abs(sum - m.RawScore(v.Features)); d > 1e-9 {
			t.Fatalf("vector %d: contributions + baseline = %.17g but raw score is %.17g (diff %.3g)",
				i, sum, m.RawScore(v.Features), d)
		}
	}
}

// TestContributionIsValueTimesCoefficient pins the exact notation the brief
// specifies for logistic regression.
func TestContributionIsValueTimesCoefficient(t *testing.T) {
	m := Model()
	if m.Kind != "logistic_regression" {
		t.Skipf("shipped model is %s", m.Kind)
	}
	g := loadGolden(t)
	v := g.Vectors[0]
	for i, c := range m.Contributions(v.Features) {
		want := m.Coefficients[i] * v.Features[i]
		if math.Abs(c-want) > 1e-12 {
			t.Fatalf("feature %s: got %v, expected value*coefficient = %v", m.Features[i], c, want)
		}
	}
}

// TestModelLoadingRejectsBadArtifacts — a model that half-loads and scores
// everything 0.5 silently disables fraud screening.
func TestModelLoadingRejectsBadArtifacts(t *testing.T) {
	cases := []struct {
		name string
		json string
	}{
		{"not json", `{nope`},
		{"unknown kind", `{"kind":"neural_net","features":["a"],"threshold_block":0.5,"threshold_review":0.2}`},
		{"coefficient arity mismatch", `{"kind":"logistic_regression","features":["a","b"],"coefficients":[1.0],"threshold_block":0.5,"threshold_review":0.2}`},
		{"no features", `{"kind":"logistic_regression","features":[],"coefficients":[],"threshold_block":0.5,"threshold_review":0.2}`},
		{"threshold not a probability", `{"kind":"logistic_regression","features":["a"],"coefficients":[1.0],"threshold_block":4,"threshold_review":0.2}`},
		{"review above block", `{"kind":"logistic_regression","features":["a"],"coefficients":[1.0],"threshold_block":0.3,"threshold_review":0.9}`},
		{"schema from the future", `{"schema_version":999,"kind":"logistic_regression","features":["a"],"coefficients":[1.0],"threshold_block":0.5,"threshold_review":0.2}`},
	}
	for _, c := range cases {
		if _, err := LoadModel([]byte(c.json)); err == nil {
			t.Errorf("%s: expected rejection, got none", c.name)
		}
	}
}

// TestModelVersionCompatibility — the current artifact must be loadable and
// must declare a schema this build understands.
func TestModelVersionCompatibility(t *testing.T) {
	m := Model()
	if m.SchemaVersion > SupportedSchemaVersion {
		t.Fatalf("embedded schema v%d exceeds supported v%d", m.SchemaVersion, SupportedSchemaVersion)
	}
	if m.Name == "" || m.Kind == "" {
		t.Fatal("model artifact must carry a name and kind for auditability")
	}
}

func TestExtractFeaturesMatchesModelArity(t *testing.T) {
	m := Model()
	x := ExtractFeatures(PaymentInput{AmountINR: 1000, PayerVPA: "a@b"},
		HistorySummary{KYCVerified: true}, 12, 2)
	if len(x) != len(m.Features) {
		t.Fatalf("ExtractFeatures produced %d values, model expects %d", len(x), len(m.Features))
	}
}

// TestMissingAndInvalidFeatures — a malformed payment must still produce a
// finite score. Refusing to score is indistinguishable from scoring zero at
// the call site, and one of those lets the payment through.
func TestMissingAndInvalidFeatures(t *testing.T) {
	cases := []struct {
		name string
		in   PaymentInput
		h    HistorySummary
	}{
		{"zero value everything", PaymentInput{}, HistorySummary{}},
		{"NaN amount", PaymentInput{AmountINR: math.NaN()}, HistorySummary{}},
		{"Inf amount", PaymentInput{AmountINR: math.Inf(1)}, HistorySummary{}},
		{"negative amount", PaymentInput{AmountINR: -5000}, HistorySummary{}},
		{"NaN in history", PaymentInput{AmountINR: 100}, HistorySummary{RecentINR: []float64{math.NaN(), 5}, TotalINR24h: math.NaN()}},
		{"negative account age", PaymentInput{AmountINR: 100}, HistorySummary{AccountAgeMin: -99}},
		{"more than ten recent", PaymentInput{AmountINR: 100}, HistorySummary{RecentINR: make([]float64, 50)}},
		{"empty vpa", PaymentInput{AmountINR: 100, PayerVPA: ""}, HistorySummary{}},
	}
	for _, c := range cases {
		x := ExtractFeatures(c.in, c.h, 12, 2)
		for i, v := range x {
			if math.IsNaN(v) || math.IsInf(v, 0) {
				t.Errorf("%s: feature %s is %v", c.name, Model().Features[i], v)
			}
		}
		r := ScorePaymentML(c.in, c.h, 12, 2)
		if r.Score < 0 || r.Score > 100 {
			t.Errorf("%s: score %d out of range", c.name, r.Score)
		}
		if math.IsNaN(r.Probability) {
			t.Errorf("%s: probability is NaN", c.name)
		}
	}
}

// TestExtremeAmounts — the score must stay bounded and monotone-ish across
// fifteen orders of magnitude.
func TestExtremeAmounts(t *testing.T) {
	for _, amt := range []float64{0, 1, 500, 1e5, 1e9, 1e15, math.MaxFloat64} {
		r := ScorePaymentML(PaymentInput{AmountINR: amt, PayerVPA: "a@okhdfcbank"},
			HistorySummary{KYCVerified: true, AccountAgeMin: 100000}, 12, 2)
		if r.Score < 0 || r.Score > 100 || math.IsNaN(r.Probability) {
			t.Fatalf("amount %g produced score %d probability %v", amt, r.Score, r.Probability)
		}
	}
}

// TestThresholdBehaviour — decisions must follow the published thresholds.
func TestThresholdBehaviour(t *testing.T) {
	m := Model()
	if m.ThresholdReview >= m.ThresholdBlock {
		t.Fatal("review threshold must sit below block threshold")
	}
	clean := ScorePaymentML(
		PaymentInput{AmountINR: 5000, PayerVPA: "ravi@okhdfcbank"},
		HistorySummary{TxnCount10m: 0, TxnCount24h: 1, TotalINR24h: 5000,
			RecentINR: []float64{4800}, AccountAgeMin: 200000, KYCVerified: true,
			PayeeSeenBefore: true, BalanceBeforeINR: 400000, TxnType: "COLLECT"}, 14, 2)
	if clean.Decision != DecisionApprove {
		t.Errorf("ordinary retail payment was not approved: %d %+v", clean.Score, clean.Factors)
	}
	mule := ScorePaymentML(
		PaymentInput{AmountINR: 450000, PayerVPA: "x@okaxis"},
		HistorySummary{TxnCount10m: 6, TxnCount24h: 7, TotalINR24h: 1500000,
			RecentINR: []float64{80000, 150000, 300000}, AccountAgeMin: 90,
			KYCVerified: false, PayeeFanIn24h: 22, DistinctPayees24h: 18,
			BalanceBeforeINR: 1000, TxnType: "TRANSFER"}, 3, 6)
	if mule.Score <= clean.Score {
		t.Errorf("mule pattern (%d) did not outscore clean payment (%d)", mule.Score, clean.Score)
	}
	if mule.Decision == DecisionApprove {
		t.Error("mule pattern was approved")
	}
}

// TestPolicyOverrides — compliance positions the model cannot waive.
func TestPolicyOverrides(t *testing.T) {
	unverified := ScorePaymentML(PaymentInput{AmountINR: 2000, PayerVPA: "ravi@okhdfcbank"},
		HistorySummary{TxnCount24h: 1, RecentINR: []float64{2000}, AccountAgeMin: 300000,
			KYCVerified: false, PayeeSeenBefore: true}, 13, 2)
	if unverified.Decision == DecisionApprove {
		t.Error("KYC-unverified payer was auto-approved")
	}
	phish := ScorePaymentML(PaymentInput{AmountINR: 2000, PayerVPA: "scamster99@okaxis"},
		HistorySummary{TxnCount24h: 1, RecentINR: []float64{2000}, AccountAgeMin: 300000,
			KYCVerified: true, PayeeSeenBefore: true}, 13, 2)
	if phish.Decision == DecisionApprove {
		t.Error("phishing-style VPA was auto-approved")
	}
}

// TestTopContributorsAreOrdered — the explanation must be ranked and signed
// correctly, or an analyst reads the wrong cause.
func TestTopContributorsAreOrdered(t *testing.T) {
	r := ScorePaymentML(PaymentInput{AmountINR: 47000, PayerVPA: "x@okaxis"},
		HistorySummary{TxnCount10m: 3, TxnCount24h: 6, TotalINR24h: 250000,
			RecentINR: []float64{46000, 47500, 46500}, AccountAgeMin: 5000,
			KYCVerified: true, TxnType: "TRANSFER", PayeeFanIn24h: 4}, 3, 1)
	for i := 1; i < len(r.TopPositive); i++ {
		if r.TopPositive[i].Weight > r.TopPositive[i-1].Weight {
			t.Error("positive contributors are not in descending order")
		}
	}
	for _, f := range r.TopPositive {
		if f.Weight <= 0 {
			t.Errorf("positive list contains non-positive weight %d (%s)", f.Weight, f.Code)
		}
	}
	for _, f := range r.TopNegative {
		if f.Weight >= 0 {
			t.Errorf("negative list contains non-negative weight %d (%s)", f.Weight, f.Code)
		}
	}
}

// TestDeterminism — a fraud decision that varies between calls cannot be
// explained to a regulator.
func TestDeterminism(t *testing.T) {
	in := PaymentInput{AmountINR: 47000, PayerVPA: "x@okaxis"}
	h := HistorySummary{TxnCount10m: 2, TxnCount24h: 5, TotalINR24h: 180000,
		RecentINR: []float64{46000, 47500, 46500}, AccountAgeMin: 5000, KYCVerified: true}
	first := ScorePaymentML(in, h, 3, 1)
	for i := 0; i < 50; i++ {
		got := ScorePaymentML(in, h, 3, 1)
		if got.Score != first.Score || got.Decision != first.Decision ||
			got.Probability != first.Probability {
			t.Fatalf("run %d differed", i)
		}
	}
}

// TestScorePaymentAutoKeepsContract — the HTTP layer swapped to the trained
// model; the original fields must still be populated.
func TestScorePaymentAutoKeepsContract(t *testing.T) {
	r := ScorePaymentAuto(
		PaymentInput{AmountINR: 5000, PayerVPA: "a@okhdfcbank", CreatedAt: time.Now()},
		HistorySummary{KYCVerified: true, AccountAgeMin: 100000, PayeeSeenBefore: true},
		DefaultThresholds())
	if r.Band == "" || r.Decision == "" || r.Model == "" || len(r.Factors) == 0 {
		t.Fatalf("RiskResult contract broken: %+v", r)
	}
}
