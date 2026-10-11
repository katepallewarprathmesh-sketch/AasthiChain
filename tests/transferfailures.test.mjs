// Two routes used to "demonstrate" failure handling by describing it.
//
//   POST /api/transfers/failure-demo {"scenario":"insufficient_balance"}
//   -> { expected:"ERR_INSUFFICIENT_BALANCE",
//        result:"ERR_INSUFFICIENT_BALANCE: have 50 need 999999999",
//        passed:true }
//
// Nothing was attempted. The scenario name was matched against a list and the
// prewritten answer came back, always passing — including on a server where
// the real check had been removed. Its NPCI twin did the same for payments.
//
// Both are deleted. This suite asserts the same four rejections by actually
// performing them, so a claim about a guardrail fails here when the guardrail
// does.
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
const HOLDER = tokenFor('investor2', 'Investor');

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

console.log(`Transfer failure modes (${API})`);

// ---- the storytelling routes are gone
for (const route of ['/api/transfers/failure-demo', '/api/npci/failure-demo']) {
  const gone = await post(route, HOLDER, { scenario: 'insufficient_balance' });
  t(`${route} no longer answers`, gone.status === 404, `got ${gone.status}`);
  t(`${route} reports no passing scenario`, !/"passed":true/.test(gone.raw), gone.raw.slice(0, 140));
}

// ---- a real asset with a real holder
const documentHash = randomBytes(32).toString('hex');
const created = await post('/api/properties', ORIGINATOR, {
  address: 'Failure Mode House, Pune', valuationINR: 5000000, documentHash, totalTokens: 10000,
});
const asset = created.body && (created.body.property?.assetId || created.body.assetId || created.body.property?.id);
if (!asset) {
  console.log('  could not mint a fixture asset — skipping');
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
await post(`/api/properties/${asset}/validate`, REGISTRAR, { decision: 'VALIDATED' });
await post(`/api/properties/${asset}/mint`, ORIGINATOR, { totalTokens: 10000 });

const balanceOf = async (owner) => {
  const r = await call(`/api/balances/${asset}/${owner}`, ORIGINATOR);
  return (r.body && (r.body.balance ?? r.body.tokens)) || 0;
};
const before = await balanceOf('originator1');
t('the originator holds the minted supply', before > 0, `balance ${before}`);

// The two servers disagree on the field name for size, so send both.
const transfer = (payload, token = ORIGINATOR) =>
  post('/api/transfers', token, { assetId: asset, ...payload });

// 1. more than the holder has
const tooMuch = await transfer({ fromId: 'originator1', toId: 'investor2', amount: 999999999, tokens: 999999999 });
t('a transfer larger than the balance is refused', tooMuch.status >= 400, `got ${tooMuch.status}`);
t('  and names insufficiency rather than a generic error',
  /INSUFFICIENT|not enough|exceeds/i.test(tooMuch.raw), tooMuch.raw.slice(0, 160));

// 2. to yourself
const self = await transfer({ fromId: 'originator1', toId: 'originator1', amount: 1, tokens: 1 });
t('a transfer to yourself is refused', self.status >= 400, `got ${self.status}`);

// 3. nothing at all
const zero = await transfer({ fromId: 'originator1', toId: 'investor2', amount: 0, tokens: 0 });
t('a zero-token transfer is refused', zero.status >= 400, `got ${zero.status}`);

// 4. no recipient at all. This one used to succeed: the tokens left the
// sender and were credited to a row called "undefined", which no one can
// ever authenticate as, and the response described it as atomic.
const nobody = await transfer({ fromId: 'originator1', amount: 50, tokens: 50 });
t('a transfer with no recipient is refused', nobody.status >= 400, `got ${nobody.status}`);
t('  and says so plainly', /RECIPIENT/i.test(nobody.raw), nobody.raw.slice(0, 160));

const placeholder = await transfer({ fromId: 'originator1', toId: 'undefined', amount: 50, tokens: 50 });
t('the literal string "undefined" is not a holder either', placeholder.status >= 400, `got ${placeholder.status}`);

// 5. a stranger who holds nothing and has no record
const ghost = await transfer({ fromId: 'originator1', toId: `ghost_${randomBytes(3).toString('hex')}`, amount: 5, tokens: 5 });
t('a transfer to an unknown holder is refused or leaves supply intact',
  ghost.status >= 400 || (await balanceOf('originator1')) === before,
  `status ${ghost.status}`);

// ---- the point of all four: nothing moved
const after = await balanceOf('originator1');
t('every refusal left the balance exactly as it was', after === before, `${before} -> ${after}`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
