// The agent harness against a running rail.
//
// tests/agentharness.test.mjs covers the decisions. This covers the part only
// a real request covers: that a passport and a mandate actually bound what an
// agent can do over plain HTTP, that the dry-run check agrees with the act,
// and above all that the principal can stop their own agent and the stop
// takes effect on the very next request.
//
// Every call here goes straight to the Go rail. The web proxy only knows the
// five named demo identities and files anything else as investor1, so an
// agent pseudonym cannot survive the hop. The rail is where the mandate is
// enforced, which is the thing under test.
//
//   node tests/agentlive.test.mjs         (RAIL=http://localhost:21100)

const RAIL = process.env.RAIL || 'http://localhost:21100';
let passed = 0, failed = 0;
const ok = (name, cond, detail) => {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failed++; console.log('  FAIL ' + name + (detail ? '\n       ' + detail : '')); }
};

const headers = (id, role, extra) => ({
  'Content-Type': 'application/json',
  'X-Fabric-Identity': id,
  'X-Identity-Role': role,
  ...(extra || {}),
});

const rail = async (path, init) => {
  const r = await fetch(`${RAIL}${path}`, init);
  const text = await r.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, body };
};
const get = (id, role, extra) => (path) => rail(path, { headers: headers(id, role, extra) });
const post = (id, role, extra) => (path, payload) => rail(path, {
  method: 'POST', headers: headers(id, role, extra), body: JSON.stringify(payload || {}),
});

const ASSET = 'PROP-GREEN-VALLEY-PUNE-001';

