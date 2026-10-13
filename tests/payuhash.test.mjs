// PayU reverse-hash verification — all four documented shapes.
//
// The callback is the only place a stranger can tell us money arrived, so the
// hash check is the whole security boundary. It is also the place where being
// too strict costs real money: PayU has already taken the payment by then, so
// a rejected callback leaves the purchase PENDING for ever and nobody is told.
//
// PayU documents four reverse-hash formulas, and which one arrives depends on
// features switched on for the MERCHANT ACCOUNT — a dashboard toggle, no code
// change on our side:
//   sha512(SALT|status||||||udf5..udf1|email|firstname|productinfo|amount|txnid|key)
//   sha512(additional_charges|SALT|status|…)
//   sha512(SALT|status|splitInfo|…)
//   sha512(additional_charges|SALT|status|splitInfo|…)
// We verified only the first. The others would have been 403'd.
//
// This suite signs payloads the way PayU would and checks each shape is
// accepted — and, just as importantly, that a tampered one still is not.
import crypto from 'node:crypto';

let pass = 0, fail = 0;
const t = (name, ok, detail) => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};

console.log('PayU reverse hash');

// The verifier is not exported (the handler file boots a whole server), so the
// function under test is read out of the source and evaluated. That keeps the
// test honest: it exercises the exact text that ships, not a copy.
const { readFileSync } = await import('node:fs');
const src = readFileSync(new URL('../frontend/api/index.js', import.meta.url), 'utf8');
const slice = (name) => {
  const i = src.indexOf(`function ${name}(`);
  if (i < 0) throw new Error(`${name} not found in the serverless handler`);
  return src.slice(i, src.indexOf('\n}\n', i) + 3);
};
const verifyPayUResponse = new Function('crypto',
  `${slice('payuResponseHash')}\n${slice('verifyPayUResponse')}\nreturn verifyPayUResponse;`)(crypto);

const SALT = 'testsalt123';
const KEY = 'testkey';
const base = {
  status: 'success', email: 'buyer@example.com', firstname: 'Asha',
  productinfo: 'PROP-GREEN-VALLEY-PUNE-001', amount: '5000.00', txnid: 'NPCI-ABC123',
  key: KEY, udf1: 'asset', udf2: '', udf3: '', udf4: '', udf5: '',
};

const sha512 = (s) => crypto.createHash('sha512').update(s).digest('hex');
const sign = (p, { additionalCharges, splitInfo } = {}) => {
  const head = [SALT, p.status];
  if (splitInfo) head.push(splitInfo);
  const parts = [...head, '', '', '', '', '', p.udf5, p.udf4, p.udf3, p.udf2, p.udf1,
    p.email, p.firstname, p.productinfo, p.amount, p.txnid, p.key];
  if (additionalCharges) parts.unshift(additionalCharges);
  return sha512(parts.join('|'));
};

// 1 · the ordinary callback
t('a plain callback verifies',
  verifyPayUResponse({ ...base, hash: sign(base) }, KEY, SALT).ok === true);
t('and reports which formula matched',
  verifyPayUResponse({ ...base, hash: sign(base) }, KEY, SALT).variant === 'generic');

// 2 · additional charges — the merchant-account toggle that used to break us
const addl = { ...base, additional_charges: '25.00' };
t('a callback carrying additional_charges verifies',
  verifyPayUResponse({ ...addl, hash: sign(addl, { additionalCharges: '25.00' }) }, KEY, SALT).ok === true,
  'this is the shape that would have been rejected after a dashboard change');
t('PayU\'s camelCase spelling is accepted too',
  verifyPayUResponse({ ...base, additionalCharges: '25.00', hash: sign(base, { additionalCharges: '25.00' }) }, KEY, SALT).ok === true);

// 3 · split settlements
const split = { ...base, splitInfo: '{"a":1}' };
t('a split-settlement callback verifies',
  verifyPayUResponse({ ...split, hash: sign(split, { splitInfo: '{"a":1}' }) }, KEY, SALT).ok === true);

// 4 · both at once
const both = { ...base, additional_charges: '25.00', splitInfo: '{"a":1}' };
t('both together verify',
  verifyPayUResponse({ ...both, hash: sign(both, { additionalCharges: '25.00', splitInfo: '{"a":1}' }) }, KEY, SALT).ok === true);

// ---- and none of that may loosen the check
t('a forged hash is still rejected',
  verifyPayUResponse({ ...base, hash: 'f'.repeat(128) }, KEY, SALT).ok === false);
t('a tampered amount invalidates the signature',
  verifyPayUResponse({ ...base, amount: '1.00', hash: sign(base) }, KEY, SALT).ok === false,
  'the amount is what the ledger settles against');
t('a tampered status invalidates the signature',
  verifyPayUResponse({ ...base, status: 'success', hash: sign({ ...base, status: 'failure' }) }, KEY, SALT).ok === false);
t('the wrong salt fails',
  verifyPayUResponse({ ...base, hash: sign(base) }, KEY, 'othersalt').ok === false);
t('a missing hash fails instead of throwing',
  verifyPayUResponse({ ...base }, KEY, SALT).ok === false);
t('a short hash fails instead of throwing',
  verifyPayUResponse({ ...base, hash: 'abc' }, KEY, SALT).ok === false,
  'timingSafeEqual throws on unequal lengths');
t('declaring additional_charges without signing them does not help an attacker',
  verifyPayUResponse({ ...base, additional_charges: '25.00', hash: sign(base, { additionalCharges: '99.00' }) }, KEY, SALT).ok === false);

// ---- the two implementations must not drift again
const rig = readFileSync(new URL('../mock-api-server.js', import.meta.url), 'utf8');
const norm = (txt) => txt.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('//')).join('\n');
const rigSlice = (name) => {
  const i = rig.indexOf(`function ${name}(`);
  return i < 0 ? '' : rig.slice(i, rig.indexOf('\n}\n', i) + 3);
};
t('the CI rig verifies callbacks exactly like production does',
  norm(slice('payuResponseHash') + slice('verifyPayUResponse')) === norm(rigSlice('payuResponseHash') + rigSlice('verifyPayUResponse')),
  'the two implementations have drifted — one of them is now wrong');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
