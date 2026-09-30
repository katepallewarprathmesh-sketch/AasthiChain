package drunix

import (
	_ "embed"
	"encoding/json"
	"math"
	"testing"
)

//go:embed fraudmodel/golden_vectors.json
var goldenJSON []byte

type goldenVector struct {
	Features              []float64 `json:"features"`
	ExpectedProbability   float64   `json:"expected_probability"`
	ExpectedContributions []float64 `json:"expected_contributions"`
}

type goldenFile struct {
	Model     string         `json:"model"`
	Tolerance float64        `json:"tolerance"`
	Vectors   []goldenVector `json:"vectors"`
}

// TestGoldenVectors is the test that matters. Everything else here checks
// behaviour; this one checks identity. 200 held-out inputs are scored by
// scikit-learn at training time, and the Go implementation must reproduce
// every probability AND every per-feature contribution to 1e-9.
//
// Without it, "we ported the model to Go" is an unverified claim — a port that
// is 99.9% right is a different model that happens to usually agree.
func TestGoldenVectors(t *testing.T) {
	var g goldenFile
	if err := json.Unmarshal(goldenJSON, &g); err != nil {
		t.Fatalf("golden vectors unreadable: %v", err)
	}
	m := Model()
	if g.Model != m.Name {
		t.Fatalf("golden vectors are for %q but the embedded model is %q — retrain or re-export", g.Model, m.Name)
	}
	if len(g.Vectors) == 0 {
		t.Fatal("no golden vectors")
	}

	tol := g.Tolerance
	if tol == 0 {
		tol = 1e-9
	}

	var worstProb, worstContrib float64
	for i, v := range g.Vectors {
		if len(v.Features) != len(m.Features) {
			t.Fatalf("vector %d has %d features, model expects %d", i, len(v.Features), len(m.Features))
		}
		got := m.Probability(v.Features)
		if d := math.Abs(got - v.ExpectedProbability); d > worstProb {
			worstProb = d
		}
		if math.Abs(got-v.ExpectedProbability) > tol {
			t.Errorf("vector %d: probability %.17g, sklearn said %.17g (diff %.3g)",
				i, got, v.ExpectedProbability, math.Abs(got-v.ExpectedProbability))
		}

		contribs := m.Contributions(v.Features)
		for j := range contribs {
			if d := math.Abs(contribs[j] - v.ExpectedContributions[j]); d > worstContrib {
				worstContrib = d
			}
			if math.Abs(contribs[j]-v.ExpectedContributions[j]) > tol {
				t.Errorf("vector %d feature %s: contribution %.17g, sklearn said %.17g",
					i, m.Features[j], contribs[j], v.ExpectedContributions[j])
			}
		}
	}
	t.Logf("%d vectors: worst probability diff %.3g, worst contribution diff %.3g",
		len(g.Vectors), worstProb, worstContrib)
}

// TestContributionsReconcile pins the property that makes the explanation
// trustworthy: the per-feature numbers shown to an analyst must add up to the
// score that was acted on. An explanation that does not reconcile is decoration.
func TestContributionsReconcile(t *testing.T) {
	var g goldenFile
	if err := json.Unmarshal(goldenJSON, &g); err != nil {
		t.Fatal(err)
	}
	m := Model()
	for i, v := range g.Vectors {
		sum := m.ExplainBase
		for _, c := range m.Contributions(v.Features) {
			sum += c
		}
		raw := m.RawScore(v.Features)
		if math.Abs(sum-raw) > 1e-9 {
			t.Fatalf("vector %d: contributions sum to %.17g but raw score is %.17g", i, sum, raw)
		}
	}
}

// TestFloat32Narrowing documents why f32 exists. sklearn compares float32
// feature values against float64 thresholds; dropping the narrowing changes
// real predictions, so this guards against someone "simplifying" it away.
func TestFloat32Narrowing(t *testing.T) {
	v := 0.1 + 0.2 // 0.30000000000000004 in float64
	if f32(v) == v {
		t.Fatal("f32 is not narrowing — sklearn parity will silently break")
	}
	if got, want := f32(1.0), 1.0; got != want {
		t.Fatalf("f32 must be exact for representable values, got %v", got)
	}
}

