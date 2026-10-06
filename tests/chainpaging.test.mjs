// The explorer must be able to reach EVERY block, not just the newest window.
//
// It loaded one 60-block window and stopped, so on a 165-block chain the page
// showed the newest 60 and silently hid the other 105 — and a /ledger?tx=...
// deep link to anything older than the window highlighted nothing. This pins
// the paging contract the page now relies on.
const BASE = process.env.BASE || 'http://localhost:8080';
let p = 0, f = 0;
const t = (n, c) => { if (c) { p++; console.log('  ok   ' + n); } else { f++; console.log('  FAIL ' + n); } };
const g = async (u) => (await fetch(BASE + u)).json();

const head = await g('/api/drunix/chain?limit=1');
const total = Number(head.totalBlocks || 0);
t('chain reports a total', total > 0);
t('a cursor-less request lands on the tip', Number(head.from || 0) === Math.max(0, total - 1));

// walk the whole chain the way the page does: tip first, then backwards
const seen = new Map();
let oldest = total;
let guard = 0;
while (oldest > 0 && guard++ < 200) {
  const span = Math.min(60, oldest);
  const from = oldest - span;
  const d = await g(`/api/drunix/chain?limit=${span}&from=${from}`);
  const bs = d.blocks || [];
  if (!bs.length) break;
  for (const b of bs) seen.set(b.height, b);
  oldest = from;
}
t('paging backwards reaches block 0', oldest === 0);
t('every block is retrievable exactly once', seen.size === total);

const heights = [...seen.keys()].sort((a, b) => a - b);
t('heights are a complete run with no gaps',
  heights[0] === 0 && heights[heights.length - 1] === total - 1 &&
  heights.every((h, i) => h === i));

// a deep link must be satisfiable from the full walk
// A freshly-started rail has no settlements yet, so this part is only
// meaningful where the chain has history (e.g. BASE=<live>).
const settled = [...seen.values()].filter(b => b.type === 'UMI_DVP_SETTLED');
if (!settled.length) {
  console.log('  skip there are no settled blocks on this chain yet');
} else {
  const iid = (settled[0].txns || []).map(x => x.instructionId).find(Boolean);
  t('a settled block carries an instructionId', !!iid);
  t('that instructionId is findable across the full chain',
    !!iid && [...seen.values()].some(b => (b.txns || []).some(x => Object.values(x).includes(iid))));
}

console.log(`\n${p}/${p + f} passed`);
process.exit(f ? 1 : 0);
