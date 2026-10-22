// What the assistant is grounded in.
//
// The assistant used to know the property catalogue and nothing else, so a
// question about how settlement works was answered from whatever the model
// remembered about blockchains in general. These checks pin the two sources
// that replaced that: retrieval over this repository's own documents, and a
// briefing of the rail's live figures.
//
// What must stay true:
//   * the committed index matches the documents as they are now, or an
//     answer quotes a doc that has since been rewritten;
//   * a question about something documented retrieves that document and not
//     a neighbouring one;
//   * a question about nothing in the docs retrieves nothing, rather than
//     the least irrelevant section available;
//   * every live figure in the briefing is the rail's own, and an unmeasured
//     one is never presented as measured;
//   * the index carries documentation only: no keys, no tokens, no backlog.
//
//   node tests/knowledge.test.mjs            (BASE=http://localhost:8080)

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import {
  retrieve, buildKnowledgeContext, buildRailContext, readRail, tokenise, loadIndex,
  identifiersIn, lookupRecords,
} from '../frontend/api/lib/knowledge.mjs';
import { systemPrompt } from '../frontend/api/lib/ai.mjs';

const BASE = process.env.BASE || 'http://localhost:8080';
const RAIL = process.env.RAIL || 'http://localhost:21100';
const root = new URL('../', import.meta.url);
let passed = 0, failed = 0;
const ok = (name, cond, detail) => {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failed++; console.log('  FAIL ' + name + (detail ? '\n       ' + detail : '')); }
};

const INDEX_PATH = new URL('frontend/api/lib/knowledge-index.json', root);

