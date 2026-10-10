// Reading one payment has been owner-checked since the payment audit. The
// lists were not.
//
// GET /api/npci/payments handed every signed-in user the whole book: who
// paid whom, how much, which VPAs, which UTRs. GET /api/npci/webhooks did
// the same for the bank callback trail. An attacker did not need to guess a
// payment id — the server offered the lot.
import { randomBytes } from 'node:crypto';

const API = process.env.API || 'http://localhost:8080';

let pass = 0, fail = 0;
const t = (name, ok, detail) => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};

const tokenFor = (identityId, role, mspId) =>
  Buffer.from(JSON.stringify({ identityId, mspId, role, exp: Date.now() + 3600000 })).toString('base64');
const INVESTOR1 = tokenFor('investor1', 'Investor', 'InvestorMSP');
const INVESTOR2 = tokenFor('investor2', 'Investor', 'InvestorMSP');
const ORIGINATOR = tokenFor('originator1', 'Originator', 'OriginatorMSP');
const REGULATOR = tokenFor('regulator1', 'Regulator', 'RegulatorMSP');

async function call(path, token, init = {}) {
  const res = await fetch(API + path, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(init.headers || {}) },
  });
  let body = null;
  try { body = await res.json(); } catch { /* not json */ }
  return { status: res.status, body };
}

console.log(`payment list scope (${API})`);

// A property of our own, so the primary sale is open on either backend.
const reg = await call('/api/properties', ORIGINATOR, {
  method: 'POST',
  body: JSON.stringify({
    title: `List Scope ${randomBytes(3).toString('hex')}`,
    state: 'Maharashtra', city: 'Pune', pincode: '411001', valuationINR: 5000000,
    documentHash: randomBytes(32).toString('hex'),
  }),
});
const assetId = reg.body && (reg.body.assetId || (reg.body.property && reg.body.property.assetId));
await call(`/api/properties/${assetId}/validate`, tokenFor('registrar1', 'Registrar', 'RegistrarMSP'), {
  method: 'POST', body: JSON.stringify({ decision: 'VALIDATED', notes: 'list scope fixture' }),
});
await call(`/api/properties/${assetId}/mint`, ORIGINATOR, { method: 'POST', body: JSON.stringify({ totalTokens: 2000 }) });

const collected = await call('/api/npci/collect', INVESTOR1, {
  method: 'POST',
  body: JSON.stringify({
    assetId, amountINR: 7500, tokenAmount: 15,
    payerVpa: 'buyer@aasthichain', payeeVpa: 'originator@aasthichain',
  }),
});
const paymentId = collected.body && (collected.body.paymentId || (collected.body.payment && collected.body.payment.paymentId));
t('investor1 has a payment on the book', !!paymentId, `got ${collected.status}`);

const has = (body, id) => Array.isArray(body && body.payments) && body.payments.some((p) => p.paymentId === id);

// ---- the hole
const outsider = await call('/api/npci/payments', INVESTOR2);
t('the list is still readable', outsider.status === 200, `got ${outsider.status}`);
t('but a stranger does not see someone elses payment', !has(outsider.body, paymentId),
  JSON.stringify((outsider.body.payments || []).map((p) => p.paymentId)).slice(0, 160));
t('and no stranger payment leaks any VPA',
  (outsider.body.payments || []).every((p) => p.payerId === 'investor2' || p.payeeId === 'investor2'),
  JSON.stringify((outsider.body.payments || []).map((p) => [p.payerId, p.payeeId])).slice(0, 160));

// ---- the people it belongs to
t('the payer sees their own payment', has((await call('/api/npci/payments', INVESTOR1)).body, paymentId));
t('a regulator sees it too', has((await call('/api/npci/payments', REGULATOR)).body, paymentId));

// ---- the callback audit trail
await call('/api/npci/webhook', INVESTOR1, {
  method: 'POST',
  body: JSON.stringify({ paymentId, status: 'SUCCESS', utr: 'UTR' + randomBytes(4).toString('hex').toUpperCase() }),
});
const hooksOutsider = await call('/api/npci/webhooks', INVESTOR2);
const mentions = (body, id) => Array.isArray(body && body.webhooks) && body.webhooks.some((w) => w.paymentId === id);
t('a stranger sees no callbacks for that payment', !mentions(hooksOutsider.body, paymentId),
  JSON.stringify((hooksOutsider.body.webhooks || []).map((w) => w.paymentId)).slice(0, 160));
t('a regulator still sees the full callback trail', mentions((await call('/api/npci/webhooks', REGULATOR)).body, paymentId));

// Scoping a list must not turn into pretending the route is gone.
t('an outsider still gets a well-formed empty-ish list',
  Array.isArray(hooksOutsider.body.webhooks) && typeof hooksOutsider.body.count === 'number');

// ---- the settlement trace
// It names the VPAs, the UTR, the RRN and the fraud score, and with no
// paymentId it used to hand back the newest payment on the platform.
const traceNamed = await call(`/api/drunix/ledger?paymentId=${encodeURIComponent(paymentId)}`, INVESTOR2);
t('a stranger cannot trace someone elses payment', traceNamed.status === 403, `got ${traceNamed.status}`);
const traceDefault = await call('/api/drunix/ledger', INVESTOR2);
t('and the no-argument trace does not fall back to theirs',
  traceDefault.status === 404 || (traceDefault.body && traceDefault.body.paymentId !== paymentId),
  `${traceDefault.status} ${JSON.stringify(traceDefault.body).slice(0, 120)}`);
t('the payer can still trace their own',
  (await call(`/api/drunix/ledger?paymentId=${encodeURIComponent(paymentId)}`, INVESTOR1)).status === 200);
t('and a regulator can trace any',
  (await call(`/api/drunix/ledger?paymentId=${encodeURIComponent(paymentId)}`, REGULATOR)).status === 200);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
