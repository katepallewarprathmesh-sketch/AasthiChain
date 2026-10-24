// Two interface rules that only break in a browser, checked in the source.
//
// WHY THIS SUITE EXISTS
// Both defects here were reported by a person using the site, and neither
// could have been caught by any existing suite: the rail answered correctly
// in both cases, and the page rendered. The failure was in what the screen
// let someone do, and in what it did afterwards.
//
//   1. The More menu stayed open after a page was chosen, so every single
//      navigation needed a second click to dismiss it.
//   2. Both write buttons on the public-chain token page were clickable with
//      an empty address and no signer loaded, so the first thing a visitor
//      saw was ERR_TOKEN_FIELDS, for a transaction that could never have been
//      signed in the first place.
//
// There is no DOM in this repository's test setup, so these are assertions
// about the source. That is weaker than driving a browser and it is stated
// plainly rather than dressed up: it proves the mechanism is present, not
// that it fires. It is enough to stop a refactor from silently removing it,
// which is the regression worth catching.
//
//   node tests/uiclosure.test.mjs

import { readFileSync } from 'node:fs';

let passed = 0, failed = 0;
const ok = (name, cond, detail) => {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failed++; console.log('  FAIL ' + name + (detail ? '\n       ' + detail : '')); }
};
const src = (rel) => readFileSync(new URL('../' + rel, import.meta.url), 'utf8');

console.log('\nInterface closure rules\n');

// --- 1. the More menu dismisses itself -----------------------------------
const app = src('frontend/src/App.jsx');
const menu = app.slice(app.indexOf('function MoreMenu'), app.indexOf('function Nav('));
ok('the More menu exists where this suite thinks it does', menu.length > 500);

ok('choosing a destination closes the menu',
   /useEffect\(\(\) => \{ setOpen\(false\) \}, \[pathname\]\)/.test(menu),
   'a route change must close the panel, not only a click on the item');
ok('the menu reads the current route to know when that happened',
   /const \{ pathname \} = useLocation\(\)/.test(menu));

// The click handler is still required: a link to the page you are already on
// does not change the route, so nothing else would dismiss the panel.
const items = [...menu.matchAll(/role="menuitem"/g)].length;
const closers = [...menu.matchAll(/onClick=\{close\}/g)].length;
ok('every menu item also closes on click, for links to the current page',
   items > 0 && closers >= items, `${items} items, ${closers} close handlers`);
ok('the backdrop still closes the menu when you click away',
   /onClick=\{close\}[\s\S]{0,200}position: 'fixed', inset: 0/.test(menu)
   || /position: 'fixed', inset: 0[\s\S]{0,200}onClick=\{close\}/.test(menu));
ok('Escape still closes it',
   /e\.key === 'Escape'/.test(menu));

// --- 2. the token page refuses before the click, not after ----------------
const token = src('frontend/src/pages/PublicToken.jsx');

ok('an Ethereum address is checked for shape before anything is signed',
   /\/\^0x\[0-9a-fA-F\]\{40\}\$\//.test(token),
   '0x and 40 hex characters, which is the same thing the rail checks');
ok('registering is disabled until there is a holder and an address',
   /const canLink = signable && hasHolder && addressShaped/.test(token));
ok('mirroring is disabled until there is a holder and an asset',
   /const canMirror = signable && hasHolder && assetId\.trim\(\)\.length > 0/.test(token));
ok('both buttons honour those gates',
   /disabled=\{busy \|\| !canLink\}/.test(token) && /disabled=\{busy \|\| !canMirror\}/.test(token));

ok('nothing is signable without a configured and funded signer',
   /const signable = Boolean\(st && st\.configured && st\.fundedForWrites\)/.test(token),
   'no key loaded means no write to offer, rather than a write that fails');
ok('the page says which setting is missing rather than only that one is',
   /st\.missing/.test(token));
ok('the reason a button is disabled is shown, never left to be guessed',
   /\{blocked\}/.test(token) && /const blocked = \(\(\) =>/.test(token));

// The client-side gate is a courtesy. The rail must still refuse, or a
// crafted request would get through, so the refusal path has to stay.
ok('the rail-side refusal is still rendered, because the gate is not the guard',
   token.includes('UMI_TOKEN_REFUSED') && /outcome\.ok \? 'Sent' : 'Refused'/.test(token));

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
