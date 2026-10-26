// Coverage of the rail, as a number that cannot quietly rot.
//
// "143 checks, 0 failed" says nothing about how much of the rail those checks
// touch. This suite recomputes the action coverage from source and holds the
// published figures to it, the same way the test census is held to the real
// file count: a figure in a document that nobody recomputes is a claim, not a
// measurement.
//
// It also guards the two ways this measurement could become a lie: a route
// table that drifts from what is registered, and coverage quietly falling
// while the suite still passes.
//
//   node tests/coverage.test.mjs

import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0, failed = 0;
const ok = (name, cond, detail) => {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failed++; console.log('  FAIL ' + name + (detail ? '\n       ' + detail : '')); }
};

// The floor exists so coverage cannot drift down unnoticed. Raise it when the
// real number rises; never lower it to make a run pass.
const FLOOR_PERCENT = 55;

console.log('\nRail action coverage\n');

const raw = execFileSync('node', [join(ROOT, 'scripts/coverage-rail.mjs'), '--json'], { encoding: 'utf8' });
const { summary, rows } = JSON.parse(raw);

ok('the coverage tool runs and reports every declared action',
  summary.actions > 50 && rows.length === summary.actions, `${summary.actions} actions`);

ok('every verdict is one of the three',
  rows.every((r) => ['covered', 'possible', 'not covered'].includes(r.verdict)));

ok('the three verdicts account for every action',
  summary.covered + summary.possible + summary.notCovered === summary.actions,
  `${summary.covered} + ${summary.possible} + ${summary.notCovered} != ${summary.actions}`);

// A route table that describes endpoints nobody serves would inflate the
// denominator and flatter the measurement.
ok('no declared route is missing from the registered routes',
  summary.undeclaredOrDriftedRoutes.length === 0, summary.undeclaredOrDriftedRoutes.join('; '));

ok(`coverage has not fallen below the floor of ${FLOOR_PERCENT}%`,
  summary.coveredPercent >= FLOOR_PERCENT, `${summary.coveredPercent}% covered`);

// The published figure must be the measured one. The TESTING note carries it.
// That note is internal and not in the published repository, so this pair of
// checks runs where it exists and is skipped where it does not. The coverage
// floor above is the assertion that must hold everywhere.
const TESTING_PATH = join(ROOT, '.internal-docs/TESTING.md');
const testing = existsSync(TESTING_PATH) ? readFileSync(TESTING_PATH, 'utf8') : null;
if (testing !== null) {
  const stated = testing.match(/\*\*(\d+(?:\.\d+)?)%\*\* of (\d+) rail actions/);
  ok('the TESTING note publishes the coverage figure', !!stated,
    'expected a line of the form "**58.1%** of 86 rail actions"');
  if (stated) {
    ok('the published percentage is the measured one',
      Number(stated[1]) === summary.coveredPercent, `document says ${stated[1]}%, measured ${summary.coveredPercent}%`);
    ok('the published action count is the measured one',
      Number(stated[2]) === summary.actions, `document says ${stated[2]}, measured ${summary.actions}`);
  }
} else {
  console.log('       skipped the published-figure checks: .internal-docs/TESTING.md is not in this checkout');
}

// The honest part: the gaps are named, not just counted.
const gaps = rows.filter((r) => r.verdict === 'not covered');
ok('the not-covered actions are enumerable, so they can be worked through',
  gaps.length === summary.notCovered);
console.log(`       ${summary.coveredPercent}% covered, ${summary.possiblePercent}% possible, ` +
  `${gaps.length} actions not covered by any suite`);

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