async function main() {
  // --- the principal registers an agent and grants it authority -------------

  const reg = await post('investor1', 'Investor')('/umi/agents', {
    purpose: 'releases conditional settlements whose named credential stands',
    version: 'caretaker-1.0.0',
    custodians: ['registrar1', 'regulator1', 'originator1'],
    threshold: 2,
  });
  ok('a principal can register an agent passport',
     reg.status === 201 || reg.status === 200, `status ${reg.status}`);

  const agentId = reg.body && reg.body.agent && reg.body.agent.agentId;
  ok('the passport is a pseudonym, not the principal\'s name',
     typeof agentId === 'string' && /^agent:aasthi:[0-9a-f]{16}$/.test(agentId) && !/investor1/.test(agentId),
     String(agentId));
  if (!agentId) { report(); return; }

  const readAs = get('investor2', 'Investor');
  const seen = await readAs(`/umi/agents/${encodeURIComponent(agentId)}`);
  ok('the register does not disclose who is behind the passport',
     seen.status === 200 && !JSON.stringify(seen.body.agent || {}).includes('investor1'),
     JSON.stringify(seen.body).slice(0, 180));

  const grant = await post('investor1', 'Investor')('/umi/mandates', {
    agent: agentId,
    actions: ['RELEASE_CONDITION'],
    limitINR: 5000,
    assets: [ASSET],
    expiresIn: '24h',
    purpose: 'release conditions whose credential has been issued',
  });
  const mandateID = grant.body && grant.body.mandate && grant.body.mandate.mandateId;
  ok('the principal can grant a bounded mandate to that passport',
     grant.status === 201 && !!mandateID, `status ${grant.status}`);
  if (!mandateID) { report(); return; }

  // The passport and the mandate must name the same identity, or revoking
  // the passport stops nothing: MandateRegistry checks standing against the
  // name on the mandate.
  ok('the mandate names the passport, so the kill switch is wired to something',
     grant.body.mandate.agent === agentId,
     `${grant.body.mandate.agent} vs ${agentId}`);

  // --- what the agent may read ---------------------------------------------

  const agentGet = get(agentId, 'Agent', { 'X-Agent-Mandate': mandateID });
  const agentPost = post(agentId, 'Agent', { 'X-Agent-Mandate': mandateID });

  const own = await agentGet(`/umi/mandates/${encodeURIComponent(mandateID)}`);
  ok('an agent can read the mandate it holds', own.status === 200, `status ${own.status}`);

  const nosy = await get('investor2', 'Investor')(`/umi/mandates/${encodeURIComponent(mandateID)}`);
  ok('an uninvolved party cannot read that mandate', nosy.status === 403, `status ${nosy.status}`);

  // The agent must be able to see the conditions it was delegated to act on.
  // Its own pseudonym is never a buyer, a seller or an asserter, so without
  // the mandate widening the view the book is empty and the delegation is
  // useless.
  const book = await agentGet('/umi/conditions');
  ok('holding a mandate lets the agent read its principal\'s condition book',
     book.status === 200 && Array.isArray(book.body.conditions),
     `status ${book.status}`);

  const unmandated = await get(agentId, 'Agent')('/umi/conditions');
  ok('without the mandate header the agent sees nothing',
     unmandated.status === 200 && (unmandated.body.conditions || []).length === 0,
     `count ${unmandated.body && unmandated.body.count}`);

  // --- the dry run ----------------------------------------------------------

  const under = await agentPost(`/umi/mandates/${encodeURIComponent(mandateID)}/check`,
    { action: 'RELEASE_CONDITION', assetId: ASSET, amountINR: 1000 });
  ok('check allows an act inside the ceiling',
     under.status === 200 && under.body.allowed === true, JSON.stringify(under.body).slice(0, 160));

  const over = await agentPost(`/umi/mandates/${encodeURIComponent(mandateID)}/check`,
    { action: 'RELEASE_CONDITION', assetId: ASSET, amountINR: 50000 });
  ok('check refuses an act above the ceiling and says why',
     over.status === 200 && over.body.allowed === false && !!over.body.reason,
     JSON.stringify(over.body).slice(0, 160));

  const wrongAction = await agentPost(`/umi/mandates/${encodeURIComponent(mandateID)}/check`,
    { action: 'SETTLE_DVP', assetId: ASSET, amountINR: 100 });
  ok('check refuses an action the mandate does not name',
     wrongAction.status === 200 && wrongAction.body.allowed === false,
     JSON.stringify(wrongAction.body).slice(0, 160));

  const wrongAsset = await agentPost(`/umi/mandates/${encodeURIComponent(mandateID)}/check`,
    { action: 'RELEASE_CONDITION', assetId: 'PROP-NOT-MINE', amountINR: 100 });
  ok('check refuses an asset outside the allowlist',
     wrongAsset.status === 200 && wrongAsset.body.allowed === false,
     JSON.stringify(wrongAsset.body).slice(0, 160));

  const before = await agentGet(`/umi/mandates/${encodeURIComponent(mandateID)}`);
  ok('a check consumes none of the ceiling',
     before.status === 200 && Number(before.body.mandate.spentPaise || 0) === 0,
     `spent ${before.body && before.body.mandate && before.body.mandate.spentPaise}`);

  // --- the stop switch ------------------------------------------------------

  const asStranger = post('investor2', 'Investor');
  const stranger = await asStranger(`/umi/agents/${encodeURIComponent(agentId)}/revoke`, {});
  ok('a stranger cannot stop somebody else\'s agent',
     stranger.status === 403 && stranger.body.error === 'ERR_UMI_AGENT_NOT_PRINCIPAL',
     `status ${stranger.status} ${JSON.stringify(stranger.body).slice(0, 120)}`);

  const asPrincipal = post('investor1', 'Investor');
  const stop = await asPrincipal(`/umi/agents/${encodeURIComponent(agentId)}/revoke`, {});
  ok('the principal can stop their own agent, with no supervisor and no ceremony',
     stop.status === 200, `status ${stop.status} ${JSON.stringify(stop.body).slice(0, 160)}`);

  const readOwn = get('investor1', 'Investor');
  const after = await readOwn(`/umi/agents/${encodeURIComponent(agentId)}`);
  ok('the register shows the passport as revoked',
     after.status === 200 && after.body.agent.status === 'REVOKED',
     `status ${after.body && after.body.agent && after.body.agent.status}`);

  // The mandate was never touched, so this only passes if revoking the
  // passport is what made it inert.
  const deadCheck = await agentPost(`/umi/mandates/${encodeURIComponent(mandateID)}/check`,
    { action: 'RELEASE_CONDITION', assetId: ASSET, amountINR: 100 });
  ok('every mandate the agent holds is inert from the next request',
     deadCheck.status === 200 && deadCheck.body.allowed === false,
     JSON.stringify(deadCheck.body).slice(0, 160));

  ok('and the refusal names the withdrawal rather than something vaguer',
     /withdraw/i.test(JSON.stringify(deadCheck.body)),
     JSON.stringify(deadCheck.body).slice(0, 200));

  const stillThere = await get('regulator1', 'Regulator')(`/umi/mandates/${encodeURIComponent(mandateID)}`);
  ok('what the agent already did stays attributable after it is stopped',
     stillThere.status === 200 && stillThere.body.mandate.agent === agentId,
     `status ${stillThere.status}`);

  report();
}

function report() {
  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
