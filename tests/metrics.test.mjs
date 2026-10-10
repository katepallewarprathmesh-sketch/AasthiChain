// Observability, through the proxy the way a scraper would reach it.
// The Go tests cover route-template normalisation; these check the endpoint
// survives the Node layer (which rewrites non-JSON into an error envelope
// unless it is told not to) and that the business numbers are real.
const BASE = process.env.BASE || 'http://localhost:8080';
const J = { 'Content-Type': 'application/json' };

let p = 0, f = 0;
const t = (n, c) => { if (c) { p++; console.log('  ok   ' + n); } else { f++; console.log('  FAIL ' + n); } };

// The rail checks who is asking before it moves anyone's money. These
// fixtures act as the settlement supervisor.
const RAIL_AS = { ...J, 'X-Fabric-Identity': 'regulator1', 'X-Identity-Role': 'Regulator' };
const post = (path, body) => fetch(BASE + path, { method: 'POST', headers: RAIL_AS, body: JSON.stringify(body) });
const metrics = async () => {
  const r = await fetch(BASE + '/api/umi/metrics');
  return { status: r.status, type: r.headers.get('content-type') || '', body: await r.text() };
};

const value = (body, name) => {
  const m = new RegExp('^' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' (\\d+(?:\\.\\d+)?)$', 'm').exec(body);
  return m ? Number(m[1]) : null;
};

const first = await metrics();
t('metrics are served through the proxy', first.status === 200);
t('and as prometheus text, not a JSON error envelope',
  /text\/plain/.test(first.type) && !first.body.startsWith('{'));
t('every metric is documented', (first.body.match(/# HELP /g) || []).length >= 6);
t('every metric declares its type', (first.body.match(/# TYPE /g) || []).length >= 6);

// --- business numbers must move with reality ---
t('the ledger height is exported', value(first.body, 'aasthi_ledger_blocks') > 0);
t('chain validity is exported as a gauge', value(first.body, 'aasthi_ledger_valid') === 1);

const tag = Date.now().toString(36);
const S = 'ms-' + tag, B = 'mb-' + tag, A = 'PROP-MET-' + tag;
await post('/api/umi/seed', { assetId: A, holder: S, tokens: 500, authorisedTokens: 500 });
await post(`/api/umi/wallets/${B}/fund`, { amountINR: 100000 });

const beforeBody = (await metrics()).body;
const settledBefore = value(beforeBody, 'aasthi_settlements_total{outcome="settled"}') ?? 0;

await post('/api/umi/dvp', { assetId: A, seller: S, buyer: B, tokens: 10, pricePerTokenINR: 500 });

const afterBody = (await metrics()).body;
t('a settlement increments the settled counter',
  value(afterBody, 'aasthi_settlements_total{outcome="settled"}') === settledBefore + 1);

// --- a failure must be visible, and attributed ---
await post('/api/umi/dvp', { assetId: A, seller: S, buyer: 'nowallet-' + tag, tokens: 10, pricePerTokenINR: 500 });
const failBody = (await metrics()).body;
t('failures are broken down by reason',
  /aasthi_settlement_failures_total\{reason="ERR_UMI_[A-Z_]+"\} \d+/.test(failBody));

// --- cardinality: the whole point ---
t('no participant id leaks into a label', !failBody.includes(B) && !failBody.includes(S));
t('no asset id leaks into a label', !failBody.includes(A));
t('dynamic segments are templated',
  /route="\/umi\/wallets\/\{id\}\/fund"/.test(failBody));

// --- latency ---
t('latency is exported as a histogram',
  /aasthi_http_request_duration_ms_bucket\{.*le="\+Inf"\}/.test(failBody));
t('request counts are exported', /aasthi_http_requests_total\{method="POST",route="\/umi\/dvp"\}/.test(failBody));

// --- a scrape must be cheap and repeatable ---
const t0 = Date.now();
await metrics();
t('a scrape returns promptly', Date.now() - t0 < 2000);


// --- the same endpoint, on the server Vercel actually runs -------------------
//
// Express has a dedicated /api/umi/metrics route, so everything above passed
// while production was broken: the serverless handler has no such route, the
// request fell into the generic /api/umi/* proxy, and that proxy assumed every
// rail response is JSON. Prometheus text failed to parse and was replaced with
// an error envelope -- returned under HTTP 200, so a scraper could not even
// tell. Checking the Express route alone cannot catch that.

process.env.UMI_GATEWAY_URL = process.env.UMI_GATEWAY_URL || 'http://localhost:21100';
const { default: serverless } = await import('../frontend/api/index.js');

function captureRes() {
  const r = { _status: 200, _body: null, _headers: {} };
  r.status = c => { r._status = c; return r; };
  r.json = b => { r._body = b; return r; };
  r.send = b => { r._body = b; return r; };
  r.setHeader = (k, v) => { r._headers[k.toLowerCase()] = v; return r; };
  r.writeHead = () => r;
  r.end = () => r;
  return r;
}

const sres = captureRes();
await serverless({ url: '/api/umi/metrics', method: 'GET', headers: {} }, sres);
const sbody = typeof sres._body === 'string' ? sres._body : JSON.stringify(sres._body || {});

t('the deployed handler serves metrics too', sres._status === 200);
t('as prometheus text, not an error envelope',
  sbody.includes('# HELP') && !sbody.trimStart().startsWith('{'));
t('and labels it text/plain',
  /text\/plain/.test(sres._headers['content-type'] || ''));
// The bug that hid for so long: an error body under a success status.
t('never reports a failure as a 200',
  !(sres._status === 200 && /"error"\s*:/.test(sbody)));

console.log(`\n  metrics: ${p} passed, ${f} failed`);
process.exit(f ? 1 : 0);
