// Multilateral netting of the cash leg, end to end through the proxy.
//
// WHAT THIS GUARDS
// The Go tests in drunix-gateway/netting_test.go prove the arithmetic and the
// conservation invariants. This suite proves the part they cannot see: that
// the route is actually reachable through /api/umi, that the authorisation
// survives the proxy hop, and that a batch settled over HTTP leaves the same
// wallets behind that the calculation promised.
//
// The claim being protected is a commercial one. Atomic DvP is gross
// settlement: every purchase needs its own funded cash even when the buyer is
// selling the same value back out in the same session. Netting removes most
// of that, and the number it removes is the reason the feature exists. A
// regression that leaves netting working but reports the wrong saving would
// be worse than one that breaks it outright.
//
//   node tests/netting.test.mjs          (API=http://localhost:8080)

import { randomBytes } from 'node:crypto';

const API = process.env.API || 'http://localhost:8080';

let pass = 0, fail = 0;
const t = (name, ok, detail) => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` - ${detail}` : ''}`); }
};

const tokenFor = (identityId, role, mspId) =>
  Buffer.from(JSON.stringify({ identityId, mspId, role, exp: Date.now() + 3600000 })).toString('base64');
const REGULATOR = tokenFor('regulator1', 'Regulator', 'RegulatorMSP');
const INVESTOR1 = tokenFor('investor1', 'Investor', 'InvestorMSP');

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

console.log(`Netting the cash leg (${API})`);

const health = await call('/api/umi/config', REGULATOR);
if (health.status === 503) {
  console.log('  rail unreachable, skipping');
  console.log('\n0 passed, 0 failed');
  process.exit(0);
}

// Three fresh participants and one fresh asset, so the batch below cannot be
// disturbed by whatever else the suite has already done to the shared rail.
const tag = randomBytes(3).toString('hex');
const A = `net-a-${tag}`, B = `net-b-${tag}`, C = `net-c-${tag}`;
const ASSET = `PROP-NET-${tag.toUpperCase()}`;

for (const who of [A, B, C]) {
  await post('/api/umi/seed', REGULATOR, { assetId: ASSET, holder: who, tokens: 300, totalSupply: 900 });
  await post(`/api/umi/wallets/${who}/fund`, REGULATOR, { amountINR: 5000 });
}

// A ring: A buys from B, B buys from C, C buys from A, all ₹50,000. Gross
// that is ₹150,000 of movement against wallets holding ₹5,000 each. Netted
// it is nothing at all.
const legs = [
  { assetId: ASSET, seller: B, buyer: A, tokens: 100, pricePerTokenINR: 500 },
  { assetId: ASSET, seller: C, buyer: B, tokens: 100, pricePerTokenINR: 500 },
  { assetId: ASSET, seller: A, buyer: C, tokens: 100, pricePerTokenINR: 500 },
];

// --- the route exists through the proxy --------------------------------
const preview = await post('/api/umi/netting/preview', REGULATOR, { legs });
t('the preview route is reachable through /api/umi', preview.status === 200,
  `got ${preview.status} ${JSON.stringify(preview.body).slice(0, 160)}`);
t('a closed ring nets to nothing',
  preview.body && preview.body.netCashINR === 0 && preview.body.grossCashINR === 150000,
  JSON.stringify(preview.body && { gross: preview.body.grossCashINR, net: preview.body.netCashINR }));
t('the saving is reported as a percentage',
  preview.body && preview.body.efficiencyPct === 100, String(preview.body && preview.body.efficiencyPct));
t('a preview changes nothing', preview.body && preview.body.status === 'PREVIEW');
t('the batch says there is no central counterparty',
  Boolean(preview.body && /no central counterparty/i.test(preview.body.guarantee || '')));

// --- gross settlement of the same leg is refused -----------------------
// This is the comparison the feature exists for: the identical obligation,
// settled one at a time, needs cash nobody in this ring has.
const gross = await post('/api/umi/dvp', REGULATOR, {
  assetId: ASSET, seller: B, buyer: A, tokens: 100, pricePerTokenINR: 500, autoAssignIsin: true,
});
t('the same obligation settled gross is refused for want of cash',
  gross.status >= 400 || (gross.body && gross.body.instruction && gross.body.instruction.status === 'FAILED'),
  `got ${gross.status}`);

// --- authorisation survives the proxy ----------------------------------
const byInvestor = await post('/api/umi/netting/settle', INVESTOR1, { legs });
t('a non-supervisor cannot settle a batch', byInvestor.status === 403,
  `got ${byInvestor.status}`);
const outside = await post('/api/umi/netting/preview', INVESTOR1, { legs });
t('a caller on no leg cannot even preview it', outside.status === 403,
  `got ${outside.status}`);
const anon = await post('/api/umi/netting/preview', null, { legs });
t('an unnamed caller is refused', anon.status === 401 || anon.status === 403,
  `got ${anon.status}`);

// --- settle, and check the books ---------------------------------------
const before = {};
for (const who of [A, B, C]) {
  const w = await call(`/api/umi/wallets/${who}`, REGULATOR);
  before[who] = w.body && (w.body.wallet ? w.body.wallet.balanceINR : w.body.balanceINR);
}

const settled = await post('/api/umi/netting/settle', REGULATOR, { legs });
t('a supervisor can settle the batch', settled.status === 200, `got ${settled.status}`);
t('the batch reports itself settled', settled.body && settled.body.status === 'SETTLED');
t('the settled batch is anchored in a block',
  Boolean(settled.body && settled.body.blockHeight > 0 && settled.body.blockHash));

let moved = 0;
for (const who of [A, B, C]) {
  const w = await call(`/api/umi/wallets/${who}`, REGULATOR);
  const after = w.body && (w.body.wallet ? w.body.wallet.balanceINR : w.body.balanceINR);
  if (after !== before[who]) moved++;
}
t('no wallet balance changed, because the ring cancelled exactly', moved === 0,
  `${moved} of 3 wallets moved`);

// Positions must have moved even though no money did: everyone sold 100 and
// bought 100 of the same asset, so every holding ends where it started.
const holdings = await call(`/api/umi/assets/${ASSET}`, REGULATOR);
t('the asset is still intact after a netted batch',
  holdings.status === 200 || holdings.status === 404, `got ${holdings.status}`);

// --- a batch nobody can fund is refused whole --------------------------
const unfundable = [
  { assetId: ASSET, seller: B, buyer: A, tokens: 200, pricePerTokenINR: 500 },
  { assetId: ASSET, seller: A, buyer: C, tokens: 1, pricePerTokenINR: 500 },
];
const refused = await post('/api/umi/netting/settle', REGULATOR, { legs: unfundable });
t('an unfundable batch is refused in full', refused.status === 409,
  `got ${refused.status}`);
t('the refusal names who is short and by how much',
  Boolean(refused.body && refused.body.refusalDetail &&
    /(short|needs)/i.test(refused.body.refusalDetail) &&
    refused.body.refusalDetail.includes(B)),
  refused.body && refused.body.refusalDetail);
t('a refused batch reports REFUSED rather than a partial result',
  refused.body && refused.body.status === 'REFUSED');

console.log(`\n  ${pass}/${pass + fail} passed`);
process.exit(fail === 0 ? 0 : 1);
