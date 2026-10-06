// The ledger explorer asks for a fixed window of blocks. A rail that answers a
// cursor-less request with the OLDEST blocks meant that once the chain grew
// past that window the page rendered genesis-era history forever, and a
// just-settled purchase could never appear. It looked plausible, which is why
// it went unnoticed. This reproduces the explorer's fetch logic exactly.
const BASE = process.env.BASE || 'http://localhost:8080';
const WINDOW = 60;

let p = 0, f = 0;
const t = (n, c) => { if (c) { p++; console.log('  ok   ' + n); } else { f++; console.log('  FAIL ' + n); } };
const get = async (q) => (await fetch(`${BASE}/api/drunix/chain?${q}`)).json();

// --- exactly what LedgerExplorer.load() does --------------------------------
const loadChain = async () => {
  let d = await get(`limit=${WINDOW}`);
  const total = Number(d.totalBlocks || 0);
  const got = Number(d.returned || (d.blocks || []).length);
  if (total > got) {
    const tail = await get(`limit=${WINDOW}&from=${Math.max(0, total - WINDOW)}`);
    if (tail && !tail.error && (tail.blocks || []).length) d = tail;
  }
  return d;
};

const d = await loadChain();
t('chain reachable', !d.error && Array.isArray(d.blocks));

const heights = (d.blocks || []).map(b => b.height).sort((a, b) => a - b);
const total = Number(d.totalBlocks || 0);
t('window reaches the tip of the chain', heights[heights.length - 1] === total - 1);
t('window is not stuck at genesis', total <= WINDOW || heights[0] !== 0);
t('chain verifies', (d.verification || {}).valid === true);

// Whatever the newest block is, the view must be able to show it.
const newest = (d.blocks || []).find(b => b.height === total - 1);
t('newest block is present in the window', Boolean(newest));
if (newest) console.log(`       newest block #${newest.height} is ${newest.type}`);

// A settled purchase must be visible once one exists on the chain.
const settled = (d.blocks || []).filter(b => b.type === 'UMI_DVP_SETTLED');
console.log(`       ${settled.length} settled DvP block(s) in the window`);

console.log(`\n${p}/${p + f} passed`);
process.exit(f ? 1 : 0);
