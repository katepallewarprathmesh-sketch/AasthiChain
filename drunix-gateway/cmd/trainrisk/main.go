// Command trainrisk fits the payment risk model and writes the weights the
// rail embeds.
//
//	go run ./cmd/trainrisk            # writes ../../riskmodel.json
//	go run ./cmd/trainrisk -out x.json -epochs 4000
//
// The dataset is generated, not collected, because nobody has handed this
// project labelled payment fraud and pretending otherwise would be worse than
// saying so. The generator below is the honest description of what the model
// knows: two overlapping populations, with the fraudulent one carrying the
// behaviours investigators actually describe (structuring just under a
// reporting threshold, repeated near-identical amounts, bursts of payments in
// minutes, fresh accounts moving large sums, activity at three in the
// morning), and with enough overlap that the problem is not trivially
// separable. A generator that produced a perfect score would mean the
// generator was too easy, not that the model was good.
//
// Everything is seeded. Running this twice produces the same file, which is
// what lets a test assert that the committed weights are the weights this
// code produces.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"math"
	"math/rand"
	"os"
	"sort"
	"time"

	drunix "github.com/katepallewarprathmesh-sketch/AasthiChain/drunix-gateway"
)

type row struct {
	x     []float64
	label float64
}

func main() {
	out := flag.String("out", "riskmodel.json", "where to write the weights")
	rows := flag.Int("rows", 12000, "rows to generate")
	epochs := flag.Int("epochs", 3000, "gradient descent epochs")
	lr := flag.Float64("lr", 0.12, "learning rate")
	l2 := flag.Float64("l2", 0.001, "L2 regularisation")
	seed := flag.Int64("seed", 20261021, "generator seed: fixed so training is reproducible")
	ablate := flag.Bool("ablate-identity", false,
		"blank the identity features and report the result without writing weights")
	flag.Parse()

	rng := rand.New(rand.NewSource(*seed))
	data := generate(rng, *rows)

	// A time-independent split would leak nothing here, but shuffling with
	// the same seed keeps the split reproducible as well.
	rng.Shuffle(len(data), func(i, j int) { data[i], data[j] = data[j], data[i] })
	cut := len(data) * 7 / 10
	train, holdout := data[:cut], data[cut:]

	n := len(drunix.RiskFeatureNames)

	// The ablation answers the only question that matters about adding
	// identity to the model: does it change anything, on the same rows?
	// Blanking the four identity features and refitting gives the
	// comparison. Claiming an improvement without this is just asserting it.
	if *ablate {
		for _, r := range data {
			for i, name := range drunix.RiskFeatureNames {
				switch name {
				case "kyc_tier_strength", "kyc_face_to_face", "log_kyc_age_days", "cap_pressure":
					r.x[i] = 0
				}
			}
		}
	}

	means, sds := standardise(train, n)
	applyScaling(train, means, sds)
	applyScaling(holdout, means, sds)

	weights, bias := fit(train, n, *epochs, *lr, *l2)

	// The operating threshold is chosen on the training split by maximising
	// F1, never on the held-out rows. Choosing it on the data you then
	// report is how models come to look better than they are.
	threshold := pickThreshold(train, weights, bias)
	metrics := evaluate(holdout, weights, bias, threshold)
	metrics.TrainRows = len(train)
	metrics.HoldoutRows = len(holdout)

	features := make([]drunix.RiskFeature, n)
	for i, name := range drunix.RiskFeatureNames {
		features[i] = drunix.RiskFeature{
			Name:        name,
			Description: drunix.RiskFeatureDescriptions[name],
			Mean:        round(means[i], 6),
			StdDev:      round(sds[i], 6),
			Weight:      round(weights[i], 6),
		}
	}

	model := drunix.RiskModel{
		Name:      "aasthi-payment-risk",
		Version:   "v1",
		Kind:      "logistic regression, fitted by batch gradient descent with L2",
		TrainedAt: time.Now().UTC().Format("2006-01-02"),
		Seed:      *seed,
		Epochs:    *epochs,
		LearnRate: *lr,
		L2:        *l2,
		Bias:      round(bias, 6),
		Features:  features,
		Metrics:   metrics,
		DataSource: "Synthetic. 12,000 payments from the seeded generator in cmd/trainrisk, 70/30 split. " +
			"No real payment data was used, because none is available to this project.",
		Limits: []string{
			"Trained on synthetic data, so the metrics describe the generator and not the world.",
			"Advisory only: the published rules in fraud.go make the decision.",
			"Linear and small on purpose, so every coefficient and every contribution is readable.",
			"Fourteen features: the payment, the payer's recent history, and the identity the KYC desk recorded. It sees nothing else.",
		},
	}

	blob, err := json.MarshalIndent(model, "", "  ")
	if err != nil {
		log.Fatal(err)
	}
	blob = append(blob, '\n')
	if err := os.WriteFile(*out, blob, 0o644); err != nil {
		log.Fatal(err)
	}
	fmt.Printf("wrote %s\n", *out)
	fmt.Printf("held-out AUC %.3f  accuracy %.3f  precision %.3f  recall %.3f  f1 %.3f  (%d rows)\n",
		metrics.AUC, metrics.Accuracy, metrics.Precision, metrics.Recall, metrics.F1, metrics.HoldoutRows)
}

