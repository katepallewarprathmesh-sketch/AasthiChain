'use strict';
/**
 * JS serving side of the trained fraud model — parity with
 * drunix-gateway/model.go and ml/train.py.
 *
 * All three implementations are pinned to the same 200 golden vectors produced
 * by scikit-learn at training time (scripts/fraud-model-parity.mjs, and
 * TestGoldenVectors in Go). If they ever disagree by more than 1e-9, CI fails.
 *
 * Two details make this a faithful port rather than an approximation:
 *
 *   1. Math.fround() before every threshold comparison. scikit-learn casts
 *      feature values to float32 inside tree prediction and compares against a
 *      float64 threshold. Comparing in float64 flips rows sitting within a
 *      float32 ulp of a split point — rare, but wrong by ~0.74 in raw score
 *      when it happens.
 *
 *   2. Contributions are measured from explainBase, which folds in each tree's
 *      root value, because path deltas telescope to (leaf - root). This is what
 *      makes the numbers shown to an analyst add up to the score that was acted on.
 */

const fs = require('fs');
const path = require('path');

const MODEL_PATH = process.env.FRAUD_MODEL_PATH
  || path.join(__dirname, '..', 'ml', 'model', 'fraud_model.json');

let model = null;

function loadModel() {
  if (model) return model;
  model = JSON.parse(fs.readFileSync(MODEL_PATH, 'utf8'));
  if (!Array.isArray(model.trees) || !model.trees.length) {
    throw new Error(`fraud model at ${MODEL_PATH} has no trees`);
  }
  return model;
}

/** Raw ensemble output, in log-odds. */
function rawScore(x, m = loadModel()) {
  let total = m.base_value;
  for (const t of m.trees) {
    let node = 0;
    while (t.left[node] !== -1) {
      node = Math.fround(x[t.feature[node]]) <= t.threshold[node]
        ? t.left[node]
        : t.right[node];
    }
    total += m.learning_rate * t.value[node];
  }
  return total;
}

function probability(x, m = loadModel()) {
  return 1 / (1 + Math.exp(-rawScore(x, m)));
}

