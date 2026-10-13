// Switching between the demo roles, for an ordinary signed-in person.
//
// The switcher used to require the deployment to name you in
// SUPERVISOR_CLERK_IDS. That made the headline feature of the demo depend on
// an environment variable being exactly right, with no way to tell from the
// outside when it was not: the dropdown simply did not appear, and the only
// evidence was 403s in the rail's log when the browser kept acting as a role
// the server had never agreed to.
//
// A verified session may now wear one of the five named demo identities.
// What must NOT follow from that is operator standing, which is the line
// these assertions are really guarding: the ops and diagnostics views read
// `entitled`, and wearing a demo role must not hand those over.
//
// Runs against the serverless handler with demo auth OFF, because demo auth
// would short-circuit the very branch under test.
process.env.DEMO_AUTH = 'false';
delete process.env.SUPERVISOR_CLERK_IDS;
delete process.env.SUPERVISOR_EMAILS;
delete process.env.CLERK_ISSUER;
delete process.env.ADMIN_DASHBOARD_KEY;

const { default: handler } = await import('../frontend/api/index.js');

let pass = 0, fail = 0;
const t = (name, ok, detail) => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` - ${detail}` : ''}`); }
};

function mockRes() {
  const r = { _status: 200, _body: null, headersSent: false };
  r.status = (c) => { r._status = c; return r; };
  r.json = (b) => { r._body = b; r.headersSent = true; return r; };
  r.send = r.json;
  r.setHeader = () => r;
  r.writeHead = () => r;
  r.end = () => { r.headersSent = true; return r; };
  return r;
}

// A Clerk-shaped session token. No CLERK_ISSUER is configured here, so the
// handler takes its decode-only path, which is what an unconfigured
// deployment does today.
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const clerkToken = (sub) => `${b64({ alg: 'none' })}.${b64({ sub, exp: Math.floor(Date.now() / 1000) + 3600 })}.x`;

const SESSION = clerkToken('user_3JYfYaligpzC5uq2d4v4YnmmmIf');

async function me(identity) {
  const res = mockRes();
  const headers = { authorization: `Bearer ${SESSION}` };
  if (identity) headers['x-fabric-identity'] = identity;
  await handler({ url: '/api/auth/me', method: 'GET', headers }, res);
  return res;
}

// 1. The dropdown has to appear, which is driven entirely by this flag.
{
  const r = await me();
  t('a signed-in session is told it may switch roles',
    r._body && r._body.canSwitchIdentity === true,
    `canSwitchIdentity was ${JSON.stringify(r._body && r._body.canSwitchIdentity)}`);
}

// 2. Each of the five demo identities must actually resolve, because the
//    previous failure was the server silently ignoring the choice.
for (const [id, role] of [
  ['originator1', 'Originator'],
  ['registrar1', 'Registrar'],
  ['investor2', 'Investor'],
  ['regulator1', 'Regulator'],
]) {
  const r = await me(id);
  t(`acting as ${id} resolves to ${role}`,
    r._body && r._body.identityId === id && r._body.role === role,
    `got ${JSON.stringify(r._body && { id: r._body.identityId, role: r._body.role })}`);
}

// 3. The line that matters, checked where it is actually enforced rather
//    than on a field /api/auth/me happens to echo. The diagnostics view
//    reads `entitled`, so if wearing a demo role set that flag, this would
//    open the deployment's internals to anyone who picked Regulator from a
//    dropdown.
{
  const res = mockRes();
  await handler({
    url: '/api/admin/diagnostics',
    method: 'GET',
    headers: { authorization: `Bearer ${SESSION}`, 'x-fabric-identity': 'regulator1' },
  }, res);
  t('wearing the regulator demo role does not open the diagnostics view',
    res._status === 401 || res._status === 403,
    `diagnostics answered ${res._status}`);
}

// 4. An identity that is not one of the five is still refused, so this is a
//    fixed list rather than "say who you are and we will believe you".
{
  const r = await me('treasury-of-india');
  t('an unknown identity is not honoured',
    r._body && r._body.identityId !== 'treasury-of-india',
    `got ${JSON.stringify(r._body && r._body.identityId)}`);
}

// 5. And with no session at all, a header still buys nothing. This is the
//    audit finding that must stay closed.
{
  const res = mockRes();
  await handler({ url: '/api/auth/me', method: 'GET', headers: { 'x-fabric-identity': 'regulator1' } }, res);
  const body = res._body || {};
  t('an unauthenticated header does not make you the regulator',
    body.identityId !== 'regulator1' && body.role !== 'Regulator',
    `got ${JSON.stringify({ id: body.identityId, role: body.role })}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
