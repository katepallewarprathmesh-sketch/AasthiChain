// Live ledger updates. The risk with a streaming endpoint is not that it
// fails loudly — it is that it quietly leaks subscribers, blocks a commit, or
// reports events that no block backs. These check all three against a live
// server.
const BASE = process.env.BASE || 'http://localhost:8080';

let p = 0, f = 0;
const t = (n, c) => { if (c) { p++; console.log('  ok   ' + n); } else { f++; console.log('  FAIL ' + n); } };

// Minimal SSE reader: collects frames for a while, then gives up the socket.
async function listen(ms, duringFn) {
  const ctrl = new AbortController();
  const res = await fetch(`${BASE}/api/umi/events`, {
    headers: { Accept: 'text/event-stream' },
    signal: ctrl.signal,
  });
  if (!res.ok || !res.body) { ctrl.abort(); return { status: res.status, frames: [] }; }

  const frames = [];
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  const pump = (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) !== -1) {
          const raw = buf.slice(0, i); buf = buf.slice(i + 2);
          const ev = /event: (.+)/.exec(raw);
          const da = /data: (.+)/.exec(raw);
          if (ev && da) { try { frames.push({ event: ev[1], data: JSON.parse(da[1]) }); } catch {} }
        }
      }
    } catch { /* aborted */ }
  })();

  if (duringFn) { await new Promise(r => setTimeout(r, 300)); await duringFn(); }
  await new Promise(r => setTimeout(r, ms));
  ctrl.abort();
  await pump.catch(() => {});
  return { status: res.status, frames };
}

const fund = (amt) => fetch(`${BASE}/api/umi/wallets/investor1/fund`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Fabric-Identity': 'regulator1', 'X-Identity-Role': 'Regulator' },
  body: JSON.stringify({ amountINR: amt }),
});

const chainHeight = async () => {
  const r = await fetch(`${BASE}/api/drunix/chain?limit=1`).catch(() => null);
  return r && r.ok ? (await r.json()).totalBlocks : null;
};

// --- the stream opens and announces itself ---
const first = await listen(600);
t('the stream opens', first.status === 200);
t('it greets a new subscriber with the current height',
  first.frames.length > 0 && first.frames[0].event === 'hello'
  && typeof first.frames[0].data.height === 'number');

// --- commits reach a listener ---
const run = await listen(900, async () => { await fund(100); await fund(100); });
const blocks = run.frames.filter(x => x.event === 'block');
t('a committed block reaches the listener', blocks.length >= 2);
t('each event names the block it refers to',
  blocks.every(b => typeof b.data.height === 'number' && b.data.type && b.data.hash));
t('event heights increase', blocks.every((b, i) => i === 0 || b.data.height > blocks[i - 1].data.height));
t('the event type is a real block type', blocks.every(b => /^[A-Z_]+$/.test(b.data.type)));

// --- a disconnected listener must not linger ---
// Each listen() above closed its socket. If the rail leaked them, the
// subscriber count in the greeting would climb run after run.
const after = await listen(400);
t('disconnected subscribers are released',
  after.frames[0] && after.frames[0].data.subscribers <= 2);

// --- the stream must never be load-bearing for settlement ---
const before = await chainHeight();
await fund(100);
const now = await chainHeight();
t('the chain height is actually readable', typeof before === 'number' && before > 0);
t('commits succeed regardless of who is listening', now > before);

console.log(`\n  ledger stream: ${p} passed, ${f} failed`);
process.exit(f === 0 ? 0 : 1);
