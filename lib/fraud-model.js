'use strict';
/**
 * JavaScript serving side of the trained fraud model.
 *
 * Parity with ml/train.py and drunix-gateway/model.go. All three are pinned to
 * the same 200 golden vectors produced by scikit-learn at training time
 * (scripts/fraud-model-parity.mjs here, TestGoldenVectors in Go). If any of the
 * three drifts by more than 1e-9, CI fails.
 *
 * The shipped model is a logistic regression: scoring is a dot product, and
 * contribution_i = feature_value_i * coefficient_i exactly, with
 * sum(contributions) + intercept = logit. The gradient-boosted artifact in
 * ml/model/gbt_comparison.json can also be loaded via FRAUD_MODEL_PATH; the
 * tree path needs Math.fround() before each threshold comparison to match
 * sklearn's internal float32 cast.
 */

const fs = require('fs');
const path = require('path');

const MODEL_PATH = process.env.FRAUD_MODEL_PATH
  || path.join(__dirname, '..', 'ml', 'model', 'fraud_model.json');

const SUPPORTED_SCHEMA_VERSION = 3;

const STRUCTURING_FLOOR = 45000;
const STRUCTURING_CEIL = 50000;
const NEW_ACCOUNT_MIN = 1440;
// A zero balance means UNKNOWN, not an empty account. Dividing by it returned
// the amount itself and made a missing balance dominate every explanation.
const BALANCE_RATIO_CAP = 20;
const RISKY_VPA_FRAGMENTS = ['fraud', 'scam', 'thief', 'steal', 'phish', 'xxx', 'darkweb'];

let model = null;

/** Validates strictly: a half-valid model that scores everything 0.5 silently
 *  disables fraud screening, which is worse than refusing to start. */
function validate(m) {
  if (!m || typeof m !== 'object') throw new Error('model is not an object');
  if ((m.schema_version || 0) > SUPPORTED_SCHEMA_VERSION) {
    throw new Error(`model schema v${m.schema_version} is newer than supported v${SUPPORTED_SCHEMA_VERSION}`);
  }
  if (!Array.isArray(m.features) || !m.features.length) throw new Error('no feature names');
  if (m.kind === 'logistic_regression') {
    if (!Array.isArray(m.coefficients) || m.coefficients.length !== m.features.length) {
      throw new Error(`${(m.coefficients || []).length} coefficients for ${m.features.length} features`);
    }
  } else if (m.kind === 'gradient_boosted_trees') {
    if (!Array.isArray(m.trees) || !m.trees.length) throw new Error('tree model carries no trees');
  } else {
    throw new Error(`unknown model kind ${JSON.stringify(m.kind)}`);
  }
  if (!(m.threshold_block > 0 && m.threshold_block < 1)) {
    throw new Error(`block threshold ${m.threshold_block} is not a probability`);
  }
  if (!(m.threshold_review < m.threshold_block)) {
    throw new Error('review threshold must sit below block threshold');
  }
  return m;
}

function loadModel() {
  if (model) return model;
  model = validate(JSON.parse(fs.readFileSync(MODEL_PATH, 'utf8')));
  return model;
}

/**
 * Injects an already-parsed artifact instead of reading from disk.
 *
 * Needed on Vercel: the serverless file tracer only bundles files it can see
 * statically, and MODEL_PATH is computed at runtime, so ml/model/*.json would
 * be missing from the deployed function and scoring would silently fall back
 * to the rules engine. The handler requires its own co-located copy and passes
 * it in here. Validated on the way in, exactly as a disk load would be.
 */
function useModel(obj) {
  model = validate(obj);
  return model;
}

/** Raw log-odds. */
function rawScore(x, m = loadModel()) {
  if (m.kind === 'logistic_regression') {
    let t = m.intercept;
    for (let i = 0; i < m.coefficients.length; i++) t += m.coefficients[i] * x[i];
    return t;
  }
  let total = m.base_value;
  for (const t of m.trees) {
    let n = 0;
    while (t.left[n] !== -1) {
      n = Math.fround(x[t.feature[n]]) <= t.threshold[n] ? t.left[n] : t.right[n];
    }
    total += m.learning_rate * t.value[n];
  }
  return total;
}

function probability(x, m = loadModel()) {
  return 1 / (1 + Math.exp(-rawScore(x, m)));
}

/** Per-feature log-odds attribution. For LR this is value * coefficient. */
function contributions(x, m = loadModel()) {
  if (m.kind === 'logistic_regression') {
    return m.coefficients.map((c, i) => c * x[i]);
  }
  const out = new Array(m.features.length).fill(0);
  for (const t of m.trees) {
    let n = 0;
    while (t.left[n] !== -1) {
      const f = t.feature[n];
      const next = Math.fround(x[f]) <= t.threshold[n] ? t.left[n] : t.right[n];
      out[f] += m.learning_rate * (t.value[next] - t.value[n]);
      n = next;
    }
  }
  return out;
}

