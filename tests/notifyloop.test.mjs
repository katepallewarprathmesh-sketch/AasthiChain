// A refused feed must be asked for once, not on every block.
//
// Production filled the rail's error log with this, twice a second:
//
//   403 GET /umi/notifications/regulator1
//   identity person_user_3JYf..., role Investor
//   ERR_UMI_NOT_YOURS
//
// The browser had regulator1 stored from a role switch the server never
// agreed to. Every committed block refreshed the bell, the bell asked for a
// stranger's feed, the rail refused, and the catch swallowed it so nothing
// on screen ever said a word.
//
// Two things are checked here, both by reading the source, because the bug
// lives in the shape of the code rather than in a response:
//
//   1. The bell stops after a refusal and does not retry the same identity.
//   2. A role switch is refused when the server said this session cannot
//      switch, which is what created the mismatch in the first place.
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const t = (name, ok, detail) => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` - ${detail}` : ''}`); }
};

const bell = readFileSync('frontend/src/components/NotificationBell.jsx', 'utf8');
const app = readFileSync('frontend/src/App.jsx', 'utf8');

t('the bell remembers which identity was refused',
  /deniedFor/.test(bell), 'no record of a refusal, so every block retries it');

t('a refusal short-circuits the next load',
  /if \(!me \|\| deniedFor\.current === me\) return/.test(bell),
  'the guard must come before the request, not after');

t('the refusal is recognised by status, not by message text',
  /e\.status === 403/.test(bell), 'matching on a message string breaks the first time the wording changes');

t('a different identity gets a fresh attempt',
  /deniedFor\.current !== me/.test(bell) && /\}, \[me\]\)/.test(bell),
  'a permanent block would break the bell for the next person signing in');

t('the catch no longer swallows every outcome silently',
  /catch \(e\)/.test(bell), 'the handler takes no argument, so it cannot tell a refusal from a timeout');

t('a role switch is refused when the server said the session cannot switch',
  /canSwitchIdentity === false/.test(app) && /handleRoleSwitch/.test(app),
  'the switcher writes an identity the server will ignore');

t('a stale demo identity is purged when the server will not honour it',
  /if \(!me\.canSwitchIdentity\)/.test(app) && /removeItem\('aasthi_clerk_demo_identity'\)/.test(app),
  'the previous session\'s choice survives and keeps asking for the wrong records');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
