// End-to-end checks for agent passports.
//
// A software actor on this rail acts under a pseudonym. The principal behind
// it is split across named custodians, and identifying them takes a threshold
// of those custodians, a stated trigger, and a block for every step. These
// checks prove the public surface hides the principal, that one party cannot
// open it alone, and that the opening is on the chain when it happens.
//
//   node tests/agentid.test.mjs             (BASE=http://localhost:8080)

const BASE = process.env.BASE || 'http://localhost:8080';
const RAIL = process.env.RAIL || 'http://localhost:21100';
let passed = 0, failed = 0;
const ok = (name, cond, detail) => {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failed++; console.log('  FAIL ' + name + (detail ? '\n       ' + detail : '')); }
};

const call = async (origin, path, init) => {
  const r = await fetch(origin + path, init);
  const text = await r.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, body };
};
const app = (path, init) => call(BASE, path, init);
const rail = (path, init) => call(RAIL, path, init);
const headers = (id, role) => ({
  'Content-Type': 'application/json', 'X-Fabric-Identity': id, 'X-Identity-Role': role,
});
const post = (id, role) => (path, payload) => rail(path, {
  method: 'POST', headers: headers(id, role), body: JSON.stringify(payload || {}),
});
const asInvestor = post('investor1', 'Investor');
const asRegistrar = post('registrar1', 'Registrar');
const asRegulator = post('regulator1', 'Regulator');
const asOriginator = post('originator1', 'Originator');
const asStranger = post('investor2', 'Investor');

const registration = {
  purpose: 'renews two tenancies and pays the upkeep invoices',
  version: 'upkeep-3.1',
  custodians: ['registrar1', 'regulator1', 'originator1'],
  threshold: 2,
};

const run = async () => {
  console.log('Agent passports');

  // 1. A split that protects nobody is refused.
  const soleCustodian = await asInvestor('/umi/agents', { ...registration, threshold: 1 });
  ok('a threshold of one is refused', soleCustodian.status === 400, JSON.stringify(soleCustodian.body));
  const selfCustody = await asInvestor('/umi/agents', { ...registration, custodians: ['investor1', 'registrar1'] });
  ok('a principal cannot hold a share of its own identity', selfCustody.status === 400,
    JSON.stringify(selfCustody.body));
  const noPurpose = await asInvestor('/umi/agents', { ...registration, purpose: '' });
  ok('an agent with no stated purpose is refused', noPurpose.status === 400, JSON.stringify(noPurpose.body));

  // 2. Registration returns a pseudonym and nothing else about the principal.
  const made = await asInvestor('/umi/agents', registration);
  ok('a principal can register an agent', made.status === 200, JSON.stringify(made.body).slice(0, 200));
  const agent = made.body && made.body.agent;
  const agentId = agent && agent.agentId;
  ok('the agent gets a pseudonym, not a name',
    !!agentId && agentId.startsWith('agent:aasthi:') && !agentId.includes('investor1'), String(agentId));
  ok('the passport says a liable principal exists without naming them',
    !!agent && agent.sponsored === true && !agent.principal && agent.status === 'ACTIVE',
    JSON.stringify(agent));
  ok('the response states that the custody is not actually distributed',
    typeof made.body.disclaimer === 'string' && /one process/i.test(made.body.disclaimer),
    String(made.body && made.body.disclaimer).slice(0, 160));

  // 3. The public register hides the principal too.
  const list = await rail('/umi/agents');
  ok('the register is readable without a session', list.status === 200 && Array.isArray(list.body.agents),
    JSON.stringify(list.body).slice(0, 160));
  ok('no passport in the register names a principal',
    (list.body.agents || []).every((a) => !a.principal), JSON.stringify(list.body.agents || []).slice(0, 200));

  // 4. Nobody opens an identity on their own.
  const strangerAsks = await asStranger('/umi/agents/' + agentId + '/reveal', { reason: 'I am curious about this' });
  ok('a stranger cannot open an identification request', strangerAsks.status === 403,
    JSON.stringify(strangerAsks.body));
  const noTrigger = await asRegulator('/umi/agents/' + agentId + '/reveal', { reason: '' });
  ok('a request with no stated trigger is refused', noTrigger.status === 400, JSON.stringify(noTrigger.body));
  const early = await asRegistrar('/umi/agents/' + agentId + '/reveal/approve', {});
  ok('a share cannot be contributed before a request exists', early.status === 409, JSON.stringify(early.body));

  const opened = await asRegulator('/umi/agents/' + agentId + '/reveal', { reason: 'settlement dispute 4412' });
  ok('a custodian or supervisor can open a request with a trigger', opened.status === 200,
    JSON.stringify(opened.body).slice(0, 200));
  ok('an open request is visible to everyone, so nobody is unmasked quietly',
    opened.body.agent && opened.body.agent.status === 'REVEAL_PENDING'
      && opened.body.agent.revealReason === 'settlement dispute 4412' && !opened.body.agent.principal,
    JSON.stringify(opened.body.agent));

  // 5. One custodian is not enough, and cannot stand in for two.
  const first = await asRegistrar('/umi/agents/' + agentId + '/reveal/approve', {});
  ok('one custodian approval identifies nobody',
    first.status === 200 && !first.body.principal && first.body.agent.approvals === 1,
    JSON.stringify(first.body).slice(0, 200));
  const twice = await asRegistrar('/umi/agents/' + agentId + '/reveal/approve', {});
  ok('the same custodian cannot approve twice to reach the threshold alone', twice.status === 409,
    JSON.stringify(twice.body));
  const outsider = await asStranger('/umi/agents/' + agentId + '/reveal/approve', {});
  ok('somebody holding no share cannot contribute one', outsider.status === 403, JSON.stringify(outsider.body));

  // 6. The threshold recovers the principal.
  const second = await asOriginator('/umi/agents/' + agentId + '/reveal/approve', {});
  ok('the threshold of custodians recovers the principal',
    second.status === 200 && second.body.principal === 'investor1',
    JSON.stringify(second.body).slice(0, 200));
  ok('the passport now reads IDENTIFIED',
    second.body.agent && second.body.agent.status === 'IDENTIFIED' && second.body.agent.revealed === true,
    JSON.stringify(second.body.agent));

  // 7. Every step of it is on the chain.
  const chain = await rail('/drunix/chain?limit=60');
  const types = (chain.body && (chain.body.blocks || chain.body.chain) || []).map((b) => b.type || b.Type);
  ok('the registration is a block', types.includes('AGENT_REGISTERED'), types.slice(0, 12).join(','));
  ok('the request is a block', types.includes('AGENT_REVEAL_REQUESTED'), types.slice(0, 12).join(','));
  ok('each approval is a block', types.filter((t) => t === 'AGENT_REVEAL_APPROVED').length >= 2,
    types.slice(0, 12).join(','));
  ok('the reveal itself is a block', types.includes('AGENT_REVEALED'), types.slice(0, 12).join(','));

  // 8. The app proxies the register without adding logic of its own.
  const proxied = await app('/api/umi/agents');
  ok('the app proxies the agent register', proxied.status === 200 && Array.isArray(proxied.body.agents),
    JSON.stringify(proxied.body).slice(0, 160));

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
};

run().catch((e) => { console.error(e); process.exit(1); });
