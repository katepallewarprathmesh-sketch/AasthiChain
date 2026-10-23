package drunix

import (
	"math"
	"testing"
	"time"
)

func cleanPayment() (PaymentInput, HistorySummary) {
	in := PaymentInput{
		PaymentID: "PAY-CLEAN",
		PayerID:   "investor1",
		AmountINR: 42000,
		CreatedAt: time.Date(2026, 6, 1, 8, 30, 0, 0, time.UTC), // 2pm IST
	}
	h := HistorySummary{
		TxnCount10m:   0,
		TxnCount24h:   1,
		TotalINR24h:   86000,
		RecentINR:     []float64{38000, 44000, 51000, 36000},
		AccountAgeMin: 400000,
		KYCVerified:   true,
	}
	return in, h
}

func structuringPayment() (PaymentInput, HistorySummary) {
	in := PaymentInput{
		PaymentID: "PAY-STRUCT",
		PayerID:   "investor9",
		AmountINR: 48500,                                        // parked just under the 50,000 line
		CreatedAt: time.Date(2026, 6, 1, 21, 0, 0, 0, time.UTC), // 2:30am IST
	}
	h := HistorySummary{
		TxnCount10m:   6,
		TxnCount24h:   17,
		TotalINR24h:   790000,
		RecentINR:     []float64{48000, 48900, 47800, 49100, 48200, 48700},
		AccountAgeMin: 90,
		KYCVerified:   false,
	}
	return in, h
}

func TestRiskModelLoads(t *testing.T) {
	m, err := LoadedRiskModel()
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if len(m.Features) != len(RiskFeatureNames) {
		t.Fatalf("model has %d features, the extractor produces %d", len(m.Features), len(RiskFeatureNames))
	}
	for i, f := range m.Features {
		if f.Name != RiskFeatureNames[i] {
			t.Fatalf("feature %d is %q in the weights file and %q in the extractor", i, f.Name, RiskFeatureNames[i])
		}
		if f.Description == "" {
			t.Fatalf("feature %q has no description, so the model card cannot explain it", f.Name)
		}
		if f.StdDev <= 0 {
			t.Fatalf("feature %q has a non-positive standard deviation", f.Name)
		}
	}
	if m.Bias == 0 {
		t.Fatal("bias is zero, which means the weights file was never fitted")
	}
}

// The metrics must be present and honest: good enough to be worth shipping,
// and short of perfect, because a perfect score on synthetic data means the
// generator was too easy rather than the model being good.
func TestRiskModelMetricsAreMeasuredAndPlausible(t *testing.T) {
	m, _ := LoadedRiskModel()
	mm := m.Metrics
	if mm.HoldoutRows < 500 {
		t.Fatalf("held-out split is only %d rows", mm.HoldoutRows)
	}
	if mm.TrainRows < mm.HoldoutRows {
		t.Fatalf("training split (%d) is smaller than the held-out split (%d)", mm.TrainRows, mm.HoldoutRows)
	}
	if mm.AUC < 0.7 {
		t.Fatalf("held-out AUC %.3f is too weak to publish", mm.AUC)
	}
	if mm.AUC > 0.99 {
		t.Fatalf("held-out AUC %.3f is implausible: the generator is separating the classes for the model", mm.AUC)
	}
	if mm.Precision <= 0 || mm.Recall <= 0 || mm.F1 <= 0 {
		t.Fatal("precision, recall and F1 must all be measured")
	}
	if mm.Threshold <= 0 || mm.Threshold >= 1 {
		t.Fatalf("operating threshold %.2f is not a probability", mm.Threshold)
	}
}

// The card must say out loud that the data is synthetic. This is the honesty
// rule for the whole repository, enforced here so it cannot quietly lapse.
func TestRiskModelDeclaresSyntheticData(t *testing.T) {
	m, _ := LoadedRiskModel()
	if m.DataSource == "" || !contains(m.DataSource, "ynthetic") {
		t.Fatalf("data source must declare that the training data is synthetic, got %q", m.DataSource)
	}
	if len(m.Limits) < 3 {
		t.Fatalf("expected the limits of the model to be published, got %d", len(m.Limits))
	}
	card := RiskModelCard()
	if card["available"] != true {
		t.Fatalf("model card unavailable: %v", card)
	}
	if _, ok := card["metrics"]; !ok {
		t.Fatal("model card must publish its metrics")
	}
}

