// The sandbox submission is a set of claims about this codebase, so the tests
// are about whether the claims are true, not whether the page renders.
//
// Four things can go wrong with a document like this and every one of them is
// silent:
//   1. The generated document drifts from the page.
//   2. A containment names a file or a test that does not exist, or that was
//      renamed six months ago.
//   3. A failure mode loses its symptom and becomes a reassurance.
//   4. Someone softens an open gap into a contained one, or starts implying an
//      approval we do not have.
//
// Each has an assertion below.

import { strict as assert } from 'node:assert';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const { PROPOSAL, FRICTION, SCOPE, FAILURE_MODES, LEARNING } =
  await import(new URL('../frontend/src/lib/sandboxProposal.js', import.meta.url).href);

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { failed++; console.log(`FAIL  ${name}\n      ${e.message}`); }
}

console.log('sandbox submission');

// 1. No drift between the screen and the document.
test('the generated document is not stale', () => {
  execFileSync('node', [path.join(ROOT, 'scripts/build-sandbox-doc.mjs'), '--check'], { stdio: 'pipe' });
});

test('the document is published and reachable from docs/', () => {
  assert.ok(existsSync(path.join(ROOT, 'docs/SANDBOX_PROPOSAL.md')), 'docs/SANDBOX_PROPOSAL.md missing');
});

// 2. Every claim points at code that exists.
test('every failure mode names a source file that exists', () => {
  for (const f of FAILURE_MODES) {
    assert.ok(f.file, `${f.mode}: no file named`);
    assert.ok(existsSync(path.join(ROOT, f.file)), `${f.mode}: ${f.file} does not exist`);
  }
});

test('every failure mode names a test that exists', () => {
  for (const f of FAILURE_MODES) {
    assert.ok(f.test, `${f.mode}: no test named`);
    assert.ok(existsSync(path.join(ROOT, f.test)), `${f.mode}: ${f.test} does not exist`);
  }
});

// 3. The shape that makes the section credible.
test('every failure mode states a symptom and a containment', () => {
  for (const f of FAILURE_MODES) {
    assert.ok(f.symptom && f.symptom.length > 30, `${f.mode}: symptom missing or too thin`);
    assert.ok(f.containment && f.containment.length > 40, `${f.mode}: containment missing or too thin`);
    assert.equal(typeof f.implemented, 'boolean', `${f.mode}: implemented must be explicit`);
  }
});

test('an unimplemented containment says so in words, not only in a flag', () => {
  for (const f of FAILURE_MODES.filter(x => !x.implemented)) {
    const says = /NOT IMPLEMENTED|not hidden|One gap remains/.test(f.containment);
    assert.ok(says, `${f.mode}: implemented=false but the text reads as if it were handled`);
  }
});

test('the two known gaps are still declared as gaps', () => {
  // These are open items in the audit. If either is ever marked contained here
  // without the audit closing, this test is the thing that catches it.
  const open = FAILURE_MODES.filter(f => !f.implemented).map(f => f.mode.toLowerCase()).join(' | ');
  assert.ok(/insolven/.test(open), 'issuer insolvency must be listed as an open failure mode');
  // The second gap used to be that a principal could not revoke their own
  // agent. That is closed in drunix-gateway/agentid.go and covered by
  // agentstop_test.go, so requiring it to stay open would be requiring the
  // page to lie in the pessimistic direction, which is still lying.
  //
  // Building the harness replaced it with a sharper one: the custody of a
  // pseudonym is threshold arithmetic held entirely inside one process, so
  // it is not custody. That is the claim this now pins.
  assert.ok(/pseudonym|re-identif/.test(open), 'the pseudonym custody gap must be listed as open');
  const closed = FAILURE_MODES.filter(f => f.implemented).map(f => f.mode.toLowerCase()).join(' | ');
  assert.ok(/agent acts beyond/.test(closed), 'agent authority is closed and should be recorded as closed');
});

test('at least two failure modes are open, so the list is not a sales sheet', () => {
  assert.ok(FAILURE_MODES.filter(f => !f.implemented).length >= 2);
});

// 4. The four sections a submission is actually judged on.
test('the friction is specific and sourced', () => {
  assert.ok(FRICTION.statement.length > 80);
  assert.ok(FRICTION.evidence.length >= 3, 'needs at least three sourced claims');
  for (const e of FRICTION.evidence) assert.ok(e.source && e.source.length > 10, `unsourced: ${e.claim}`);
  assert.ok(FRICTION.evidence.some(e => /INSC 1292/.test(e.source)), 'the land-dispute citation must be present');
});

test('the scope is bounded on every axis that matters', () => {
  const axes = SCOPE.bounds.map(b => b.bound.toLowerCase()).join(' ');
  for (const need of ['geography', 'asset class', 'participants', 'ticket size', 'duration', 'cash leg']) {
    assert.ok(axes.includes(need), `scope does not bound: ${need}`);
  }
  assert.ok(SCOPE.reversibility.length > 100, 'a contained scope must say how it is reversed');
});

test('the cohort answers one defined question with named measures', () => {
  assert.ok(LEARNING.question.trim().endsWith('?'), 'the learning goal must be a question');
  assert.ok(LEARNING.measures.length >= 4, 'a question with no measures is a hope');
  assert.ok(LEARNING.negativeResult.length > 80, 'a negative result must be stated as acceptable');
});

// 5. Nothing here may imply standing we do not have.
test('no approval, licence or live connectivity is claimed', () => {
  const all = JSON.stringify({ PROPOSAL, FRICTION, SCOPE, FAILURE_MODES, LEARNING }).toLowerCase();
  const banned = [
    'approved by', 'licensed by', 'authorised by rbi', 'authorized by rbi',
    'in partnership with rbi', 'npci partner', 'regulator-approved', 'sebi-approved',
    'live connection to rbi', 'accepted into',
  ];
  for (const b of banned) assert.ok(!all.includes(b), `claims standing we do not have: "${b}"`);
  assert.ok(/draft/i.test(PROPOSAL.status), 'the status must say it is a draft');
  assert.ok(/not submitted|not approved/i.test(PROPOSAL.status));
});

test('the disclaimers are an explicit section, not a footnote', () => {
  assert.ok(LEARNING.notAsking.length >= 3);
  const txt = LEARNING.notAsking.join(' ').toLowerCase();
  assert.ok(txt.includes('no licence') || txt.includes('no license'));
  assert.ok(txt.includes('rbi') && txt.includes('registrar'), 'must name the rails that are simulated');
  assert.ok(txt.includes('seed'), 'must disclose that the signing keys are demo keys');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
