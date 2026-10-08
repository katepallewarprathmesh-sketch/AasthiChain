// A payment belongs to the person who made it.
//
// Found by probing the live surface: every /api/npci/payments/:id route was
// behind authMiddleware and nothing else, so any signed-in user could read,
// approve, settle, refund or decline anyone else's payment. Declining was
// the damaging one — cancelling a stranger's purchase mid-flight.
//
// The root cause was upstream: /api/npci/collect took payerId from the
// request body and defaulted it to 'investor1'. The server never recorded
// who actually made the payment, so it could not have enforced anything —
// and tokens were credited to that same wrong identity on release.
const API = process.env.API || 'http://localhost:8080';
const ASSET = process.env.ASSET || 'PROP-COLD-CHAIN-NSK-009';

let pass = 0, fail = 0;
const t = (name, ok, detail) => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};

const tokenFor = (identityId, role = 'Investor', mspId = 'InvestorMSP') =>
  Buffer.from(JSON.stringify({ identityId, mspId, role, exp: Date.now() + 3600000 })).toString('base64');

const I1 = tokenFor('investor1');
const I2 = tokenFor('investor2');
const REG = tokenFor('regulator1', 'Regulator', 'RegulatorMSP');

async function call(path, token, init = {}) {
  const res = await fetch(API + path, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(init.headers || {}) },
  });
  let body = null;
  try { body = await res.json(); } catch { /* not json */ }
  return { status: res.status, body };
}

const collect = async (token, extra = {}) => {
  const r = await call('/api/npci/collect', token, {
    method: 'POST',
    body: JSON.stringify({
      assetId: ASSET, tokenAmount: 1, amountINR: 500,
      payerVpa: 'buyer@aasthichain', payeeVpa: 'originator@aasthichain', ...extra,
    }),
  });
  return r.body && r.body.paymentId ? r.body : null;
};

console.log(`payment ownership (${API})`);

// --- the record has to name its real owner before anything can be enforced
const mine = await collect(I2);
t('investor2 can start a payment', !!mine, 'collect returned no paymentId');
if (!mine) { console.log(`\n${pass} passed, ${fail + 1} failed`); process.exit(1); }
t('the payment is recorded as investor2\u2019s', mine.payerId === 'investor2', `payerId=${mine.payerId}`);

// Claiming to be someone else does not make it so.
const spoofed = await collect(I2, { payerId: 'investor1' });
t('a body cannot hand the payment to another identity',
  spoofed && spoofed.payerId === 'investor2', spoofed && `payerId=${spoofed.payerId}`);

// --- a stranger cannot touch it
const strangerReads = await call(`/api/npci/payments/${mine.paymentId}`, I1);
t('a stranger cannot read it', strangerReads.status === 403, `got ${strangerReads.status}`);
t('  and the refusal is specific', strangerReads.body && strangerReads.body.error === 'ERR_NOT_YOUR_PAYMENT',
  JSON.stringify(strangerReads.body));

for (const action of ['approve', 'decline', 'refund', 'reattach', 'release', 'settle']) {
  const r = await call(`/api/npci/payments/${mine.paymentId}/${action}`, I1, {
    method: 'POST', body: JSON.stringify({ payerId: 'investor1' }),
  });
  t(`a stranger cannot ${action} it`, r.status === 403, `got ${r.status}`);
}

// Still PENDING: none of the above got through to the handler.
const afterAttacks = await call(`/api/npci/payments/${mine.paymentId}`, I2);
t('the payment survived every attempt untouched',
  afterAttacks.status === 200 && afterAttacks.body.status === 'PENDING',
  `status=${afterAttacks.body && afterAttacks.body.status}`);

// --- the owner is unaffected
const ownerReads = await call(`/api/npci/payments/${mine.paymentId}`, I2);
t('the owner can read it', ownerReads.status === 200, `got ${ownerReads.status}`);
const ownerApproves = await call(`/api/npci/payments/${mine.paymentId}/approve`, I2, {
  method: 'POST', body: JSON.stringify({ payerId: 'investor2' }),
});
t('the owner can approve it', ownerApproves.status === 200, `got ${ownerApproves.status}`);

// --- supervision still works
const theirs = await collect(I2);
const supervisor = await call(`/api/npci/payments/${theirs.paymentId}`, REG);
t('a regulator can still read any payment', supervisor.status === 200, `got ${supervisor.status}`);

// --- an unknown id must still 404, not leak existence through a 403
const ghost = await call('/api/npci/payments/NPCI-DOES-NOT-EXIST', I1);
t('an unknown payment is 404, not 403', ghost.status === 404, `got ${ghost.status}`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