func TestPredictSeparatesCleanFromStructured(t *testing.T) {
	cleanIn, cleanH := cleanPayment()
	clean, err := PredictRisk(cleanIn, cleanH)
	if err != nil {
		t.Fatalf("predict clean: %v", err)
	}
	badIn, badH := structuringPayment()
	bad, err := PredictRisk(badIn, badH)
	if err != nil {
		t.Fatalf("predict structured: %v", err)
	}
	if !(bad.Probability > clean.Probability) {
		t.Fatalf("structuring scored %.3f and the ordinary payment %.3f", bad.Probability, clean.Probability)
	}
	if bad.Probability < 0.5 {
		t.Fatalf("a six-payment structuring burst from a 90 minute old unverified account scored only %.3f", bad.Probability)
	}
	if clean.Probability > 0.4 {
		t.Fatalf("an ordinary verified payment scored %.3f", clean.Probability)
	}
	if len(bad.Contributions) == 0 {
		t.Fatal("a score with no explanation is not usable by a reviewer")
	}
	if bad.Note == "" || !contains(bad.Note, "advisory") {
		t.Fatalf("every score must repeat that it is advisory, got %q", bad.Note)
	}
}

// Deterministic: the same payment must score the same every time, or an
// audit of a past decision is meaningless.
func TestPredictIsDeterministic(t *testing.T) {
	in, h := structuringPayment()
	first, _ := PredictRisk(in, h)
	for i := 0; i < 20; i++ {
		again, _ := PredictRisk(in, h)
		if again.Probability != first.Probability {
			t.Fatalf("same input scored %.6f then %.6f", first.Probability, again.Probability)
		}
	}
}

func TestExtractFeaturesHandlesEmptyHistory(t *testing.T) {
	x := ExtractRiskFeatures(PaymentInput{AmountINR: 10000}, HistorySummary{})
	if len(x) != len(RiskFeatureNames) {
		t.Fatalf("got %d features, want %d", len(x), len(RiskFeatureNames))
	}
	for i, v := range x {
		if math.IsNaN(v) || math.IsInf(v, 0) {
			t.Fatalf("feature %s is %v on an empty history", RiskFeatureNames[i], v)
		}
	}
	// A negative amount must not produce a negative logarithm.
	neg := ExtractRiskFeatures(PaymentInput{AmountINR: -5000}, HistorySummary{})
	if neg[0] != 0 {
		t.Fatalf("negative amount produced log feature %v", neg[0])
	}
}

func TestNearThresholdOnlyFiresUnderTheLine(t *testing.T) {
	under := ExtractRiskFeatures(PaymentInput{AmountINR: 49500}, HistorySummary{})[7]
	over := ExtractRiskFeatures(PaymentInput{AmountINR: 52000}, HistorySummary{})[7]
	far := ExtractRiskFeatures(PaymentInput{AmountINR: 12000}, HistorySummary{})[7]
	if under <= 0.8 {
		t.Fatalf("49,500 against a 50,000 threshold scored %.3f", under)
	}
	if over != 0 || far != 0 {
		t.Fatalf("amounts away from a threshold must score 0, got over=%.3f far=%.3f", over, far)
	}
}

// The model must never take the decision away from the published rules.
func TestAssessKeepsTheRulesInCharge(t *testing.T) {
	in, h := cleanPayment()
	a := AssessPayment(in, h, DefaultThresholds())
	if a.Decision != a.Rules.Decision {
		t.Fatalf("assessment decided %q but the rules said %q", a.Decision, a.Rules.Decision)
	}
	if a.Model == nil {
		t.Fatal("the model score should accompany the rules")
	}
	if !contains(a.DecidedBy, "rules") {
		t.Fatalf("decidedBy must name the rules, got %q", a.DecidedBy)
	}

	badIn, badH := structuringPayment()
	b := AssessPayment(badIn, badH, DefaultThresholds())
	if b.Decision != b.Rules.Decision {
		t.Fatal("the model changed the decision on a risky payment")
	}
	switch b.Agreement {
	case "AGREE_RISKY", "AGREE_CLEAN", "MODEL_ONLY", "RULES_ONLY":
	default:
		t.Fatalf("unexpected agreement value %q", b.Agreement)
	}
}

func contains(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}

// The identity half of the model, added when AMA item 13 was closed. Until
// then the screening path sent KYCVerified: true for every payer, so these
// tests exist to stop that from quietly coming back.

