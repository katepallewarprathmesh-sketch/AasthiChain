// The UMI page dry-runs the trade as you type, so a blocked settlement is
// explained before the click instead of coming back as a red error after it.
// That is only safe if a dry run is genuinely free: no state, no instruction,
// no block. This pins that.
const RAIL = process.env.RAIL || 'http://localhost:21100';
let p = 0, f = 0;
const t = (n, c) => { if (c) { p++; console.log('  ok   ' + n); } else { f++; console.log('  FAIL ' + n); } };

const post = async (path, body) => {
  const r = await fetch(RAIL + path, {
    method: 'POST', headers: { 'content-type': 'application/json', 'X-Fabric-Identity': 'regulator1', 'X-Identity-Role': 'Regulator' }, body: JSON.stringify(body),
  });
  return { s: r.status, b: await r.json().catch(() => ({})) };
};
const get = async (path) => (await fetch(RAIL + path)).json();

const count = async () => ((await get('/umi/instructions?limit=500')).instructions || []).length;
const height = async () => Number((await get('/umi/reconciliation')).chain.blocks || 0);

const before = await count();
const blocksBefore = await height();

// a property with no opening position on the rail — the exact case that
// produced "originator1 holds 0 tokens of PROP-..., needs 100"
const miss = await post('/umi/dvp', {
  assetId: 'PROP-NEVER-SEEDED-001', seller: 'originator1', buyer: 'investor1',
  tokens: 100, pricePerTokenINR: 500, dryRun: true,
});
t('dry run refuses an unseeded property', miss.s === 400);
t('it says which leg is short', miss.b.error === 'ERR_UMI_INSUFFICIENT_SECURITIES');
t('the message names the holder and the gap',
  /holds 0 tokens/.test(miss.b.message || '') && /needs 100/.test(miss.b.message || ''));

// a trade that should pass
const ok = await post('/umi/dvp', {
  assetId: 'PROP-GREEN-VALLEY-PUNE-001', seller: 'originator1', buyer: 'investor1',
  tokens: 10, pricePerTokenINR: 100, dryRun: true,
});
t('dry run accepts a settleable trade', ok.s === 200);

// the whole point: neither call left anything behind
t('no instruction was recorded by either dry run', (await count()) === before);
t('no block was committed by either dry run', (await height()) === blocksBefore);

console.log(`\n${p}/${p + f} passed`);
process.exit(f ? 1 : 0);
