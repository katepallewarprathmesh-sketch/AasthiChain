// Notifications. The thing worth testing is not that a feed exists, but that
// it only ever reports what the ledger already recorded: no notification for
// a dry run, none for a failed trade's seller, and no way to fabricate one.
const BASE = process.env.BASE || 'http://localhost:8080';
const J = { 'Content-Type': 'application/json' };

let p = 0, f = 0;
const t = (n, c) => { if (c) { p++; console.log('  ok   ' + n); } else { f++; console.log('  FAIL ' + n); } };

// The rail checks who is asking before it moves anyone's money. These
// fixtures act as the settlement supervisor.
const RAIL_AS = { ...J, 'X-Fabric-Identity': 'regulator1', 'X-Identity-Role': 'Regulator' };
const post = (path, body) => fetch(BASE + path, { method: 'POST', headers: RAIL_AS, body: JSON.stringify(body) });
const get = (path) => fetch(BASE + path);
const feed = async (who) => (await (await get(`/api/umi/notifications/${who}`)).json());

const tag = Date.now().toString(36);
const SELLER = 'nts-' + tag;
const BUYER = 'ntb-' + tag;
const POOR = 'ntp-' + tag;
const ASSET = 'PROP-NTF-' + tag;

await post('/api/umi/seed', { assetId: ASSET, holder: SELLER, tokens: 1000, authorisedTokens: 1000 });
await post(`/api/umi/wallets/${BUYER}/fund`, { amountINR: 200000 });
await post(`/api/umi/wallets/${POOR}/fund`, { amountINR: 100 });

// --- a fresh participant starts clean ---
const fresh = await feed('nobody-' + tag);
t('an unknown participant has an empty feed', fresh.count === 0 && fresh.unread === 0);

// --- a dry run is a question, not an event ---
await post('/api/umi/dvp', {
  assetId: ASSET, seller: SELLER, buyer: BUYER, tokens: 10, pricePerTokenINR: 500, dryRun: true,
});
t('a dry run notifies nobody', (await feed(BUYER)).count === 0);

// --- a settled trade notifies both sides ---
await post('/api/umi/dvp', {
  assetId: ASSET, seller: SELLER, buyer: BUYER, tokens: 100, pricePerTokenINR: 500,
});
const bf = await feed(BUYER);
const sf = await feed(SELLER);
t('the buyer is told they bought', bf.notifications.some(n => n.kind === 'BOUGHT'));
t('the seller is told they sold', sf.notifications.some(n => n.kind === 'SOLD'));
t('the notification cites the block that proves it',
  bf.notifications[0].blockHeight > 0);
t('it carries the amount that moved', bf.notifications[0].amountINR === 50000);
t('unread counts it', bf.unread >= 1);

// --- a failed trade tells the buyer, and only the buyer ---
const sellerBefore = (await feed(SELLER)).count;
await post('/api/umi/dvp', {
  assetId: ASSET, seller: SELLER, buyer: POOR, tokens: 100, pricePerTokenINR: 500,
});
const pf = await feed(POOR);
t('the buyer is told the purchase failed',
  pf.notifications.some(n => n.kind === 'SETTLEMENT_FAILED'));
t('and is told exactly how short they were',
  /short by ₹/.test(pf.notifications[0].detail));
t('the seller is not bothered by a trade that never happened',
  (await feed(SELLER)).count === sellerBefore);

// --- income reaches holders ---
const PAYER = 'ntl-' + tag;
await post(`/api/umi/wallets/${PAYER}/fund`, { amountINR: 100000 });
await post('/api/umi/servicing', { assetId: ASSET, payer: PAYER, amountINR: 3000 });
t('a holder is told about rent income',
  (await feed(BUYER)).notifications.some(n => n.kind === 'INCOME'));

// --- feeds are per participant ---
t('one participant cannot see another\'s feed',
  (await feed('stranger-' + tag)).count === 0);

// --- read state ---
const before = await feed(BUYER);
const first = before.notifications[0];
const marked = await post(`/api/umi/notifications/${BUYER}/read`, { id: first.id });
t('marking one read succeeds', marked.status === 200);
t('the unread count drops', (await marked.json()).unread === before.unread - 1);
t('an unknown notification id is a 404',
  (await post(`/api/umi/notifications/${BUYER}/read`, { id: 'NTF-NOPE' })).status === 404);

await post(`/api/umi/notifications/${BUYER}/read-all`, {});
const cleared = await feed(BUYER);
t('read-all clears the badge', cleared.unread === 0);
t('but keeps the history', cleared.count === before.count);

// --- the feed cannot be written to from outside ---
const forged = await post(`/api/umi/notifications/${BUYER}`, {
  kind: 'INCOME', title: 'Free money', detail: 'forged',
});
t('there is no way to post a notification', forged.status === 405 || forged.status === 404);

console.log(`\n  notifications: ${p} passed, ${f} failed`);
process.exit(f === 0 ? 0 : 1);
