// Route parity between the two servers.
//
// AasthiChain ships the same HTTP API twice: mock-api-server.js (Express, what
// runs locally and what every other suite tests) and frontend/api/index.js (the
// serverless handler Vercel actually serves). They drifted far enough that a
// whole admin page and the title-deed checker were 404 in production while the
// local suite stayed green — nothing was testing the half the public hits.
//
// This walks every route the Express server declares, asks the serverless
// handler for it, and fails on "Not found". It is deliberately a reachability
// check, not a response-shape check: the point is to catch a route that was
// added to one server and forgotten in the other.

const { default: handler } = await import('../frontend/api/index.js');
const src = await (await import('node:fs/promises')).readFile(
  new URL('../mock-api-server.js', import.meta.url), 'utf8');

const SAMPLE = {
  ':id': 'PROP-GREEN-VALLEY-PUNE-001', ':assetId': 'PROP-GREEN-VALLEY-PUNE-001',
  ':ownerId': 'investor1', ':identityId': 'investor1', ':participant': 'investor1',
  ':paymentId': 'PAY-1', ':offerId': 'OFR-1', ':cid': 'bafk', ':loanId': 'L-1',
  ':proposalId': 'P-1', ':height': '1', ':basketId': 'B-1', ':isin': 'INE000A01001',
  ':utr': 'UTR1',
};
const fill = p => p.split('/').map(s => s.startsWith(':') ? (SAMPLE[s] || 'x') : s).join('/');

function mockRes() {
  const r = { _status: 200, _body: null };
  r.status = c => { r._status = c; return r; };
  r.json = b => { r._body = b; return r; };
  r.send = r.json; r.setHeader = () => r; r.writeHead = () => r; r.end = () => r;
  return r;
}

async function probe(method, route) {
  const res = mockRes();
  try {
    await handler({
      url: fill(route), method,
      headers: { 'x-fabric-identity': 'registrar1', 'content-type': 'application/json' },
      body: {},
    }, res);
  } catch (e) {
    return { unreachable: true, why: 'handler threw: ' + e.message };
  }
  // 4xx/5xx are fine — they mean the route exists and rejected a bare probe.
  // Only the catch-all "Not found" means no such route.
  const notFound = res._status === 404 && res._body && res._body.error === 'Not found';
  return { unreachable: notFound, why: notFound ? '404 Not found' : '' };
}

let pass = 0, fail = 0;
const t = (name, ok, extra = '') => ok ? (pass++, console.log('  ok   ' + name))
  : (fail++, console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')));

const declared = [
  ...[...src.matchAll(/app\.get\(\s*'([^']+)'/g)].map(m => ['GET', m[1]]),
  ...[...src.matchAll(/app\.(post|put|patch|delete)\(\s*'([^']+)'/g)]
      .map(m => [m[1].toUpperCase(), m[2]]),
];
const seen = new Set();
const routes = declared.filter(([m, p]) => {
  const k = m + ' ' + p;
  if (seen.has(k)) return false;
  seen.add(k);
  return true;
});

const missing = [];
for (const [method, route] of routes) {
  const { unreachable, why } = await probe(method, route);
  if (unreachable) missing.push(`${method} ${route} (${why})`);
}

t(`every Express route is reachable on the serverless API (${routes.length} checked)`,
  missing.length === 0, missing.join('; '));

// The two routes this audit was written after. Named explicitly so a
// regression points at the page that breaks rather than a bare count.
for (const [name, method, route] of [
  ['the ops queue is deployed', 'GET', '/api/admin/ops'],
  ['the deed checker is deployed', 'POST', '/api/properties/:id/verify-document'],
]) {
  const { unreachable } = await probe(method, route);
  t(name, !unreachable);
}

if (missing.length) {
  console.log('\n  routes missing from frontend/api/index.js:');
  for (const m of missing) console.log('    - ' + m);
}

const total = pass + fail;
console.log(`\n  api parity: ${pass}/${total} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
