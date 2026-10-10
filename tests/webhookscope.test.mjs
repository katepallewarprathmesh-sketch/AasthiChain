// A bank callback must be authenticated by something.
//
// /api/npci/webhook names its payment in the body, so the path-based payment
// gate never saw it. Any signed-in user could post a SUCCESS callback for a
// stranger's payment and move it to CONFIRMED — the state that asserts the
// money arrived and permits release of tokens — carrying a UTR of their own
// choosing. The capability list advertised this endpoint as auth:
// 'signature', and /webhook/test replied "signature verified in mock mode".
// Neither was true: nothing verified anything.
//
// With NPCI_WEBHOOK_SECRET set, a valid HMAC is accepted as a real bank
// callback. Without it, the endpoint falls back to the same ownership rule
// as every other payment route, and says so.
const API = process.env.API || 'http://localhost:8080';

let pass = 0, fail = 0;
const t = (name, ok, detail) => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};

const tokenFor = (identityId, role = 'Investor', mspId = 'InvestorMSP') =>
  Buffer.from(JSON.stringify({ identityId, mspId, role, exp: Date.now() + 3600000 })).toString('base64');
const I1 = tokenFor('investor1');
const I2 = tokenFor('investor2');

async function call(path, token, init = {}) {
  const headers = { 'Content-Type': 'application/json', ...(init.headers || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(API + path, { ...init, headers });
  let body = null;
  try { body = await res.json(); } catch { /* not json */ }
  return { status: res.status, body };
}

const newPayment = async () => {
  const r = await call('/api/npci/collect', I2, {
    method: 'POST',
    body: JSON.stringify({
      assetId: 'PROP-COLD-CHAIN-NSK-009', tokenAmount: 1, amountINR: 500,
      payerVpa: 'buyer@aasthichain', payeeVpa: 'originator@aasthichain',
    }),
  });
  return r.body && r.body.paymentId ? r.body : null;
};

console.log(`webhook authorisation (${API})`);

const pay = await newPayment();
t('investor2 has a pending payment', !!pay && pay.status === 'PENDING', JSON.stringify(pay && pay.status));
if (!pay) { console.log(`\n${pass} passed, ${fail + 1} failed`); process.exit(1); }

const stateOf = async (id, token = I2) => {
  const r = await call(`/api/npci/payments/${id}`, token);
  return r.body || {};
};

// --- a stranger cannot confirm someone else's payment
const forged = await call('/api/npci/webhook', I1, {
  method: 'POST',
  body: JSON.stringify({ paymentId: pay.paymentId, status: 'SUCCESS', utr: '999999999999', rrn: '888888888888' }),
});
t('a stranger cannot fire a callback for it', forged.status === 403, `got ${forged.status}`);
t('  and is told why', forged.body && forged.body.error === 'ERR_NOT_YOUR_PAYMENT', JSON.stringify(forged.body));

const afterForged = await stateOf(pay.paymentId);
t('the payment is still PENDING', afterForged.status === 'PENDING', `status=${afterForged.status}`);
// The UTR is the bank's reference for money that moved. An attacker-supplied
// one must not have been written anywhere.
t('no attacker UTR was recorded', afterForged.utr !== '999999999999' && afterForged.rrn !== '888888888888',
  `utr=${afterForged.utr} rrn=${afterForged.rrn}`);

const forgedTest = await call('/api/npci/webhook/test', I1, {
  method: 'POST', body: JSON.stringify({ paymentId: pay.paymentId }),
});
t('a stranger cannot use the test callback either', forgedTest.status === 403, `got ${forgedTest.status}`);

// A header that merely looks like a signature must not buy trust.
const bluffed = await call('/api/npci/webhook', I1, {
  method: 'POST',
  headers: { 'x-webhook-signature': 'deadbeef'.repeat(8) },
  body: JSON.stringify({ paymentId: pay.paymentId, status: 'SUCCESS' }),
});
t('a bogus signature header grants nothing', bluffed.status === 403, `got ${bluffed.status}`);

// --- anonymous callers stop at the perimeter, as before
const anon = await fetch(`${API}/api/npci/webhook`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ paymentId: pay.paymentId, status: 'SUCCESS' }),
});
t('an anonymous callback is 401', anon.status === 401, `got ${anon.status}`);

// --- the owner's own callback still works, or the purchase flow is broken
const owned = await call('/api/npci/webhook', I2, {
  method: 'POST',
  body: JSON.stringify({ paymentId: pay.paymentId, status: 'SUCCESS', utr: '123456789012', rrn: '210987654321' }),
});
t('the payment owner can still drive it', owned.status === 200, `got ${owned.status}`);
const confirmed = await stateOf(pay.paymentId);
t('and the payment reaches CONFIRMED', confirmed.status === 'CONFIRMED', `status=${confirmed.status}`);

// --- the advertised auth mode must match reality
const caps = await call('/api/openfinance/capabilities', I2);
const webhookCap = ((caps.body && (caps.body.apis || caps.body.capabilities || caps.body.integrations || [])) || [])
  .find((c) => c && c.endpoint === '/api/npci/webhook');
t('the capability list describes the webhook', !!webhookCap, JSON.stringify(caps.body && Object.keys(caps.body)));
if (webhookCap) {
  const claimsSignature = /^signature/.test(String(webhookCap.auth));
  const secretSet = !!process.env.NPCI_WEBHOOK_SECRET;
  t('it does not claim signature auth unless a secret is configured',
    claimsSignature === secretSet, `auth="${webhookCap.auth}" secret=${secretSet}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
