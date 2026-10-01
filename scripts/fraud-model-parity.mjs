#!/usr/bin/env node
/**
 * Pins the JavaScript fraud scorer to scikit-learn's output, and exercises the
 * robustness cases the Go suite covers.
 *
 * The model is trained in Python and served in Go and JS. Three
 * implementations of the same arithmetic drift unless something forces them
 * not to. This asserts the JS implementation reproduces every golden logit,
 * probability and per-feature contribution to 1e-9; Go's TestGoldenVectors
 * asserts the same on the same vectors.
 *
 * Usage: node scripts/fraud-model-parity.mjs
 */

import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const fm = require('../lib/fraud-model.js');

const TOL = 1e-9;
const golden = JSON.parse(fs.readFileSync(
  path.join(process.cwd(), 'ml', 'model', 'golden_vectors.json'), 'utf8'));
const model = fm.loadModel();

let passed = 0;
const failures = [];
const check = (name, cond, detail = '') => {
  if (cond) passed++; else failures.push(`${name}${detail ? ' — ' + detail : ''}`);
};

console.log(`\nFraud model parity → ${model.name} (${model.kind}, schema v${model.schema_version})`);
console.log(`  ${model.features.length} features, tolerance ${TOL}\n`);

if (golden.model !== model.name) {
  console.error(`FAIL: golden vectors are for ${golden.model}, model is ${model.name} — re-export`);
  process.exit(1);
}

// ---- golden parity --------------------------------------------------------
let worstLogit = 0, worstProb = 0, worstContrib = 0;
for (const [i, v] of golden.vectors.entries()) {
  const dl = Math.abs(fm.rawScore(v.features) - v.expected_logit);
  if (dl > worstLogit) worstLogit = dl;
  check(`vector ${i} logit`, dl <= TOL, `diff ${dl.toExponential(3)}`);

  const p = fm.probability(v.features);
  const dp = Math.abs(p - v.expected_probability);
  if (dp > worstProb) worstProb = dp;
  check(`vector ${i} probability`, dp <= TOL, `got ${p} want ${v.expected_probability}`);

  const c = fm.contributions(v.features);
  for (let j = 0; j < c.length; j++) {
    const dc = Math.abs(c[j] - v.expected_contributions[j]);
    if (dc > worstContrib) worstContrib = dc;
    check(`vector ${i} contribution ${model.features[j]}`, dc <= TOL);
  }
}

// ---- explanation correctness ---------------------------------------------
for (const [i, v] of golden.vectors.entries()) {
  const sum = fm.contributions(v.features).reduce((a, b) => a + b, fm.explanationBaseline());
  check(`vector ${i} contributions reconcile to the logit`,
    Math.abs(sum - v.expected_logit) < TOL, `sum ${sum} vs ${v.expected_logit}`);
}
if (model.kind === 'logistic_regression') {
  const v = golden.vectors[0];
  const c = fm.contributions(v.features);
  check('contribution == feature_value * coefficient',
    c.every((x, i) => Math.abs(x - model.coefficients[i] * v.features[i]) < 1e-12));
}

// ---- model loading / version compatibility --------------------------------
const bad = [
  ['unknown kind', { kind: 'neural_net', features: ['a'], threshold_block: 0.5, threshold_review: 0.2 }],
  ['coefficient arity', { kind: 'logistic_regression', features: ['a', 'b'], coefficients: [1], threshold_block: 0.5, threshold_review: 0.2 }],
  ['no features', { kind: 'logistic_regression', features: [], coefficients: [], threshold_block: 0.5, threshold_review: 0.2 }],
  ['threshold not a probability', { kind: 'logistic_regression', features: ['a'], coefficients: [1], threshold_block: 4, threshold_review: 0.2 }],
  ['review above block', { kind: 'logistic_regression', features: ['a'], coefficients: [1], threshold_block: 0.3, threshold_review: 0.9 }],
  ['schema from the future', { schema_version: 999, kind: 'logistic_regression', features: ['a'], coefficients: [1], threshold_block: 0.5, threshold_review: 0.2 }],
];
for (const [name, m] of bad) {
  let threw = false;
  try { fm.validate(m); } catch { threw = true; }
  check(`rejects bad artifact: ${name}`, threw);
}
check('current artifact schema is supported',
  (model.schema_version || 0) <= fm.SUPPORTED_SCHEMA_VERSION);

// ---- missing / invalid features ------------------------------------------
const nasty = [
  ['empty input', {}],
  ['NaN amount', { amountINR: NaN }],
  ['Infinity amount', { amountINR: Infinity }],
  ['negative amount', { amountINR: -5000 }],
  ['string amount', { amountINR: 'not-a-number' }],
  ['null history', { amountINR: 100, recentINR: null }],
  ['NaN inside history', { amountINR: 100, recentINR: [NaN, 5], totalINR24h: NaN }],
  ['50 recent amounts', { amountINR: 100, recentINR: new Array(50).fill(1000) }],
  ['undefined vpa', { amountINR: 100, payerVpa: undefined }],
];
for (const [name, input] of nasty) {
  const x = fm.extractFeatures(input);
  check(`no NaN/Inf features: ${name}`, x.every(Number.isFinite),
    JSON.stringify(x.filter(v => !Number.isFinite(v))));
  const r = fm.scorePaymentML(input);
  check(`score in range: ${name}`, r.score >= 0 && r.score <= 100 && Number.isFinite(r.probability));
}

