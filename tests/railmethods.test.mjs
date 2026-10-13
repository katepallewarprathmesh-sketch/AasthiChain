// Actions must be sent as actions.
//
// umiFetch decides the HTTP method from whether a body was passed: a body
// means POST, no body means GET. That is right for reads and quietly wrong
// for an action that needs no arguments. "Fund this order" and "accept this
// delivery" carry nothing but the order id in the path, so both went to the
// rail as GETs; the rail answered ERR_METHOD and the two buttons that move
// escrow did nothing. Everything passed — the API suites post directly and
// never exercise the browser's call.
//
// So this suite reads the source. Any call to a route that changes state has
// to say POST, either by going through umiPost or by naming the method. A
// bodyless mutation is the exact shape of the bug and cannot be written again
// without failing here.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const API = process.env.API || 'http://localhost:8080';
const SRC = new URL('../frontend/src/', import.meta.url).pathname;

let pass = 0, fail = 0;
const t = (name, ok, detail) => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};

console.log('Rail call methods');

// ---- the helper itself -----------------------------------------------------
const helper = readFileSync(join(SRC, 'lib/umiFetch.js'), 'utf8');
t('umiPost exists, so a bodyless action has a way to say POST',
  /export const umiPost\s*=/.test(helper));
t('umiPost states the method rather than inferring it',
  /umiPost\s*=\s*\(path,\s*body\)\s*=>\s*umiFetch\(path,\s*\{\s*method:\s*'POST'/.test(helper));

// ---- every call site -------------------------------------------------------
const walk = (dir) => readdirSync(dir).flatMap((e) => {
  const p = join(dir, e);
  return statSync(p).isDirectory() ? walk(p) : (/\.(jsx?|mjs)$/.test(p) ? [p] : []);
});

// Segments that change something on the rail. A call whose path ends in one
// of these is an action, whatever it carries.
const MUTATING = /\/(fund|accept|assign|dispute|refund|cancel|submit|settle|restate|seed)\b/;

const offenders = [];
let scanned = 0;

for (const file of walk(SRC)) {
  const src = readFileSync(file, 'utf8');
  if (!src.includes('umiFetch(')) continue;
  src.split('\n').forEach((line, i) => {
    const m = line.match(/umiFetch\(\s*(`[^`]*`|'[^']*')/);
    if (!m) return;
    scanned++;
    const path = m[1].slice(1, -1);
    if (!MUTATING.test(path)) return;
    // An action is acceptable only if this call names its method.
    if (!/method:\s*'(POST|PUT|PATCH|DELETE)'/.test(line)) {
      offenders.push(`${file.replace(SRC, '')}:${i + 1} → ${path}`);
    }
  });
}

t(`every mutating umiFetch call states its method (${scanned} raw umiFetch call${scanned === 1 ? '' : 's'} scanned)`,
  offenders.length === 0, offenders.join('; '));

// ---- and the rail really does refuse a read on an action -------------------
// Pins the other half: if the rail ever started accepting GET here, the bug
// above would stop being detectable from the outside.
const reachable = await fetch(`${API}/api/health`).then(r => r.ok).catch(() => false);
if (!reachable) {
  console.log('  skip live check — no server on ' + API);
} else {
  const token = Buffer.from(JSON.stringify({
    identityId: 'investor2', role: 'Investor', mspId: 'InvestorMSP',
    exp: Math.floor(Date.now() / 1000) + 3600,
  })).toString('base64');
  const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const props = await fetch(`${API}/api/properties`, { headers: auth })
    .then(r => r.json()).then(d => d.properties || []).catch(() => []);
  const made = props.length ? await fetch(`${API}/api/umi/work`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({
      assetId: props[0].assetId, title: 'Method check', category: 'INSPECTION',
      spec: 'confirm the rail refuses a read here', feeINR: 1000,
      acceptanceCriteria: ['nothing — this order is never funded'],
    }),
  }).then(r => r.json()).catch(() => null) : null;
  const orderId = made && made.order && made.order.orderId;

  if (!orderId) {
    console.log('  skip live check — work desk not mounted on this server');
  } else {
    const res = await fetch(`${API}/api/umi/work/${orderId}/fund`, { method: 'GET', headers: auth });
    const body = await res.json().catch(() => ({}));
    t('the rail refuses a GET on a funding route rather than quietly doing nothing',
      res.status === 405 && body.error === 'ERR_METHOD', `${res.status} ${body.error || ''}`);
    // And the same route, sent properly, moves the money.
    const ok = await fetch(`${API}/api/umi/work/${orderId}/fund`, { method: 'POST', headers: auth });
    const okBody = await ok.json().catch(() => ({}));
    t('the same route sent as POST reserves the fee',
      ok.status === 200 && okBody.order && okBody.order.status === 'FUNDED',
      `${ok.status} ${(okBody.order && okBody.order.status) || okBody.error || ''}`);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
