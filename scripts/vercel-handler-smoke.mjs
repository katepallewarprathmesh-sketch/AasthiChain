#!/usr/bin/env node
/**
 * Test harness + access-control suite for the Vercel serverless handler.
 *
 * frontend/api/index.js is a ~3,700 line default-export handler. It had no
 * tests, which is why a real authentication hole survived in it: getUser()
 * returned the investor1 identity when a request carried NO Authorization
 * header at all, taking the identity from the client-supplied
 * x-fabric-identity header if present. Every signed-token control added
 * elsewhere only protected requests that bothered to send a token.
 *
 * This drives the exported handler directly with mock req/res objects, so the
 * file is testable without deploying it.
 *
 * Usage: node scripts/vercel-handler-smoke.mjs
 */

const handler = (await import('../frontend/api/index.js')).default;

let passed = 0;
const failures = [];
const check = (name, cond, detail = '') => {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failures.push(name); console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
};

/** Minimal Node-ish res the handler is written against. */
function mockRes() {
  const r = {
    statusCode: 200, body: undefined, headers: {}, ended: false,
    setHeader(k, v) { r.headers[k] = v; return r; },
    status(c) { r.statusCode = c; return r; },
    json(o) { r.body = o; r.ended = true; return r; },
    send(o) { r.body = o; r.ended = true; return r; },
    end() { r.ended = true; return r; },
  };
  return r;
}

async function call(path, { method = 'GET', token, headers = {}, body } = {}) {
  const req = {
    url: path,
    method,
    headers: {
      host: 'test.local',
      'content-type': 'application/json',
      ...(token ? { authorization: 'Bearer ' + token } : {}),
      ...headers,
    },
    body,
    socket: { remoteAddress: '127.0.0.1' },
    on() {},
  };
  const res = mockRes();
  await handler(req, res);
  return res;
}

console.log('\nVercel handler smoke test (frontend/api/index.js)\n');

// ---------------------------------------------------------------- harness
{
  const r = await call('/api/health');
  check('harness drives the handler (health responds)', r.statusCode === 200 && !!r.body,
    `HTTP ${r.statusCode}`);
}

// ---------------------------------------------------------------- public surface
console.log('  -- public paths must stay reachable without a token --');
for (const p of ['/health', '/api/health', '/api/chain', '/api/chain/verify',
                 '/api/umi/capabilities', '/api/umi/conformance']) {
  const r = await call(p);
  check(`public: ${p}`, r.statusCode !== 401, `HTTP ${r.statusCode}`);
}
{
  const r = await call('/api/auth/login', {
    method: 'POST', body: { identityId: 'investor1', role: 'Investor' },
  });
  check('public: POST /api/auth/login issues a token',
    r.statusCode === 200 && !!(r.body && r.body.token), `HTTP ${r.statusCode}`);
}

// ---------------------------------------------------------------- the hole
console.log('  -- protected paths must refuse an unauthenticated request --');
const protectedPaths = [
  '/api/npci/payments',
  '/api/balances/wallet/investor1',
  '/api/portfolio/investor1/nav',
  '/api/transfers/history',
];
for (const p of protectedPaths) {
  const r = await call(p);
  check(`no header -> 401: ${p}`, r.statusCode === 401, `HTTP ${r.statusCode}`);
}
{
  // The exact escalation: no token, identity asserted via header.
  const r = await call('/api/npci/payments', { headers: { 'x-fabric-identity': 'regulator1' } });
  check('no token + x-fabric-identity: regulator1 -> 401', r.statusCode === 401,
    `HTTP ${r.statusCode}`);
}
{
  const unsigned = Buffer.from(JSON.stringify({
    identityId: 'regulator1', mspId: 'RegulatorMSP', role: 'Regulator',
  })).toString('base64');
  const r = await call('/api/npci/payments', { token: unsigned });
  check('self-minted unsigned token -> 401', r.statusCode === 401, `HTTP ${r.statusCode}`);
}
{
  const r = await call('/api/npci/payments', { token: 'garbage' });
  check('garbage token -> 401', r.statusCode === 401, `HTTP ${r.statusCode}`);
}

// ---------------------------------------------------------------- happy path
console.log('  -- a properly signed token still works --');
const login = await call('/api/auth/login', {
  method: 'POST', body: { identityId: 'investor1', role: 'Investor' },
});
const token = login.body && login.body.token;
check('login returned a signed token', typeof token === 'string' && token.includes('.'));
{
  const r = await call('/api/npci/payments', { token });
  check('signed token reaches a protected path', r.statusCode === 200, `HTTP ${r.statusCode}`);
}
{
  const r = await call('/api/portfolio/investor1/nav', { token });
  check('own portfolio is readable', r.statusCode === 200, `HTTP ${r.statusCode}`);
}
{
  const other = await call('/api/auth/login', {
    method: 'POST', body: { identityId: 'investor2', role: 'Investor' },
  });
  const r = await call('/api/portfolio/investor1/nav', { token: other.body.token });
  check('another user cannot read investor1 portfolio', r.statusCode === 403,
    `HTTP ${r.statusCode}`);
}

// ---------------------------------------------------------------- fraud model
console.log('  -- the handler serves the trained model, not the rules --');
{
  const r = await call('/api/npci/collect', {
    method: 'POST', token,
    body: {
      amountINR: 5000, tokenAmount: 10, assetId: 'PROP-GREEN-VALLEY-PUNE-001',
      payerVpa: 'ravi@okhdfcbank', payeeVpa: 'seller@okicici',
    },
  });
  const risk = r.body && r.body.risk;
  check('collect is scored', !!risk, `HTTP ${r.statusCode}`);
  check('scored by the trained model, not rules',
    risk && risk.engine === 'model', risk ? `engine=${risk.engine}` : 'no risk');
  check('explanation carries a model version',
    !!(risk && risk.modelVersion && /lr-v\d/.test(risk.modelVersion)),
    risk ? String(risk.modelVersion) : '');
  check('explanation carries the synthetic-data caveat',
    !!(risk && /SYNTHETIC/i.test(risk.dataCaveat || '')));
}

console.log(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) {
  failures.forEach(f => console.error('  FAIL ' + f));
  process.exit(1);
}
console.log('Vercel handler OK');
