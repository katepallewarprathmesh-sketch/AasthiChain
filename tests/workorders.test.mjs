// Work orders — escrowed property upkeep, paid only against delivered evidence.
//
// A tokenised building still has to be inspected, repaired and revalued, and
// until now all of that happened off-ledger on an invoice nobody could audit.
// The desk applies the rail's own discipline to it: the fee is reserved on the
// funder's e₹-W wallet up front, and it moves to the worker in the same step
// that anchors the deliverable's hash.
//
// What this suite is really checking:
//   the money is reserved, never minted, and conservation survives every path
//   reserved money cannot be spent twice
//   only the funder pays out, only the assigned worker delivers
//   no state jump is possible that would pay for work nobody evidenced
import { randomBytes } from 'node:crypto';

const API = process.env.API || 'http://localhost:8080';

let pass = 0, fail = 0;
const t = (name, ok, detail) => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};

const tokenFor = (identityId, role, mspId) =>
  Buffer.from(JSON.stringify({ identityId, mspId, role, exp: Date.now() + 3600000 })).toString('base64');

const SUFFIX = randomBytes(3).toString('hex');
const FUNDER = 'wfunder' + SUFFIX;
const WORKER = 'wworker' + SUFFIX;
const STRANGER = 'wstranger' + SUFFIX;

const FUNDER_T = tokenFor(FUNDER, 'Originator', 'OriginatorMSP');
const WORKER_T = tokenFor(WORKER, 'Investor', 'InvestorMSP');
const STRANGER_T = tokenFor(STRANGER, 'Investor', 'InvestorMSP');
const REGULATOR = tokenFor('regulator1', 'Regulator', 'RegulatorMSP');

