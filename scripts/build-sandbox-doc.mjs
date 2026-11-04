#!/usr/bin/env node
// Generate docs/SANDBOX_PROPOSAL.md from frontend/src/lib/sandboxProposal.js.
//
// The proposal has two audiences: a reader on the /sandbox screen and a
// reader who was sent a file. Written twice they drift, and the drift always
// flatters: the page keeps the honest "not implemented" line and the document
// quietly loses it, or the other way round. So the data is written once and
// the document is a build artefact.
//
//   node scripts/build-sandbox-doc.mjs           write the file
//   node scripts/build-sandbox-doc.mjs --check   fail if it is stale
//
// tests/sandbox.test.mjs runs the second form, so a change to the proposal
// that forgets to regenerate the document cannot reach main.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = new URL('../', import.meta.url);
const OUT = fileURLToPath(new URL('docs/SANDBOX_PROPOSAL.md', ROOT));

const { PROPOSAL, FRICTION, SCOPE, FAILURE_MODES, LEARNING } =
  await import(new URL('frontend/src/lib/sandboxProposal.js', ROOT).href);

const lines = [];
const p = (s = '') => lines.push(s);

p(`# ${PROPOSAL.title}`);
p();
p(`**${PROPOSAL.status}**`);
p();
p(`${PROPOSAL.summary}`);
p();
p(`Applicant: ${PROPOSAL.applicant}. ${PROPOSAL.venue}.`);
p();
p('<!-- Generated from frontend/src/lib/sandboxProposal.js by scripts/build-sandbox-doc.mjs.');
p('     Edit the data file, not this document. tests/sandbox.test.mjs fails if they disagree. -->');
p();
p('A sandbox exists to create regulatory clarity, not to demonstrate that software runs. The four');
p('sections below are the four things that carry the weight: the specific friction, a scope small');
p('enough that reversing it is uninteresting, the failure modes stated before anyone asks, and what');
p('will have been learned either way.');
p();

p('## 1. The friction');
p();
p(FRICTION.statement);
p();
for (const e of FRICTION.evidence) {
  p(`- ${e.claim}`);
  p(`  <br><sub>${e.source}</sub>`);
}
p();
p(`**Why this cohort, now.** ${FRICTION.whyNow}`);
p();

p('## 2. Scope, and how it is contained');
p();
p(SCOPE.statement);
p();
p('| Bound | Limit |');
p('| --- | --- |');
for (const b of SCOPE.bounds) p(`| ${b.bound} | ${b.value} |`);
p();
p(`**Reversibility.** ${SCOPE.reversibility}`);
p();

p('## 3. Failure modes, stated before being asked');
p();
p('Each row names what goes wrong, what it looks like from outside, and what is already built. The');
p('rows marked **open** are not handled. They are listed because an application claiming everything');
p('is handled is the one a reader stops believing.');
p();
for (const f of FAILURE_MODES) {
  p(`### ${f.mode}${f.implemented ? '' : ' (open)'}`);
  p();
  p(`**Symptom.** ${f.symptom}`);
  p();
  p(`**Today.** ${f.containment}`);
  p();
  p(`<sub>\`${f.file}\` · \`${f.test}\`</sub>`);
  p();
}

p('## 4. What the cohort would establish');
p();
p(`**The question.** ${LEARNING.question}`);
p();
p('**Measured by:**');
p();
for (const m of LEARNING.measures) p(`- ${m}`);
p();
p(`**A negative result is still a result.** ${LEARNING.negativeResult}`);
p();
p('## What is not being claimed');
p();
for (const n of LEARNING.notAsking) p(`- ${n}`);
p();

const body = lines.join('\n').replace(/\n{3,}/g, '\n\n') + '\n';

if (process.argv.includes('--check')) {
  const current = existsSync(OUT) ? readFileSync(OUT, 'utf8') : '';
  if (current !== body) {
    console.error('docs/SANDBOX_PROPOSAL.md is stale. Run: node scripts/build-sandbox-doc.mjs');
    process.exit(1);
  }
  console.log('docs/SANDBOX_PROPOSAL.md is up to date');
  process.exit(0);
}

writeFileSync(OUT, body);
console.log(`wrote ${OUT} (${body.split('\n').length} lines)`);
