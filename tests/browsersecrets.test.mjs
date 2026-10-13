// A server secret does not belong in the browser.
//
// The role switcher used to open a window.prompt asking for the deployment's
// ADMIN_DASHBOARD_KEY, then keep it in session storage and attach it to later
// requests. The key is a long-lived server secret. Typing it into a browser
// prompt puts it in plain sight on whatever screen is being shared, and
// storing it leaves it readable by anything running on the page.
//
// The supported path needs no secret in the browser at all: name the person
// in SUPERVISOR_CLERK_IDS server-side and the role dropdown appears on its
// own. This suite keeps the prompt from coming back.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SRC = new URL('../frontend/src/', import.meta.url).pathname;

let pass = 0, fail = 0;
const t = (name, ok, detail) => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(jsx?|tsx?)$/.test(p)) out.push(p);
  }
  return out;
}
const files = walk(SRC);

// Nothing may prompt for the key.
const prompters = files.filter((f) => {
  const s = readFileSync(f, 'utf8');
  return /window\.prompt\(/.test(s) && /ADMIN_DASHBOARD_KEY|operator key/i.test(s);
});
t('nothing prompts the user for the operator key', prompters.length === 0,
  prompters.map((f) => f.replace(SRC, '')).join(', '));

// The shell must not stash or replay the key.
const app = readFileSync(join(SRC, 'App.jsx'), 'utf8');
t('App.jsx never writes the key to storage',
  !/setItem\(\s*'aasthi_admin_key'/.test(app));
t('App.jsx never sends x-admin-key',
  !/'x-admin-key'\s*:/.test(app));
t('App.jsx clears any key an older build left behind',
  /removeItem\(\s*'aasthi_admin_key'\s*\)/.test(app));

// The role-switch guidance must name the variable that actually works.
// SUPERVISOR_EMAILS is matched against an email claim, and a stock Clerk
// session token carries no email, so advising it sends people to set a
// variable that can never match.
const unlock = app.slice(app.indexOf('handleOperatorUnlock'), app.indexOf('handleOperatorLock'));
t('the role-switch guidance names SUPERVISOR_CLERK_IDS',
  /SUPERVISOR_CLERK_IDS/.test(unlock));
t('the role-switch guidance does not advise SUPERVISOR_EMAILS',
  !/SUPERVISOR_EMAILS/.test(unlock),
  'that variable cannot match a stock Clerk token');

// The operator pages may still take a key the person types into a form field,
// which is a different and acceptable thing. Confirm we did not break them.
const opsPages = files.filter((f) => /AdminOps|Insights/.test(f));
t('the operator pages still have their own key field', opsPages.length >= 2,
  `${opsPages.length} found`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
