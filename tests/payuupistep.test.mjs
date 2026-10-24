// One step to pay, not three.
//
// WHAT WAS WRONG
// The checkout posts to PayU's hosted page with pg=UPI and bankcode=UPI, and
// with the payer's UPI ID in the vpa parameter. Those two choose a category;
// they do not choose what the page shows inside it. So a payer who had
// already typed their UPI ID on our screen was then asked which UPI app they
// wanted, and only after that was given the UPI ID field, restating a choice
// the merchant had already made twice. Three screens for a collect request
// that was fully specified before the first one.
//
// PayU's documented levers for its hosted page are enforce_paymethod (which
// categories may appear at all) and drop_category (which options inside a
// category to hide). Both are now sent, which leaves the UPI ID field as the
// only thing on the page, prefilled from vpa.
//
// WHY THESE ASSERTIONS AND NOT A CLICK-THROUGH
// PayU's page is PayU's. Nothing here can prove what it renders; what it can
// prove is that the request carries the parameters their documentation says
// control it, that the signature is unaffected, that an operator can retune
// the list without a code change, and that the second copy of this function
// did not get left behind. The last one is not hypothetical: this repository
// carries two implementations of the same checkout and they have drifted
// before.
//
//   node tests/payuupistep.test.mjs

import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const t = (name, ok, detail) => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ''}`); }
};

console.log('\nPayU: landing on the UPI ID field\n');

// Lift the real function out of each implementation, the way payuhash does,
// so the thing under test is the text that ships.
const load = (rel) => {
  const src = readFileSync(new URL('../' + rel, import.meta.url), 'utf8');
  const slice = (name) => {
    const i = src.indexOf(`function ${name}(`);
    if (i < 0) throw new Error(`${name} not found in ${rel}`);
    return src.slice(i, src.indexOf('\n}\n', i) + 3);
  };
  return new Function('crypto', 'process',
    `${slice('payuRequestHash')}\n${slice('buildPayUCheckout')}\nreturn buildPayUCheckout;`,
  )(crypto, process);
};

const payu = { key: 'TESTKEY', salt: 'TESTSALT', base: 'https://test.payu.in' };
const pay = { paymentId: 'PAY-1', upiTxnId: 'UPI-1' };
const order = {
  assetId: 'PROP-1', tokenAmount: 10, amountINR: 5000, payerVpa: 'buyer@okhdfcbank',
  payeeVpa: 'seller@okaxis', note: 'ten tokens', idemKey: 'idem-1',
};
const build = (impl, env = {}) => {
  const saved = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    if (v === null) delete process.env[k]; else process.env[k] = v;
  }
  try { return impl(payu, pay, order, 'https://example.test'); }
  finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
};

const handler = load('frontend/api/index.js');
const mock = load('mock-api-server.js');

// --- the default: one screen ---------------------------------------------
const d = build(handler, { PAYU_PIN_UPI: null, PAYU_ENFORCE_PAYMETHOD: null, PAYU_DROP_CATEGORY: null }).params;

t('UPI is the category', d.pg === 'UPI' && d.bankcode === 'UPI');
t('the payer\'s UPI ID is sent, so the field arrives prefilled',
  d.vpa === 'buyer@okhdfcbank');
t('no other payment category may appear', d.enforce_paymethod === 'upi',
  `enforce_paymethod=${d.enforce_paymethod}`);
t('the app tiles inside UPI are dropped, leaving the UPI ID field',
  typeof d.drop_category === 'string' && d.drop_category.includes('UPI|'),
  `drop_category=${d.drop_category}`);

// The tiles that caused the extra screen, each named.
for (const app of ['TEZ', 'PHONEPE', 'PAYTM', 'BHIM', 'AMAZONPAY', 'CRED', 'INTENT']) {
  t(`the ${app} tile is dropped`, d.drop_category.split(',').includes(`UPI|${app}`));
}
t('every dropped entry is scoped to the UPI category',
  d.drop_category.split(',').every((e) => e.startsWith('UPI|')),
  'dropping outside UPI would hide options enforce_paymethod has already removed');

// --- the signature is untouched ------------------------------------------
// enforce_paymethod and drop_category are not in PayU's hash sequence. If
// adding them changed the hash, every transaction would be rejected, so this
// is the assertion that matters most.
const expected = crypto.createHash('sha512').update([
  payu.key, pay.paymentId, '5000.00',
  'ten tokens', 'buyer', 'buyer@aasthichain.demo',
  'PROP-1', '10', 'UPI-1', 'seller@okaxis', 'idem-1',
  '', '', '', '', '', payu.salt,
].join('|')).digest('hex');
t('the request hash is exactly what PayU expects', d.hash === expected,
  `got ${String(d.hash).slice(0, 24)}…`);

const withoutPinning = build(handler, { PAYU_PIN_UPI: 'false' }).params;
t('pinning off and pinning on produce the same hash', withoutPinning.hash === d.hash,
  'the new parameters are outside the signed sequence');

// --- an operator can retune it without a deploy --------------------------
const noDrop = build(handler, { PAYU_DROP_CATEGORY: '' }).params;
t('PAYU_DROP_CATEGORY="" restores the app tiles', noDrop.drop_category === undefined);
t('and still keeps the page to one category', noDrop.enforce_paymethod === 'upi',
  'a merchant whose tiles are wanted should not get cards back as well');

const custom = build(handler, { PAYU_DROP_CATEGORY: 'UPI|TEZ', PAYU_ENFORCE_PAYMETHOD: 'upi|netbanking' }).params;
t('both lists are overridable for an account with different options enabled',
  custom.drop_category === 'UPI|TEZ' && custom.enforce_paymethod === 'upi|netbanking');

const full = build(handler, { PAYU_PIN_UPI: 'false' }).params;
t('PAYU_PIN_UPI=false still means the full PayU menu, untouched',
  full.pg === undefined && full.enforce_paymethod === undefined && full.drop_category === undefined);

// --- the other implementation did not get left behind --------------------
const m = build(mock, { PAYU_PIN_UPI: null, PAYU_ENFORCE_PAYMETHOD: null, PAYU_DROP_CATEGORY: null }).params;
const differing = [...new Set([...Object.keys(d), ...Object.keys(m)])]
  .filter((k) => d[k] !== m[k]);
t('both checkout implementations build the identical request', differing.length === 0,
  differing.map((k) => `${k}: ${d[k]} vs ${m[k]}`).join('; '));

// --- the screen no longer walks the payer through removed steps ----------
const ui = readFileSync(new URL('../frontend/src/components/PayUCheckout.jsx', import.meta.url), 'utf8');
t('the instructions no longer tell the payer to choose a method first',
  !/choose <strong>UPI ID/.test(ui),
  'copy describing a step that no longer exists is worse than no copy');
t('the screen says where PayU will land', /straight on the UPI ID field/.test(ui));

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
