// What a visitor who is not signed in costs the rail.
//
// WHY THIS SUITE EXISTS
// Production was reporting a double-digit error rate, and the errors were
// its own front page. A visitor who had not signed in loaded /umi, each
// panel fired a read at the rail, and the rail refused every one of them
// with ERR_UMI_NO_IDENTITY, correctly: those routes read a named
// participant's wallet, orders, conditions and instructions, and the caller
// had no name.
//
// Nothing was broken. The requests should never have been sent. The fix is
// a list of the routes that need an identity, checked in the browser before
// the request leaves, and this suite is what keeps that list honest. It
// holds the list against the running rail in both directions:
//
//   every prefix on the list really does refuse an anonymous caller, and
//   no route the frontend calls off the list refuses one.
//
// Either kind of drift is a defect. A route wrongly on the list silently
// stops working for signed-out visitors who should have seen it; a route
// wrongly off it brings back the failing requests this was written to stop.
//
//   RAIL=http://localhost:21100 node tests/railanon.test.mjs

import { readFileSync, readdirSync } from 'node:fs';
import { needsIdentity, isSignedIn, __test__ } from '../frontend/src/lib/railScopes.js';

const RAIL = process.env.RAIL || process.env.UMI_GATEWAY_URL || 'http://localhost:21100';

let passed = 0, failed = 0;
const ok = (name, cond, detail) => {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failed++; console.log('  FAIL ' + name + (detail ? '\n       ' + detail : '')); }
};

console.log('\nThe rail seen by a visitor who is not signed in\n');

// --- the classifier itself -----------------------------------------------
ok('a participant route is recognised', needsIdentity('/wallets'));
ok('its item form is too', needsIdentity('/work/W-123'));
ok('a query string does not hide it', needsIdentity('/conditions?limit=5'));
ok('a trailing slash does not hide it', needsIdentity('/wallets/'));
ok('a public rules route is not swept up', !needsIdentity('/crossborder/rules'));
ok('nor the token routes, which describe the asset', !needsIdentity('/token') && !needsIdentity('/token/compare'));
ok('nor an unrelated route', !needsIdentity('/chainstate') && !needsIdentity('/jurisdictions'));
ok('a route that merely starts with the same letters is not matched',
   !needsIdentity('/workspaces'), 'prefix matching must respect path segments');

// isSignedIn runs in a browser; here there is no localStorage at all, which
// is the same answer it must give for a visitor who has never signed in.
ok('with no session storage at all, nobody is signed in', isSignedIn() === false);

// --- the chokepoint ------------------------------------------------------
const fetcher = readFileSync(new URL('../frontend/src/lib/umiFetch.js', import.meta.url), 'utf8');
ok('umiFetch refuses before the network, not after',
   /if \(needsIdentity\(path\) && !isSignedIn\(\)\)/.test(fetcher));
ok('the short circuit returns the same shape a real refusal has',
   /ok: false,\s*status: 401/.test(fetcher),
   'callers must not need to know whether a request was sent');
ok('the refusal is explained in words, not just a code',
   /ERR_UMI_SIGNIN_REQUIRED: 'Sign in to see this/.test(fetcher));

// --- against the running rail -------------------------------------------
// The frontend calls /api/umi + path; the app server strips /api and passes
// the rest to the rail, which mounts everything under /umi.
const reach = async (path) => {
  const res = await fetch(RAIL + '/umi' + path, { headers: { Accept: 'application/json' } });
  return res.status;
};

let live = true;
try {
  const probe = await fetch(RAIL + '/health');
  live = probe.ok;
} catch { live = false; }

if (!live) {
  console.log('\n  the rail is not running, so the live half is skipped');
  console.log(`  start it, or set RAIL, to check the list against ${RAIL}\n`);
} else {
  // Every prefix on the list must really refuse an anonymous caller.
  for (const prefix of __test__.IDENTIFIED_PREFIXES) {
    const status = await reach(prefix);
    ok(`the rail refuses ${prefix} to an unnamed caller`, status === 401 || status === 403,
       `got ${status}; if this route is public it does not belong on the list`);
  }

  // And every public exception must really be public.
  for (const path of __test__.PUBLIC_EXCEPTIONS) {
    const status = await reach(path);
    ok(`the rail still answers ${path} to anyone`, status < 400 || status === 400,
       `got ${status}; a 401 here means the exception is wrong`);
  }

  // The other direction: routes the frontend calls that are NOT on the list
  // must not refuse an anonymous caller, or the panels start failing again.
  const called = new Set();
  const walk = (dir) => {
    const entries = readdirSync(new URL('../frontend/src/' + dir, import.meta.url), { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) walk(dir + entry.name + '/');
      else if (/\.(jsx|js)$/.test(entry.name)) {
        const text = readFileSync(new URL('../frontend/src/' + dir + entry.name, import.meta.url), 'utf8');
        for (const m of text.matchAll(/umiFetch\(\s*'(\/[^'?${]*)/g)) {
          // A literal ending in / is the head of a template: umiFetch(
          // '/jurisdictions/' + code). The prefix on its own is not a route.
          if (!m[1].endsWith('/')) called.add(m[1]);
        }
      }
    }
  };
  walk('');

  for (const path of [...called].sort()) {
    if (needsIdentity(path)) continue;
    const status = await reach(path);
    ok(`${path} is callable by a visitor, as the frontend assumes`,
       status !== 401 && status !== 403 && status !== 404,
       `got ${status}; either add it to IDENTIFIED_PREFIXES, or stop calling it signed out`);
  }
}



console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
