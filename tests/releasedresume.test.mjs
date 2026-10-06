// Returning from PayU to a purchase the server already finished must show
// success, not an error.
//
// The PayU callback settles server-side now, so by the time the browser polls
// the payment it is usually RELEASED, not CONFIRMED. The resume loop treated
// "anything that is not PENDING or CONFIRMED" as a failure and told the buyer
// "Payment RELEASED — no tokens moved, nothing was kept" for a purchase that
// had completed correctly and whose tokens HAD moved.
//
// The contract the UI now depends on: settling an already-RELEASED payment is
// idempotent, reports ok, and hands back the transfer so the success screen
// can render.
const BASE = process.env.BASE || 'http://localhost:8099';
const ASSET = 'PROP-GREEN-VALLEY-PUNE-001';
let p = 0, f = 0;
const t = (n, c) => { if (c) { p++; console.log('  ok   ' + n); } else { f++; console.log('  FAIL ' + n); } };

const tok = Buffer.from(JSON.stringify({
  identityId: 'investor2', mspId: 'InvestorMSP', role: 'Investor',
  exp: Math.floor(Date.now() / 1000) + 3600,
})).toString('base64');
const auth = { 'content-type': 'application/json', authorization: 'Bearer ' + tok };
const j = async (u, o) => { const r = await fetch(BASE + u, o); return { s: r.status, b: await r.json().catch(() => ({})) }; };

const { b: pay } = await j('/api/npci/collect', {
  method: 'POST', headers: auth,
  body: JSON.stringify({
    assetId: ASSET, tokenAmount: 3, amountINR: 1500,
    payerVpa: 'investor@aasthichain', payeeVpa: 'originator@aasthichain',
    payerId: 'investor2', payeeId: 'originator1',
  }),
});
t('collect created a payment', !!pay.paymentId);

await j(`/api/npci/payments/${pay.paymentId}/approve`, {
  method: 'POST', headers: auth, body: JSON.stringify({ payerId: 'investor2' }),
});

// server-side settlement, the way the PayU callback does it
const { b: first } = await j(`/api/npci/payments/${pay.paymentId}/settle`, {
  method: 'POST', headers: auth, body: JSON.stringify({}),
});
t('the server settles the purchase', first.ok === true);
t('tokens moved', !!(first.transfer && first.transfer.transferId));
const movedTo = first.transfer && first.transfer.toId;

// now the browser comes back and polls — this is the resume path
const { b: seen } = await j(`/api/npci/payments/${pay.paymentId}`, { headers: auth });
t('the browser sees RELEASED, not CONFIRMED', seen.status === 'RELEASED');

// what the resume loop does with it
const { s: rs, b: again } = await j(`/api/npci/payments/${pay.paymentId}/settle`, {
  method: 'POST', headers: auth, body: JSON.stringify({}),
});
t('settling an already-settled payment is not an error', rs === 200 && again.ok === true);
t('it is reported as already done', again.already === true);
t('it returns the transfer so success can render', !!(again.transfer && again.transfer.transferId));
t('the transfer is the same one, not a second purchase',
  again.transfer && first.transfer && again.transfer.transferId === first.transfer.transferId);
t('the tokens are with the buyer', movedTo === 'investor2');

console.log(`\n${p}/${p + f} passed`);
process.exit(f ? 1 : 0);
