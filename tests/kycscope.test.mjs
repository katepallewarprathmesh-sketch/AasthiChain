// KYC is the strongest claim in the system: verified means a real person
// behind an identity. The DigiLocker routes named whose KYC it was in the
// request body, where the URL-keyed ownership table could not see it, so
// anyone could mark anyone verified and then read their documents back.
const BASE = process.env.API || 'http://localhost:8080';
const J = { 'Content-Type': 'application/json' };

let pass = 0, fail = 0;
const t = (name, ok, extra = '') => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${extra}`); }
};

const token = (identityId, role) => Buffer.from(JSON.stringify({
  identityId, mspId: role + 'MSP', role, exp: Date.now() + 3600000,
})).toString('base64');

const as = (identityId, role) => ({
  ...J,
  Authorization: 'Bearer ' + token(identityId, role),
  'X-Identity-Id': identityId,
  'X-Fabric-Identity': identityId,
  'X-Identity-Role': role,
});

const post = (path, body, headers = J) =>
  fetch(BASE + path, { method: 'POST', headers, body: JSON.stringify(body) });

const victim = 'kycv-' + Date.now().toString(36);

// The Express server never implemented the DigiLocker flow; only the
// serverless handler serves it. A 404 here means "not this server", not a
// missing gate, so say so once and stop rather than report false failures.
const probe = await post('/api/kyc/digilocker/init', { identityId: victim });
if (probe.status === 404) {
  console.log('  skip kycscope — this server does not serve the DigiLocker routes');
  console.log('\nkycscope: 0 passed, 0 failed');
  process.exit(0);
}

// --- a stranger cannot start, finish or read someone else's KYC ---
for (const [route, body] of [
  ['/api/kyc/digilocker/init', { identityId: victim }],
  ['/api/kyc/digilocker/callback', { identityId: victim, code: 'mock-code' }],
  ['/api/kyc/digilocker/pull-document', { identityId: victim, docType: 'AADHAAR' }],
]) {
  const anon = await post(route, body);
  t(`anonymous ${route} is refused`, anon.status === 401 || anon.status === 403, `got ${anon.status}`);

  const other = await post(route, body, as('investor2', 'Investor'));
  const j = await other.json().catch(() => ({}));
  t(`${route} for someone else is 403`, other.status === 403 && j.error === 'ERR_NOT_YOUR_KYC',
    `got ${other.status} ${JSON.stringify(j).slice(0, 120)}`);
}

// --- and the refusal left no verified record behind ---
const after = await fetch(BASE + `/api/kyc/${victim}`, { headers: as('regulator1', 'Regulator') });
const rec = await after.json().catch(() => ({}));
t('the victim was never marked verified',
  !rec || !rec.kycStatus || rec.kycStatus !== 'VERIFIED', JSON.stringify(rec).slice(0, 120));

// --- the owner can still complete their own KYC ---
const me = 'kycself-' + Date.now().toString(36);
const mine = as(me, 'Investor');
const init = await post('/api/kyc/digilocker/init', { identityId: me }, mine);
t('a caller can start their own KYC', init.status === 200, `got ${init.status}`);
const started = await init.json().catch(() => ({}));
const cb = await post('/api/kyc/digilocker/callback',
  { identityId: me, code: 'mock-code', state: started.state }, mine);
const cbBody = await cb.json().catch(() => ({}));
t('a caller can finish their own KYC', cb.status === 200 && cbBody.kycStatus === 'VERIFIED',
  `got ${cb.status} ${JSON.stringify(cbBody).slice(0, 120)}`);
const pull = await post('/api/kyc/digilocker/pull-document',
  { identityId: me, docType: 'AADHAAR' }, mine);
t('a caller can read their own document', pull.status === 200, `got ${pull.status}`);

// --- a registrar verifies on someone's behalf, because that is the job ---
const byRegistrar = await post('/api/kyc/digilocker/init',
  { identityId: victim }, as('registrar1', 'Registrar'));
t('a registrar may act for someone else', byRegistrar.status === 200, `got ${byRegistrar.status}`);

console.log(`\nkycscope: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
