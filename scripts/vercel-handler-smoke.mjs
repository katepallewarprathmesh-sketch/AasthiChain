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
  // Vercel populates req.query; the handler reads it (e.g. ?format=json on the
  // UTR receipt), so the harness must provide it or it misreports behaviour.
  const qs = path.includes('?') ? new URLSearchParams(path.split('?')[1]) : new URLSearchParams();
  const req = {
    url: path,
    method,
    query: Object.fromEntries(qs),
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

// ---------------------------------------------------------------- UTR receipt
console.log('  -- the UTR receipt is openable without signing in --');
{
  // Create a settled payment so there is a real UTR to look up.
  const c = await call('/api/npci/collect', {
    method: 'POST', token,
    body: { amountINR: 1000, tokenAmount: 2, assetId: 'PROP-GREEN-VALLEY-PUNE-001',
            payerVpa: 'ravi@okhdfcbank', payeeVpa: 'seller@okicici' },
  });
  const pid = c.body && c.body.paymentId;
  await call(`/api/npci/payments/${pid}/approve`, { method: 'POST', token, body: {} });
  await call(`/api/npci/payments/${pid}/settle`, { method: 'POST', token, body: {} });
  const paid = await call(`/api/npci/payments/${pid}`, { token });
  const rec = (paid.body && (paid.body.payment || paid.body)) || {};
  const utr = rec.utr12 || rec.utr || rec.rrn;
  check('a settled payment has a UTR', !!utr, JSON.stringify(rec).slice(0, 80));

  if (utr) {
    // No token at all — this is someone opening the link in a browser.
    const anon = await call(`/api/npci/utr/${utr}`);
    check('UTR lookup without a token is not 401', anon.statusCode !== 401,
      `HTTP ${anon.statusCode}`);
    check('UTR lookup returns the payment', anon.statusCode === 200,
      `HTTP ${anon.statusCode}`);

    // And the browser case: Accept: text/html must render the receipt page.
    const html = await call(`/api/npci/utr/${utr}`, { headers: { accept: 'text/html' } });
    const body = typeof html.body === 'string' ? html.body : '';
    check('a browser gets the HTML verification receipt',
      /PAYMENT VERIFICATION/.test(body), `got ${typeof html.body}`);
  }

  // An unknown reference must 404, not 401 — "not found" is the honest answer.
  const missing = await call('/api/npci/utr/NPCI-DOES-NOT-EXIST');
  check('unknown UTR is 404, not 401', missing.statusCode === 404,
    `HTTP ${missing.statusCode}`);
}

// ---------------------------------------------------------------- identity
console.log('  -- the token decides identity, never a client header --');
{
  // Switching role by rewriting x-fabric-identity used to work, because the
  // server trusted the header. It no longer does, which is why the UI must
  // mint a new token when the role changes instead of relabelling itself.
  const inv = await call('/api/npci/payments', {
    token, headers: { 'x-fabric-identity': 'regulator1' },
  });
  check('investor token + regulator header is still the investor',
    inv.statusCode === 200 && inv.body && inv.body.scope === 'own',
    `scope=${inv.body && inv.body.scope}`);

  const regLogin = await call('/api/auth/login', {
    method: 'POST', body: { identityId: 'regulator1', role: 'Regulator' },
  });
  const reg = await call('/api/npci/payments', { token: regLogin.body.token });
  check('a real regulator token is not scope-limited',
    reg.statusCode === 200 && (!reg.body.scope || reg.body.scope === 'all'),
    `scope=${reg.body && reg.body.scope}`);
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