function explanationBaseline(m = loadModel()) {
  return m.kind === 'logistic_regression' ? m.intercept : m.explain_base;
}

// ---------------------------------------------------------------------------
// Feature extraction — mirrors ml/features.py and Go's ExtractFeatures.
// ---------------------------------------------------------------------------

/** Missing or non-finite input collapses to a defined value: a malformed
 *  payment must still produce a score. */
function safe(v, d = 0) {
  const f = Number(v);
  return Number.isFinite(f) ? f : d;
}

/** Payee handle copies the payer's local part on a different bank. */
function handleMimic(payerVpa, payeeVpa) {
  if (!payerVpa || !payeeVpa || payerVpa === payeeVpa) return 0;
  const a = payerVpa.split('@')[0];
  const b = payeeVpa.split('@')[0];
  return a && a === b ? 1 : 0;
}

function coeffVar(vals) {
  if (!vals || vals.length < 2) return 0;
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  if (mean <= 0) return 0;
  return Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length) / mean;
}

function extractFeatures(i) {
  const amount = Math.max(0, safe(i.amountINR));
  const recent = (i.recentINR || []).slice(0, 10).map(v => safe(v));
  const mean = recent.length ? recent.reduce((a, b) => a + b, 0) / recent.length : 0;
  const ratio = mean > 0 ? amount / mean : 1;
  const structCount = recent.filter(a => a > STRUCTURING_FLOOR && a <= STRUCTURING_CEIL).length;
  const cv = coeffVar(recent);
  const c10 = safe(i.txnCount10m);
  const c24 = safe(i.txnCount24h);
  const age = Math.max(0, safe(i.accountAgeMin));
  const bal = Math.max(0, safe(i.balanceBeforeINR));
  const hour = Math.trunc(safe(i.hourOfDay, 12));
  const dow = Math.trunc(safe(i.dayOfWeek, 2));
  const vpa = String(i.payerVpa || '').toLowerCase();
  const ttype = String(i.txnType || 'COLLECT').toUpperCase();

  return [
    Math.log1p(amount),
    (amount > STRUCTURING_FLOOR && amount <= STRUCTURING_CEIL) ? 1 : 0,
    bal <= 0 ? 0 : Math.min(amount / bal, BALANCE_RATIO_CAP),
    structCount,
    cv,
    structCount * (1 - Math.min(1, cv)),
    c10,
    c24,
    Math.log1p(Math.max(0, safe(i.totalINR24h))),
    ratio,
    c10 / (c24 + 1),
    c10 * ratio,
    i.payeeSeenBefore ? 0 : 1,
    safe(i.distinctPayees24h),
    safe(i.payeeFanIn24h),
    Math.log1p(age),
    i.kycVerified ? 0 : 1,
    (age < NEW_ACCOUNT_MIN ? 1 : 0) * Math.log1p(amount),
    (hour >= 0 && hour < 5) ? 1 : 0,
    (dow === 5 || dow === 6) ? 1 : 0,
    (ttype === 'TRANSFER' || ttype === 'CASH_OUT') ? 1 : 0,
    RISKY_VPA_FRAGMENTS.some(f => vpa.includes(f)) ? 1 : 0,
    handleMimic(vpa, String(i.payeeVpa || '').toLowerCase()),
  ];
}

