// Listing a property must make it tradeable on the settlement rail.
//
// Tokenizing wrote the opening balance into the app ledger only. The rail had
// never heard of the asset, so the first purchase moved tokens app-side while
// the rail refused the DvP with ERR_UMI_INSUFFICIENT_SECURITIES — the buyer
// got a "Payment Successful, atomic DvP" receipt while the chain recorded
// UMI_DVP_FAILED for the same purchase. This pins listing and settleability
// together.
const BASE = process.env.BASE || 'http://localhost:8080';
const RAIL = process.env.RAIL || 'http://localhost:21100';
let p = 0, f = 0;
const t = (n, c) => { if (c) { p++; console.log('  ok   ' + n); } else { f++; console.log('  FAIL ' + n); } };

const tok = Buffer.from(JSON.stringify({
  identityId: 'originator1', mspId: 'OriginatorMSP', role: 'Originator',
  exp: Math.floor(Date.now() / 1000) + 3600,
})).toString('base64');
const auth = { 'content-type': 'application/json', authorization: 'Bearer ' + tok };
const j = async (u, o) => { const r = await fetch(BASE + u, o); return { s: r.status, b: await r.json().catch(() => ({})) }; };
const railPost = async (path, body) => {
  const r = await fetch(RAIL + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { s: r.status, b: await r.json().catch(() => ({})) };
};

const stamp = Date.now();
const { s: cs, b: created } = await j('/api/properties', {
  method: 'POST', headers: auth,
  body: JSON.stringify({
    title: `Rail Seed Check ${stamp}`, city: 'Pune', state: 'Maharashtra',
    pincode: '411001', valuationINR: 5000000, propertyType: 'RESIDENTIAL',
  }),
});
t('property created', cs < 400 && !!created.assetId);
const assetId = created.assetId;

const TOKENS = 5000;
// a listing must be registrar-validated before it can be tokenized
const regTok = Buffer.from(JSON.stringify({
  identityId: 'registrar1', mspId: 'RegistrarMSP', role: 'Registrar',
  exp: Math.floor(Date.now() / 1000) + 3600,
})).toString('base64');
const { s: vs } = await j(`/api/properties/${encodeURIComponent(assetId)}/validate`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer ' + regTok },
  body: JSON.stringify({ decision: 'VALIDATED', notes: 'test' }),
});
t('registrar validated the listing', vs === 200);

const { s: ms, b: minted } = await j(`/api/properties/${encodeURIComponent(assetId)}/mint`, {
  method: 'POST', headers: auth, body: JSON.stringify({ totalTokens: TOKENS }),
});
t('property tokenized', ms === 200 && minted.totalTokens === TOKENS);

// the point of the fix
t('tokenizing reported a rail result', !!minted.rail);
t('the opening position was issued on the rail', minted.rail && minted.rail.ok === true);

// and the proof: a DvP for this brand-new asset is settleable immediately
const dry = await railPost('/umi/dvp', {
  assetId, seller: 'originator1', buyer: 'investor1',
  tokens: 10, pricePerTokenINR: 100, dryRun: true,
});
t('a purchase of a freshly listed property settles on the rail', dry.s === 200);
t('it is NOT refused for missing securities', dry.b.error !== 'ERR_UMI_INSUFFICIENT_SECURITIES');

console.log(`\n${p}/${p + f} passed`);
process.exit(f ? 1 : 0);
