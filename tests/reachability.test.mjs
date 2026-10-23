// Every rail feature must be reachable by a person.
//
// WHY THIS SUITE EXISTS
// The team's standard is that a feature is not shipped until it is end to
// end. The failure mode this catches is specific and it had already happened
// four times: rail code written, chain blocks emitted, an integration suite
// passing, and no screen anywhere, so the only way to use the feature was
// curl. A test suite that drives the API directly will never notice, because
// it is itself the curl.
//
// So this walks the other way round. It enumerates the modules the rail
// mounts, and for each one demands that some page or component in the
// frontend actually calls it, that the route is registered, and that a
// visitor could find it from the navigation or the explore index.
//
// An audit by grep is also how I previously got this wrong in the other
// direction, reporting eight unreachable features when four of them were
// reached through a differently-named helper. The check below therefore
// searches for the rail path itself rather than for a particular call style.
//
//   node tests/reachability.test.mjs

import { readFileSync, readdirSync } from 'node:fs';

let passed = 0, failed = 0;
const ok = (name, cond, detail) => {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failed++; console.log('  FAIL ' + name + (detail ? '\n       ' + detail : '')); }
};

const src = (rel) => readFileSync(new URL('../' + rel, import.meta.url), 'utf8');

// Every .jsx under src, concatenated: the question is whether ANY screen
// reaches the module, not which one.
const allFrontend = (() => {
  const out = [];
  const walk = (dir) => {
    for (const e of readdirSync(new URL('../frontend/src/' + dir, import.meta.url), { withFileTypes: true })) {
      if (e.isDirectory()) walk(dir + e.name + '/');
      else if (e.name.endsWith('.jsx') || e.name.endsWith('.js')) out.push(src('frontend/src/' + dir + e.name));
    }
  };
  walk('');
  return out.join('\n');
})();

// The rail modules a person is expected to be able to use. Deliberately
// excluded: nothing. If a module should not have a screen, it should not be
// mounted either, and the exclusion belongs in this comment with a reason.
const MODULES = [
  ['keys', 'key register'],
  ['oracle', 'signed feeds'],
  ['backing', 'backing attestations'],
  ['agents', 'agent passports'],
  ['mandates', 'delegated authority'],
  ['proposals', 'proposing agent'],
  ['credentials', 'verifiable credentials'],
  ['attestations', 'attestations'],
  ['crossborder', 'cross-border funding'],
  ['cbdc', 'digital rupee'],
  ['corridors', 'corridors'],
  ['aml', 'AML screening'],
  ['interop', 'cross-ledger transfer'],
  ['work', 'work desk'],
  ['private', 'private data collections'],
  ['throughput', 'throughput and latency'],
  ['carbon', 'carbon credits'],
  ['jurisdictions', 'per-jurisdiction rule sets'],
  ['cards', 'card economics and disputes'],
  ['chainstate', 'chain-first state projections'],
];

const run = async () => {
  console.log('Reachability');

  // 1. Something in the frontend calls each rail module.
  for (const [mod, label] of MODULES) {
    const re = new RegExp("['\"`]/" + mod + "[/?'\"`]");
    ok(`${label} (/umi/${mod}) is called by a screen`, re.test(allFrontend));
  }

  // 2. The two screens added for this standard are routed and findable.
  const app = src('frontend/src/App.jsx');
  const explore = src('frontend/src/pages/Explore.jsx');
  const seo = src('frontend/src/lib/seo.js');
  const smoke = src('frontend/smoke/smoke-render.jsx');

  for (const [route, page] of [['/keys', 'KeyRegister.jsx'], ['/feeds', 'Feeds.jsx'], ['/cards', 'Cards.jsx'], ['/chainstate', 'ChainState.jsx'], ['/token', 'PublicToken.jsx']]) {
    ok(`${route} has a route`, app.includes(`path="${route}"`), app.includes(route) ? 'mentioned but not routed' : 'absent');
    ok(`${route} is reachable from the navigation`, app.includes(`path: '${route}'`));
    ok(`${route} is listed in the explore index`, explore.includes(`'${route}'`));
    ok(`${route} has page metadata`, seo.includes(`'${route}'`));
    ok(`${route} is covered by the render smoke`, smoke.includes(`['${route}'`));
    ok(`${page} exists`, (() => { try { src('frontend/src/pages/' + page); return true; } catch { return false; } })());
  }

  // 3. The key register screen must never post a private key. The whole
  //    point of the challenge flow is that possession is proved without
  //    sending the secret, and a refactor that "simplified" this would be a
  //    serious regression rather than a style change.
  const keys = src('frontend/src/pages/KeyRegister.jsx');
  ok('the key screen posts a public key and a signature, never a private key',
    keys.includes('publicKey') && keys.includes('challengeSignature') &&
    !/privateKey\s*[,:)]/.test(keys.replace(/pair\.privateKey/g, '')),
    'a private key must never be sent to the server');
  ok('the key screen proves possession against a server-issued challenge',
    keys.includes("/keys/challenge"));
  ok('the key screen demonstrates a refusal, not only the happy path',
    /weak/i.test(keys) && keys.includes('seed[31] = 4'));

  // 4. The feeds screen must show the refusal states, not flatten them into
  //    "unavailable". Each state means something different.
  const feeds = src('frontend/src/pages/Feeds.jsx');
  for (const state of ['USABLE', 'STALE', 'NO_QUORUM', 'NO_DATA', 'RETIRED', 'UNATTRIBUTABLE']) {
    ok('the feeds screen explains ' + state, feeds.includes(state));
  }
  ok('the feeds screen shows whether issuance is still allowed', feeds.includes('mayIssue'));

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
};

run().catch((e) => { console.error(e); process.exit(1); });