// TestModelIntegrity checks the embedded model is structurally sound rather
// than merely valid JSON.
func TestModelIntegrity(t *testing.T) {
	m := Model()
	if m.NTrees != len(m.Trees) {
		t.Fatalf("model claims %d trees, carries %d", m.NTrees, len(m.Trees))
	}
	if len(m.Features) == 0 {
		t.Fatal("model has no feature names")
	}
	if m.ThresholdBlock <= 0 || m.ThresholdBlock >= 1 {
		t.Fatalf("block threshold %v is not a probability", m.ThresholdBlock)
	}
	if m.ThresholdReview >= m.ThresholdBlock {
		t.Fatalf("review threshold %v must be below block threshold %v",
			m.ThresholdReview, m.ThresholdBlock)
	}
	for i, tr := range m.Trees {
		if len(tr.Feature) != len(tr.Value) || len(tr.Left) != len(tr.Right) {
			t.Fatalf("tree %d has ragged arrays", i)
		}
		for n := range tr.Feature {
			if tr.Left[n] == -1 {
				continue
			}
			if tr.Feature[n] < 0 || tr.Feature[n] >= len(m.Features) {
				t.Fatalf("tree %d node %d splits on feature %d, out of range", i, n, tr.Feature[n])
			}
		}
	}
}

// TestExtractFeaturesMatchesModelArity catches a feature added to Go but not
// to the training pipeline, or vice versa.
func TestExtractFeaturesMatchesModelArity(t *testing.T) {
	m := Model()
	x := ExtractFeatures(PaymentInput{AmountINR: 1000, PayerVPA: "a@b"},
		HistorySummary{KYCVerified: true}, 12)
	if len(x) != len(m.Features) {
		t.Fatalf("ExtractFeatures produced %d values, model expects %d (%v)",
			len(x), len(m.Features), m.Features)
	}
}

// TestScorePaymentMLBehaviour checks the decisions move in the right direction
// on clearly-separated cases.
func TestScorePaymentMLBehaviour(t *testing.T) {
	clean := ScorePaymentML(
		PaymentInput{AmountINR: 5000, PayerVPA: "ravi@okhdfcbank"},
		HistorySummary{TxnCount10m: 0, TxnCount24h: 1, TotalINR24h: 5000,
			RecentINR: []float64{4800}, AccountAgeMin: 200000, KYCVerified: true},
		14)
	if clean.Decision == DecisionBlock {
		t.Errorf("ordinary retail payment was blocked: score=%d factors=%+v", clean.Score, clean.Factors)
	}

	takeover := ScorePaymentML(
		PaymentInput{AmountINR: 480000, PayerVPA: "ravi@okhdfcbank"},
		HistorySummary{TxnCount10m: 9, TxnCount24h: 11, TotalINR24h: 900000,
			RecentINR:     []float64{9000, 18000, 40000, 90000, 200000},
			AccountAgeMin: 120000, KYCVerified: true},
		2)
	if takeover.Score <= clean.Score {
		t.Errorf("takeover pattern (%d) did not score above clean payment (%d)",
			takeover.Score, clean.Score)
	}

	// Policy override: an unverified payer is never silently approved.
	unverified := ScorePaymentML(
		PaymentInput{AmountINR: 2000, PayerVPA: "ravi@okhdfcbank"},
		HistorySummary{TxnCount10m: 0, TxnCount24h: 1, TotalINR24h: 2000,
			RecentINR: []float64{2000}, AccountAgeMin: 300000, KYCVerified: false},
		13)
	if unverified.Decision == DecisionApprove {
		t.Error("KYC-unverified payer was auto-approved; the policy override did not fire")
	}
}

// TestDeterminism — the same input must always produce the same decision.
// A fraud decision that varies between calls cannot be explained to a regulator.
func TestDeterminism(t *testing.T) {
	in := PaymentInput{AmountINR: 47000, PayerVPA: "x@okaxis"}
	h := HistorySummary{TxnCount10m: 2, TxnCount24h: 5, TotalINR24h: 180000,
		RecentINR: []float64{46000, 47500, 46500}, AccountAgeMin: 5000, KYCVerified: true}
	first := ScorePaymentML(in, h, 3)
	for i := 0; i < 50; i++ {
		if got := ScorePaymentML(in, h, 3); got.Score != first.Score || got.Decision != first.Decision {
			t.Fatalf("run %d differed: %d/%s vs %d/%s", i, got.Score, got.Decision, first.Score, first.Decision)
		}
	}
}
