// A new account must not arrive already verified.
//
// The KYC gate was real in the sense that it checked a record and refused a
// payment when the record said UNVERIFIED. It was decorative in the sense
// that no record ever said that: signing in for the first time created one
// marked VERIFIED, so nothing was gated and the trust page had to carry it as
// a known gap.
//
// These assertions are written to fail against that old behaviour: a fresh
// identity must read UNVERIFIED, must be refused at the payment gate, and
// must be able to clear the gate only by going through the verification flow.
// The seeded demo identities must keep working, because the demo and the rest
// of the suite depend on them.
import { randomBytes } from 'node:crypto';

const API = process.env.API || 'http://localhost:8080';

let pass = 0, fail = 0;
const t = (name, ok, detail) => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` - ${detail}` : ''}`); }
};

const token = (identityId, role, mspId) => Buffer.from(JSON.stringify({
  identityId, role, mspId, exp: Math.floor(Date.now() / 1000) + 3600,
})).toString('base64');

const as = (identityId, role, mspId) => ({
  'Content-Type': 'application/json',
  Authorization: `Bearer ${token(identityId, role, mspId)}`,
  'X-Fabric-Identity': identityId,
  'X-Identity-Role': role,
});

const j = async (path, opts = {}) => {
  const res = await fetch(`${API}${path}`, opts);
  const raw = await res.text();
  let body = null;
  try { body = JSON.parse(raw); } catch { body = raw; }
  return { status: res.status, body };
};

const NEW_ID = `newcomer_${randomBytes(4).toString('hex')}`;

// 1. A fresh identity reads UNVERIFIED. This one is a shape guard rather
//    than a discriminating test: the lookup already defaulted to UNVERIFIED
//    for an unknown id. What changed is that the record created when a real
//    session first resolves now says the same thing, and that path needs a
//    Clerk session, which this suite cannot mint. The two assertions below
//    are the ones that fail against the old behaviour.
{
  const r = await j(`/api/kyc/${NEW_ID}`, { headers: as(NEW_ID, 'Investor', 'InvestorMSP') });
  const status = r.body && (r.body.kycStatus || (r.body.kyc && r.body.kyc.kycStatus));
  t('a brand new identity is UNVERIFIED', status === 'UNVERIFIED', `got ${JSON.stringify(status)}`);
}

// 2. The payment gate refuses it. The payee is the one being checked here,
//    so the unverified newcomer stands on that side.
{
  const r = await j('/api/npci/collect', {
    method: 'POST',
    headers: as('investor1', 'Investor', 'InvestorMSP'),
    body: JSON.stringify({
      // An asset with no primary subscription, so the supply check cannot
      // answer first and hide the thing being tested.
      assetId: 'PROP-KYC-GATE-PROBE',
      tokenAmount: 1,
      amountINR: 500,
      payerVpa: 'investor1@aasthi',
      payeeVpa: `${NEW_ID}@aasthi`,
      payerId: 'investor1',
      payeeId: NEW_ID,
    }),
  });
  const body = JSON.stringify(r.body || '');
  t('an unverified payee is refused at the payment gate',
    body.includes('KYC_NOT_VERIFIED'), `status ${r.status}: ${body.slice(0, 220)}`);
}

// 3. The verification flow is the only way out of that state.
{
  await j('/api/kyc/digilocker/init', {
    method: 'POST',
    headers: as(NEW_ID, 'Investor', 'InvestorMSP'),
    body: JSON.stringify({ identityId: NEW_ID }),
  });
  const cb = await j('/api/kyc/digilocker/callback', {
    method: 'POST',
    headers: as(NEW_ID, 'Investor', 'InvestorMSP'),
    body: JSON.stringify({ identityId: NEW_ID, code: 'mock-code' }),
  });
  t('verification moves the record to VERIFIED',
    cb.status === 200 && cb.body && cb.body.kycStatus === 'VERIFIED',
    `status ${cb.status}`);

  const after = await j(`/api/kyc/${NEW_ID}`, { headers: as(NEW_ID, 'Investor', 'InvestorMSP') });
  const status = after.body && (after.body.kycStatus || (after.body.kyc && after.body.kyc.kycStatus));
  t('and the change is what the gate reads afterwards', status === 'VERIFIED', `got ${JSON.stringify(status)}`);
}

// 4. The seeded demo identities are untouched. Tightening the default must
//    not quietly break the demo or the rest of this suite.
for (const id of ['originator1', 'investor1', 'investor2', 'registrar1', 'regulator1']) {
  const r = await j(`/api/kyc/${id}`, { headers: as(id, 'Investor', 'InvestorMSP') });
  const status = r.body && (r.body.kycStatus || (r.body.kyc && r.body.kyc.kycStatus));
  t(`seeded identity ${id} stays VERIFIED`, status === 'VERIFIED', `got ${JSON.stringify(status)}`);
}

// 5. And the fixture that exists to be unverified still is.
{
  const r = await j('/api/kyc/unverified_user', { headers: as('unverified_user', 'Investor', 'InvestorMSP') });
  const status = r.body && (r.body.kycStatus || (r.body.kyc && r.body.kyc.kycStatus));
  t('the unverified fixture is still UNVERIFIED', status === 'UNVERIFIED', `got ${JSON.stringify(status)}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
