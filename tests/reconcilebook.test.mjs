// The reconciliation dashboard was the payments book, open to any account.
//
// GET /api/npci/reconcile returns every participant's payments: totals and
// volume, per-payment ids and amounts in its issues lists, the raw provider
// callbacks, and a sample of the UTR index — which is a list of other
// people's bank references, the exact key the receipt route is looked up by.
// Its own note reads "For Regulator". Nothing enforced that: any signed-in
// investor could read the lot, and from there walk the UTRs.
//
// It is supervisory work, so it now needs a supervisor session.
// Your own payments remain at /api/npci/payments, filtered to you.
import { randomBytes } from 'node:crypto';

const API = process.env.API || 'http://localhost:8080';
const ADMIN_KEY = process.env.ADMIN_DASHBOARD_KEY || 'devkey';

let pass = 0, fail = 0;
const t = (name, ok, detail) => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};

const tokenFor = (identityId, role) =>
  Buffer.from(JSON.stringify({ identityId, mspId: 'M', role, exp: Date.now() + 3600000 })).toString('base64');
const ORIGINATOR = tokenFor('originator1', 'Originator');
const REGISTRAR = tokenFor('registrar1', 'Registrar');
const PAYER = tokenFor('investor2', 'Investor');
const STRANGER = tokenFor('investor1', 'Investor');
const REGULATOR = tokenFor('regulator1', 'Regulator');

async function call(path, token, init = {}) {
  const headers = { 'Content-Type': 'application/json', ...(init.headers || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(API + path, { ...init, headers });
  let body = null;
  try { body = await res.json(); } catch { /* not json */ }
  return { status: res.status, body, raw: JSON.stringify(body || {}) };
}
const post = (path, token, payload) =>
  call(path, token, { method: 'POST', body: JSON.stringify(payload || {}) });

console.log(`Reconciliation book scope (${API})`);

const probe = await call('/api/npci/reconcile', REGULATOR);
if (probe.status === 404) {
  console.log('  reconciliation route not implemented here — skipping');
  console.log('\n0 passed, 0 failed');
  process.exit(0);
}

// ---- a payment belonging to someone else
const documentHash = randomBytes(32).toString('hex');
const created = await post('/api/properties', ORIGINATOR, {
  address: 'Reconciliation Scope House, Pune', valuationINR: 5000000, documentHash, totalTokens: 10000,
});
const asset = created.body && (created.body.property?.assetId || created.body.assetId || created.body.property?.id);
if (asset) {
  await post(`/api/properties/${asset}/validate`, REGISTRAR, { decision: 'VALIDATED' });
  await post(`/api/properties/${asset}/mint`, ORIGINATOR, { totalTokens: 10000 });
  const collected = await post('/api/npci/collect', PAYER, {
    assetId: asset, amountINR: 7777, tokenAmount: 5,
    payerVpa: 'investor2@upi', payeeVpa: 'owner@upi',
  });
  const paymentId = collected.body && collected.body.paymentId;
  if (paymentId) await post(`/api/npci/payments/${paymentId}/approve`, PAYER, { payerId: 'investor2' });
}

// ---- who may read the book
const stranger = await call('/api/npci/reconcile', STRANGER);
t('a signed-in investor cannot read the reconciliation book', stranger.status === 403, `got ${stranger.status}`);
t('the refusal points them at their own payments',
  /npci\/payments/.test(stranger.raw), stranger.raw.slice(0, 200));
t('the refusal carries no payment data',
  !/utrIndexSample|recentWebhooks|totalVolumeINR/.test(stranger.raw), stranger.raw.slice(0, 200));

const supervisor = await call('/api/npci/reconcile', REGULATOR);
t('a supervisor reads the book', supervisor.status === 200, `got ${supervisor.status}`);
t('the book is actually populated for the supervisor',
  supervisor.status === 200 && /summary/.test(supervisor.raw), supervisor.raw.slice(0, 120));

// No session at all is turned away by the sign-in gate before the
// reconciliation rule is ever consulted — the ops key is not a way in here.
const keyed = await call('/api/npci/reconcile', null, { headers: { 'x-admin-key': ADMIN_KEY } });
t('a keyed but sessionless caller is still refused', keyed.status === 401, `got ${keyed.status}`);

// ---- the thing that made it worse than a disclosure: it hands out the keys
t('a refused caller gets no UTRs to replay',
  !/\d{12}/.test(stranger.raw), stranger.raw.slice(0, 200));

// ---- a participant can still reconcile themselves
const own = await call('/api/npci/payments', PAYER);
t('the payer can still list their own payments', own.status === 200, `got ${own.status}`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
