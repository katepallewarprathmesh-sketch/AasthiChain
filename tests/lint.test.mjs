// The lint gate itself is tested, because a gate nobody runs is decoration.
//
// Two things are asserted. First, that a configuration exists at all: ESLint
// 10 refuses to run without one, and for a long time this repository had
// none, so `npm run build` was standing in for a lint gate it cannot
// perform. Second, that the frontend and the serverless handlers pass it
// with zero errors. Warnings are allowed through on purpose; errors are not.
//
// This suite is deliberately slow (ESLint walks the whole tree). It earns it:
// the first run of this config found an undefined `recordBuy`, an undefined
// `collectData`, a `properties` read out of a sibling component's scope, an
// unimported `githubDB` and three conditionally called React hooks. Every one
// of those compiled and shipped.

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const frontend = join(root, 'frontend');

let passed = 0;
let failed = 0;
const ok = (name, cond, detail) => {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failed++; console.log('  FAIL ' + name); if (detail) console.log('       ' + String(detail).slice(0, 600)); }
};

console.log('\nLint gate\n');

ok('a flat ESLint config exists', existsSync(join(frontend, 'eslint.config.js')));

const installed = existsSync(join(frontend, 'node_modules', 'eslint'));
if (!installed) {
  // A contributor who has not installed the frontend dependencies should be
  // told that, not handed a stack trace that looks like a lint failure.
  console.log('  skip ESLint is not installed in frontend/node_modules (run: cd frontend && npm install)');
  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

let out = '';
let clean = true;
try {
  out = execFileSync('npx', ['eslint', '.', '--format', 'json'], {
    cwd: frontend, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
  });
} catch (e) {
  // ESLint exits non-zero when it reports errors; the JSON is still on stdout.
  out = String(e.stdout || '');
  clean = false;
}

let report = [];
try { report = JSON.parse(out); } catch { report = []; }
ok('ESLint ran and produced a report', Array.isArray(report) && report.length > 0,
  clean ? '' : out.slice(0, 300));

const errors = [];
for (const file of report) {
  for (const m of file.messages || []) {
    if (m.severity === 2) errors.push(`${file.filePath.split('frontend/').pop()}:${m.line} ${m.ruleId} ${m.message}`);
  }
}
ok('the frontend and the API handlers lint with zero errors', errors.length === 0,
  errors.slice(0, 10).join('\n       '));

const linted = report.length;
ok('the config covers the whole source tree, not one directory', linted > 50, `${linted} files linted`);

console.log(`\n  ${passed} passed, ${failed} failed  (${linted} files linted)\n`);
process.exit(failed === 0 ? 0 : 1);
