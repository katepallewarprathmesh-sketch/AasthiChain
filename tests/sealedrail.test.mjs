// What does the app tell a buyer when the settlement rail cannot record?
//
// A rail whose ledger failed verification seals itself and refuses new
// blocks. The app keeps working — the ownership ledger is a separate chain —
// so a purchase still completes. The danger is what the app *says* about it:
// if the response reads the same as a settled trade, the user is told a
// settlement happened that nothing can prove.
//
// This suite stands a stub in front of the app that behaves exactly like a
// sealed rail (reads fine, every write 503 ERR_LEDGER_SEALED) and checks the
// app stays honest about it.
import { spawn } from 'node:child_process';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';

const APP_PORT = 8097;
const RAIL_PORT = 21197;
const API = `http://localhost:${APP_PORT}`;

let pass = 0, fail = 0;
const t = (name, ok, detail) => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};

const tokenFor = (identityId, role) =>
  Buffer.from(JSON.stringify({ identityId, mspId: 'M', role, exp: Date.now() + 3600000 })).toString('base64');
const ORIGINATOR = tokenFor('originator1', 'Originator');
const REGISTRAR = tokenFor('registrar1', 'Registrar');
const INVESTOR = tokenFor('investor1', 'Investor');

// --- the sealed rail stand-in ---
const rail = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    if (req.method !== 'GET') {
      res.statusCode = 503;
      return res.end(JSON.stringify({ error: 'ERR_LEDGER_SEALED', message: 'ledger refusing new blocks' }));
    }
    if (req.url.startsWith('/health')) return res.end(JSON.stringify({ build: { commit: 'sealedstub' } }));
    if (req.url.startsWith('/umi/reconciliation')) {
      return res.end(JSON.stringify({
        conserved: true,
        chain: { valid: false, brokenAt: 190, reason: 'merkle root mismatch — transactions altered after commit' },
      }));
    }
    res.end(JSON.stringify({ ok: true }));
  });
});
rail.listen(RAIL_PORT, '0.0.0.0');
await once(rail, 'listening');

const app = spawn(process.execPath, ['server.js'], {
  cwd: new URL('..', import.meta.url).pathname,
  env: {
    ...process.env,
    DEMO_AUTH: 'true',
    ADMIN_DASHBOARD_KEY: 'devkey',
    UMI_GATEWAY_URL: `http://localhost:${RAIL_PORT}`,
    PORT: String(APP_PORT),
  },
  stdio: 'ignore',
});

const shutdown = () => { app.kill('SIGKILL'); rail.close(); };
process.on('exit', shutdown);

async function call(path, token, init = {}) {
  const headers = { 'Content-Type': 'application/json', ...(init.headers || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(API + path, { ...init, headers });
  let body = null;
  try { body = await res.json(); } catch { /* not json */ }
  return { status: res.status, body };
}

// wait for boot
let up = false;
for (let i = 0; i < 60 && !up; i++) {
  try { up = (await call('/api/properties', null)).status === 200; } catch { /* retry */ }
  if (!up) await new Promise((r) => setTimeout(r, 250));
}
if (!up) { console.log('  app did not start'); shutdown(); process.exit(1); }

console.log(`sealed settlement rail (${API})`);

// A purchasable listing of our own: the seeded one can be fully subscribed.
const reg = await call('/api/properties', ORIGINATOR, {
  method: 'POST',
  body: JSON.stringify({
    title: 'Sealed Rail Probe', state: 'MH', city: 'Pune', pincode: '411001',
    valuationINR: 5000000, documentHash: randomBytes(32).toString('hex'),
  }),
});
const assetId = (reg.body && (reg.body.assetId || (reg.body.property && reg.body.property.assetId)));
t('a listing can still be registered while the rail is sealed', Boolean(assetId), JSON.stringify(reg.body).slice(0, 140));

await call(`/api/properties/${assetId}/validate`, REGISTRAR, { method: 'POST', body: JSON.stringify({ decision: 'VALIDATED' }) });
await call(`/api/properties/${assetId}/mint`, ORIGINATOR, { method: 'POST', body: JSON.stringify({ totalTokens: 1000 }) });

// --- the purchase ---
const collect = await call('/api/npci/collect', INVESTOR, {
  method: 'POST',
  body: JSON.stringify({
    assetId, amountINR: 5000, tokenAmount: 10,
    payerVpa: 'buyer@aasthichain', payeeVpa: 'originator@aasthichain',
  }),
});
const paymentId = collect.body && collect.body.paymentId;
t('a payment can still be raised', Boolean(paymentId), JSON.stringify(collect.body).slice(0, 140));

await call(`/api/npci/payments/${paymentId}/approve`, INVESTOR, { method: 'POST', body: JSON.stringify({ payerId: 'investor1' }) });
await call(`/api/npci/payments/${paymentId}/settle`, INVESTOR, { method: 'POST', body: JSON.stringify({}) });

const pay = (await call(`/api/npci/payments/${paymentId}`, INVESTOR)).body;
const record = (pay && pay.payment) || pay || {};

// The honesty conditions. The app ledger legitimately moved the tokens, so
// the payment reaching RELEASED is correct. What must NOT happen is the
// payment claiming a DvP instruction that no block backs.
t('the purchase still completes in the ownership ledger', record.status === 'RELEASED', `status=${record.status}`);
t('the refusal is recorded on the payment', record.umiError === 'ERR_LEDGER_SEALED', `umiError=${record.umiError}`);
t('no settlement instruction id is claimed', !record.umiInstructionId, `umiInstructionId=${record.umiInstructionId}`);

// --- the verify report ---
const verify = (await call(`/api/properties/${assetId}/verify`, null)).body;
const chainCheck = (verify.checks || []).find((c) => c.id === 'chain') || {};
t('the chain check names which ledger it checked',
  /ownership ledger/i.test(chainCheck.label || ''), chainCheck.label);
t('and it reports the rail ledger failing verification',
  /settlement rail/i.test(chainCheck.detail || '') && /190/.test(chainCheck.detail || ''),
  (chainCheck.detail || '').slice(0, 160));
t('  flagged as a warning, not a silent pass', chainCheck.warn === true, JSON.stringify(chainCheck).slice(0, 120));

// --- the operator view ---
const status = (await call('/api/admin/insights/status', null)).body;
t('the operator status reports the rail ledger as invalid',
  status.rail && status.rail.ledgerValid === false, JSON.stringify(status.rail).slice(0, 160));
t('  and names the break', status.rail && status.rail.ledgerBrokenAt === 190, JSON.stringify(status.rail).slice(0, 160));

// --- the rail proxy itself ---
const direct = await call(`/api/umi/wallets/investor1/fund`, tokenFor('regulator1', 'Regulator'), {
  method: 'POST', body: JSON.stringify({ amountINR: 1000 }),
});
t('a rail write is passed through as refused, not swallowed',
  direct.status === 503 && direct.body && direct.body.error === 'ERR_LEDGER_SEALED',
  `${direct.status} ${JSON.stringify(direct.body).slice(0, 120)}`);

console.log(`\n${pass} passed, ${fail} failed`);
shutdown();
process.exit(fail ? 1 : 0);