func featureIndex(t *testing.T, name string) int {
	t.Helper()
	for i, n := range RiskFeatureNames {
		if n == name {
			return i
		}
	}
	t.Fatalf("no feature called %q", name)
	return -1
}

func TestIdentityFeaturesReflectTheTier(t *testing.T) {
	in := PaymentInput{AmountINR: 9000, CreatedAt: time.Date(2026, 6, 1, 11, 0, 0, 0, time.UTC)}

	full := ExtractRiskFeatures(in, HistorySummary{
		KYCTier: KYCFull, KYCVerified: true, FaceToFace: true, KYCAgeDays: 400,
		PerPaymentCapINR: 100000,
	})
	minimal := ExtractRiskFeatures(in, HistorySummary{
		KYCTier: KYCMinimal, KYCVerified: true, KYCAgeDays: 0, PerPaymentCapINR: 10000,
	})
	unknown := ExtractRiskFeatures(in, HistorySummary{})

	ti := featureIndex(t, "kyc_tier_strength")
	if !(full[ti] > minimal[ti] && minimal[ti] > unknown[ti]) {
		t.Fatalf("tier strength should order full > minimum > unknown, got %v %v %v",
			full[ti], minimal[ti], unknown[ti])
	}

	fi := featureIndex(t, "kyc_face_to_face")
	if full[fi] != 1 || minimal[fi] != 0 {
		t.Fatalf("face-to-face flag wrong: full=%v minimal=%v", full[fi], minimal[fi])
	}

	ai := featureIndex(t, "log_kyc_age_days")
	if !(full[ai] > minimal[ai]) {
		t.Fatalf("an identity held for 400 days should read older than one verified today")
	}

	// The same rupees press much harder against the smaller ceiling, which
	// is the point of combining KYC with the model rather than reporting
	// them side by side.
	ci := featureIndex(t, "cap_pressure")
	if !(minimal[ci] > full[ci]) {
		t.Fatalf("cap pressure should be higher under the minimum-KYC ceiling, got %v vs %v",
			minimal[ci], full[ci])
	}
	if unknown[ci] != 0 {
		t.Fatalf("an unknown tier implies no ceiling, so no pressure, got %v", unknown[ci])
	}
}

func TestExpiredVerificationCountsAsNone(t *testing.T) {
	in := PaymentInput{AmountINR: 9000, CreatedAt: time.Date(2026, 6, 1, 11, 0, 0, 0, time.UTC)}
	live := ExtractRiskFeatures(in, HistorySummary{KYCTier: KYCFull, KYCVerified: true, FaceToFace: true})
	lapsed := ExtractRiskFeatures(in, HistorySummary{KYCTier: KYCFull, KYCVerified: true, FaceToFace: true, KYCExpired: true})

	ti, fi := featureIndex(t, "kyc_tier_strength"), featureIndex(t, "kyc_face_to_face")
	if lapsed[ti] != 0 {
		t.Fatalf("a lapsed verification is not a weaker one, it is none: got %v", lapsed[ti])
	}
	if lapsed[fi] != 0 {
		t.Fatalf("a lapsed verification cannot still count as face-to-face")
	}
	if live[ti] == 0 {
		t.Fatal("a live full-KYC identity should carry tier strength")
	}
}

func TestUnknownIdentityIsNotTreatedAsVerified(t *testing.T) {
	// The defect this closes: the screening path used to assert
	// KYCVerified: true for every payer, so the model's identity input was
	// a constant. An empty summary must read as unknown.
	in := PaymentInput{AmountINR: 9000, CreatedAt: time.Date(2026, 6, 1, 11, 0, 0, 0, time.UTC)}
	x := ExtractRiskFeatures(in, HistorySummary{})
	ti := featureIndex(t, "kyc_tier_strength")
	if x[ti] != 0 {
		t.Fatalf("an unknown identity must score zero tier strength, got %v", x[ti])
	}
}

func TestScreeningReadsTheDeskRatherThanAssuming(t *testing.T) {
	chain := NewChain()
	rail := NewUMIRail(NewMemorySecurities(), chain)
	ledger := NewCBDCLedger(rail, chain)
	desk := NewKYCDesk(chain, ledger)
	if ledger.identityOf == nil {
		t.Fatal("creating the desk must give the ledger a way to ask who a payer is")
	}

	// A holder the desk has never seen comes back unknown, not verified.
	h := desk.IdentityFor("nobody")
	if h.KYCVerified || h.KYCTier != "" {
		t.Fatalf("an unknown holder must not come back verified, got %+v", h)
	}
}