async function call(path, token, init = {}) {
  const headers = { 'Content-Type': 'application/json', ...(init.headers || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(API + path, { ...init, headers });
  let body = null;
  try { body = await res.json(); } catch { /* not json */ }
  return { status: res.status, body };
}
const post = (path, token, payload) =>
  call(path, token, { method: 'POST', body: JSON.stringify(payload || {}) });

console.log(`Work orders (${API})`);

const health = await call('/api/umi/config', REGULATOR);
if (health.status === 503) {
  console.log('  rail unreachable — skipping');
  console.log('\n0 passed, 0 failed');
  process.exit(0);
}
const probe = await call('/api/umi/work/provider', REGULATOR);
if (probe.status === 404) {
  console.log('  work desk not mounted on this rail build — skipping');
  console.log('\n0 passed, 0 failed');
  process.exit(0);
}

const HASH = randomBytes(32).toString('hex');

// ---- the adapter is honest about whether the partner link is real
t('the provider reports a mode', ['live', 'simulation'].includes(probe.body?.mode), JSON.stringify(probe.body?.mode));
t('an unconfigured provider says simulation, not live',
  probe.body?.configured?.WORK_PROVIDER_URL === true || probe.body?.mode === 'simulation',
  JSON.stringify(probe.body?.configured));
t('the roster can be shortlisted by category',
  (await call('/api/umi/work/provider?category=VALUATION', REGULATOR)).body?.roster?.every(r => r.skills.includes('VALUATION')) !== false);

// ---- set the stage: the funder needs e₹-W to escrow
const funded = await post(`/api/umi/wallets/${FUNDER}/fund`, REGULATOR, { amountINR: 50000 });
t('a supervisor can fund the paying wallet', funded.status === 200, `got ${funded.status}`);

const order = {
  assetId: 'PROP-GREEN-VALLEY-PUNE-001',
  title: 'Annual structural inspection',
  spec: 'Walk every floor, photograph damp, report in PDF.',
  category: 'INSPECTION',
  feeINR: 9000,
  funder: FUNDER,
  acceptanceCriteria: ['photographs of all floors', 'signed PDF report'],
};

// ---- opening an order
const anon = await post('/api/umi/work', null, order);
t('an anonymous caller cannot open a work order', anon.status === 401, `got ${anon.status}`);
t('and it is refused for having no identity, not for being wrong',
  anon.body?.error === 'ERR_UMI_NO_IDENTITY', JSON.stringify(anon.body?.error));

const hijack = await post('/api/umi/work', STRANGER_T, order);
t('nobody can open an order that spends a stranger\'s wallet',
  hijack.status === 403, `got ${hijack.status}`);

const created = await post('/api/umi/work', FUNDER_T, order);
t('the funder can open their own order', created.status === 201, `got ${created.status}`);
const ID = created.body?.order?.orderId;
t('the order starts holding no money',
  created.body?.order?.status === 'CREATED' && created.body?.order?.escrowed === false,
  JSON.stringify(created.body?.order?.status));
t('every order says whether the partner link is simulated',
  created.body?.order?.providerMode === 'simulation' || created.body?.order?.providerMode === 'live');

// ---- escrow
const wBefore = (await call(`/api/umi/wallets/${FUNDER}`, FUNDER_T)).body?.wallet;
const fundedOrder = await post(`/api/umi/work/${ID}/fund`, FUNDER_T);
t('funding the order reserves the fee', fundedOrder.body?.order?.status === 'FUNDED', `got ${fundedOrder.status}`);
const wAfter = (await call(`/api/umi/wallets/${FUNDER}`, FUNDER_T)).body?.wallet;
t('the balance is untouched — the money is only reserved',
  wAfter?.balanceINR === wBefore?.balanceINR, `${wBefore?.balanceINR} -> ${wAfter?.balanceINR}`);
t('but it can no longer be spent elsewhere',
  wAfter?.availableINR === wBefore?.availableINR - 9000,
  `${wBefore?.availableINR} -> ${wAfter?.availableINR}`);

// ---- who may do what
const outsiderAssign = await post(`/api/umi/work/${ID}/assign`, STRANGER_T, { worker: STRANGER });
t('a stranger cannot assign themselves the work', outsiderAssign.status === 403, `got ${outsiderAssign.status}`);

const selfDeal = await post(`/api/umi/work/${ID}/assign`, FUNDER_T, { worker: FUNDER });
t('the funder cannot pay themselves out of their own escrow',
  selfDeal.status === 409 && selfDeal.body?.error === 'ERR_WORK_SELF_DEAL', `got ${selfDeal.status}`);

const assigned = await post(`/api/umi/work/${ID}/assign`, FUNDER_T, { worker: WORKER, providerRef: 'RZX-TEST' });
t('the funder can assign a worker', assigned.body?.order?.status === 'ASSIGNED', `got ${assigned.status}`);

const funderSubmits = await post(`/api/umi/work/${ID}/submit`, FUNDER_T, { deliverableHash: HASH });
t('the funder cannot submit the deliverable on the worker\'s behalf',
  funderSubmits.status === 403, `got ${funderSubmits.status}`);

const badHash = await post(`/api/umi/work/${ID}/submit`, WORKER_T, { deliverableHash: 'nope' });
t('a deliverable with no real hash is refused',
  badHash.status === 400 && badHash.body?.error === 'ERR_WORK_BAD_HASH', `got ${badHash.status}`);

const submitted = await post(`/api/umi/work/${ID}/submit`, WORKER_T, { deliverableHash: HASH, deliverableUri: 'ipfs://report' });
t('the assigned worker can submit', submitted.body?.order?.status === 'SUBMITTED', `got ${submitted.status}`);

const workerAccepts = await post(`/api/umi/work/${ID}/accept`, WORKER_T);
t('the worker cannot accept their own work', workerAccepts.status === 403, `got ${workerAccepts.status}`);

// ---- payment
const accepted = await post(`/api/umi/work/${ID}/accept`, FUNDER_T, { note: 'report received' });
t('the funder accepting releases the escrow', accepted.body?.order?.status === 'ACCEPTED', `got ${accepted.status}`);
t('the deliverable hash is on the accepted order',
  accepted.body?.order?.deliverableHash === HASH);
t('the payment is anchored in a block', (accepted.body?.order?.blockHeight || 0) > 0,
  JSON.stringify(accepted.body?.order?.blockHeight));

const funderFinal = (await call(`/api/umi/wallets/${FUNDER}`, FUNDER_T)).body?.wallet;
const workerFinal = (await call(`/api/umi/wallets/${WORKER}`, WORKER_T)).body?.wallet;
t('the fee left the funder', funderFinal?.balanceINR === wBefore?.balanceINR - 9000,
  `${wBefore?.balanceINR} -> ${funderFinal?.balanceINR}`);
t('nothing stays reserved afterwards', funderFinal?.reservedPaise === undefined || funderFinal?.availableINR === funderFinal?.balanceINR);
t('the worker was paid exactly the fee', workerFinal?.balanceINR === 9000, `got ${workerFinal?.balanceINR}`);

// ---- the invariant
const rec = await call('/api/umi/reconciliation', REGULATOR);
t('escrow never created or destroyed central bank money', rec.body?.conserved === true,
  rec.body?.conservationNote);

// ---- no replay after a terminal state
const again = await post(`/api/umi/work/${ID}/accept`, FUNDER_T);
t('an accepted order cannot be accepted twice',
  again.status === 409 && again.body?.error === 'ERR_WORK_BAD_STATE', `got ${again.status}`);
const lateRefund = await post(`/api/umi/work/${ID}/refund`, FUNDER_T, { reason: 'changed my mind' });
t('and it cannot be refunded after payment', lateRefund.status === 409, `got ${lateRefund.status}`);

// ---- refund path returns the money
const second = await post('/api/umi/work', FUNDER_T, { ...order, title: 'Repaint stairwell', category: 'REPAIR', feeINR: 5000 });
const ID2 = second.body?.order?.orderId;
await post(`/api/umi/work/${ID2}/fund`, FUNDER_T);
const refunded = await post(`/api/umi/work/${ID2}/refund`, FUNDER_T, { reason: 'owner postponed it' });
t('an unassigned order can be refunded', refunded.body?.order?.status === 'REFUNDED', `got ${refunded.status}`);
const afterRefund = (await call(`/api/umi/wallets/${FUNDER}`, FUNDER_T)).body?.wallet;
t('the refund restores full spending power',
  afterRefund?.availableINR === afterRefund?.balanceINR,
  `available ${afterRefund?.availableINR} vs balance ${afterRefund?.balanceINR}`);

// ---- the desk is scoped to the people in the deal
const strangerList = await call('/api/umi/work', STRANGER_T);
t('a stranger sees none of these orders',
  (strangerList.body?.orders || []).every(o => o.orderId !== ID), 'a private order leaked');
const funderList = await call('/api/umi/work', FUNDER_T);
t('the funder sees their own', (funderList.body?.orders || []).some(o => o.orderId === ID));
const workerList = await call('/api/umi/work', WORKER_T);
t('the worker sees the one they delivered', (workerList.body?.orders || []).some(o => o.orderId === ID));
const supervisorList = await call('/api/umi/work', REGULATOR);
t('a supervisor sees the whole desk', (supervisorList.body?.orders || []).some(o => o.orderId === ID));

const peek = await call(`/api/umi/work/${ID}`, STRANGER_T);
t('a stranger cannot read one order directly either', peek.status === 403, `got ${peek.status}`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
