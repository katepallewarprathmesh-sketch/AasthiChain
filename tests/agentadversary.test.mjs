// The adversarial harness, run against the live rail.
//
// WHY THIS SUITE EXISTS SEPARATELY FROM agentlive
// agentlive checks that a well-behaved agent is permitted to do the things it
// should be permitted to do. This one checks the opposite and more important
// half: that an agent which skips its own checks, reuses other people's
// authority, replays what worked and keeps going after being stopped gets
// nowhere. A control that has only ever been tested by a caller who was
// trying to respect it has not been tested.
//
// The harness itself is Python, in agent/adversary.py, because it has to be
// an outsider holding nothing but an identity header and a socket. This file
// is the adapter that puts it in front of `make test-fresh`, which is the
// only gate anybody runs.
//
//   node tests/agentadversary.test.mjs
//   python3 agent/adversary.py            (the same run, with its own report)

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const HARNESS = path.join(ROOT, 'agent', 'adversary.py');
const RAIL = process.env.RAIL || 'http://localhost:21100';

let passed = 0, failed = 0;
const ok = (name, cond, detail) => {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failed++; console.log('  FAIL ' + name + (detail ? '\n       ' + detail : '')); }
};
const done = () => {
  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
};

ok('the adversarial harness is present', existsSync(HARNESS), HARNESS);
if (!existsSync(HARNESS)) done();

const interpreter = ['python3', 'python'].find((bin) =>
  spawnSync(bin, ['--version'], { encoding: 'utf8' }).status === 0);
ok('a Python interpreter is available', !!interpreter, 'neither python3 nor python is on PATH');
if (!interpreter) done();

const run = spawnSync(interpreter, [HARNESS], {
  cwd: ROOT, encoding: 'utf8', env: { ...process.env, RAIL },
});
const output = `${run.stdout || ''}${run.stderr || ''}`;
const tally = output.match(/(\d+) bounds held, (\d+) breached/);

ok('the harness ran against the rail', !!tally,
   output.trim().split('\n').slice(-10).join('\n') || 'no output');
if (!tally) done();

const [, heldStr, breachedStr] = tally;
const held = Number(heldStr);

// A harness that stops attacking passes silently forever, which is the
// failure mode of every security suite that has ever rotted. Pin the floor:
// if somebody deletes attacks, this notices before the next reader assumes
// the bounds are still being tested.
ok(`the harness still attacks (${held} bounds exercised)`, held >= 18,
   `only ${held} attacks ran; attacks were removed or are failing to reach the rail`);

ok('every bound held', Number(breachedStr) === 0,
   output.split('\n').filter((l) => /BREACHED/.test(l)).join('\n'));

// The honest limitation has to stay visible. If the FORGERY note ever
// disappears, somebody has either fixed the underlying thing, in which case
// this should be updated deliberately, or quietly dropped an admission.
ok('the harness still declares what it cannot test', /FORGERY:/.test(output),
   'the note about identity forgery and proxy placement is gone');

ok('the harness exits non-zero only when a bound broke',
   run.status === (Number(breachedStr) === 0 ? 0 : 1), `exit ${run.status}`);

done();
