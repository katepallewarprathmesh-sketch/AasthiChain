#!/usr/bin/env node
/**
 * Asserts no raw error code can reach a user, and that every failure names a
 * next action that actually resolves it.
 *
 * The bug this guards: the live marketplace rendered
 * `Failed to load: ERR_UNAUTHORIZED`. That is the server's internal code shown
 * verbatim — it tells the user nothing, offers no way out, and the real cause
 * (a session that had silently become invalid) was only fixable by knowing to
 * clear localStorage.
 *
 * Usage: node scripts/error-ux-check.mjs
 */

import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';

const { describeError, tokenLooksUsable, ApiError } =
  await import(pathToFileURL(path.resolve('frontend/src/lib/apiError.js')).href);

let passed = 0;
const failures = [];
const check = (name, cond, detail = '') => {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failures.push(name); console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
};

console.log('\nError-UX check\n');

// ---------------------------------------------------------------- no raw codes
console.log('  -- a server code must never reach the screen --');
const cases = [
  ['401 unauthorized', new ApiError({ status: 401, code: 'ERR_UNAUTHORIZED' }), 'login'],
  ['401 invalid token', new ApiError({ status: 401, code: 'ERR_INVALID_TOKEN', serverMessage: 'Token is missing, malformed, expired or not signed by this server.' }), 'login'],
  ['403 forbidden', new ApiError({ status: 403, code: 'ERR_FORBIDDEN', serverMessage: 'This belongs to investor1. You are signed in as investor2.' }), 'none'],
  ['403 role', new ApiError({ status: 403, code: 'ERR_FORBIDDEN' }), 'none'],
  ['404', new ApiError({ status: 404, code: 'ERR_ASSET_NOT_FOUND' }), 'back'],
  ['409 already settled', new ApiError({ status: 409, code: 'ERR_ALREADY_SETTLED', serverMessage: 'This payment was already settled; the original settlement is attached.' }), 'none'],
  ['400 bad input', new ApiError({ status: 400, code: 'FAILED_INVALID_VPA', serverMessage: 'Invalid payeeVpa s@okicici' }), 'retry'],
  ['429', new ApiError({ status: 429, code: 'ERR_RATE_LIMIT' }), 'retry'],
  ['500', new ApiError({ status: 500, code: 'ERR_INTERNAL' }), 'retry'],
  ['network', Object.assign(new ApiError({ status: 0, code: 'ERR_NETWORK' }), { offline: true }), 'retry'],
];

const CODE_RE = /\bERR_[A-Z_]+\b|\bFAILED_[A-Z_]+\b|\bHTTP \d{3}\b/;

for (const [label, err, expectedAction] of cases) {
  const d = describeError(err, { what: 'the marketplace' });
  check(`${label}: no raw code in the title`, !CODE_RE.test(d.title), d.title);
  check(`${label}: no raw code in the detail`, !CODE_RE.test(d.detail), d.detail);
  check(`${label}: has a human title`, !!d.title && d.title.length > 8, d.title);
  check(`${label}: has guidance`, !!d.detail && d.detail.length > 20);
  check(`${label}: action is '${expectedAction}'`, d.action.kind === expectedAction,
    `got '${d.action.kind}'`);
  if (d.action.kind !== 'none') {
    check(`${label}: action is labelled`, !!d.action.label);
  }
}

// a 401 must always route to sign-in, never to a dead end
for (const [label, err] of cases.filter(c => c[1].status === 401)) {
  const d = describeError(err);
  check(`${label}: offers sign-in`, d.action.kind === 'login');
}

// ---------------------------------------------------------------- stale tokens
console.log('  -- a session this build cannot use is detected up front --');
check('legacy unsigned base64 token is rejected',
  !tokenLooksUsable(Buffer.from(JSON.stringify({ identityId: 'investor1' })).toString('base64')));
check('empty token is rejected', !tokenLooksUsable(''));
check('null token is rejected', !tokenLooksUsable(null));
check('"clerk-user_123" placeholder is rejected', !tokenLooksUsable('clerk-user_123'));
check('signed two-part token is accepted', tokenLooksUsable('abc.def'));
check('three-part Clerk JWT is accepted', tokenLooksUsable('a.b.c'));
check('token with an empty part is rejected', !tokenLooksUsable('abc.'));

// ---------------------------------------------------------------- source scan
console.log('  -- no page renders a raw error value --');
const pagesDir = 'frontend/src/pages';
const offenders = [];
for (const f of fs.readdirSync(pagesDir).filter(f => f.endsWith('.jsx'))) {
  const src = fs.readFileSync(path.join(pagesDir, f), 'utf8');
  // `Failed to load: {error}` and friends: a bare error value in JSX text.
  if (/Failed to load:\s*\{/.test(src)) offenders.push(`${f}: "Failed to load: {...}"`);
  if (/>\s*\{\s*(error|err)\s*\}\s*</.test(src) && !/ErrorNote/.test(src)) {
    offenders.push(`${f}: renders {error} directly`);
  }
}
check('no page renders a bare error value', offenders.length === 0, offenders.join('; '));

console.log(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) { failures.forEach(f => console.error('  FAIL ' + f)); process.exit(1); }
console.log('Error UX OK');
