// The operations queue, exercised against the Vercel serverless handler
// rather than the Express server.
//
// This suite exists because /admin/ops was live and broken for a long time: the
// route was implemented in mock-api-server.js only, so every local check passed
// while the deployed page loaded its spinner and then showed "Not found". The
// two servers are separate implementations of the same API, and nothing was
// testing the one the public actually hits.
//
// It imports the handler directly and feeds it a request object, so it needs no
// listening port and no deployment.

const { default: handler } = await import('../frontend/api/index.js');

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

async function get(path, headers = {}) {
  const res = mockRes();
  await handler({ url: path, method: 'GET', headers }, res);
  return res;
}

let pass = 0, fail = 0;
const t = (name, ok) => ok ? (pass++, console.log('  ok   ' + name))
                           : (fail++, console.log('  FAIL ' + name));

const asRegistrar = await get('/api/admin/ops', { 'x-fabric-identity': 'registrar1' });

t('a registrar gets the queue, not a 404', asRegistrar._status === 200);
t('the actor is echoed back', asRegistrar._body?.actor?.role === 'Registrar');
t('actionable is a count', typeof asRegistrar._body?.actionable === 'number');

const queues = asRegistrar._body?.queues || {};
for (const k of ['awaitingValidation', 'validatedNotMinted', 'frozen',
                 'stuckPayments', 'expiredPending', 'pendingKyc']) {
  t(`queue ${k} is a list`, Array.isArray(queues[k]));
}
t('counts mirror the queues',
  Object.entries(queues).every(([k, v]) => asRegistrar._body.counts[k] === v.length));

// The page must render even with no rail configured, and must say which it is
// rather than implying an empty rail is a healthy one.
t('rail reachability is stated either way',
  typeof asRegistrar._body?.rail?.reachable === 'boolean');
t('chain height is reported', typeof asRegistrar._body?.chain?.blocks === 'number');

t('a regulator may also read it',
  (await get('/api/admin/ops', { 'x-fabric-identity': 'regulator1' }))._status === 200);

const asInvestor = await get('/api/admin/ops', { 'x-fabric-identity': 'investor1' });
t('an investor is refused', asInvestor._status === 403);
t('the refusal says why', asInvestor._body?.error === 'ERR_NOT_REGISTRAR');

const total = pass + fail;
console.log(`\n  admin ops (serverless): ${pass}/${total} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
