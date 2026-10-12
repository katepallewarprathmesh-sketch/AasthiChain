// Two people signing in have to be two people.
//
// A verified session with no supervisory claim fell through to investor1 —
// every account, the same one. Ownership scoping is keyed on that identity,
// so with everyone sharing it, every gate built during this audit was a gate
// between a person and themselves: one investor could list another's
// payments, read their wallet and act on their money, because the server
// could not tell them apart.
//
// A session now resolves to its own identity, derived from the Clerk
// subject. A deployment can pin named people onto an existing ledger
// identity with IDENTITY_ALIASES, which is how the holder of positions
// created before this change keeps them.
//
// These checks need a production-shaped server: no DEMO_AUTH. Under demo
// auth the shared identities are the whole point, so the suite says so and
// skips rather than pretending to pass.
const API = process.env.API || 'http://localhost:8080';

let pass = 0, fail = 0, skipped = 0;
const t = (name, ok, detail) => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const skip = (name, why) => { skipped++; console.log(`  skip ${name} — ${why}`); };

const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const clerkToken = (sub, email) =>
  `${b64url({ alg: 'none' })}.${b64url({ sub, email, clerk: true, exp: 9999999999 })}.sig`;

async function call(path, { token, identity, method = 'GET', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  // The real browser always sends this, naming investor1. That is exactly
  // how the collapse happened, so every probe here sends it too.
  headers['X-Fabric-Identity'] = identity || 'investor1';
  const res = await fetch(API + path, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  let parsed = null;
  try { parsed = await res.json(); } catch { /* not json */ }
  return { status: res.status, body: parsed || {}, raw: JSON.stringify(parsed || {}) };
}

console.log(`Identity separation (${API})`);

const alice = clerkToken('user_alice_sep', 'alice@example.com');
const bob = clerkToken('user_bob_sep', 'bob@example.com');

const meA = await call('/api/auth/me', { token: alice });
const meB = await call('/api/auth/me', { token: bob });

if (meA.status === 404) {
  skip('the whole suite', 'this server does not serve /api/auth/me');
} else if (meA.body.identityId === 'investor1' && meB.body.identityId === 'investor1'
           && meA.body.canSwitchIdentity) {
  // Demo auth: shared identities are intended here.
  skip('the whole suite', 'server is in demo mode, where identities are shared on purpose');
} else {
  t('a signed-in person gets an identity of their own',
    !!meA.body.identityId && meA.body.identityId !== 'investor1',
    `got ${meA.body.identityId}`);

  t('two different people get two different identities',
    !!meB.body.identityId && meA.body.identityId !== meB.body.identityId,
    `${meA.body.identityId} vs ${meB.body.identityId}`);

  t('the identity is stable across requests',
    (await call('/api/auth/me', { token: alice })).body.identityId === meA.body.identityId);

  t('claiming investor1 in the header does not make you investor1',
    meA.body.identityId !== 'investor1');

  t('an ordinary person is not offered the identity switcher',
    meA.body.canSwitchIdentity === false, `got ${meA.body.canSwitchIdentity}`);

  t('an anonymous caller is not told an identity',
    (await call('/api/auth/me')).status === 401);

  // The leak itself: one person's payment must not appear in another's list.
  const seen = await call('/api/npci/payments', { token: bob });
  const mine = Array.isArray(seen.body) ? seen.body : (seen.body.payments || []);
  const foreign = mine.filter(p => p.payerId && p.payerId !== meB.body.identityId);
  t('one person cannot see payments belonging to another',
    foreign.length === 0,
    `saw ${foreign.length} foreign payment(s): ${foreign.slice(0, 2).map(p => p.payerId).join(', ')}`);

  // The identity has to be usable: an unknown identity with no KYC standing
  // would silently block the buying flow that worked a moment ago.
  const kyc = await call(`/api/kyc/${encodeURIComponent(meA.body.identityId)}`, { token: alice });
  t('a new person starts with the KYC standing they had before',
    kyc.status === 200 && kyc.body.kycStatus === 'VERIFIED',
    `${kyc.status} ${kyc.raw.slice(0, 120)}`);
}

console.log(`\n${pass} passed, ${fail} failed${skipped ? `, ${skipped} skipped` : ''}`);
process.exit(fail ? 1 : 0);
