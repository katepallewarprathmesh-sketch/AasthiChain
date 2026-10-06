// Secondary marketplace, exercised the way the browser reaches it: through
// the Node proxy. The Go tests already cover the book's internals and the
// concurrency; these check the HTTP contract and that the money rules still
// hold when a request arrives over the wire.
const BASE = process.env.BASE || 'http://localhost:8080';
const J = { 'Content-Type': 'application/json' };

let p = 0, f = 0;
const t = (n, c) => { if (c) { p++; console.log('  ok   ' + n); } else { f++; console.log('  FAIL ' + n); } };

const post = (path, body) => fetch(BASE + path, { method: 'POST', headers: J, body: JSON.stringify(body) });
const get = (path) => fetch(BASE + path);

// Unique participants per run so repeat runs cannot collide.
const tag = Date.now().toString(36);
const SELLER = 'mseller-' + tag;
const BUYER = 'mbuyer-' + tag;
const BROKE = 'mbroke-' + tag;
const ASSET = 'PROP-MKT-' + tag;

await post('/api/umi/seed', { assetId: ASSET, holder: SELLER, tokens: 1000, authorisedTokens: 1000 });
await post(`/api/umi/wallets/${BUYER}/fund`, { amountINR: 500000 });
await post(`/api/umi/wallets/${BROKE}/fund`, { amountINR: 50 });

// --- listing ---
const made = await post('/api/umi/offers', {
  assetId: ASSET, seller: SELLER, tokens: 200, pricePerTokenINR: 500,
});
t('listing tokens returns 201', made.status === 201);
const offer = (await made.json()).offer;
t('a new offer starts fully available',
  offer.tokensRemaining === 200 && offer.status === 'OPEN');

const oversold = await post('/api/umi/offers', {
  assetId: ASSET, seller: SELLER, tokens: 900, pricePerTokenINR: 500,
});
t('the same tokens cannot be promised twice', oversold.status === 409);
t('and the refusal says why in plain words',
  /already offered/i.test((await oversold.json()).message || ''));

t('a zero-token offer is refused',
  (await post('/api/umi/offers', { assetId: ASSET, seller: SELLER, tokens: 0, pricePerTokenINR: 500 })).status === 400);
t('a free offer is refused',
  (await post('/api/umi/offers', { assetId: ASSET, seller: SELLER, tokens: 5, pricePerTokenINR: 0 })).status === 400);

// --- browsing ---
const book = await (await get(`/api/umi/offers?assetId=${ASSET}`)).json();
t('the book lists the offer', (book.offers || []).some(o => o.offerId === offer.offerId));
const depth = await (await get(`/api/umi/market/${ASSET}`)).json();
t('market depth counts what is for sale',
  depth.tokensForSale === 200 && depth.bestPriceINR === 500);

// --- taking ---
t('you cannot buy your own offer',
  (await post(`/api/umi/offers/${offer.offerId}/take`, { buyer: SELLER, tokens: 1 })).status === 400);
t('you cannot take more than is left',
  (await post(`/api/umi/offers/${offer.offerId}/take`, { buyer: BUYER, tokens: 9999 })).status === 400);

const dry = await (await post(`/api/umi/offers/${offer.offerId}/take`,
  { buyer: BUYER, tokens: 50, dryRun: true })).json();
t('a dry run reports what would happen', dry.instruction.cashINR === 25000);
t('a dry run consumes nothing', dry.offer.tokensRemaining === 200 && dry.offer.fills.length === 0);

const bought = await (await post(`/api/umi/offers/${offer.offerId}/take`,
  { buyer: BUYER, tokens: 50 })).json();
t('a purchase settles atomically', bought.instruction.status === 'SETTLED');
t('the offer records the partial fill',
  bought.offer.tokensRemaining === 150 && bought.offer.fills.length === 1);
t('the trade is committed to the ledger', bought.instruction.blockHeight > 0);

// --- a buyer who cannot pay must not consume the offer ---
const short = await post(`/api/umi/offers/${offer.offerId}/take`, { buyer: BROKE, tokens: 100 });
t('an underfunded purchase is refused', short.status === 409);
const stillThere = await (await get(`/api/umi/offers/${offer.offerId}`)).json();
t('and the offer is left exactly as it was',
  stillThere.offer.tokensRemaining === 150 && stillThere.offer.status === 'OPEN');

// --- ownership actually moved, and only by what was bought ---
const own = await (await get(`/api/umi/ownership/${ASSET}`)).json();
const held = Object.fromEntries((own.holders || []).map(h => [h.holder, h.tokens]));
t('the buyer holds exactly what they bought', held[BUYER] === 50);
t('the seller is down by exactly that much', held[SELLER] === 950);

// --- withdrawing ---
t('a stranger cannot withdraw the offer',
  (await post(`/api/umi/offers/${offer.offerId}/cancel`, { seller: BUYER })).status === 403);
t('the seller can withdraw it',
  (await post(`/api/umi/offers/${offer.offerId}/cancel`, { seller: SELLER })).status === 200);
t('a withdrawn offer cannot be bought',
  (await post(`/api/umi/offers/${offer.offerId}/take`, { buyer: BUYER, tokens: 1 })).status === 409);

console.log(`\n  secondary market: ${p} passed, ${f} failed`);
process.exit(f === 0 ? 0 : 1);
