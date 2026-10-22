// Does the suite actually catch anything?
//
// From the Scapia Argus write-up: for weeks their nightly run flagged no
// regression, and they could not tell whether the app was stable or their
// assertions were weak. So they deleted a real feature on a branch and ran
// the suite. Nine of fifty flows failed on the missing element and the other
// forty-one passed, which told them something a green run never can.
//
// "That's one planted bug, not a proof" is the honest way to put it, and it
// applies here too. This harness plants a small number of defects that a
// careless change could plausibly introduce, runs the one suite that should
// notice each, and reports whether it did. A defect nobody catches is a hole
// in the suite, stated as such rather than discovered later.
//
// It edits a file, runs a suite, and restores the file. The original is held
// in memory and written back in a finally block, and the run refuses to start
// if the working tree has uncommitted changes to the files it touches, so a
// crash cannot leave a planted defect in the repository.
//
//   node scripts/plant-defect.mjs              plant all, one at a time
//   node scripts/plant-defect.mjs aml-threshold   just one

import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync, execSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Each defect is a realistic mistake, not a syntax error: a threshold nudged,
// a guard dropped, a refusal softened. The point is to plant something that
// still compiles and still looks reasonable in review.
const DEFECTS = [
  {
    id: 'aml-threshold',
    file: 'drunix-gateway/aml.go',
    what: 'screening stops blocking: the block threshold is raised above any achievable score',
    find: 'amlBlockScore  = 0.93',
    replace: 'amlBlockScore  = 1.93',
    suite: 'tests/aml.test.mjs',
    shouldCatch: 'a listed name is blocked',
  },
  {
    id: 'kyc-aadhaar',
    file: 'drunix-gateway/kyc.go',
    what: 'the Aadhaar refusal is removed, so a twelve digit number is accepted and stored',
    find: 'if twelveDigits.MatchString(strings.ReplaceAll(v, " ", "")) {',
    replace: 'if false && twelveDigits.MatchString(strings.ReplaceAll(v, " ", "")) {',
    suite: 'tests/kyc.test.mjs',
    shouldCatch: 'an Aadhaar number is refused outright',
  },
  {
    id: 'kyc-vcip-liveness',
    file: 'drunix-gateway/kyc.go',
    what: 'a video session without a liveness check is treated as face-to-face anyway',
    find: 'if !req.LivenessPassed {',
    replace: 'if false {',
    suite: 'tests/kyc.test.mjs',
    shouldCatch: 'a video session missing liveness is refused',
  },
  {
    id: 'agent-staleness',
    file: 'drunix-gateway/agent.go',
    what: 'the proposing agent stops re-reading its evidence, so an approval acts on state that moved',
    find: 'if why, fresh := a.evidenceStillHolds(copyP, time.Now()); !fresh {',
    replace: 'if why, fresh := a.evidenceStillHolds(copyP, time.Now()); false && !fresh {',
    suite: 'tests/proposals.test.mjs',
    shouldCatch: 'approval either performs the action or refuses as stale',
  },
  {
    id: 'corridor-travel-rule',
    file: 'drunix-gateway/corridors.go',
    what: 'the Travel Rule check passes even when the parties are not named',
    find: 'if chk.TravelRule && (strings.TrimSpace(req.Originator) == "" || strings.TrimSpace(req.Beneficiary) == "") {',
    replace: 'if false && chk.TravelRule && (strings.TrimSpace(req.Originator) == "" || strings.TrimSpace(req.Beneficiary) == "") {',
    suite: 'tests/corridors.test.mjs',
    shouldCatch: 'a payment above the Travel Rule threshold needs both parties named',
  },
];

const sh = (cmd, opts = {}) => execSync(cmd, { cwd: ROOT, encoding: 'utf8', stdio: 'pipe', ...opts });

function cleanTree(files) {
  const dirty = sh('git status --porcelain').split('\n').map((l) => l.slice(3).trim()).filter(Boolean);
  return files.filter((f) => dirty.includes(f));
}

function rebuildAndRestart() {
  // The rail under test is the built binary, so a planted defect only exists
  // once the gateway is rebuilt and restarted.
  sh('bash scripts/dev-stack.sh --stop || true', { stdio: 'ignore' });
  sh('bash scripts/dev-stack.sh --no-evm', { stdio: 'ignore', env: { ...process.env } });
}

function runSuite(suite) {
  try {
    const out = execFileSync('node', [suite], { cwd: ROOT, encoding: 'utf8' });
    return { failed: 0, out };
  } catch (e) {
    const out = String(e.stdout || '') + String(e.stderr || '');
    const m = out.match(/(\d+)\s+passed,\s+(\d+)\s+failed/);
    return { failed: m ? Number(m[2]) : -1, out };
  }
}

async function main() {
  const only = process.argv[2];
  const planned = only ? DEFECTS.filter((d) => d.id === only) : DEFECTS;
  if (!planned.length) {
    console.error(`No defect named ${only}. Known: ${DEFECTS.map((d) => d.id).join(', ')}`);
    process.exit(2);
  }

  const dirty = cleanTree([...new Set(planned.map((d) => d.file))]);
  if (dirty.length) {
    console.error(`Refusing to run: uncommitted changes in ${dirty.join(', ')}. Commit or stash first.`);
    process.exit(2);
  }

  console.log('\nPlanted defects: does the suite notice?\n');
  const results = [];

  for (const d of planned) {
    const path = join(ROOT, d.file);
    const original = readFileSync(path, 'utf8');
    if (!original.includes(d.find)) {
      console.log(`  SKIP  ${d.id}: the line it plants into has moved, so this defect needs updating`);
      results.push({ ...d, caught: null });
      continue;
    }
    try {
      writeFileSync(path, original.replace(d.find, d.replace), 'utf8');
      rebuildAndRestart();
      const { failed, out } = runSuite(d.suite);
      const named = out.includes(`FAIL ${d.shouldCatch}`);
      const caught = failed > 0;
      console.log(`  ${caught ? 'caught' : 'MISSED'}  ${d.id.padEnd(22)} ${failed} check(s) failed` +
        `${named ? ', including the one that should' : caught ? ', but not the one expected' : ''}`);
      console.log(`          ${d.what}`);
      results.push({ ...d, caught, failed, named });
    } finally {
      writeFileSync(path, original, 'utf8');
    }
  }

  // Leave the tree as it was found: rebuilt, restarted, clean.
  rebuildAndRestart();

  const missed = results.filter((r) => r.caught === false);
  console.log(`\n  ${results.filter((r) => r.caught).length}/${results.filter((r) => r.caught !== null).length} planted defects were caught`);
  if (missed.length) {
    console.log('  holes in the suite:');
    for (const m of missed) console.log(`    ${m.id}: ${m.what}`);
  }
  console.log('\n  These are planted defects, not a proof. They say the suite notices these five\n' +
    '  specific mistakes, and nothing about the ones nobody thought of.\n');
  process.exit(missed.length ? 1 : 0);
}

main();
