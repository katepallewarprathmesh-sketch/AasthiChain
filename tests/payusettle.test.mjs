// A successful PayU payment must reach the ledger from the callback alone.
// Previously the callback marked the payment CONFIRMED and stopped there:
// tokens only moved if the buyer's browser made it back to the property page
// and drove the settle itself. Close the tab and the money was taken while
// the ledger showed nothing.
import crypto from 'crypto';

const BASE = process.env.BASE || 'http://localhost:8099';
const KEY = process.env.PAYU_MERCHANT_KEY || 'testkey';
const SALT = process.env.PAYU_SALT || 'testsalt';
const ASSET = 'PROP-GREEN-VALLEY-PUNE-001';

let p = 0, f = 0;
const t = (n, c) => { if (c) { p++; console.log('  ok   ' + n); } else { f++; console.log('  FAIL ' + n); } };

const tok = Buffer.from(JSON.stringify({
  identityId: 'investor1', mspId: 'InvestorMSP', role: 'Investor',
  exp: Math.floor(Date.now() / 1000) + 3600,
})).toString('base64');
const auth = { 'content-type': 'application/json', authorization: 'Bearer ' + tok };

const j = async (u, o) => { const r = await fetch(BASE + u, o); return { s: r.status, b: await r.json().catch(() => ({})) }; };
// This is the chain LedgerExplorer.jsx renders (api.getUmiChain → /api/drunix/chain).
const chain = async () => (await j('/api/drunix/chain?limit=100')).b || {};
const chainLen = async () => Number((await chain()).totalBlocks ?? 0);
const chainTypes = async () => ((await chain()).blocks || []).map(b => b.type);

// PayU's response hash: salt|status||||||udf5..udf1|email|firstname|productinfo|amount|txnid|key
const respHash = (st, pay, udf) => crypto.createHash('sha512').update([
  SALT, st, '', '', '', '', '',
  udf[4], udf[3], udf[2], udf[1], udf[0],
  'investor@aasthichain.demo', 'investor', pay.productinfo,
  Number(pay.amountINR).toFixed(2), pay.paymentId, KEY,
].join('|')).digest('hex');

const before = await chainLen();

const { b: pay } = await j('/api/npci/collect', {
  method: 'POST', headers: auth,
  body: JSON.stringify({ assetId: ASSET, tokenAmount: 2, amountINR: 1000,
    payerVpa: 'investor@aasthichain', payeeVpa: 'owner@aasthichain' }),
});
t('collect returns a PayU checkout', Boolean(pay.payuCheckout));
t('payment starts PENDING', pay.status === 'PENDING');

const udf = [pay.assetId, String(pay.tokenAmount), pay.upiTxnId || '', 'owner@aasthichain', ''];
const productinfo = pay.payuCheckout.params.productinfo;
const body = new URLSearchParams({
  key: KEY, txnid: pay.paymentId, amount: Number(pay.amountINR).toFixed(2),
  productinfo, firstname: 'investor', email: 'investor@aasthichain.demo',
  status: 'success', mihpayid: 'MIH' + Date.now(), bank_ref_num: '418900112233',
  udf1: udf[0], udf2: udf[1], udf3: udf[2], udf4: udf[3], udf5: udf[4],
  hash: respHash('success', { ...pay, productinfo }, udf),
});

// PayU posts this to us when the buyer finishes paying.
const cb = await fetch(BASE + '/api/npci/payu/callback', {
  method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body,
});
t('callback accepted', cb.status === 200);
const html = await cb.text();
t('receipt shows success, not pending', html.includes('Payment confirmed'));

const { b: after } = await j(`/api/npci/payments/${pay.paymentId}`, { headers: auth });
t('payment settled without the browser', after.status === 'RELEASED');
t('a transfer id was recorded', Boolean(after.drunixTransferId));
t('UTR captured from PayU', after.utr === '418900112233');

t('the explorer chain grew', (await chainLen()) > before);
t('a DvP settlement block was committed', (await chainTypes()).includes('UMI_DVP_SETTLED'));
t('payment carries its UMI instruction id', Boolean(after.umiInstructionId));

const { b: hist } = await j(`/api/transfers/history?ownerId=investor1&assetId=${ASSET}`, { headers: auth });
t('transfer appears in history', (hist.transfers || []).some(x => x.transferId === after.drunixTransferId));

// Replaying the same callback must not double-spend.
const lenAfter = await chainLen();
await fetch(BASE + '/api/npci/payu/callback', {
  method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body,
});
t('replayed callback does not add blocks', (await chainLen()) === lenAfter);
const { b: again } = await j(`/api/npci/payments/${pay.paymentId}`, { headers: auth });
t('replay keeps one transfer id', again.drunixTransferId === after.drunixTransferId);

console.log(`\n${p}/${p + f} passed`);
process.exit(f ? 1 : 0);
