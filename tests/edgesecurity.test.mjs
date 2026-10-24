// The edge: who we believe a caller is, and what every response declares.
//
// WHY THIS SUITE EXISTS
// Two findings, one of which was being exploited the moment anyone noticed it.
//
//   1. The assistant's rate limit keyed anonymous callers on X-Forwarded-For,
//      a header the caller sends. A different value per request meant a new
//      bucket per request, so the limit could be stepped around entirely and
//      every question past it is a paid model call. The test below performs
//      the evasion and requires it to fail.
//
//   2. No security headers were sent by anything: not the handler, not the
//      static deployment. No HSTS, no nosniff, no framing rule on an
//      application whose buttons move money.
//
// The headers are defined once in frontend/api/lib/edge.mjs and repeated in
// frontend/vercel.json, because static assets are served by the CDN and never
// reach the handler. Two copies can disagree, so the agreement is asserted
// here rather than trusted.
//
//   node tests/edgesecurity.test.mjs

import { readFileSync } from 'node:fs';
import { applySecurityHeaders, clientIp, rateLimitKey, trustedProxy, SECURITY_HEADERS }
  from '../frontend/api/lib/edge.mjs';
import { rateLimit, LIMITS } from '../frontend/api/lib/ai.mjs';

let passed = 0, failed = 0;
const ok = (name, cond, detail) => {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failed++; console.log('  FAIL ' + name + (detail ? '\n       ' + detail : '')); }
};

const reqWith = (headers, remoteAddress = '203.0.113.9') => ({
  headers, socket: { remoteAddress },
});

console.log('\nEdge security\n');

// --- the address, when nothing is in front --------------------------------
const saved = process.env.TRUSTED_PROXY;
const savedVercel = process.env.VERCEL;
process.env.VERCEL = '';

process.env.TRUSTED_PROXY = 'none';
ok('with no trusted proxy, the address is the socket', clientIp(reqWith({})) === '203.0.113.9');
ok('a forwarded header from the caller is ignored',
   clientIp(reqWith({ 'x-forwarded-for': '1.2.3.4' })) === '203.0.113.9',
   'X-Forwarded-For is appended to, so anything in it may be the caller\'s invention');
ok('a Cloudflare header is ignored when Cloudflare is not in front',
   clientIp(reqWith({ 'cf-connecting-ip': '1.2.3.4' })) === '203.0.113.9',
   'otherwise anyone can claim to be arriving through Cloudflare');
ok('an IPv4-mapped IPv6 socket address is the same visitor as its IPv4 form',
   clientIp(reqWith({}, '::ffff:203.0.113.9')) === '203.0.113.9');

// --- the address, behind a declared proxy ---------------------------------
process.env.TRUSTED_PROXY = 'cloudflare';
ok('behind Cloudflare, its own header is believed',
   clientIp(reqWith({ 'cf-connecting-ip': '198.51.100.7', 'x-forwarded-for': '1.2.3.4' })) === '198.51.100.7');
ok('even then X-Forwarded-For is not the fallback',
   clientIp(reqWith({ 'x-forwarded-for': '1.2.3.4' })) === '203.0.113.9',
   'a fallback the caller can trigger is the original hole with extra steps');

process.env.TRUSTED_PROXY = 'vercel';
ok('on Vercel, the header its edge overwrites is believed',
   clientIp(reqWith({ 'x-vercel-forwarded-for': '198.51.100.8' })) === '198.51.100.8');
ok('a list in a trusted header resolves to the left-most entry',
   clientIp(reqWith({ 'x-vercel-forwarded-for': '198.51.100.8, 10.0.0.1' })) === '198.51.100.8');

process.env.TRUSTED_PROXY = 'nonsense-value';
ok('an unrecognised TRUSTED_PROXY trusts nothing rather than guessing',
   trustedProxy() === 'none' && clientIp(reqWith({ 'cf-connecting-ip': '1.2.3.4' })) === '203.0.113.9');

// --- the evasion, performed ----------------------------------------------
process.env.TRUSTED_PROXY = 'none';

// One caller, one socket, a fresh forged header on every request. Before the
// fix each of these produced a distinct bucket and none were ever limited.
let blocked = 0;
const attempts = LIMITS.requestsPerWindow + 6;
for (let i = 0; i < attempts; i++) {
  const req = reqWith({ 'x-forwarded-for': `1.2.3.${i}`, 'x-real-ip': `9.9.9.${i}` });
  if (rateLimit(rateLimitKey(req, null))) blocked++;
}
ok('rotating X-Forwarded-For does not buy a fresh rate-limit budget',
   blocked === attempts - LIMITS.requestsPerWindow,
   `${attempts} attempts, limit ${LIMITS.requestsPerWindow}, ${blocked} refused`);