// ---- extreme amounts ------------------------------------------------------
for (const amt of [0, 1, 500, 1e5, 1e9, 1e15, Number.MAX_VALUE]) {
  const r = fm.scorePaymentML({ amountINR: amt, payerVpa: 'a@okhdfcbank', kycVerified: true, accountAgeMin: 100000, payeeSeenBefore: true });
  check(`extreme amount ${amt} stays bounded`,
    r.score >= 0 && r.score <= 100 && Number.isFinite(r.probability));
}

// ---- threshold behaviour --------------------------------------------------
check('review threshold below block threshold', model.threshold_review < model.threshold_block);
const clean = fm.scorePaymentML({
  amountINR: 5000, payerVpa: 'ravi@okhdfcbank', recentINR: [4800], txnCount10m: 0,
  txnCount24h: 1, totalINR24h: 5000, accountAgeMin: 200000, kycVerified: true,
  hourOfDay: 14, dayOfWeek: 2, payeeSeenBefore: true, balanceBeforeINR: 400000, txnType: 'COLLECT',
});
check('ordinary retail payment is approved', clean.decision === 'APPROVE',
  `got ${clean.decision} score ${clean.score}`);
const mule = fm.scorePaymentML({
  amountINR: 450000, payerVpa: 'x@okaxis', recentINR: [80000, 150000, 300000],
  txnCount10m: 6, txnCount24h: 7, totalINR24h: 1500000, accountAgeMin: 90,
  kycVerified: false, hourOfDay: 3, dayOfWeek: 6, payeeFanIn24h: 22,
  distinctPayees24h: 18, balanceBeforeINR: 1000, txnType: 'TRANSFER',
});
check('mule pattern outscores clean payment', mule.score > clean.score, `${mule.score} vs ${clean.score}`);
check('mule pattern is not approved', mule.decision !== 'APPROVE');

// ---- policy overrides -----------------------------------------------------
const unverified = fm.scorePaymentML({ amountINR: 2000, payerVpa: 'a@okhdfcbank', kycVerified: false, accountAgeMin: 300000, payeeSeenBefore: true, txnCount24h: 1, recentINR: [2000] });
check('KYC-unverified payer is never auto-approved', unverified.decision !== 'APPROVE');
const phish = fm.scorePaymentML({ amountINR: 2000, payerVpa: 'scamster99@okaxis', kycVerified: true, accountAgeMin: 300000, payeeSeenBefore: true, txnCount24h: 1, recentINR: [2000] });
check('phishing-style VPA is never auto-approved', phish.decision !== 'APPROVE');

// ---- contributor ordering -------------------------------------------------
const explained = fm.scorePaymentML({
  amountINR: 47000, payerVpa: 'x@okaxis', recentINR: [46000, 47500, 46500],
  txnCount10m: 3, txnCount24h: 6, totalINR24h: 250000, accountAgeMin: 5000,
  kycVerified: true, hourOfDay: 3, dayOfWeek: 1, txnType: 'TRANSFER', payeeFanIn24h: 4,
});
check('positive contributors are descending',
  explained.topPositive.every((f, i, a) => i === 0 || a[i - 1].weight >= f.weight));
check('positive contributors are all positive', explained.topPositive.every(f => f.weight > 0));
check('negative contributors are all negative', explained.topNegative.every(f => f.weight < 0));
check('model version is reported', typeof explained.modelVersion === 'string' && explained.modelVersion.length > 0);
check('data caveat is reported', typeof explained.dataCaveat === 'string' && /SYNTHETIC/i.test(explained.dataCaveat));

// ---- determinism ----------------------------------------------------------
const first = fm.scorePaymentML(explainedInput());
let stable = true;
for (let i = 0; i < 50; i++) {
  const r = fm.scorePaymentML(explainedInput());
  if (r.score !== first.score || r.probability !== first.probability || r.decision !== first.decision) stable = false;
}
check('scoring is deterministic across 50 runs', stable);
function explainedInput() {
  return { amountINR: 47000, payerVpa: 'x@okaxis', recentINR: [46000, 47500, 46500],
    txnCount10m: 2, txnCount24h: 5, totalINR24h: 180000, accountAgeMin: 5000,
    kycVerified: true, hourOfDay: 3, dayOfWeek: 1 };
}

console.log(`  worst logit diff:        ${worstLogit.toExponential(3)}`);
console.log(`  worst probability diff:  ${worstProb.toExponential(3)}`);
console.log(`  worst contribution diff: ${worstContrib.toExponential(3)}`);
console.log(`\n${passed} checks passed, ${failures.length} failed\n`);
if (failures.length) {
  failures.slice(0, 12).forEach(f => console.error('  FAIL ' + f));
  if (failures.length > 12) console.error(`  ... and ${failures.length - 12} more`);
  process.exit(1);
}
console.log('JS scorer matches scikit-learn exactly.');
