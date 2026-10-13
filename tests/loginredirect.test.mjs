// A component may not use a variable that belongs to a different component.
//
// ClerkLogin ended its sign-in handler with navigate(next). `next` is declared
// in DemoPresets, a sibling component in the same file, so inside ClerkLogin
// it was simply undefined. Every signed-in visitor hit a ReferenceError on
// that line, the surrounding try/catch logged it to the console, and the page
// sat on "Already signed in redirecting to marketplace..." with a spinner,
// forever. Sign-in was effectively broken for everyone with a session.
//
// Nothing caught it: the build does not resolve identifiers inside a function
// body, ESLint is not usable in this project, and no suite drives the browser.
// So this one reads the source, splits a file into its top-level components,
// and checks that every identifier a component uses from a known set is one
// that component actually declares.
//
// It also asserts the failure is visible. A swallowed error that leaves a
// spinner running is worse than a crash, because it looks like progress.

import { readFileSync } from 'node:fs';

const FILE = new URL('../frontend/src/pages/Login.jsx', import.meta.url).pathname;
const src = readFileSync(FILE, 'utf8');

let pass = 0, fail = 0;
const t = (name, ok, detail) => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};

// Split the file into top-level `function Name(...) {` blocks.
function components(text) {
  const out = [];
  const re = /^(?:export default )?function (\w+)\s*\(/gm;
  let m;
  const starts = [];
  while ((m = re.exec(text)) !== null) starts.push({ name: m[1], at: m.index });
  for (let i = 0; i < starts.length; i++) {
    const end = i + 1 < starts.length ? starts[i + 1].at : text.length;
    out.push({ name: starts[i].name, body: text.slice(starts[i].at, end) });
  }
  return out;
}

const comps = components(src);
t('the file splits into components', comps.length >= 4, `found ${comps.length}`);

// Locals that are easy to use from the wrong scope because several components
// declare their own copy. Module-level helpers are deliberately excluded.
const SCOPED = ['next', 'location', 'navigate', 'loadingId'];

const offenders = [];
for (const c of comps) {
  for (const name of SCOPED) {
    const used = new RegExp(`[^\\w.'"\`]${name}\\b`).test(c.body.replace(/^.*?\{/s, ''));
    if (!used) continue;
    const declared = new RegExp(`(?:const|let|var)\\s+${name}\\b`).test(c.body)
      // const [name, setName] = useState(...)
      || new RegExp(`(?:const|let|var)\\s*\\[[^\\]]*\\b${name}\\b[^\\]]*\\]`).test(c.body)
      // destructured prop or hook result
      || new RegExp(`\\(\\s*\\{[^}]*\\b${name}\\b[^}]*\\}`).test(c.body)
      || new RegExp(`(?:const|let|var)\\s*\\{[^}]*\\b${name}\\b[^}]*\\}`).test(c.body);
    if (!declared) offenders.push(`${c.name} uses "${name}" without declaring it`);
  }
}
t('no component uses another component\'s variable', offenders.length === 0, offenders.join(' | '));

// The specific regression.
const clerk = comps.find((c) => c.name === 'ClerkLogin');
t('ClerkLogin exists', Boolean(clerk));
if (clerk) {
  t('ClerkLogin declares next before navigating to it',
    /const next = safeNext\(/.test(clerk.body),
    'navigate(next) with no local next is the original bug');
  t('ClerkLogin surfaces a failed sign-in instead of spinning',
    /setFailed\(/.test(clerk.body) && /failed \?/.test(clerk.body),
    'a swallowed error must not leave the spinner running');
}

// The stray URL that was pasted into the back link label.
t('the back-home link is a label, not a pasted URL',
  !/Back to home https?:\/\//.test(src),
  'the link text contains a full URL');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
