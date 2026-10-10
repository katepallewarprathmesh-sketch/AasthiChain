// Two more places where the caller was never checked.
//
// 1. POST /api/npci/payu/reconcile names its payment in the request BODY.
//    The payment gate matches on the URL, so it never saw this route — the
//    same blind spot the bank webhook had. Reconciliation is not read-only:
//    when it comes back CONFIRMED the server settles the purchase and moves
//    tokens. Any signed-in user could force a stranger's payment through.
//
// 2. Verification codes are six digits and nothing counted wrong guesses,
//    so the whole space could be walked in seconds. The code was also
//    matched on identifier alone, never on who asked for it, so whoever
//    guessed it got the verification.
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

console.log(`reconcile + verification scope (${API})`);

// ---- 1. reconciliation of someone else's payment
// The seeded catalogue differs between the two backends and its headline
// property can be fully subscribed, so the suite lists its own.
const ORIGINATOR = tokenFor('originator1', 'Originator', 'OriginatorMSP');
const reg = await call('/api/properties', ORIGINATOR, {
  method: 'POST',
  body: JSON.stringify({
    title: `Reconcile Scope ${randomBytes(3).toString('hex')}`,
    state: 'Maharashtra', city: 'Pune', pincode: '411001', valuationINR: 5000000,
    documentHash: randomBytes(32).toString('hex'),
  }),
});
const assetId = reg.body && (reg.body.assetId || (reg.body.property && reg.body.property.assetId));
await call(`/api/properties/${assetId}/validate`, tokenFor('registrar1', 'Registrar', 'RegistrarMSP'), {
  method: 'POST', body: JSON.stringify({ decision: 'VALIDATED', notes: 'reconcile scope fixture' }),
});
await call(`/api/properties/${assetId}/mint`, ORIGINATOR, {
  method: 'POST', body: JSON.stringify({ totalTokens: 2000 }),
});

const collected = await call('/api/npci/collect', INVESTOR1, {
  method: 'POST',
  body: JSON.stringify({
    assetId, amountINR: 5000, tokenAmount: 10,
    payerVpa: 'buyer@aasthichain', payeeVpa: 'originator@aasthichain',
  }),
});
const paymentId = collected.body && (collected.body.paymentId || (collected.body.payment && collected.body.payment.paymentId));
t('investor1 can start a payment', !!paymentId, `got ${collected.status} ${JSON.stringify(collected.body).slice(0, 120)}`);

if (paymentId) {
  const before = (await call(`/api/npci/payments/${paymentId}`, INVESTOR1)).body;

  const stranger = await call('/api/npci/payu/reconcile', INVESTOR2, {
    method: 'POST', body: JSON.stringify({ paymentId }),
  });
  t('a stranger cannot reconcile it', stranger.status === 403, `got ${stranger.status} ${JSON.stringify(stranger.body).slice(0, 120)}`);
  t('  refused as not-your-payment', stranger.body && stranger.body.error === 'ERR_NOT_YOUR_PAYMENT',
    JSON.stringify(stranger.body));

  const after = (await call(`/api/npci/payments/${paymentId}`, INVESTOR1)).body;
  t('the payment is unchanged by the refusal',
    after && before && after.status === before.status && !after.utr,
    `${before && before.status} -> ${after && after.status}`);

  // The payer themselves is allowed through to the handler. PayU is not
  // configured in the test rig, so the honest answer there is "bridge not
  // active" — what matters is that it is not a 403.
  const owner = await call('/api/npci/payu/reconcile', INVESTOR1, {
    method: 'POST', body: JSON.stringify({ paymentId }),
  });
  t('the payer is not turned away', owner.status !== 403, `got ${owner.status}`);
  const supervisor = await call('/api/npci/payu/reconcile', REGULATOR, {
    method: 'POST', body: JSON.stringify({ paymentId }),
  });
  t('nor is a regulator', supervisor.status !== 403, `got ${supervisor.status}`);
}

// An unknown payment id must not become a 403 that confirms nothing exists.
const ghost = await call('/api/npci/payu/reconcile', INVESTOR2, {
  method: 'POST', body: JSON.stringify({ paymentId: 'PAY-does-not-exist' }),
});
t('an unknown payment id is not a 403', ghost.status !== 403, `got ${ghost.status}`);

// ---- 2. verification codes
const ident = `probe-${Date.now()}@aasthichain.test`;
const issued = await call('/api/auth/verification', INVESTOR1, {
  method: 'POST', body: JSON.stringify({ identifier: ident }),
});
t('a verification code can be requested', issued.status === 201, `got ${issued.status}`);
t('  and the code itself is never returned',
  issued.body && !('value' in issued.body) && !JSON.stringify(issued.body).match(/\b\d{6}\b/),
  JSON.stringify(issued.body));

// Guessing must get expensive almost immediately.
let sawRefusal = false;
for (let i = 0; i < 8; i++) {
  const guess = await call('/api/auth/verification/verify', INVESTOR2, {
    method: 'POST', body: JSON.stringify({ identifier: ident, value: String(100000 + i) }),
  });
  if (guess.status === 429) { sawRefusal = true; break; }
  if (guess.body && guess.body.verified === true) {
    t('a guessed code must not verify', false, `guess ${100000 + i} was accepted`);
    break;
  }
}
t('guessing is cut off after a handful of wrong codes', sawRefusal);

// A fresh identifier is unaffected by another one being locked out.
const other = `probe2-${Date.now()}@aasthichain.test`;
await call('/api/auth/verification', INVESTOR1, { method: 'POST', body: JSON.stringify({ identifier: other }) });
const otherGuess = await call('/api/auth/verification/verify', INVESTOR1, {
  method: 'POST', body: JSON.stringify({ identifier: other, value: '000000' }),
});
t('the lockout is per identifier, not global', otherGuess.status !== 429, `got ${otherGuess.status}`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
