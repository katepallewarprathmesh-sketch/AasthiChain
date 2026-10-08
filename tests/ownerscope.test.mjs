// Being signed in is not the same as being entitled.
//
// Found on production: any logged-in demo user could read any other user's
// KYC record, wallet holdings, loans and net worth, and could write anyone's
// KYC status — the routes were behind authMiddleware, and that was all. The
// perimeter was closed; the inside was not.
const API = process.env.API || 'http://localhost:8080';

let pass = 0, fail = 0;
const t = (name, ok, detail) => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};

const tokenFor = (identityId, mspId, role) =>
  Buffer.from(JSON.stringify({ identityId, mspId, role, exp: Date.now() + 3600000 })).toString('base64');

const INVESTOR1 = tokenFor('investor1', 'InvestorMSP', 'Investor');
const INVESTOR2 = tokenFor('investor2', 'InvestorMSP', 'Investor');
const REGULATOR = tokenFor('regulator1', 'RegulatorMSP', 'Regulator');
const REGISTRAR = tokenFor('registrar1', 'RegistrarMSP', 'Registrar');

async function call(path, token, init = {}) {
  const res = await fetch(API + path, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(init.headers || {}) },
  });
  let body = null;
  try { body = await res.json(); } catch { /* not json */ }
  return { status: res.status, body };
}

console.log(`owner-scoped routes (${API})`);

const OWN = [
  ['/api/kyc/investor1', '/api/kyc/investor2'],
  ['/api/balances/wallet/investor1', '/api/balances/wallet/investor2'],
  ['/api/credit/loans/investor1', '/api/credit/loans/investor2'],
  ['/api/portfolio/investor1/nav', '/api/portfolio/investor2/nav'],
];

for (const [mine, theirs] of OWN) {
  const self = await call(mine, INVESTOR1);
  t(`investor1 can read ${mine}`, self.status === 200, `got ${self.status}`);

  const other = await call(theirs, INVESTOR1);
  t(`investor1 is refused ${theirs}`, other.status === 403, `got ${other.status}`);
  t(`  refusal names the right error`, other.body && other.body.error === 'ERR_NOT_YOURS',
    JSON.stringify(other.body));
  // A 403 that still ships the data would be worse than a 200.
  t('  refusal carries no payload', !other.body || !('balances' in other.body || 'loans' in other.body || 'navINR' in other.body || 'kycStatus' in other.body));
}

// It has to work in both directions, or the rule is just a block on one id.
const back = await call('/api/portfolio/investor1/nav', INVESTOR2);
t('investor2 is refused investor1 net worth', back.status === 403, `got ${back.status}`);

// Supervisory access is the point of a regulator.
for (const [, theirs] of OWN) {
  const sup = await call(theirs, REGULATOR);
  t(`regulator1 may read ${theirs}`, sup.status === 200, `got ${sup.status}`);
}
const registrarKyc = await call('/api/kyc/investor2', REGISTRAR);
t('registrar1 may read any KYC record', registrarKyc.status === 200, `got ${registrarKyc.status}`);
const registrarNav = await call('/api/portfolio/investor2/nav', REGISTRAR);
t('registrar1 may not read net worth', registrarNav.status === 403, `got ${registrarNav.status}`);

// The write was the worst of it: anyone could mark anyone else verified.
const steal = await call('/api/kyc/investor2', INVESTOR1, {
  method: 'PUT', body: JSON.stringify({ status: 'VERIFIED' }),
});
t('investor1 cannot write investor2 KYC status', steal.status === 403, `got ${steal.status}`);

const ownWrite = await call('/api/kyc/investor1', INVESTOR1, {
  method: 'PUT', body: JSON.stringify({ status: 'VERIFIED' }),
});
t('investor1 can still write their own KYC status', ownWrite.status === 200, `got ${ownWrite.status}`);

const byRegistrar = await call('/api/kyc/investor2', REGISTRAR, {
  method: 'PUT', body: JSON.stringify({ status: 'VERIFIED' }),
});
t('registrar1 can still verify someone', byRegistrar.status === 200, `got ${byRegistrar.status}`);

// Anonymous callers must still hit the 401 perimeter, not the 403 inside it:
// the two answers leak different things.
const anon = await fetch(API + '/api/kyc/investor2');
t('anonymous still gets 401, not 403', anon.status === 401, `got ${anon.status}`);

// The cap table is public on the listing page; locking it would break the
// holders panel. Explicitly left open, so assert that on purpose.
const capTable = await call('/api/balances/PROP-GREEN-VALLEY-PUNE-001/investor2', INVESTOR1);
t('per-asset cap table stays readable', capTable.status === 200, `got ${capTable.status}`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