/** Per-feature log-odds attribution; sums with explain_base to the raw score. */
function contributions(x, m = loadModel()) {
  const out = new Array(m.features.length).fill(0);
  for (const t of m.trees) {
    let node = 0;
    while (t.left[node] !== -1) {
      const f = t.feature[node];
      const next = Math.fround(x[f]) <= t.threshold[node] ? t.left[node] : t.right[node];
      out[f] += m.learning_rate * (t.value[next] - t.value[node]);
      node = next;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Feature extraction — mirrors ml/features.py and Go's ExtractFeatures.
// ---------------------------------------------------------------------------

const STRUCTURING_FLOOR = 45000;
const STRUCTURING_CEIL = 50000;
const RISKY_VPA_FRAGMENTS = ['fraud', 'scam', 'thief', 'steal', 'phish', 'xxx', 'darkweb'];

function coeffVar(vals) {
  if (!vals || vals.length < 2) return 0;
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  if (mean <= 0) return 0;
  const varr = vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length;
  return Math.sqrt(varr) / mean;
}

/**
 * Builds the model input from exactly what the API holds when a collect
 * request arrives. hourOfDay is a parameter, not read from the clock, so a
 * decision can be reproduced later.
 */
function extractFeatures({ amountINR, payerVpa, recentINR, txnCount10m, txnCount24h,
                           totalINR24h, accountAgeMin, kycVerified, hourOfDay }) {
  const recent = (recentINR || []).slice(0, 10);
  const recentMean = recent.length ? recent.reduce((a, b) => a + b, 0) / recent.length : 0;
  const ratio = recentMean > 0 ? amountINR / recentMean : 1;
  const structCount = recent.filter(a => a > STRUCTURING_FLOOR && a <= STRUCTURING_CEIL).length;
  const vpa = String(payerVpa || '').toLowerCase();
  const cv = coeffVar(recent);

  return [
    Math.log1p(Math.max(0, amountINR)),
    (amountINR > STRUCTURING_FLOOR && amountINR <= STRUCTURING_CEIL) ? 1 : 0,
    structCount,
    cv,
    txnCount10m,
    txnCount24h,
    Math.log1p(Math.max(0, totalINR24h)),
    ratio,
    Math.log1p(Math.max(0, accountAgeMin)),
    kycVerified ? 0 : 1,
    (hourOfDay >= 0 && hourOfDay < 5) ? 1 : 0,
    RISKY_VPA_FRAGMENTS.some(f => vpa.includes(f)) ? 1 : 0,
    txnCount10m * ratio,
    txnCount10m / (txnCount24h + 1),
    (accountAgeMin < 1440 ? 1 : 0) * Math.log1p(Math.max(0, amountINR)),
    structCount * (1 - Math.min(1, cv)),
  ];
}

function featurePhrase(name, v) {
  switch (name) {
    case 'log_amount': return `payment size ₹${Math.round(Math.expm1(v))}`;
    case 'amount_in_structuring_band':
      return v > 0 ? 'amount sits just under the ₹50,000 reporting line' : 'amount is not near the reporting line';
    case 'recent_in_structuring_band': return `${v} recent payments just under the reporting line`;
    case 'recent_amount_cv': return `spread of recent amounts (CV ${v.toFixed(2)})`;
    case 'txn_count_10m': return `${v} payments in the last 10 minutes`;
    case 'txn_count_24h': return `${v} payments in the last 24 hours`;
    case 'log_total_24h': return `₹${Math.round(Math.expm1(v))} moved in the last 24 hours`;
    case 'amount_vs_recent_mean': return `${v.toFixed(1)}x the payer's recent average`;
    case 'log_account_age_min': return `account age ${Math.round(Math.expm1(v))} minutes`;
    case 'kyc_unverified': return v > 0 ? 'payer KYC is not verified' : 'payer KYC is verified';
    case 'is_night': return v > 0 ? 'payment made between 00:00 and 05:00' : 'payment made during normal hours';
    case 'risky_vpa_fragment': return v > 0 ? 'payer VPA contains a phishing-style fragment' : 'payer VPA looks ordinary';
    case 'velocity_x_escalation': return `burst activity with escalating amounts (index ${v.toFixed(1)})`;
    case 'burstiness': return `${Math.round(v * 100)}% of the day's activity is in the last 10 minutes`;
    case 'new_account_x_amount': return v > 0 ? 'large payment on an account less than a day old' : 'account is established';
    case 'structuring_x_tightness':
      return v > 0 ? `repeated near-identical amounts below the reporting line (index ${v.toFixed(1)})`
                   : 'no repeated near-threshold pattern';
    default: return name;
  }
}

/**
 * Screens a payment with the trained model.
 *
 * The model decides. The remaining rules are policy overrides, not scoring:
 * an unverified payer or a phishing-style VPA is never auto-approved on a low
 * model score, because those are compliance positions rather than statistical ones.
 */
function scorePaymentML(input) {
  const m = loadModel();
  const x = extractFeatures(input);
  const prob = probability(x, m);
  const contribs = contributions(x, m);

  const factors = contribs
    .map((val, idx) => ({ idx, val }))
    .sort((a, b) => Math.abs(b.val) - Math.abs(a.val))
    .filter(f => Math.abs(f.val) >= 0.01)
    .slice(0, 5)
    .map(f => ({
      code: m.features[f.idx].toUpperCase(),
      note: featurePhrase(m.features[f.idx], x[f.idx]),
      weight: Math.round(f.val * 100),
    }));

  let band = 'LOW';
  let decision = 'APPROVE';
  if (prob >= m.threshold_block) { band = 'HIGH'; decision = 'BLOCK'; }
  else if (prob >= m.threshold_review) { band = 'MEDIUM'; decision = 'REVIEW'; }

  if (!input.kycVerified && decision === 'APPROVE') {
    band = 'MEDIUM'; decision = 'REVIEW';
    factors.push({ code: 'POLICY_KYC_REQUIRED', note: 'held for review: payer KYC is not verified (policy, not model)', weight: 0 });
  }
  if (x[11] > 0 && decision === 'APPROVE') {
    band = 'MEDIUM'; decision = 'REVIEW';
    factors.push({ code: 'POLICY_RISKY_VPA', note: 'held for review: payer VPA matches a phishing-style pattern (policy, not model)', weight: 0 });
  }
  if (!factors.length) {
    factors.push({ code: 'CLEAN', note: 'no material risk signals — model probability below review threshold', weight: 0 });
  }

  return {
    score: Math.round(prob * 100),
    probability: prob,
    band,
    decision,
    factors,
    model: m.name,
    modelKind: m.kind,
    trainedOn: m.trained_on,
    dataCaveat: m.data_caveat,
    explainer: m.explainer,
  };
}

function modelInfo() {
  const m = loadModel();
  return {
    name: m.name, kind: m.kind, explainer: m.explainer,
    features: m.features, nTrees: m.n_trees, maxDepth: m.max_depth,
    thresholdBlock: m.threshold_block, thresholdReview: m.threshold_review,
    rowsTrained: m.rows_trained, trainingFraudRate: m.fraud_rate,
    trainedOn: m.trained_on, dataCaveat: m.data_caveat, metrics: m.metrics,
  };
}

module.exports = {
  loadModel, rawScore, probability, contributions,
  extractFeatures, scorePaymentML, modelInfo, featurePhrase,
};
