// The agent harness policy suite, which is written in Python.
//
// WHY A NODE FILE THAT RUNS PYTHON
// The harness is Python because that is what agent harnesses are written in,
// and the policy tests belong next to the code they test. But this repository
// has exactly one test gate, `make test-fresh`, which walks tests/*.test.mjs.
// A suite that only runs when somebody remembers to type a second command is
// a suite that rots, so this is the adapter: one file in the place the runner
// looks, delegating to the real tests.
//
// It deliberately does not reimplement anything. If it starts asserting on
// behaviour itself, the behaviour has two sources of truth and they will
// drift.
//
//   node tests/agentharness.test.mjs
//   python3 -m unittest discover -s agent/tests -v      (the same tests, verbose)

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SUITE = path.join(ROOT, 'agent', 'tests');

let passed = 0, failed = 0;
const ok = (name, cond, detail) => {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failed++; console.log('  FAIL ' + name + (detail ? '\n       ' + detail : '')); }
};

const done = () => {
  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
};

ok('the Python policy suite is where the runner expects it', existsSync(SUITE), SUITE);
if (!existsSync(SUITE)) done();

// Pick an interpreter rather than assuming one. CI runners and dev boxes
// disagree about whether `python` exists at all, and a suite that fails
// because of the name of a binary tells you nothing about the code.
const interpreter = ['python3', 'python'].find((bin) => {
  const probe = spawnSync(bin, ['--version'], { encoding: 'utf8' });
  return probe.status === 0;
});

ok('a Python interpreter is available', !!interpreter,
   'neither python3 nor python is on PATH; the agent harness needs one');
if (!interpreter) done();

// The harness imports nothing outside the standard library, on purpose: a
// harness that needs a package index before it will run is a harness nobody
// runs. If that ever stops being true this check is what notices, because
// the suite below would fail on a bare interpreter.
const run = spawnSync(interpreter, ['-m', 'unittest', 'discover', '-s', SUITE, '-t', SUITE, '-v'], {
  cwd: ROOT, encoding: 'utf8',
});

const output = `${run.stdout || ''}${run.stderr || ''}`;
const ran = output.match(/^Ran (\d+) tests?/m);

ok('the policy suite runs', run.status !== null && !!ran,
   (output.trim().split('\n').slice(-12).join('\n') || 'no output'));

if (ran) {
  // A suite that silently stops collecting tests passes forever. Pin a floor.
  ok(`the policy suite still has its checks (${ran[1]})`, Number(ran[1]) >= 25,
     `only ${ran[1]} tests were collected`);
}

ok('every policy check passes', run.status === 0,
   output.split('\n').filter((l) => /^(FAIL|ERROR):/.test(l)).join('\n')
   || output.trim().split('\n').slice(-12).join('\n'));

done();
