// An internal rail read must say who is asking.
//
// The rail used to believe any caller, so the operator panels could fetch
// /umi/instructions bare and get an answer. The moment UMI_PROXY_SECRET was
// set on both hosts the rail started treating unstamped callers as anonymous,
// those reads came back 401, and the calling code did `if (r.ok)` and left its
// array empty. The ops panel then rendered "instructions 0, settled 0,
// failed 0" against a rail holding fifty settled instructions.
//
// That is the dangerous shape: not an error, a confident zero. A dead rail and
// a refused read look identical downstream.
//
// So this suite reads the source. Every fetch the app makes to the rail on its
// own behalf has to carry headers, which in practice means railReadHeaders()
// or an explicit identity plus railProxyAuth(). A bare rail read cannot be
// written again without failing here.

import { readFileSync } from 'node:fs';

const FILE = new URL('../frontend/api/index.js', import.meta.url).pathname;
const src = readFileSync(FILE, 'utf8');

let pass = 0, fail = 0;
const t = (name, ok, detail) => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};

// The helper must exist and must include both the identity and the secret.
const helper = src.match(/function railReadHeaders\(\)\s*\{([\s\S]*?)\n\}/);
t('railReadHeaders() exists', Boolean(helper));
if (helper) {
  t('railReadHeaders() names the caller', /X-Fabric-Identity/.test(helper[1]));
  t('railReadHeaders() carries the proxy stamp', /railProxyAuth\(\)/.test(helper[1]));
}

// Find every fetch aimed at the rail and check it passes headers.
//
// The rail base is held in `base` or `railBase` depending on the call site, so
// match either, then take the whole call up to the closing paren of its
// options object.
// Find every fetch aimed at the rail and check it passes headers.
//
// The rail base is held in `base` or `railBase` depending on the call site.
// Scan forward from each match to the end of that call's options object.
const offenders = [];
const fetchRe = /fetch\(\s*(?:railBase|base)\s*\+/g;
let m;
while ((m = fetchRe.exec(src)) !== null) {
  // Walk to the matching close paren so the whole call is examined.
  let i = m.index + 'fetch('.length, depth = 1;
  while (i < src.length && depth > 0) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')') depth--;
    i++;
  }
  const call = src.slice(m.index, i);
  if (/headers\s*:/.test(call)) continue;
  const line = src.slice(0, m.index).split('\n').length;
  offenders.push(`line ${line}: ${call.replace(/\s+/g, ' ').slice(0, 90)}`);
}

t('every rail fetch sends headers', offenders.length === 0,
  offenders.length ? `${offenders.length} bare call(s): ${offenders.join(' | ')}` : '');

// The two reads that actually went blind, named so a regression is obvious.
// Each is matched at its fetch, not at any mention of the route, because one
// of them is reached through a helper that does the stamping.
for (const route of ['/umi/instructions', '/umi/reconciliation']) {
  const at = src.indexOf(`+ '${route}'`);
  const stamped = at !== -1 && /headers\s*:/.test(src.slice(at, at + 200));
  t(`the ${route} read is stamped`, stamped,
    at === -1 ? 'no direct fetch for this route (reached via helper)' : 'no headers within the call');
}

// The helper path must be stamped too, otherwise the reconciliation read
// above is only safe by accident.
const getHelper = src.match(/const r = await fetch\(base \+ p,[^;]*;/g) || [];
t('the shared rail GET helper is stamped',
  getHelper.length > 0 && getHelper.every((c) => /headers\s*:/.test(c)),
  `${getHelper.length} helper call(s)`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
