// The settlement rail had no idea who was calling it.
//
// Every /umi/* route acted on whatever participant the URL or the body
// named. Through the public proxy that meant anyone — signed in or not —
// could read a stranger's wholesale CBDC wallet, credit a wallet with money
// that was never debited anywhere, or run a DvP naming someone else as the
// buyer, which spends that person's cash balance.
//
// The rules now live in Go next to the ledger they protect (the node layer
// stays a pure proxy and only forwards the identity it authenticated):
//   wallet read   — the owner, or a supervisor
//   wallet fund   — supervisors only; it creates money rather than moving it
//   dvp           — the caller must be the buyer, or a supervisor
//   reconciliation— deliberately public: the rail proving its own books
import { randomBytes } from 'node:crypto';

const API = process.env.API || 'http://localhost:8080';

let pass = 0, fail = 0;
const t = (name, ok, detail) => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};

const tokenFor = (identityId, role, mspId) =>
  Buffer.from(JSON.stringify({ identityId, mspId, role, exp: Date.now() + 3600000 })).toString('base64');
const INVESTOR1 = tokenFor('investor1', 'Investor', 'InvestorMSP');
const INVESTOR2 = tokenFor('investor2', 'Investor', 'InvestorMSP');
const REGULATOR = tokenFor('regulator1', 'Regulator', 'RegulatorMSP');

async function call(path, token, init = {}) {
  const headers = { 'Content-Type': 'application/json', ...(init.headers || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(API + path, { ...init, headers });
  let body = null;
  try { body = await res.json(); } catch { /* not json */ }
  return { status: res.status, body };
}
const asSupervisor = (path, init) => call(path, REGULATOR, init);

console.log(`UMI rail scope (${API})`);

const health = await call('/api/umi/config', REGULATOR);
if (health.status === 503) {
  console.log('  rail unreachable — skipping');
  console.log('\n0 passed, 0 failed');
  process.exit(0);
}

const WHO = 'scope' + randomBytes(3).toString('hex');

// Fund a wallet as the supervisor so there is something worth protecting.
const funded = await asSupervisor(`/api/umi/wallets/${WHO}/fund`, {
  method: 'POST', body: JSON.stringify({ amountINR: 50000 }),
});
t('a supervisor can fund a wallet', funded.status === 200, `got ${funded.status}`);

// ---- reading someone else's cash position
const anon = await call(`/api/umi/wallets/${WHO}`, null);
t('an anonymous caller cannot read a wallet', anon.status === 401, `got ${anon.status}`);

const nosy = await call(`/api/umi/wallets/${WHO}`, INVESTOR2);
t('another participant cannot read it', nosy.status === 403, `got ${nosy.status}`);
t('  refused as not-yours', nosy.body && nosy.body.error === 'ERR_UMI_NOT_YOURS', JSON.stringify(nosy.body).slice(0, 140));

t('a supervisor can read it', (await asSupervisor(`/api/umi/wallets/${WHO}`)).status === 200);

// ---- the wallet book
const book = await call('/api/umi/wallets', INVESTOR2);
const names = ((book.body && book.body.wallets) || []).map((w) => w.participant);
t('the wallet book does not list everyone', !names.includes(WHO), names.join(',').slice(0, 160));
const fullBook = await asSupervisor('/api/umi/wallets');
t('a supervisor still sees the whole book',
  ((fullBook.body && fullBook.body.wallets) || []).some((w) => w.participant === WHO));

// ---- funding is money creation
const selfFund = await call(`/api/umi/wallets/investor2/fund`, INVESTOR2, {
  method: 'POST', body: JSON.stringify({ amountINR: 10000000 }),
});
t('a participant cannot fund their own wallet', selfFund.status === 403, `got ${selfFund.status}`);
t('  refused as a settlement-bank action',
  selfFund.body && selfFund.body.error === 'ERR_UMI_NOT_SUPERVISOR', JSON.stringify(selfFund.body).slice(0, 140));
t('nor can an anonymous caller',
  (await call(`/api/umi/wallets/${WHO}/fund`, null, { method: 'POST', body: JSON.stringify({ amountINR: 1 }) })).status === 401);

// ---- settling against someone else's wallet
const before = (await asSupervisor(`/api/umi/wallets/${WHO}`)).body.wallet;
const trade = {
  assetId: 'PROP-GREEN-VALLEY-PUNE-001', seller: 'originator1', buyer: WHO,
  tokens: 1, pricePerTokenINR: 500,
};
const raid = await call('/api/umi/dvp', INVESTOR2, { method: 'POST', body: JSON.stringify(trade) });
t('a stranger cannot settle against someone elses wallet', raid.status === 403, `got ${raid.status}`);
const after = (await asSupervisor(`/api/umi/wallets/${WHO}`)).body.wallet;
t('and not a paisa moved', after.balancePaise === before.balancePaise,
  `${before.balancePaise} -> ${after.balancePaise}`);

t('an anonymous settlement is refused',
  (await call('/api/umi/dvp', null, { method: 'POST', body: JSON.stringify(trade) })).status === 401);

// A dry run prices a trade without moving anything, so it stays open.
const dry = await call('/api/umi/dvp', INVESTOR2, {
  method: 'POST', body: JSON.stringify({ ...trade, dryRun: true }),
});
t('a dry run is still allowed', dry.status !== 403 && dry.status !== 401, `got ${dry.status}`);

// ---- the public view stays public
const recon = await call('/api/umi/reconciliation', null);
t('reconciliation is still readable by anyone', recon.status === 200, `got ${recon.status}`);
t('  and still balances', recon.body && recon.body.conserved === true, JSON.stringify(recon.body).slice(0, 120));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
