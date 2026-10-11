// A bank reference was treated as a password.
//
// GET /api/npci/utr/{utr} answered with the entire payment record — both UPI
// handles, both identities, the internal ids, the risk assessment — to
// anyone who knew the reference, with no session at all. A UTR is not a
// secret: it is printed on receipts, pasted into support tickets and sent to
// the counterparty. Meanwhile the payments list one route over has been
// owner-filtered since the payment audit, so the same data was private
// through one door and public through another.
//
// The reference stays checkable, because that is what a receipt is for. What
// changed is how much a checker who is not part of the payment is told: the
// amount, the status, when it settled, and the account handles masked.
// Payer, payee and supervisors still get the full record.
import { randomBytes } from 'node:crypto';

const API = process.env.API || 'http://localhost:8080';

let pass = 0, fail = 0;
const t = (name, ok, detail) => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};

const tokenFor = (identityId, role) =>
  Buffer.from(JSON.stringify({ identityId, mspId: 'M', role, exp: Date.now() + 3600000 })).toString('base64');
const ORIGINATOR = tokenFor('originator1', 'Originator');
const REGISTRAR = tokenFor('registrar1', 'Registrar');
// investor2 pays. That matters: a demo-mode server hands an unauthenticated
// caller a stand-in investor1 identity, so making investor1 the payer would
// quietly turn the anonymous probe into an owner probe and prove nothing.
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

console.log(`UTR lookup scope (${API})`);

// ---- a payment of our own to look up
const documentHash = randomBytes(32).toString('hex');
const created = await post('/api/properties', ORIGINATOR, {
  address: 'UTR Scope House, Pune', valuationINR: 5000000, documentHash, totalTokens: 10000,
});
const asset = (created.body && (created.body.property?.assetId || created.body.assetId || created.body.property?.id));
if (!asset) {
  console.log(`  could not create a property (${created.status}) — skipping`);
  console.log('\n0 passed, 0 failed');
  process.exit(0);
}
await post(`/api/properties/${asset}/validate`, REGISTRAR, { decision: 'VALIDATED' });
await post(`/api/properties/${asset}/mint`, ORIGINATOR, { totalTokens: 10000 });

const collected = await post('/api/npci/collect', PAYER, {
  assetId: asset, amountINR: 5000, tokenAmount: 10,
  payerVpa: 'investor2@upi', payeeVpa: 'owner@upi',
});
const paymentId = collected.body && (collected.body.paymentId || collected.body.payment?.paymentId);
if (!paymentId) {
  console.log(`  could not raise a collect (${collected.status}) — skipping`);
  console.log('\n0 passed, 0 failed');
  process.exit(0);
}
const approved = await post(`/api/npci/payments/${paymentId}/approve`, PAYER, { payerId: 'investor2' });
const utr = approved.body && (approved.body.utr || approved.body.payment?.utr);
if (!utr) {
  console.log(`  no UTR issued on approval (${approved.status}) — skipping`);
  console.log('\n0 passed, 0 failed');
  process.exit(0);
}

const leaks = (r) => /investor2@upi|owner@upi/.test(r.raw);

// ---- the reference still works for anyone holding it
const anon = await call(`/api/npci/utr/${utr}`, null);
t('an anonymous checker can still verify the reference', anon.status === 200, `got ${anon.status}`);
t('the anonymous answer confirms the amount', anon.body?.amountINR === 5000 || anon.body?.payment?.amountINR === 5000,
  anon.raw.slice(0, 160));

// ---- but it no longer hands over the payment
t('an anonymous checker does not get the account handles', !leaks(anon), anon.raw.slice(0, 200));
t('an anonymous checker does not get the payer identity', !/"payerId"\s*:\s*"investor2"/.test(anon.raw), anon.raw.slice(0, 200));
t('the anonymous answer says it is a receipt view', anon.body?.scope === 'receipt', String(anon.body?.scope));
t('the handles are masked rather than dropped',
  /\*\*\*@upi/.test(anon.raw), anon.raw.slice(0, 200));

const stranger = await call(`/api/npci/utr/${utr}`, STRANGER);
t('a signed-in stranger gets the same receipt view, not the record', !leaks(stranger) && stranger.status === 200,
  `${stranger.status} ${stranger.raw.slice(0, 160)}`);

// ---- the people it belongs to still see everything
const payer = await call(`/api/npci/utr/${utr}`, PAYER);
t('the payer sees the full record', payer.status === 200 && leaks(payer), `${payer.status} ${payer.raw.slice(0, 160)}`);
t('the payer answer is marked full', payer.body?.scope === 'full', String(payer.body?.scope));

const supervisor = await call(`/api/npci/utr/${utr}`, REGULATOR);
t('a supervisor sees the full record', supervisor.status === 200 && leaks(supervisor),
  `${supervisor.status} ${supervisor.raw.slice(0, 160)}`);

// ---- the printable receipt page follows the same rule
const html = await fetch(`${API}/api/npci/utr/${utr}`, { headers: { accept: 'text/html' } });
const page = await html.text();
t('the public receipt page masks the handles too',
  !/investor2@upi|owner@upi/.test(page), page.slice(0, 200));

// ---- an unknown reference is still a plain 404, not a hint
const missing = await call('/api/npci/utr/000000000000', null);
t('an unknown reference is a flat 404', missing.status === 404, `got ${missing.status}`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