// And the control: a genuinely different caller is still a different bucket.
ok('a different socket is still a different caller',
   rateLimit(rateLimitKey(reqWith({}, '198.51.100.44'), null)) === null);

// A signed-in caller is keyed on identity, so two people behind one office
// address do not share a budget.
ok('a signed-in caller is keyed on identity, not address',
   rateLimitKey(reqWith({}), 'investor1') === 'id:investor1');
ok('the anonymous placeholder identity does not become a shared identity key',
   rateLimitKey(reqWith({}), 'ANONYMOUS_USER').startsWith('ip:'));
ok('an address that cannot be established shares one strict bucket',
   rateLimitKey({ headers: {} }, null) === 'ip:unknown',
   'an unidentifiable flood is throttled as one caller, never waved through as thousands');

process.env.TRUSTED_PROXY = saved === undefined ? '' : saved;
process.env.VERCEL = savedVercel === undefined ? '' : savedVercel;

// --- the headers themselves ----------------------------------------------
const sent = {};
applySecurityHeaders({
  setHeader: (k, v) => { sent[k] = v; },
  removeHeader: (k) => { delete sent[k]; },
  headersSent: false,
});

const required = {
  'Strict-Transport-Security': /max-age=(\d+)/,
  'X-Content-Type-Options': /^nosniff$/,
  'X-Frame-Options': /^DENY$/,
  'Referrer-Policy': /strict-origin/,
  'Permissions-Policy': /camera=\(\)/,
  'Cross-Origin-Opener-Policy': /same-origin/,
};
for (const [name, shape] of Object.entries(required)) {
  ok(`every response sends ${name}`, shape.test(sent[name] || ''), `got ${sent[name]}`);
}
ok('HSTS is long enough to be worth sending',
   parseInt((sent['Strict-Transport-Security'].match(/max-age=(\d+)/) || [])[1], 10) >= 31536000);
ok('HSTS covers subdomains', /includeSubDomains/.test(sent['Strict-Transport-Security']));
ok('the server banner is not advertised', !('X-Powered-By' in sent));

const csp = sent['Content-Security-Policy-Report-Only'] || '';
ok('a content policy is at least being reported', csp.length > 0);
ok('the reported policy forbids framing and object embedding',
   csp.includes("frame-ancestors 'none'") && csp.includes("object-src 'none'"));
ok('the policy is report-only, which is honest about not having been measured',
   !('Content-Security-Policy' in sent),
   'enforcing an unmeasured policy breaks the site for real visitors');

// Applying to a response that has already started must not throw.
let threw = false;
try { applySecurityHeaders({ setHeader: () => { throw new Error('too late'); }, headersSent: false }); }
catch { threw = true; }
ok('a response already in flight is not a crash', !threw);
ok('a stream that reports headersSent is left alone',
   applySecurityHeaders({ setHeader: () => { throw new Error('nope'); }, headersSent: true }) !== undefined);

// --- the two copies agree -------------------------------------------------
const vercel = JSON.parse(readFileSync(new URL('../frontend/vercel.json', import.meta.url), 'utf8'));
const allRoutes = (vercel.headers || []).find((h) => h.source === '/(.*)');
ok('the static deployment sends headers on every path', Boolean(allRoutes),
   'assets are served by the CDN and never reach the handler');
if (allRoutes) {
  const edgeMap = Object.fromEntries(allRoutes.headers.map((h) => [h.key, h.value]));
  const mismatches = Object.entries(SECURITY_HEADERS)
    .filter(([k, v]) => v !== '' && edgeMap[k] !== v)
    .map(([k]) => k);
  ok('the CDN headers are identical to the handler headers', mismatches.length === 0,
     mismatches.join(', ') + ' differ; regenerate vercel.json from edge.mjs');
}

// --- the handler actually uses it -----------------------------------------
const handler = readFileSync(new URL('../frontend/api/index.js', import.meta.url), 'utf8');
ok('the handler applies the headers to every response',
   /applySecurityHeaders\(res\)/.test(handler));
ok('no route still keys a limit on a caller-supplied address',
   !/ip:\$\{String\(req\.headers\['x-forwarded-for'\]/.test(handler));
ok('the login record stores an address the caller cannot dictate',
   /ip: clientIp\(req\)/.test(handler));

const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
ok('the app server sends them too, for static files and the SPA shell',
   /applySecurityHeaders\(res\)/.test(server));
ok('it imports that definition rather than repeating it',
   /edge\.mjs/.test(server));

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
