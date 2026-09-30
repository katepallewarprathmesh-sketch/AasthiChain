#!/usr/bin/env node
/**
 * Pins the JS fraud scorer to scikit-learn's output.
 *
 * The model is trained in Python and served in Go and JS. Three
 * implementations of the same arithmetic will drift unless something forces
 * them not to. This asserts the JS implementation reproduces every golden
 * probability and every per-feature contribution to 1e-9; Go's
 * TestGoldenVectors asserts the same thing on the same vectors.
 *
 * Usage: node scripts/fraud-model-parity.mjs
 */

import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { probability, contributions, loadModel, extractFeatures } = require('../lib/fraud-model.js');

const TOL = 1e-9;
const golden = JSON.parse(fs.readFileSync(
  path.join(process.cwd(), 'ml', 'model', 'golden_vectors.json'), 'utf8'));
const model = loadModel();

let passed = 0;
const failures = [];

function check(name, cond, detail = '') {
  if (cond) { passed++; } else { failures.push(`${name}${detail ? ' — ' + detail : ''}`); }
}

console.log(`\nFraud model parity → ${model.name}`);
console.log(`  ${model.n_trees} trees, ${model.features.length} features, tolerance ${TOL}\n`);

if (golden.model !== model.name) {
  console.error(`FAIL: golden vectors are for ${golden.model}, model is ${model.name} — re-export`);
  process.exit(1);
}

let worstProb = 0;
let worstContrib = 0;

for (const [i, v] of golden.vectors.entries()) {
  const p = probability(v.features);
  const dp = Math.abs(p - v.expected_probability);
  if (dp > worstProb) worstProb = dp;
  check(`vector ${i} probability`, dp <= TOL,
    `got ${p} expected ${v.expected_probability} (diff ${dp.toExponential(3)})`);

  const c = contributions(v.features);
  for (let j = 0; j < c.length; j++) {
    const dc = Math.abs(c[j] - v.expected_contributions[j]);
    if (dc > worstContrib) worstContrib = dc;
    check(`vector ${i} contribution ${model.features[j]}`, dc <= TOL,
      `got ${c[j]} expected ${v.expected_contributions[j]}`);
  }
}

// Contributions must reconcile to the score an analyst was shown.
for (const [i, v] of golden.vectors.entries()) {
  const sum = contributions(v.features).reduce((a, b) => a + b, model.explain_base);
  const raw = Math.log(v.expected_probability / (1 - v.expected_probability));
  check(`vector ${i} contributions reconcile`, Math.abs(sum - raw) < 1e-7,
    `sum ${sum} vs raw ${raw}`);
}

// Feature arity must match, or the JS extractor has drifted from training.
const x = extractFeatures({
  amountINR: 1000, payerVpa: 'a@b', recentINR: [], txnCount10m: 0, txnCount24h: 0,
  totalINR24h: 0, accountAgeMin: 100, kycVerified: true, hourOfDay: 12,
});
check('extractFeatures arity matches model', x.length === model.features.length,
  `got ${x.length} expected ${model.features.length}`);

// Math.fround must actually narrow, or sklearn parity breaks silently.
check('Math.fround narrows to float32', Math.fround(0.1 + 0.2) !== (0.1 + 0.2));

console.log(`  worst probability diff:  ${worstProb.toExponential(3)}`);
console.log(`  worst contribution diff: ${worstContrib.toExponential(3)}`);
console.log(`\n${passed} checks passed, ${failures.length} failed\n`);

if (failures.length) {
  failures.slice(0, 10).forEach(f => console.error('  FAIL ' + f));
  if (failures.length > 10) console.error(`  ... and ${failures.length - 10} more`);
  process.exit(1);
}
console.log('JS scorer matches scikit-learn exactly.');
