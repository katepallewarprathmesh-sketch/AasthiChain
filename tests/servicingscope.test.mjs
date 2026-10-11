// Asset servicing paid out of a wallet nobody checked you owned.
//
// POST /umi/servicing runs a rent or coupon distribution: it debits the
// wallet named in the body's `payer` field and credits every holder of the
// asset pro-rata. The payer came from the request body and was never
// compared against the caller, and the route had no identity check at all,
// so an anonymous stranger could empty someone else's e₹-W balance into the
// holders of any asset they liked — real money movement, with a block to
// prove it happened.
//
// POST /umi/seed had the same shape in the other direction: it issues a
// securities position out of nothing. It is a demo fixture, but an anonymous
// caller could mint themselves any number of tokens of any asset, which the
// marketplace and the DvP leg then treat as a real holding.
//
// Rules now enforced in Go, next to the ledger:
//   servicing — the caller must BE the payer, or be a supervisor
//   seed      — supervisors only; it creates securities rather than moving them
import { randomBytes } from 'node:crypto';

const API = process.env.API || 'http://localhost:8080';

let pass = 0, fail = 0;
const t = (name, ok, detail) => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};

const tokenFor = (identityId, role, mspId) =>
  Buffer.from(JSON.stringify({ identityId, mspId, role, exp: Date.now() + 3600000 })).toString('base64');
const PAYER = 'svcpayer' + randomBytes(3).toString('hex');
const HOLDER = 'svcholder' + randomBytes(3).toString('hex');
const PAYER_TOKEN = tokenFor(PAYER, 'Investor', 'InvestorMSP');
const STRANGER = tokenFor('svcstranger' + randomBytes(3).toString('hex'), 'Investor', 'InvestorMSP');
const REGULATOR = tokenFor('regulator1', 'Regulator', 'RegulatorMSP');

async function call(path, token, init = {}) {
  const headers = { 'Content-Type': 'application/json', ...(init.headers || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(API + path, { ...init, headers });
  let body = null;
  try { body = await res.json(); } catch { /* not json */ }
  return { status: res.status, body };
}
const post = (path, token, payload) =>
  call(path, token, { method: 'POST', body: JSON.stringify(payload) });

console.log(`UMI servicing and seeding scope (${API})`);

const health = await call('/api/umi/config', REGULATOR);
if (health.status === 503 || health.status === 404) {
  console.log('  rail unreachable — skipping');
  console.log('\n0 passed, 0 failed');
  process.exit(0);
}

const ASSET = 'SVC-' + randomBytes(4).toString('hex').toUpperCase();

// ---- seeding: issuing a position is an issuance, not a convenience
const seedAnon = await post('/api/umi/seed', null,
  { assetId: ASSET, holder: HOLDER, tokens: 1000, authorisedTokens: 1000 });
t('an anonymous caller cannot issue a securities position', seedAnon.status === 401, `got ${seedAnon.status}`);

const seedStranger = await post('/api/umi/seed', STRANGER,
  { assetId: ASSET, holder: HOLDER, tokens: 1000, authorisedTokens: 1000 });
t('an ordinary investor cannot issue a securities position', seedStranger.status === 403, `got ${seedStranger.status}`);

const ownership = await call(`/api/umi/ownership/${ASSET}`, REGULATOR);
const issuedAnyway = JSON.stringify(ownership.body || {}).includes(HOLDER);
t('the refused issuance created nothing', !issuedAnyway, JSON.stringify(ownership.body || {}).slice(0, 160));

const seedOk = await post('/api/umi/seed', REGULATOR,
  { assetId: ASSET, holder: HOLDER, tokens: 1000, authorisedTokens: 1000 });
t('a supervisor can issue a securities position', seedOk.status === 200, `got ${seedOk.status}`);

// ---- a wallet worth draining
const funded = await post(`/api/umi/wallets/${PAYER}/fund`, REGULATOR, { amountINR: 40000 });
t('a supervisor can fund the paying wallet', funded.status === 200, `got ${funded.status}`);

const balance = async () => {
  const r = await call(`/api/umi/wallets/${PAYER}`, REGULATOR);
  const w = r.body && (r.body.wallet || r.body);
  return (w && (w.balanceINR ?? w.balance)) ?? null;
};
const opening = await balance();
t('the paying wallet opens with the funded balance', opening === 40000, `got ${opening}`);

// ---- servicing: the payer field is a claim
const svcAnon = await post('/api/umi/servicing', null,
  { assetId: ASSET, payer: PAYER, amountINR: 10000 });
t('an anonymous caller cannot run a servicing payout', svcAnon.status === 401, `got ${svcAnon.status}`);

const svcStranger = await post('/api/umi/servicing', STRANGER,
  { assetId: ASSET, payer: PAYER, amountINR: 10000 });
t('a stranger cannot pay servicing out of someone else\'s wallet', svcStranger.status === 403, `got ${svcStranger.status}`);
t('the refusal names the right reason',
  svcStranger.body && svcStranger.body.error === 'ERR_UMI_NOT_YOURS',
  JSON.stringify(svcStranger.body || {}).slice(0, 160));

const afterRefusals = await balance();
t('neither refusal moved a rupee', afterRefusals === opening, `${opening} -> ${afterRefusals}`);

// ---- and the people who may
const svcSelf = await post('/api/umi/servicing', PAYER_TOKEN,
  { assetId: ASSET, payer: PAYER, amountINR: 10000 });
t('the payer can run their own servicing', svcSelf.status === 200, `got ${svcSelf.status} ${JSON.stringify(svcSelf.body || {}).slice(0, 160)}`);

const afterSelf = await balance();
t('the payout actually debited the payer', afterSelf === opening - 10000, `${opening} -> ${afterSelf}`);

const svcSupervisor = await post('/api/umi/servicing', REGULATOR,
  { assetId: ASSET, payer: PAYER, amountINR: 5000 });
t('a supervisor can run servicing on behalf of the payer', svcSupervisor.status === 200, `got ${svcSupervisor.status}`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