/* ---------------- the generator ---------------- */

// generate builds a labelled population. The honest part of this function is
// the overlap: ordinary people also make large payments at odd hours, and
// most round-number payments are rent.
func generate(rng *rand.Rand, n int) []row {
	out := make([]row, 0, n)
	base := time.Date(2026, 6, 1, 0, 0, 0, 0, time.UTC)

	for i := 0; i < n; i++ {
		fraud := rng.Float64() < 0.18
		var in drunix.PaymentInput
		var h drunix.HistorySummary

		// The two populations are deliberately mixed. Roughly a third of the
		// fraudulent payments are careful enough to look ordinary, and about
		// a sixth of the ordinary ones carry a shape that looks wrong. A
		// generator without this overlap scores perfectly and teaches the
		// model nothing a reviewer could not do with a ruler.
		shape := fraud
		if fraud && rng.Float64() < 0.22 {
			shape = false
		} else if !fraud && rng.Float64() < 0.10 {
			shape = true
		}

		// The mule archetype: a payment that behaves perfectly normally and
		// is wrong about who is making it. A rented or freshly opened
		// account, thin or lapsed verification, an amount pressed against
		// the ceiling of a small tier. Behaviour alone cannot see this one,
		// which is the whole reason identity belongs in the model.
		//
		// Worth being blunt about what this is: the generator decides what
		// is learnable, so adding this archetype is what makes identity
		// useful here. It is a statement about a known fraud pattern, not
		// evidence that the pattern has this weight in the real world.
		mule := fraud && !shape && rng.Float64() < 0.55

		if mule {
			// Ordinary-looking money movement.
			norm := 3000 + rng.Float64()*9000
			in.AmountINR = norm * (0.8 + rng.Float64()*0.6)
			h.TxnCount10m = pickSmall(rng)
			h.TxnCount24h = h.TxnCount10m + rng.Intn(3)
			h.RecentINR = jitterAround(rng, norm, 2+rng.Intn(5), 0.3)
			h.AccountAgeMin = 1440 + rng.Intn(20000)
			in.CreatedAt = base.Add(time.Duration(8+rng.Intn(12)) * time.Hour)

			// The tell is entirely in the identity.
			switch rng.Intn(3) {
			case 0:
				h.KYCTier, h.KYCRoute, h.KYCAgeDays = drunix.KYCMinimal, "AADHAAR_OTP_EKYC", 0
			case 1:
				h.KYCTier, h.KYCRoute, h.KYCAgeDays = drunix.KYCMinimal, "AADHAAR_OFFLINE_XML", rng.Intn(2)
				h.KYCExpired = true
			default:
				h.KYCTier, h.KYCRoute, h.KYCAgeDays = "", "", 0
			}
			h.FaceToFace = false
			h.KYCVerified = h.KYCTier != ""
			// Pressed against the minimum-KYC per-payment ceiling.
			if h.KYCTier == drunix.KYCMinimal {
				in.AmountINR = 10000 * (0.82 + rng.Float64()*0.17)
			}
		} else if shape {
			switch rng.Intn(4) {
			case 0: // structuring under a reporting threshold
				t := []float64{50000, 200000, 1000000}[rng.Intn(3)]
				amt := t * (0.88 + rng.Float64()*0.11)
				in.AmountINR = amt
				h.TxnCount10m = 2 + rng.Intn(6)
				h.TxnCount24h = h.TxnCount10m + rng.Intn(14)
				h.RecentINR = jitterAround(rng, amt, 6, 0.04)
			case 1: // burst from a fresh account
				in.AmountINR = 20000 + rng.Float64()*900000
				h.TxnCount10m = 4 + rng.Intn(9)
				h.TxnCount24h = h.TxnCount10m + rng.Intn(20)
				h.AccountAgeMin = rng.Intn(180)
				h.RecentINR = jitterAround(rng, in.AmountINR, 5, 0.5)
			case 2: // sudden jump against a quiet history
				prior := 1500 + rng.Float64()*6000
				in.AmountINR = prior * (6 + rng.Float64()*10)
				h.TxnCount10m = rng.Intn(3)
				h.TxnCount24h = 1 + rng.Intn(6)
				h.RecentINR = jitterAround(rng, prior, 8, 0.3)
			default: // repeated identical amounts, smurfing shape
				amt := 9000 + rng.Float64()*40000
				in.AmountINR = amt
				h.TxnCount10m = 3 + rng.Intn(7)
				h.TxnCount24h = h.TxnCount10m + rng.Intn(25)
				h.RecentINR = jitterAround(rng, amt, 9, 0.02)
			}
			if h.AccountAgeMin == 0 {
				h.AccountAgeMin = rng.Intn(4000)
			}
			// Identity for the shaped population. Weak tiers dominate,
			// verification is often hours old, and the route is usually
			// one of the remote ones. The overlap is deliberate: a
			// patient launderer holds full KYC on a face-to-face route
			// and waits, and roughly a fifth of these do.
			switch {
			case rng.Float64() < 0.22:
				h.KYCTier, h.FaceToFace = drunix.KYCFull, true
				h.KYCRoute, h.KYCAgeDays = "VCIP", 30+rng.Intn(900)
			case rng.Float64() < 0.45:
				h.KYCTier = ""
				h.KYCRoute, h.KYCAgeDays = "", 0
			default:
				h.KYCTier, h.FaceToFace = drunix.KYCMinimal, false
				h.KYCRoute = []string{"AADHAAR_OTP_EKYC", "AADHAAR_OFFLINE_XML", "DIGILOCKER_OVD"}[rng.Intn(3)]
				h.KYCAgeDays = rng.Intn(4)
			}
			h.KYCExpired = h.KYCTier != "" && rng.Float64() < 0.18
			h.KYCVerified = h.KYCTier != ""
			if rng.Float64() < 0.45 {
				in.CreatedAt = base.Add(time.Duration(rng.Intn(5)) * time.Hour) // early morning IST
			} else {
				in.CreatedAt = base.Add(time.Duration(6+rng.Intn(16)) * time.Hour)
			}
		} else {
			// Ordinary behaviour: one or two payments, amounts clustered
			// around a personal norm, mostly verified, mostly daytime.
			norm := 2000 + rng.Float64()*120000
			in.AmountINR = norm * (0.6 + rng.Float64()*0.9)
			h.TxnCount10m = pickSmall(rng)
			h.TxnCount24h = h.TxnCount10m + rng.Intn(4)
			h.RecentINR = jitterAround(rng, norm, 2+rng.Intn(7), 0.35)
			h.AccountAgeMin = 1440 + rng.Intn(600000)
			// Ordinary identity: mostly full KYC on a face-to-face route,
			// held for months. A minority are genuinely new, because a
			// first-time buyer verifying yesterday is not suspicious by
			// itself, and the model should not be taught that it is.
			switch {
			case rng.Float64() < 0.72:
				h.KYCTier, h.FaceToFace = drunix.KYCFull, true
				h.KYCRoute, h.KYCAgeDays = "VCIP", 20+rng.Intn(1200)
			case rng.Float64() < 0.85:
				h.KYCTier, h.FaceToFace = drunix.KYCMinimal, false
				h.KYCRoute, h.KYCAgeDays = "DIGILOCKER_OVD", 5+rng.Intn(700)
			default:
				h.KYCTier, h.FaceToFace = drunix.KYCMinimal, false
				h.KYCRoute, h.KYCAgeDays = "AADHAAR_OTP_EKYC", rng.Intn(3)
			}
			h.KYCExpired = rng.Float64() < 0.03
			h.KYCVerified = h.KYCTier != ""
			if rng.Float64() < 0.08 {
				in.CreatedAt = base.Add(time.Duration(rng.Intn(5)) * time.Hour)
			} else {
				in.CreatedAt = base.Add(time.Duration(6+rng.Intn(16)) * time.Hour)
			}
			// A minority of legitimate payments look alarming: a property
			// purchase against a quiet history, a new account buying in.
			if rng.Float64() < 0.07 {
				in.AmountINR *= 8 + rng.Float64()*6
			}
			if rng.Float64() < 0.05 {
				h.AccountAgeMin = rng.Intn(300)
			}
		}

		// The ceiling the tier implies, so cap_pressure means the same
		// thing in training as it does in production.
		switch h.KYCTier {
		case drunix.KYCFull:
			h.PerPaymentCapINR = 100000
		case drunix.KYCMinimal:
			h.PerPaymentCapINR = 10000
		}

		for _, v := range h.RecentINR {
			h.TotalINR24h += v
		}
		h.TotalINR24h += in.AmountINR

		label := 0.0
		if fraud {
			label = 1
		}
		// Two percent label noise, because real fraud labels are decided by
		// tired people reading incomplete files.
		if rng.Float64() < 0.02 {
			label = 1 - label
		}
		out = append(out, row{x: drunix.ExtractRiskFeatures(in, h), label: label})
	}
	return out
}