function featurePhrase(name, v) {
  switch (name) {
    case 'log_amount': return `payment size ₹${Math.round(Math.expm1(v))}`;
    case 'amount_in_structuring_band': return v > 0 ? 'amount sits just under the ₹50,000 reporting line' : 'amount is not near the reporting line';
    case 'balance_ratio': return `payment is ${Math.round(v * 100)}% of available balance`;
    case 'recent_in_structuring_band': return `${v} recent payments just under the reporting line`;
    case 'recent_amount_cv': return `spread of recent amounts (CV ${v.toFixed(2)})`;
    case 'structuring_x_tightness': return v > 0 ? `repeated near-identical amounts below the reporting line (index ${v.toFixed(1)})` : 'no repeated near-threshold pattern';
    case 'txn_count_10m': return `${v} payments in the last 10 minutes`;
    case 'txn_count_24h': return `${v} payments in the last 24 hours`;
    case 'log_total_24h': return `₹${Math.round(Math.expm1(v))} moved in the last 24 hours`;
    case 'amount_vs_recent_mean': return `${v.toFixed(1)}x the payer's recent average`;
    case 'burstiness': return `${Math.round(v * 100)}% of the day's activity is in the last 10 minutes`;
    case 'velocity_x_escalation': return `burst activity with escalating amounts (index ${v.toFixed(1)})`;
    case 'beneficiary_is_new': return v > 0 ? 'first ever payment to this beneficiary' : 'beneficiary has been paid before';
    case 'distinct_payees_24h': return `${v} distinct beneficiaries in 24h (fan-out)`;
    case 'payee_fan_in_24h': return `${v} distinct payers into this beneficiary (fan-in)`;
    case 'log_account_age_min': return `account age ${Math.round(Math.expm1(v))} minutes`;
    case 'kyc_unverified': return v > 0 ? 'payer KYC is not verified' : 'payer KYC is verified';
    case 'new_account_x_amount': return v > 0 ? 'large payment on an account less than a day old' : 'account is established';
    case 'is_night': return v > 0 ? 'payment made between 00:00 and 05:00' : 'payment made during normal hours';
    case 'is_weekend': return v > 0 ? 'weekend payment' : 'weekday payment';
    case 'is_transfer_type': return v > 0 ? 'account-to-account transfer rather than a merchant collect' : 'ordinary merchant collect';
    case 'risky_vpa_fragment': return v > 0 ? 'payer VPA contains a phishing-style fragment' : 'payer VPA looks ordinary';
    case 'handle_mimic': return v > 0 ? "payee handle copies the payer's on a different bank (impersonation pattern)" : "payee handle is unrelated to the payer's";
    default: return name;
  }
}

/**
 * Screens a payment with the trained model.
 *
 * The model decides. The two remaining rules are policy overrides, not
 * scoring: an unverified payer or a phishing-style VPA is never auto-approved,
 * because those are compliance positions rather than statistical ones.
 */
function scorePaymentML(input) {
  const m = loadModel();
  const x = extractFeatures(input);
  const prob = probability(x, m);
  const contribs = contributions(x, m);

  const ranked = contribs
    .map((val, idx) => ({ idx, val }))
    .sort((a, b) => b.val - a.val);
  const toFactor = f => ({
    code: m.features[f.idx].toUpperCase(),
    note: featurePhrase(m.features[f.idx], x[f.idx]),
    weight: Math.round(f.val * 100),
  });
  const topPositive = ranked.filter(f => f.val > 0.01).slice(0, 5).map(toFactor);
  const topNegative = ranked.filter(f => f.val < -0.01).slice(-5).reverse().map(toFactor);

  let band = 'LOW';
  let decision = 'APPROVE';
  if (prob >= m.threshold_block) { band = 'HIGH'; decision = 'BLOCK'; }
  else if (prob >= m.threshold_review) { band = 'MEDIUM'; decision = 'REVIEW'; }

  const factors = [...topPositive];
  if (!input.kycVerified && decision === 'APPROVE') {
    band = 'MEDIUM'; decision = 'REVIEW';
    factors.push({ code: 'POLICY_KYC_REQUIRED', note: 'held for review: payer KYC is not verified (policy, not model)', weight: 0 });
  }
  if (x[21] > 0 && decision === 'APPROVE') {
    band = 'MEDIUM'; decision = 'REVIEW';
    factors.push({ code: 'POLICY_RISKY_VPA', note: 'held for review: payer VPA matches a phishing-style pattern (policy, not model)', weight: 0 });
  }
  if (!factors.length) {
    factors.push({ code: 'CLEAN', note: 'no material risk signals — model probability below review threshold', weight: 0 });
  }

  return {
    score: Math.round(prob * 100),
    band, decision, factors,
    model: m.name,
    probability: prob,
    modelVersion: `${m.name} (schema v${m.schema_version})`,
    modelKind: m.kind,
    threshold: m.threshold_block,
    baseline: explanationBaseline(m),
    topPositive, topNegative,
    dataCaveat: m.data_caveat,
    explainer: m.explainer,
  };
}

function modelInfo() {
  const m = loadModel();
  return {
    name: m.name, kind: m.kind, schemaVersion: m.schema_version,
    explainer: m.explainer, features: m.features,
    thresholdBlock: m.threshold_block, thresholdReview: m.threshold_review,
    thresholdSelectedOn: m.threshold_selected_on,
    precisionFloor: m.precision_floor, precisionFloorMet: m.precision_floor_met,
    rowsTrained: m.rows_trained, trainingFraudRate: m.fraud_rate,
    trainedOn: m.trained_on, dataCaveat: m.data_caveat, metrics: m.metrics,
    coefficients: m.kind === 'logistic_regression'
      ? Object.fromEntries(m.features.map((f, i) => [f, m.coefficients[i]])) : undefined,
    intercept: m.intercept,
  };
}

module.exports = {
  loadModel, useModel, validate, rawScore, probability, contributions, explanationBaseline,
  extractFeatures, scorePaymentML, modelInfo, featurePhrase,
  SUPPORTED_SCHEMA_VERSION,
};
