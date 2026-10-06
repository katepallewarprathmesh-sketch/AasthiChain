// Properties were showing above 100% allocated. The cause was not the maths on
// the dashboard — it was the transfer self-heal paths, which credited a missing
// balance with tokens nobody had debited, so the holdings of an asset could sum
// to more than its issued supply.
//
// These load supplyHeadroom out of both runtimes (the local server and the
// Vercel handler) and assert the cap, plus assert that neither heal path has
// quietly gone back to handing out the full supply.
import { readFileSync } from 'node:fs';

let p = 0, f = 0;
const t = (n, c) => { if (c) { p++; console.log('  ok   ' + n); } else { f++; console.log('  FAIL ' + n); } };

function loadHeadroom(file) {
  const src = readFileSync(new URL('../' + file, import.meta.url), 'utf8');
  const start = src.indexOf('function supplyHeadroom');
  if (start === -1) throw new Error('supplyHeadroom missing from ' + file);
  const end = src.indexOf('\n}', start) + 2;
  return new Function(src.slice(start, end) + '; return supplyHeadroom;')();
}

for (const file of ['mock-api-server.js', 'frontend/api/index.js']) {
  const headroom = loadHeadroom(file);
  const label = file.split('/').pop();

  // 10000 issued, investors already hold 3000 between them.
  const held = {
    'A~investor1': { assetId: 'A', ownerId: 'investor1', balance: 2000 },
    'A~investor2': { assetId: 'A', ownerId: 'investor2', balance: 1000 },
  };

  t(`${label}: heal is capped at the unsold remainder`,
    headroom(held, 'A', 'originator1', 10000) === 7000);

  t(`${label}: the owner's own stale balance is not counted against them`,
    headroom({ ...held, 'A~originator1': { assetId: 'A', ownerId: 'originator1', balance: 7000 } },
      'A', 'originator1', 10000) === 7000);

  t(`${label}: a fully sold asset heals to zero, never to the full supply`,
    headroom({ 'A~investor1': { assetId: 'A', ownerId: 'investor1', balance: 10000 } },
      'A', 'originator1', 10000) === 0);

  t(`${label}: oversold state clamps at zero rather than going negative`,
    headroom({ 'A~investor1': { assetId: 'A', ownerId: 'investor1', balance: 12000 } },
      'A', 'originator1', 10000) === 0);

  t(`${label}: other assets do not consume this asset's supply`,
    headroom({ 'B~investor1': { assetId: 'B', ownerId: 'investor1', balance: 9000 } },
      'A', 'originator1', 10000) === 10000);

  t(`${label}: missing or junk balances are ignored`,
    headroom({ x: null, y: { assetId: 'A', ownerId: 'investor1', balance: undefined } },
      'A', 'originator1', 10000) === 10000);

  // The whole point is that no heal path hands out prop.totalTokens directly.
  const src = readFileSync(new URL('../' + file, import.meta.url), 'utf8');
  const healBlock = src.slice(src.indexOf('demo auto-fix'), src.indexOf('demo auto-fix') + 500);
  t(`${label}: the demo auto-fix heal goes through supplyHeadroom`,
    healBlock.includes('supplyHeadroom'));
}

console.log(`\n  supply conservation: ${p} passed, ${f} failed`);
process.exit(f === 0 ? 0 : 1);
