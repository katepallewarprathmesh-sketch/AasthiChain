// The trained payment risk model.
//
// The rules in the rail are hand-written: a person decided that six payments
// in ten minutes looks wrong. That is useful and it is not machine learning.
// This suite covers the thing that is: a classifier fitted on a labelled
// dataset, shipped with the coefficients and with the numbers it scored on
// data it never saw.
//
// What these checks defend is mostly honesty. The service must publish the
// metrics rather than assert quality, must say the training data is
// synthetic, and must never let an advisory score take a decision away from
// the published rules.
//
//   node tests/riskmodel.test.mjs          (RAIL=http://localhost:21100)

const RAIL = process.env.RAIL || 'http://localhost:21100';
let passed = 0, failed = 0;
const ok = (name, cond, detail) => {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failed++; console.log('  FAIL ' + name + (detail ? '\n       ' + detail : '')); }
};

const rail = async (path, init) => {
  const r = await fetch(RAIL + path, init);
  const text = await r.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, body };
};
const post = (path, payload) => rail(path, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(payload),
});

const clean = {
  payment: { paymentId: 'PAY-T-CLEAN', payerId: 'investor1', amountINR: 42000, createdAt: '2026-06-01T08:30:00Z' },
  history: {
    txnCount10m: 0, txnCount24h: 1, totalINR24h: 86000,
    recentINR: [38000, 44000, 51000, 36000], accountAgeMin: 400000, kycVerified: true,
  },
};
const structured = {
  payment: { paymentId: 'PAY-T-STRUCT', payerId: 'investor9', amountINR: 48500, createdAt: '2026-06-01T21:00:00Z' },
  history: {
    txnCount10m: 6, txnCount24h: 17, totalINR24h: 790000,
    recentINR: [48000, 48900, 47800, 49100, 48200, 48700], accountAgeMin: 90, kycVerified: false,
  },
};

const run = async () => {
  console.log('Trained payment risk model');

  // 1. The model card is public: anybody being scored can read what by.
  const card = await rail('/fraud/model');
  ok('the model card is published', card.status === 200 && card.body.available === true,
    JSON.stringify(card.body).slice(0, 160));
  const m = card.body || {};
  ok('it names the kind of model', typeof m.kind === 'string' && /logistic/i.test(m.kind), m.kind);
  ok('it publishes every coefficient',
    Array.isArray(m.weights) && m.weights.length >= 8 && m.weights.every((w) => typeof w.coefficient === 'number'));
  ok('every feature is explained in words',
    Array.isArray(m.weights) && m.weights.every((w) => typeof w.means === 'string' && w.means.length > 10));

  // 2. Metrics are measured on held-out rows, and are short of perfect.
  const mm = m.metrics || {};
  ok('it reports held-out AUC, precision and recall',
    typeof mm.auc === 'number' && typeof mm.precision === 'number' && typeof mm.recall === 'number',
    JSON.stringify(mm));
  ok('the held-out split is real', (mm.holdoutRows || 0) > 500 && (mm.trainRows || 0) >= (mm.holdoutRows || 0),
    `train ${mm.trainRows} holdout ${mm.holdoutRows}`);
  ok('the score is good enough to publish and short of perfect',
    mm.auc > 0.7 && mm.auc < 0.99, String(mm.auc));

  // 3. Synthetic data is declared, not glossed over.
  ok('the training data is declared synthetic', /synthetic/i.test(String(m.dataSource)), String(m.dataSource));
  ok('the limits of the model are published',
    Array.isArray(m.limits) && m.limits.length >= 3 && m.limits.some((l) => /advisory/i.test(l)));
  ok('retraining is documented', /trainrisk/.test(String(m.retrain)));

  // 4. It separates the two shapes it was trained to separate.
  const a = await post('/fraud/assess', clean);
  const b = await post('/fraud/assess', structured);
  ok('an ordinary payment is assessed', a.status === 200 && a.body.model, JSON.stringify(a.body).slice(0, 160));
  ok('a structuring burst is assessed', b.status === 200 && b.body.model);
  ok('the structuring burst scores higher than the ordinary payment',
    b.body.model.probability > a.body.model.probability,
    `${b.body?.model?.probability} vs ${a.body?.model?.probability}`);
  ok('the ordinary payment stays in the low band', a.body.model.band === 'LOW', a.body?.model?.band);

  // 5. Every score explains itself.
  ok('the score names the features that moved it',
    Array.isArray(b.body.model.contributions) && b.body.model.contributions.length > 0
      && b.body.model.contributions.every((c) => c.feature && typeof c.contribution === 'number'));
  ok('each contribution says which way it pushed',
    b.body.model.contributions.every((c) => /raises|lowers/.test(String(c.direction))));
  ok('the score repeats that it is advisory', /advisory/i.test(String(b.body.model.note)));

  // 6. The rules keep the decision. A model trained on invented data does
  //    not get to stop anybody's money.
  const rulesOnly = await post('/fraud/score', structured);
  ok('the rules endpoint is untouched', rulesOnly.status === 200 && typeof rulesOnly.body.decision === 'string');
  ok('the combined assessment decides exactly what the rules decided',
    b.body.decision === rulesOnly.body.decision && a.body.decision === a.body.rules.decision,
    `${b.body.decision} vs ${rulesOnly.body.decision}`);
  ok('the assessment says who decided', /rules/i.test(String(b.body.decidedBy)));
  ok('agreement between the two is reported',
    ['AGREE_RISKY', 'AGREE_CLEAN', 'MODEL_ONLY', 'RULES_ONLY'].includes(b.body.agreement), b.body.agreement);

  // 7. Determinism: an audit of a past decision has to reproduce it.
  const again = await post('/fraud/assess', structured);
  ok('the same payment scores the same twice',
    again.body.model.probability === b.body.model.probability);

  // 8. The rules config must no longer describe itself as machine learning.
  const cfg = await rail('/fraud/config');
  ok('the rules engine does not call itself AI',
    cfg.status === 200 && !/\bML-pluggable\b/i.test(JSON.stringify(cfg.body)),
    JSON.stringify(cfg.body).slice(0, 160));

  // 9. The committed weights are a fitted file, not a placeholder.
  const { readFileSync } = await import('node:fs');
  const weights = JSON.parse(readFileSync(new URL('../drunix-gateway/riskmodel.json', import.meta.url), 'utf8'));
  ok('the weights file carries a fitted bias and standardisation',
    weights.bias !== 0 && weights.features.every((f) => f.stdDev > 0 && f.weight !== 0));
  ok('the weights file records the seed and epochs that produced it',
    typeof weights.seed === 'number' && weights.epochs > 0);

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
};

run().catch((e) => { console.error(e); process.exit(1); });
