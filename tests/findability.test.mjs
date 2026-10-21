// Can a person find everything, without the navbar turning into a list?
//
// Two failures this pins. The first: a page shipped as a route and nothing
// linked to it, so it existed only for whoever knew the URL. The digital
// rupee layer sat like that for a day. The second is the opposite mistake,
// answering the first by putting every page in the navbar until the five
// screens people use daily were buried among fifteen.
//
// So: every public route must be reachable from the directory at /explore,
// the directory must only point at routes that exist, and the navbar must
// stay short. The digital rupee page must also still be able to act, not
// only read, because a screen that can show a refund but not open one is
// half a feature.
//
//   node tests/findability.test.mjs          (BASE=http://localhost:8080)

import { readFileSync } from 'node:fs';

const BASE = process.env.BASE || 'http://localhost:8080';
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let passed = 0, failed = 0;
const ok = (name, cond, detail) => {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failed++; console.log('  FAIL ' + name + (detail ? '\n       ' + detail : '')); }
};

// Routes a visitor is meant to reach by browsing. Dynamic and sign-in-only
// entry points are excluded: /login is the sign-in page itself, /property/:id
// is reached from a listing, and the legal pages sit in the footer.
const NOT_IN_DIRECTORY = new Set(['/', '/login', '/property/:id', '/explore', '/privacy', '/terms']);

async function main() {
  console.log('\nFindability\n');

  const app = read('frontend/src/App.jsx');
  const explore = read('frontend/src/pages/Explore.jsx');
  const rupee = read('frontend/src/pages/DigitalRupee.jsx');
  const seo = read('frontend/src/lib/seo.js');

  // 1. Every route the app serves is either in the directory or deliberately out.
  const routes = [...app.matchAll(/<Route path="([^"]+)"/g)].map((m) => m[1]);
  ok('the app has routes to check', routes.length > 25, String(routes.length));
  const missing = routes.filter((r) => !NOT_IN_DIRECTORY.has(r) && !explore.includes(`'${r}'`));
  ok('every browsable route is listed in the directory', missing.length === 0, missing.join(', '));

  // 2. The directory points at nothing that does not exist.
  const listed = [...explore.matchAll(/path: '([^']+)'/g)].map((m) => m[1]);
  const dangling = listed.filter((p) => !routes.includes(p));
  ok('the directory links only to real routes', dangling.length === 0, dangling.join(', '));
  ok('the directory describes each page, not just names it',
    listed.length > 20 && [...explore.matchAll(/what: '([^']{20,})'/g)].length >= listed.length,
    `${listed.length} listed`);

  // 3. The navbar stays short for every role.
  const navAll = app.slice(app.indexOf('const navItems = user'), app.indexOf('const moreGroups'));
  const navBlock = navAll.slice(0, navAll.indexOf(": [{ path: '/', label: 'Home'"));
  const navPaths = [...navBlock.matchAll(/path: '([^']+)'/g)].map((m) => m[1]);
  ok('the signed-in navbar carries at most six links', navPaths.length <= 6, navPaths.join(', '));
  ok('the rest sits behind one menu', /MoreMenu/.test(app) && /Everything on AasthiChain/.test(app));
  ok('the menu can be closed with the keyboard', /key === 'Escape'/.test(app));

  // The menu opened invisibly once: an absolutely positioned panel inside
  // .site-nav-links, which is a horizontal scroll container, was clipped by
  // it. Both halves of that fix are pinned here.
  const linksRow = app.slice(app.indexOf('className="site-nav-links"'), app.indexOf('<MoreMenu'));
  ok('the menu trigger sits outside the scrolling row of links',
    !linksRow.includes('<MoreMenu') && app.indexOf('<MoreMenu') > app.indexOf('className="site-nav-links"'));
  ok('the panel is positioned against the viewport, so nothing can clip it',
    /position: 'fixed', top: rect\.top/.test(app));
  ok('the trigger is measured before it opens', /getBoundingClientRect/.test(app));

  // 4. The directory itself is findable, and indexable.
  ok('the directory is in the footer', /\/explore/.test(app.slice(app.indexOf('const cols = ['), app.indexOf('const cols = [') + 900)));
  ok('the directory has its own title and description', /'\/explore':/.test(seo));

  // 5. The digital rupee page acts, it does not only read.
  for (const [label, path] of [
    ['issue', '/cbdc/issue'],
    ['redeem', '/cbdc/redeem'],
    ['transfer', '/cbdc/transfer'],
    ['lock money against an event', '/cbdc/conditions'],
    ['attest an event', '/cbdc/events'],
    ['bind money to a purpose', '/cbdc/grants'],
    ['carry value offline', '/cbdc/offline/issue'],
    ['redeem an offline voucher', '/cbdc/offline/redeem'],
    ['send across a corridor', '/corridors/send'],
    ['check a corridor first', '/corridors/check'],
  ]) {
    ok(`the page can ${label}`, rupee.includes(`'${path}'`) || rupee.includes(path));
  }
  ok('a hash-locked transfer can be claimed from the page', /\/claim`/.test(rupee));
  ok('a foreign leg can be confirmed from the page', /\/confirm`/.test(rupee));
  ok('actions go through the shared rail helper, never a bare fetch',
    /umiPost/.test(rupee) && !/\bfetch\s*\(/.test(rupee.replace(/umiFetch\s*\(/g, '')));
  ok('a refusal is printed as the rail worded it', /explainRail/.test(rupee));
  ok('actions are offered to a signed-in participant only', /if \(!user\)/.test(rupee));

  // 6. The rail still answers the reads the page depends on.
  const status = await (await fetch(BASE + '/api/umi/cbdc')).json();
  ok('the rail reports conservation', status.conservation && typeof status.conservation.conserved === 'boolean',
    JSON.stringify(status).slice(0, 140));
  ok('the rail still says the money is simulated', /no central bank money is issued/i.test(String(status.disclaimer)));

  // 7. And the page is prerendered, so a crawler sees it too.
  const page = await fetch(BASE + '/explore');
  ok('the directory is served', page.ok, String(page.status));

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
