// POST /api/payments/confirm was a confirmation oracle.
//
// It read transferId, amountINR and method out of the request body, hashed
// the three of them together, and answered:
//
//   { confirmationId: "PAY-…", paymentHash: "…", status: "CONFIRMED" }
//
// No payment was looked up. No state was read or written. The caller was
// never compared to anyone. Any signed-in user could ask for a confirmation
// of any reference, for any amount, and get back something that looks exactly
// like proof the platform settled it — including for a payment belonging to
// someone else, and for references that never existed.
//
// It is removed rather than scoped: even restricted to the payer, it would
// still be a receipt for a payment nobody checked. Proof comes from the
// payment record — approval issues a UTR, and /api/npci/utr/{utr} shows it.
import { randomBytes } from 'node:crypto';

const API = process.env.API || 'http://localhost:8080';

let pass = 0, fail = 0;
const t = (name, ok, detail) => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};

const tokenFor = (identityId, role) =>
  Buffer.from(JSON.stringify({ identityId, mspId: 'M', role, exp: Date.now() + 3600000 })).toString('base64');
const ORIGINATOR = tokenFor('originator1', 'Originator');
const REGISTRAR = tokenFor('registrar1', 'Registrar');
const PAYER = tokenFor('investor2', 'Investor');
const STRANGER = tokenFor('investor1', 'Investor');

async function call(path, token, init = {}) {
  const headers = { 'Content-Type': 'application/json', ...(init.headers || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(API + path, { ...init, headers });
  let body = null;
  try { body = await res.json(); } catch { /* not json */ }
  return { status: res.status, body, raw: JSON.stringify(body || {}) };
}
const post = (path, token, payload) =>
  call(path, token, { method: 'POST', body: JSON.stringify(payload || {}) });

console.log(`Payment confirmation (${API})`);

// ---- the oracle is gone, for everyone
const anon = await post('/api/payments/confirm', null, { transferId: 'ANY', amountINR: 9999999, method: 'UPI' });
t('an anonymous caller gets no confirmation', anon.status === 404 || anon.status === 401, `got ${anon.status}`);

const signedIn = await post('/api/payments/confirm', STRANGER, {
  transferId: 'TRF-DOES-NOT-EXIST', amountINR: 9999999, method: 'UPI',
});
t('a signed-in caller gets no confirmation either', signedIn.status === 404, `got ${signedIn.status}`);
t('nothing comes back saying CONFIRMED', !/CONFIRMED/.test(signedIn.raw), signedIn.raw.slice(0, 160));
t('and no confirmation id or payment hash is issued',
  !/confirmationId|paymentHash/.test(signedIn.raw), signedIn.raw.slice(0, 160));

// ---- the real path still issues real proof
const documentHash = randomBytes(32).toString('hex');
const created = await post('/api/properties', ORIGINATOR, {
  address: 'Confirmation Proof House, Pune', valuationINR: 5000000, documentHash, totalTokens: 10000,
});
const asset = created.body && (created.body.property?.assetId || created.body.assetId || created.body.property?.id);

if (!asset) {
  console.log('  could not mint a fixture asset — skipping the positive half');
} else {
  await post(`/api/properties/${asset}/validate`, REGISTRAR, { decision: 'VALIDATED' });
  await post(`/api/properties/${asset}/mint`, ORIGINATOR, { totalTokens: 10000 });

  const collected = await post('/api/npci/collect', PAYER, {
    assetId: asset, amountINR: 5000, tokenAmount: 10,
    payerVpa: 'investor2@upi', payeeVpa: 'owner@upi',
  });
  const paymentId = collected.body && collected.body.paymentId;
  t('a payment can still be raised', !!paymentId, collected.raw.slice(0, 160));

  if (paymentId) {
    const approved = await post(`/api/npci/payments/${paymentId}/approve`, PAYER, { payerId: 'investor2' });
    const utr = approved.body && (approved.body.utr || approved.body.payment?.utr);
    t('approval issues a UTR', !!utr, approved.raw.slice(0, 200));

    if (utr) {
      const receipt = await call(`/api/npci/utr/${utr}`, PAYER);
      t('the UTR reads back as a real receipt',
        receipt.status === 200 && /CONFIRMED|RELEASED|SETTLED/.test(receipt.raw), `${receipt.status} ${receipt.raw.slice(0, 160)}`);
      t('the receipt is tied to the payment, not to numbers in a request body',
        receipt.raw.includes(paymentId), receipt.raw.slice(0, 200));
    }
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