async function main() {
  console.log('\nAssistant grounding\n');

  const index = JSON.parse(readFileSync(INDEX_PATH, 'utf8'));

  // 1. The index is real, and it is current.
  ok('the index has sections from the project documents',
    index.sections.length > 100 && new Set(index.sections.map((s) => s.file)).size > 15,
    `${index.sections.length} sections`);
  const before = index.sourceDigest;
  execFileSync(process.execPath, ['scripts/build-knowledge.mjs'], { cwd: new URL('.', root).pathname, stdio: 'pipe' });
  const after = JSON.parse(readFileSync(INDEX_PATH, 'utf8')).sourceDigest;
  ok('the committed index is not stale', before === after,
    'run node scripts/build-knowledge.mjs and commit the result');

  // 2. Every section says where it came from, so an answer can be traced.
  ok('every section names its document and heading',
    index.sections.every((s) => s.doc && s.file && s.heading && s.text),
    'a section with no source cannot be cited');
  ok('nothing in the index is a to-do list or an audit of open problems',
    !index.sections.some((s) => /BACKLOG|REPOSITORY_AUDIT/.test(s.file)));

  // 3. No credential may be carried into a prompt.
  const blob = JSON.stringify(index);
  ok('the index carries no secret',
    !/github_pat_|sk-[a-zA-Z0-9]{20}|gsk_[a-zA-Z0-9]{20}|BEGIN [A-Z ]*PRIVATE KEY/.test(blob));

  // 4. Retrieval lands on the right document.
  const expectations = [
    ['how was the fraud model scored and on what data', 'RISK_MODEL'],
    ['what happens if nobody attests the event behind a locked payment', ['CBDC', 'README', 'AMA_COVERAGE']],
    ['which cross-border corridor is refused and what licence is missing', ['CORRIDORS', 'CBDC']],
    ['how is a block anchored to a public chain', ['ANCHORING', 'SEPOLIA', 'ARCHITECTURE']],
    ['what does the throughput number actually measure', ['THROUGHPUT', 'PERFORMANCE']],
  ];
  for (const [q, want] of expectations) {
    const hits = retrieve(q, 5);
    const docs = hits.map((h) => h.doc);
    const list = Array.isArray(want) ? want : [want];
    ok(`"${q.slice(0, 44)}..." retrieves ${list.join(' or ')}`,
      docs.some((d) => list.includes(d)), docs.join(', ') || 'nothing');
  }

  // 5. And refuses to pad the prompt when the question is about nothing here.
  for (const q of ['what is the recipe for biryani', 'who won the cricket world cup in 2019']) {
    ok(`"${q.slice(0, 30)}..." grounds in nothing`, buildKnowledgeContext([{ role: 'user', content: q }]) === null);
  }
  const grounded = buildKnowledgeContext([{ role: 'user', content: 'how was the risk model trained and measured' }]);
  ok('a documented question produces a cited briefing',
    typeof grounded === 'string' && grounded.includes('RISK_MODEL') && grounded.includes('docs/RISK_MODEL.md'),
    String(grounded).slice(0, 120));

  // 6. Retrieval is deterministic: the same question twice is the same answer.
  const a = retrieve('offline digital rupee voucher', 3).map((h) => h.heading).join('|');
  const b = retrieve('offline digital rupee voucher', 3).map((h) => h.heading).join('|');
  ok('retrieval is deterministic', a === b && a.length > 0, a);
  ok('stop words do not drive the result', tokenise('what is the of and a corridor').join(',') === 'corridor');

  // 7. The live briefing is the rail's own figures.
  const rail = await readRail(RAIL);
  if (!rail.cbdc) {
    ok('the rail answered for the briefing', false, `no answer from ${RAIL}/umi/cbdc`);
  } else {
    const brief = buildRailContext(rail);
    ok('the briefing reports the conservation check',
      /Supply conservation check: (passing|FAILING)/.test(brief), String(brief).slice(0, 160));
    ok('the briefing uses the figure the rail reported',
      brief.includes('₹' + (rail.cbdc.conservation.issuedPaise / 100).toLocaleString('en-IN', { maximumFractionDigits: 0 })));
    ok('the briefing names a blocked corridor and what it lacks',
      /refuses every payment here because this deployment holds none of/.test(brief));
    ok('the briefing says the money is simulated', /simulated, no central bank money/.test(brief));
    if (rail.risk && rail.risk.metrics) {
      ok('the briefing quotes measured model metrics, with the data source',
        brief.includes(String(rail.risk.metrics.auc)) && /[Ss]ynthetic/.test(brief),
        'metrics must arrive with the fact that the training data was synthetic');
      ok('the briefing says the score is advisory', /advisory/.test(brief));
    }
  }

  // 8. The prompt tells the model what to do with all this, including the
  //    case where there is nothing.
  const prompt = systemPrompt('Properties: none.', grounded, buildRailContext(rail));
  ok('the prompt carries the retrieved documentation', prompt.includes('DOCUMENTATION'));
  const flat = prompt.replace(/\s+/g, ' ');
  ok('the prompt forbids citing a document it was not given',
    /never invent a file name/i.test(flat) && /Never cite a document that is not shown/i.test(flat));
  ok('the prompt forbids recomputing the live figures', /Do not recompute, round or extrapolate/i.test(flat));
  ok('the prompt allows "this is not documented here" as a complete answer',
    /not documented here/i.test(flat) && /plausible guess is not/i.test(flat));
  const bare = systemPrompt('Properties: none.', null, null);
  ok('with no grounding the prompt says so rather than pretending',
    /nothing in the project documentation matched/i.test(bare) && /LIVE RAIL STATE: not available/i.test(bare));

  // 9. The feature stays off when there is no key, grounded or not.
  const status = await (await fetch(BASE + '/api/ai/status')).json();
  ok('the deployment reports honestly whether the assistant is on',
    typeof status.enabled === 'boolean', JSON.stringify(status).slice(0, 120));
  if (!status.enabled) {
    const chat = await fetch(BASE + '/api/ai/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hello' }] }),
    });
    const body = await chat.json();
    ok('with no key the assistant is off, not faking an answer',
      chat.status === 503 && body.error === 'ERR_AI_NOT_CONFIGURED', `${chat.status} ${body.error}`);
  }

  // 10. Looking a named record up, which is the question people actually ask.
  ok('a reference in the question is recognised',
    JSON.stringify(identifiersIn('what happened in settlement UMI-3F2A9C1B04 and in block 5?'))
      === JSON.stringify([{ kind: 'instruction', id: 'UMI-3F2A9C1B04' }, { kind: 'block', id: '5' }]),
    JSON.stringify(identifiersIn('what happened in settlement UMI-3F2A9C1B04 and in block 5?')));
  ok('a question with no reference looks nothing up',
    identifiersIn('how does settlement work here').length === 0);
  ok('a question stuffed with references is capped',
    identifiersIn(Array.from({ length: 12 }, (_, i) => `UMI-ABCDEF01${i}0`).join(' ')).length <= 4);

  ok('an unknown reference is reported as unknown, not invented',
    /No settlement instruction exists with the reference UMI-DEADBEEF99/.test(
      String(await lookupRecords([{ role: 'user', content: 'what happened in UMI-DEADBEEF99' }], RAIL))));

  // A real record: open one on the rail and ask for it back by reference.
  const post = (path, body, id = 'investor1', role = 'Investor') => fetch(RAIL + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Fabric-Identity': id, 'X-Identity-Role': role },
    body: JSON.stringify(body),
  }).then((r) => r.json());

  await post('/umi/cbdc/issue', { holder: 'investor1', amountPaise: 900000, kycTier: 'FULL_KYC' }, 'regulator1', 'Regulator');
  const opened = await post('/umi/cbdc/conditions', {
    payer: 'investor1', payee: 'originator1', amountPaise: 150000,
    eventType: 'FLIGHT_CANCELLED', eventKey: 'TEST-KNOWLEDGE', attestor: 'registrar1', deadlineHours: 24,
  });
  const conditionId = opened && opened.condition && opened.condition.conditionId;
  if (!conditionId) {
    ok('a conditional payment could be opened to look up', false, JSON.stringify(opened).slice(0, 160));
  } else {
    const found = String(await lookupRecords([{ role: 'user', content: `what happened in ${conditionId}` }], RAIL));
    ok('a real reference returns the record itself', found.includes(conditionId), found.slice(0, 160));
    ok('the record states who may release it and by when',
      /registrar1 attests FLIGHT_CANCELLED/.test(found) && /returns to the payer/.test(found));
    ok('the amount comes from the rail, not from arithmetic', found.includes('₹1,500'), found.slice(0, 200));
  }

  const blockLook = String(await lookupRecords([{ role: 'user', content: 'what is in block 5' }], RAIL));
  ok('a block can be looked up by height', /Block 5, type /.test(blockLook), blockLook.slice(0, 140));
  const noBlock = String(await lookupRecords([{ role: 'user', content: 'what is in block 999999' }], RAIL));
  ok('a block that does not exist says so', /no block 999999/.test(noBlock), noBlock.slice(0, 140));

  ok('the lookup layer is pattern driven, not a tool the model can steer',
    /are recognised here, by pattern/i.test(
      readFileSync(new URL('frontend/api/lib/knowledge.mjs', root), 'utf8').replace(/\s+/g, ' ')));
  const withRecords = systemPrompt('Properties: none.', null, null, blockLook).replace(/\s+/g, ' ');
  ok('the prompt forbids describing a record it was not given',
    /never describe a record you were not given/i.test(withRecords));
  ok('with no reference the prompt says none was named',
    /RECORDS: the question named no reference/i.test(systemPrompt('x', null, null, null)));

  // 11. Grounding must not have loosened the read-only promise.
  const ai = readFileSync(new URL('frontend/api/lib/ai.mjs', root), 'utf8');
  ok('the assistant still has no tools and cannot act',
    !/tool_choice|tools:\s*\[/.test(ai) && /It reads\. It never acts/.test(ai));

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