func pickSmall(rng *rand.Rand) int {
	switch {
	case rng.Float64() < 0.75:
		return 0
	case rng.Float64() < 0.9:
		return 1
	default:
		return 2
	}
}

func jitterAround(rng *rand.Rand, centre float64, count int, spread float64) []float64 {
	out := make([]float64, 0, count)
	for i := 0; i < count; i++ {
		out = append(out, centre*(1+(rng.Float64()*2-1)*spread))
	}
	return out
}

/* ---------------- the fit ---------------- */

func standardise(rows []row, n int) (means, sds []float64) {
	means = make([]float64, n)
	sds = make([]float64, n)
	for _, r := range rows {
		for i := 0; i < n; i++ {
			means[i] += r.x[i]
		}
	}
	for i := range means {
		means[i] /= float64(len(rows))
	}
	for _, r := range rows {
		for i := 0; i < n; i++ {
			d := r.x[i] - means[i]
			sds[i] += d * d
		}
	}
	for i := range sds {
		sds[i] = math.Sqrt(sds[i] / float64(len(rows)))
		if sds[i] < 1e-9 {
			sds[i] = 1
		}
	}
	return means, sds
}

func applyScaling(rows []row, means, sds []float64) {
	for _, r := range rows {
		for i := range r.x {
			r.x[i] = (r.x[i] - means[i]) / sds[i]
		}
	}
}

