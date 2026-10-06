// Cross-property portfolio tokens and dynamic ownership, over HTTP.
//
// A portfolio used to be a view: the app could add up holdings, but there was
// no instrument you could hold or settle. A basket unit is a real claim on a
// fixed recipe of property tokens, and it must always be fully backed — the
// moment a unit exists without its tokens in custody, the whole idea is a lie.
//
// Ownership used to be a snapshot, which pays someone who bought yesterday the
// same as someone who held all year. These check the time-weighted basis too.

const BASE = process.env.BASE || 'http://localhost:8080';
let p = 0, f = 0;
const t = (n, c) => { if (c) { p++; console.log('  ok   ' + n); } else { f++; console.log('  FAIL ' + n); } };

const j = async (u, opts) => {
  const r = await fetch(BASE + u, opts);
  const raw = await r.text();
  let b = null; try { b = JSON.parse(raw) } catch {}
  return { s: r.status, b, raw };
};
const post = (u, body) => j(u, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
});

const stamp = Date.now();
const A = `PROP-BSKT-A-${stamp}`;
const B = `PROP-BSKT-B-${stamp}`;
const BID = `BASKET-${stamp}`;
const HOLDER = `basket-investor-${stamp}`;

// --- seed two properties to one holder -------------------------------------
for (const [asset, tokens] of [[A, 1000], [B, 1000]]) {
  const r = await post('/api/umi/seed', { assetId: asset, holder: HOLDER, tokens, authorisedTokens: 10000 });
  t(`seeded ${asset.slice(-12)}`, r.s === 200);
}

// --- a basket must actually be a basket -------------------------------------
const single = await post('/api/umi/baskets', {
  basketId: `${BID}-BAD`, name: 'one asset',
  components: [{ assetId: A, tokensPerUnit: 1, indicativePriceINR: 100 }]
});
t('a one-asset basket is refused', single.s === 400);
t('the refusal names the reason', /two distinct assets/i.test(single.b?.message || ''));

const dupe = await post('/api/umi/baskets', {
  basketId: `${BID}-DUPE`, name: 'dupes',
  components: [{ assetId: A, tokensPerUnit: 1 }, { assetId: A, tokensPerUnit: 2 }]
});
t('the same asset twice is refused', dupe.s === 400);

// --- create -----------------------------------------------------------------
const created = await post('/api/umi/baskets', {
  basketId: BID, name: 'Pune + Mumbai mix', custodian: `${BID}-CUSTODY`,
  components: [
    { assetId: A, tokensPerUnit: 2, indicativePriceINR: 500 },
    { assetId: B, tokensPerUnit: 3, indicativePriceINR: 100 }
  ]
});
t('basket created', created.s === 201);
t('NAV per unit is the recipe value', created.b?.navPerUnitINR === 1300);
t('creating issues no units', created.b?.basket?.unitsOutstanding === 0);
t('creation is committed to the chain', !!created.b?.block);

// --- subscribe --------------------------------------------------------------
const sub = await post(`/api/umi/baskets/${BID}/subscribe`, { holder: HOLDER, units: 10 });
t('subscription accepted', sub.s === 200);
t('units issued', sub.b?.unitsHeld === 10);
t('units outstanding tracked', sub.b?.basket?.unitsOutstanding === 10);
t('every issued unit is fully backed', sub.b?.basket?.fullyBacked === true);
t('subscription is committed to the chain', !!sub.b?.block);

const backing = sub.b?.basket?.backing || [];
const bA = backing.find(x => x.assetId === A);
t('custody holds 2 tokens per unit of the first asset', bA?.heldInCustody === 20);
t('custody requirement is stated', bA?.requiredInCustody === 20);

// --- backing came out of the holder ----------------------------------------
const own = await j(`/api/umi/ownership/${A}`);
t('ownership endpoint responds', own.s === 200);
const slice = (own.b?.holders || []).find(h => h.holder === HOLDER);
t('holder gave up the backing tokens', slice?.tokens === 980);
t('ownership reports a current percentage', typeof slice?.pctNow === 'number');
t('ownership reports a time-weighted percentage', typeof slice?.pctTimeWeighted === 'number');
t('ownership journalled the moves', (own.b?.events || 0) > 0);
const custodySlice = (own.b?.holders || []).find(h => h.holder === `${BID}-CUSTODY`);
t('custody appears in the cap table', custodySlice?.tokens === 20);

// --- holdings across properties as one number -------------------------------
const hold = await j(`/api/umi/holdings/${HOLDER}`);
t('holdings endpoint responds', hold.s === 200);
const mine = (hold.b?.baskets || []).find(x => x.basketId === BID);
t('basket holding is reported', mine?.units === 10);
t('value spans both properties as one figure', mine?.valueINR === 13000);
t('total basket value is summed', hold.b?.totalBasketValueINR >= 13000);

// --- all-or-nothing ----------------------------------------------------------
const broke = `broke-${stamp}`;
await post('/api/umi/seed', { assetId: A, holder: broke, tokens: 50, authorisedTokens: 10000 });
// Holds A but nothing of B, so the second leg must fail and the first roll back.
const partial = await post(`/api/umi/baskets/${BID}/subscribe`, { holder: broke, units: 5 });
t('a subscription that cannot deliver every leg fails', partial.s === 409);
const afterA = await j(`/api/umi/ownership/${A}`);
const brokeSlice = (afterA.b?.holders || []).find(h => h.holder === broke);
t('the deliverable leg was rolled back', brokeSlice?.tokens === 50);

// --- redeem ------------------------------------------------------------------
const red = await post(`/api/umi/baskets/${BID}/redeem`, { holder: HOLDER, units: 4 });
t('redemption accepted', red.s === 200);
t('units burned', red.b?.unitsHeld === 6);
t('still fully backed after partial redemption', red.b?.basket?.fullyBacked === true);

const afterRedeem = await j(`/api/umi/ownership/${A}`);
const back = (afterRedeem.b?.holders || []).find(h => h.holder === HOLDER);
t('backing tokens came back on redemption', back?.tokens === 988);

const over = await post(`/api/umi/baskets/${BID}/redeem`, { holder: HOLDER, units: 999 });
t('cannot redeem more units than held', over.s === 409);
const stranger = await post(`/api/umi/baskets/${BID}/redeem`, { holder: 'nobody-at-all', units: 1 });
t('a non-holder cannot redeem', stranger.s === 409);

// --- recipe is immutable once units exist ------------------------------------
const remake = await post('/api/umi/baskets', {
  basketId: BID, name: 'changed recipe',
  components: [{ assetId: A, tokensPerUnit: 99 }, { assetId: B, tokensPerUnit: 99 }]
});
t('the recipe cannot change under issued units', remake.s === 409);

// --- listing + 404s -----------------------------------------------------------
const list = await j('/api/umi/baskets');
t('baskets can be listed', list.s === 200 && Array.isArray(list.b?.baskets));
t('our basket is in the list', (list.b?.baskets || []).some(x => x.basketId === BID));
const missing = await j('/api/umi/baskets/NO-SUCH-BASKET');
t('an unknown basket is a 404', missing.s === 404);

// --- the chain still verifies -------------------------------------------------
const recon = await j('/api/umi/reconciliation');
t('money still conserved after basket activity', recon.b?.conserved === true);
t('chain still valid after basket activity', recon.b?.chain?.valid === true);

console.log(`\n${p}/${p + f} passed`);
process.exit(f ? 1 : 0);
