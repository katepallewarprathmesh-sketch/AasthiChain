// A purchase completed through the client-driven release path must land on the
// UMI chain, exactly like one completed by the PayU callback.
//
// This was the fourth and final reason "view transfer in ledger" showed
// nothing. /api/npci/payments/{id}/release flipped the payment to RELEASED and
// credited the payee, but never called the settlement rail — so the UI flow
// (which is what real users go through) moved tokens without ever writing a
// UMI_DVP_SETTLED block. On live, 29 payments were RELEASED and only 2 had an
// instruction id: the 2 I had driven through the callback myself.
const BASE = process.env.BASE || 'http://localhost:8099';
const ASSET = 'PROP-GREEN-VALLEY-PUNE-001';
const ADMIN = process.env.ADMIN_DASHBOARD_KEY || 'devkey';

let p = 0, f = 0;
const t = (n, c) => { if (c) { p++; console.log('  ok   ' + n); } else { f++; console.log('  FAIL ' + n); } };

const tok = (id) => Buffer.from(JSON.stringify({
  identityId: id, mspId: 'InvestorMSP', role: 'Investor',
  exp: Math.floor(Date.now() / 1000) + 3600,
})).toString('base64');
const auth = { 'content-type': 'application/json', authorization: 'Bearer ' + tok('investor2') };

const j = async (u, o) => { const r = await fetch(BASE + u, o); return { s: r.status, b: await r.json().catch(() => ({})) }; };
const chain = async () => (await j('/api/drunix/chain?limit=200')).b || {};

const before = Number((await chain()).totalBlocks ?? 0);

// 1. a purchase driven the way the UI drives it: collect -> confirm -> release
const { b: pay } = await j('/api/npci/collect', {
  method: 'POST', headers: auth,
  body: JSON.stringify({
    assetId: ASSET, tokenAmount: 1, amountINR: 500,
    payerVpa: 'investor@aasthichain', payeeVpa: 'originator@aasthichain',
  }),
});
t('collect created a payment', !!pay.paymentId);

const { s: as_, b: appr } = await j(`/api/npci/payments/${pay.paymentId}/approve`, {
  method: 'POST', headers: auth, body: JSON.stringify({ payerId: 'investor2' }),
});
t('approve confirmed the payment', as_ === 200 && appr.status === 'CONFIRMED');

const tid = `TXN-rel-${Date.now()}`;
const { s: rs, b: rel } = await j(`/api/npci/payments/${pay.paymentId}/release`, {
  method: 'POST', headers: auth, body: JSON.stringify({ drunixTransferId: tid }),
});
t('release returns 200', rs === 200);
t('payment is RELEASED', rel.status === 'RELEASED');

// 2. the point of the whole fix
t('release put the purchase on the UMI chain', !!rel.umiInstructionId);
t('release reports the rail result', !!rel.rail);

const after = await chain();
t('chain grew', Number(after.totalBlocks ?? 0) > before);

const onChain = JSON.stringify(after.blocks || []);
t('the cited instruction id is findable on the chain',
  !!rel.umiInstructionId && onChain.includes(rel.umiInstructionId));

// 3. releasing again must not double-settle
const { s: s2, b: again } = await j(`/api/npci/payments/${pay.paymentId}/release`, {
  method: 'POST', headers: auth, body: JSON.stringify({ drunixTransferId: tid }),
});
t('a second release does not create a second instruction',
  s2 === 400 || again.umiInstructionId === rel.umiInstructionId);

// 4. backfill is guarded and idempotent
const { s: noKey } = await j('/api/npci/rail/backfill', { method: 'POST', headers: { 'content-type': 'application/json' } });
t('backfill rejects a request with no admin key', noKey === 401);

const { s: bs, b: bf } = await j('/api/npci/rail/backfill', {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-admin-key': ADMIN },
});
t('backfill returns 200 with an admin key', bs === 200);
t('backfill reports what it considered', typeof bf.considered === 'number');
t('nothing is left behind that it could have committed', (bf.committed ?? 0) + (bf.skipped ?? 0) === bf.considered);

console.log(`\n${p} passed, ${f} failed`);
process.exit(f ? 1 : 0);
