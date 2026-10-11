// A header is a claim, not a credential.
//
// Production runs with DEMO_AUTH unset, and in that mode the API used to
// accept X-Fabric-Identity on its own as proof of who you were — so anyone
// could send `X-Fabric-Identity: regulator1` and hold every supervisory
// power in the system. This suite starts its own server with demo auth OFF,
// because the shared one on :8080 deliberately trusts headers so local
// tooling works.
import { spawn } from 'node:child_process';
import process from 'node:process';

const PORT = Number(process.env.CLAIM_PORT || 8137);
const BASE = `http://localhost:${PORT}`;
const J = { 'Content-Type': 'application/json' };

let pass = 0, fail = 0;
const t = (name, ok, extra = '') => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${extra}`); }
};

const env = { ...process.env, PORT: String(PORT), NODE_ENV: 'production' };
delete env.DEMO_AUTH;
delete env.CLERK_ISSUER;

const server = spawn('node', ['server.js'], {
  cwd: new URL('..', import.meta.url).pathname,
  env, stdio: ['ignore', 'ignore', 'ignore'],
});
const stop = () => { try { server.kill('SIGKILL'); } catch {} };

const waitUp = async () => {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(BASE + '/api/health');
      if (r.ok) return true;
    } catch {}
    await new Promise(r => setTimeout(r, 250));
  }
  return false;
};

if (!await waitUp()) {
  console.log('  FAIL server with demo auth off never came up');
  stop();
  console.log('\nidentityclaim: 0 passed, 1 failed');
  process.exit(1);
}

const claim = (identityId) => ({ ...J, 'X-Fabric-Identity': identityId, 'X-Identity-Role': 'Regulator' });
const get = (path, headers) => fetch(BASE + path, { headers });
const post = (path, body, headers) =>
  fetch(BASE + path, { method: 'POST', headers, body: JSON.stringify(body) });

try {
  // --- claiming a supervisory identity buys nothing ---
  const ledger = await get('/api/drunix/ledger', claim('regulator1'));
  t('a claimed regulator cannot read the scoped ledger', ledger.status === 401,
    `got ${ledger.status}`);

  const history = await get('/api/transfers/history', claim('regulator1'));
  t('a claimed regulator cannot read transfer history', history.status === 401,
    `got ${history.status}`);

  const users = await get('/api/auth/users', claim('regulator1'));
  t('a claimed regulator cannot list the user directory', users.status === 401,
    `got ${users.status}`);

  const payments = await get('/api/npci/payments', claim('regulator1'));
  t('a claimed regulator cannot list payments', payments.status === 401,
    `got ${payments.status}`);

  // --- and cannot write ---
  const mint = await post('/api/properties/PROP-GREEN-VALLEY-PUNE-001/mint',
    { totalTokens: 100 }, claim('originator1'));
  t('a claimed owner cannot mint', mint.status === 401, `got ${mint.status}`);

  const validate = await post('/api/properties/PROP-GREEN-VALLEY-PUNE-001/validate',
    { decision: 'VALIDATED' }, claim('registrar1'));
  t('a claimed registrar cannot validate title', validate.status === 401,
    `got ${validate.status}`);

  const kyc = await post('/api/kyc/digilocker/callback',
    { identityId: 'investor1', code: 'mock-code' }, claim('registrar1'));
  t('a claimed registrar cannot verify someone else KYC', kyc.status === 401,
    `got ${kyc.status}`);

  // --- public pages are untouched: no sign-in, no problem ---
  const listings = await get('/api/properties', J);
  t('the marketplace is still public', listings.status === 200, `got ${listings.status}`);

  const chain = await get('/api/chain', J);
  t('the ledger explorer is still public', chain.status === 200, `got ${chain.status}`);

  const health = await get('/api/health', J);
  t('health is still public', health.status === 200, `got ${health.status}`);
} finally {
  stop();
}

console.log(`\nidentityclaim: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