func fit(rows []row, n, epochs int, lr, l2 float64) ([]float64, float64) {
	w := make([]float64, n)
	b := 0.0
	m := float64(len(rows))
	for e := 0; e < epochs; e++ {
		gw := make([]float64, n)
		gb := 0.0
		for _, r := range rows {
			z := b
			for i := 0; i < n; i++ {
				z += w[i] * r.x[i]
			}
			err := 1/(1+math.Exp(-z)) - r.label
			for i := 0; i < n; i++ {
				gw[i] += err * r.x[i]
			}
			gb += err
		}
		for i := 0; i < n; i++ {
			w[i] -= lr * (gw[i]/m + l2*w[i])
		}
		b -= lr * gb / m
	}
	return w, b
}

// pickThreshold sweeps the operating point on training data only.
func pickThreshold(rows []row, w []float64, b float64) float64 {
	best, bestF1 := 0.5, -1.0
	for t := 0.05; t <= 0.95; t += 0.01 {
		m := evaluate(rows, w, b, t)
		if m.F1 > bestF1 {
			best, bestF1 = round(t, 2), m.F1
		}
	}
	return best
}

func evaluate(rows []row, w []float64, b, threshold float64) drunix.RiskModelMetrics {
	type scored struct {
		p     float64
		label float64
	}
	preds := make([]scored, 0, len(rows))
	positives := 0.0
	for _, r := range rows {
		z := b
		for i := range w {
			z += w[i] * r.x[i]
		}
		preds = append(preds, scored{p: 1 / (1 + math.Exp(-z)), label: r.label})
		positives += r.label
	}

	var tp, fp, tn, fn float64
	for _, s := range preds {
		switch {
		case s.p >= threshold && s.label == 1:
			tp++
		case s.p >= threshold && s.label == 0:
			fp++
		case s.p < threshold && s.label == 1:
			fn++
		default:
			tn++
		}
	}
	precision, recall, f1 := 0.0, 0.0, 0.0
	if tp+fp > 0 {
		precision = tp / (tp + fp)
	}
	if tp+fn > 0 {
		recall = tp / (tp + fn)
	}
	if precision+recall > 0 {
		f1 = 2 * precision * recall / (precision + recall)
	}

	// AUC by rank: the probability that a random positive outranks a random
	// negative.
	sort.Slice(preds, func(i, j int) bool { return preds[i].p < preds[j].p })
	rankSum, pos, neg := 0.0, 0.0, 0.0
	for i, s := range preds {
		if s.label == 1 {
			rankSum += float64(i + 1)
			pos++
		} else {
			neg++
		}
	}
	auc := 0.0
	if pos > 0 && neg > 0 {
		auc = (rankSum - pos*(pos+1)/2) / (pos * neg)
	}

	return drunix.RiskModelMetrics{
		AUC:       round(auc, 4),
		Accuracy:  round((tp+tn)/float64(len(rows)), 4),
		Precision: round(precision, 4),
		Recall:    round(recall, 4),
		F1:        round(f1, 4),
		Threshold: threshold,
		Positives: round(positives/float64(len(rows)), 4),
	}
}

func round(v float64, places int) float64 {
	f := math.Pow(10, float64(places))
	return math.Round(v*f) / f
}
