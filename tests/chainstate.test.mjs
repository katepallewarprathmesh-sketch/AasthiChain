// Chain-first state: is the ledger the state, or a description of it?
//
// The gap this closes is the one the AMA audit called "blockchain as the main
// hero". Listings, documents and work orders lived in Go maps while blocks
// were written *about* them. That is a log. The difference only becomes
// visible when somebody rebuilds the state from the blocks alone and checks
// it against what the system is serving, which is what these checks do.
//
// The important property is that the verification can FAIL. A projection
// that always agrees because it reads the same memory proves nothing, so one
// check below lists an offer and then confirms the replay picked it up from
// the chain rather than from the book.
//
//   node tests/chainstate.test.mjs         (RAIL=http://localhost:21100)

const RAIL = process.env.RAIL || 'http://localhost:21100';
let passed = 0, failed = 0;
const ok = (name, cond, detail) => {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failed++; console.log('  FAIL ' + name + (detail ? '\n       ' + detail : '')); }
};

const call = async (path, init) => {
  const r = await fetch(RAIL + path, init);
  const text = await r.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, body };
};
const post = (path, payload) => call(path, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Identity-Id': 'investor1', 'X-Fabric-Identity': 'investor1' },
  body: JSON.stringify(payload || {}),
});

const run = async () => {
  console.log('Chain-first state');

  // ------------------------------------------------------ the projections
  const all = await call('/umi/chainstate', { method: 'GET' });
  ok('the projections are readable without signing in', all.status === 200, 'status ' + all.status);
  const mods = (all.body.projections || []).map(p => p.module).sort();
  ok('offers, documents and work are all projected',
    JSON.stringify(mods) === JSON.stringify(['documents', 'offers', 'work']), JSON.stringify(mods));
  ok('each projection declares which block types it reads',
    (all.body.projections || []).every(p => (p.blockTypesConsumed || []).length > 0));
  ok('the index admits that unlisted modules are not covered',
    /still hold state/i.test(all.body.disclaimer || ''));

  const docs = await call('/umi/chainstate/documents', { method: 'GET' });
  ok('one projection reads back on its own', docs.status === 200 && docs.body.module === 'documents');
  ok('the register admits the bytes are not on the chain',
    (docs.body.fieldsNotOnChain || []).some(f => /bytes/i.test(f)),
    JSON.stringify(docs.body.fieldsNotOnChain));

  const nowhere = await call('/umi/chainstate/tea-leaves', { method: 'GET' });
  ok('a module nobody projects is a 404, not an empty success', nowhere.status === 404,
    'status ' + nowhere.status);

  // --------------------------------------------------------- the verdict
  const before = await call('/umi/chainstate/verify', { method: 'GET' });
  ok('the comparison runs', before.status === 200);
  ok('the ledger and the running process agree', before.body.agrees === true,
    JSON.stringify((before.body.checks || []).filter(c => !c.agrees)).slice(0, 400));
  ok('every module reports both counts',
    (before.body.checks || []).every(c => typeof c.liveEntities === 'number' && typeof c.chainEntities === 'number'));
  ok('the verification states what it does not prove',
    /still hold state/i.test(before.body.whatThisDoesNotProve || ''));
  ok('the comparison names how many blocks it read', (before.body.blocksInLedger || 0) > 0);

  // ------------------------- a listing must appear in the replay, not just
  // ------------------------- in the book, which is the whole claim
  const offersBefore = (await call('/umi/chainstate/offers', { method: 'GET' })).body.count || 0;

  // Seed a position of our own so repeat runs cannot collide.
  const tag = Date.now().toString(36);
  const asset = 'PROP-CHAINSTATE-' + tag;
  const seller = 'cstate-' + tag;
  const asSeller = { 'Content-Type': 'application/json', 'X-Identity-Id': seller, 'X-Fabric-Identity': seller };
  await call('/umi/seed', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Fabric-Identity': 'regulator1', 'X-Identity-Role': 'Regulator' },
    body: JSON.stringify({ assetId: asset, holder: seller, tokens: 100, authorisedTokens: 100 }),
  });

  const listed = await call('/umi/offers', {
    method: 'POST', headers: asSeller,
    body: JSON.stringify({ assetId: asset, seller, tokens: 10, pricePerTokenINR: 1234 }),
  });
  ok('a holder can list tokens', listed.status === 201 || listed.status === 200,
    'status ' + listed.status + ' ' + JSON.stringify(listed.body).slice(0, 200));

  const offer = (listed.body && (listed.body.offer || listed.body)) || {};
  const offerId = offer.offerId;
  ok('the listing itself is committed as a block', (offer.blockHeight || 0) > 0,
    JSON.stringify(offer).slice(0, 200));

  const after = await call('/umi/chainstate/offers', { method: 'GET' });
  ok('the replay sees the new listing', (after.body.count || 0) === offersBefore + 1,
    'before ' + offersBefore + ', after ' + after.body.count);
  const projected = (after.body.entities || []).find(e => e.id === offerId);
  ok('the rebuilt offer carries the seller and the size from the block alone',
    !!projected && projected.fields.seller === seller && projected.fields.tokensRemaining === 10,
    JSON.stringify(projected));
  ok('the rebuilt offer points at the block that created it',
    !!projected && (projected.blocks || []).length >= 1);

  const stillAgrees = await call('/umi/chainstate/verify', { method: 'GET' });
  ok('the book still matches the ledger after a listing', stillAgrees.body.agrees === true,
    JSON.stringify((stillAgrees.body.checks || []).filter(c => !c.agrees)).slice(0, 300));

  const cancelled = await call('/umi/offers/' + offerId + '/cancel', {
    method: 'POST', headers: asSeller, body: '{}',
  });
  ok('a holder can withdraw a listing', cancelled.status === 200, 'status ' + cancelled.status);
  const afterCancel = await call('/umi/chainstate/offers', { method: 'GET' });
  const gone = (afterCancel.body.entities || []).find(e => e.id === offerId);
  ok('the withdrawal is on the ledger, not only in memory',
    !!gone && gone.status === 'CANCELLED', JSON.stringify(gone));
  ok('the withdrawn offer carries both of its blocks', !!gone && (gone.blocks || []).length === 2);

  // --------------------------------------------------------- the recovery
  const restore = await post('/umi/chainstate/restore', {});
  ok('the book can be rebuilt from the ledger on demand', restore.status === 200);
  ok('a rail that never restarted has nothing to recover', restore.body.restored === 0,
    'restored ' + restore.body.restored);
  ok('the restore reports the comparison it leaves behind',
    restore.body.verify && restore.body.verify.agrees === true);

  // ------------------------------------------------------------ the screen
  const { readFileSync } = await import('node:fs');
  const page = readFileSync(new URL('../frontend/src/pages/ChainState.jsx', import.meta.url), 'utf8');
  ok('a screen runs the comparison', /['"`]\/chainstate\/verify/.test(page));
  ok('the screen shows each projection', page.includes("'/chainstate'"));
  ok('the screen can trigger the rebuild', page.includes('/chainstate/restore'));
  ok('the screen shows divergences rather than hiding them', /divergences/.test(page));
  ok('the screen names the fields the chain cannot rebuild', /fieldsNotOnChain/.test(page));
  ok('the screen states what it does not claim', /What this does not claim/.test(page));

  console.log(`\n  ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
};

run().catch(e => { console.error(e); process.exit(1); });
