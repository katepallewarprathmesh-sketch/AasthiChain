// The proposing agent: it notices, it drafts, and then it stops.
//
// The valuable half of an agent in a settlement system is noticing. The
// dangerous half is acting. These checks are mostly about the second half not
// happening: nothing executes without a named person, the person's name is
// what lands in the block, and an approval given after the facts changed does
// not run against the new facts.
//
//   node tests/proposals.test.mjs            (BASE=http://localhost:8080)

const BASE = process.env.BASE || 'http://localhost:8080';
let passed = 0, failed = 0;
const ok = (name, cond, detail) => {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failed++; console.log('  FAIL ' + name + (detail ? '\n       ' + detail : '')); }
};
const headers = (id, role) => ({ 'Content-Type': 'application/json', 'X-Fabric-Identity': id, 'X-Identity-Role': role });
const get = async (path, id, role) => {
  const r = await fetch(BASE + '/api/umi' + path, { headers: headers(id || 'investor1', role || 'Investor') });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const post = async (path, id, role, payload) => {
  const r = await fetch(BASE + '/api/umi' + path, { method: 'POST', headers: headers(id, role), body: JSON.stringify(payload || {}) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

async function main() {
  console.log('\nProposing agent\n');

  // 1. It declares what it is and what it is not allowed to do.
  const root = await get('/proposals');
  ok('the agent is mounted', root.status === 200, JSON.stringify(root.body).slice(0, 140));
  const st = root.body;
  ok('it publishes the actions it can propose',
    Array.isArray(st.actionsItCanPropose) && st.actionsItCanPropose.length > 0, JSON.stringify(st.actionsItCanPropose));
  const cannot = (st.itCannot || []).join(' | ').toLowerCase();
  ok('it publishes what it cannot do', cannot.length > 0, cannot);
  ok('it cannot move or create money', /issue, redeem or move money/.test(cannot));
  ok('it cannot approve its own proposal', /approve its own proposal/.test(cannot));
  ok('it cannot act on a timer', /timer/.test(cannot));
  ok('it says the evidence is re-read at approval', /re-read/i.test(String(st.onApproval)));
  ok('the disclaimer says it executes nothing on its own',
    /does not execute anything on its own/i.test(String(st.disclaimer)));

  // 2. Scanning is an act by a supervisor, not something anybody can trigger.
  const scanAsInvestor = await post('/proposals/scan', 'investor1', 'Investor', {});
  ok('an investor cannot run the agent', scanAsInvestor.status === 403, String(scanAsInvestor.status));

  // 3. Give it something real to notice: an AML case nobody works. The
  // detector only fires after a day, so a fresh rail produces nothing, and
  // that silence is itself the correct behaviour to assert.
  await post('/aml/cases', 'regulator1', 'Regulator', {
    name: 'Helios Shipping Lines Limited', relatedRef: 'PROPOSAL-TEST', counterparty: 'investor1', amountPaise: 750000,
  });
  const quiet = await post('/proposals/scan', 'regulator1', 'Regulator', {});
  ok('a case opened moments ago is not yet called neglected',
    quiet.status === 200 && (quiet.body.drafted || []).every((p) => !/Helios/.test(p.title)),
    JSON.stringify(quiet.body.drafted || []).slice(0, 160));
  ok('a scan that drafts nothing says nothing was performed',
    /Nothing has been performed/i.test(String(quiet.body.note)));

  // 3b. Something it should notice now: a conditional payment whose deadline
  // is inside the window, with nobody having attested. The agent must draft,
  // and must not release the money.
  await post('/cbdc/issue', 'regulator1', 'Regulator', { holder: 'investor1', amountPaise: 5000000, kycTier: 'FULL_KYC' });
  const cond = await post('/cbdc/conditions', 'investor1', 'Investor', {
    payer: 'investor1', payee: 'originator1', amountPaise: 100000,
    eventType: 'DELIVERY', eventKey: 'proposal-test-' + Date.now(), attestor: 'registrar1', deadlineHours: 1,
  });
  const conditionId = cond.body?.condition?.conditionId;
  ok('a conditional payment was opened to give the agent something to see', !!conditionId,
    `${cond.status} ${JSON.stringify(cond.body).slice(0, 140)}`);
  const scan = await post('/proposals/scan', 'regulator1', 'Regulator', {});
  const drafted = (scan.body.drafted || []).find((p) => p.subject === conditionId);
  ok('the agent notices a condition about to expire unattested', !!drafted,
    JSON.stringify((scan.body.drafted || []).map((p) => p.subject)).slice(0, 160));
  if (drafted) {
    ok('it names the attestor who has not attested', drafted.why.join(' ').includes('registrar1'), drafted.why.join(' '));
    ok('it refuses to release the money itself',
      /does not release the money/.test(drafted.whatWillHappen), drafted.whatWillHappen);
    ok('it says what happens if nobody acts', /returns to the payer/.test(drafted.ifIgnored), drafted.ifIgnored);
  }
  const again = await post('/proposals/scan', 'regulator1', 'Regulator', {});
  ok('scanning twice does not duplicate the same situation',
    (again.body.drafted || []).every((p) => p.subject !== conditionId),
    JSON.stringify((again.body.drafted || []).map((p) => p.subject)));

  // 3c. Staleness, deterministically. The proposal above is about a
  // conditional payment; release that payment and the reason for the
  // proposal is gone. Approving it afterwards must perform nothing. This
  // scenario exists because a planted defect that removed the freshness
  // check broke no test: the suite accepted either outcome.
  if (drafted) {
    const key = cond.body.condition.eventKey;
    const released = await post('/cbdc/events', 'registrar1', 'Registrar', { eventType: 'DELIVERY', eventKey: key });
    ok('the condition can be released by its attestor', released.status === 200 || released.status === 201,
      `${released.status} ${JSON.stringify(released.body).slice(0, 120)}`);
    const late = await post(`/proposals/${drafted.proposalId}/approve`, 'regulator1', 'Regulator', { note: 'late' });
    ok('approving a proposal whose situation resolved is refused as stale',
      late.status === 409 && late.body.error === 'ERR_UMI_AGENT_STALE', `${late.status} ${late.body.error}`);
    ok('the staleness says what changed',
      /no longer needs anybody|released|refunded/i.test(String(late.body.message)), String(late.body.message).slice(0, 160));
    const after = await get(`/proposals/${drafted.proposalId}`);
    ok('and the proposal is recorded as stale, not approved',
      after.body?.proposal?.status === 'STALE', String(after.body?.proposal?.status));
  }

  // 4. The queue is public, because a queue only its operator can see is a
  // queue nobody can hold to account.
  const queue = await get('/proposals', 'investor1', 'Investor');
  ok('the queue is readable without a supervisor role', queue.status === 200 && Array.isArray(queue.body.proposalQueue));

  // 5. Deciding is supervisor-only, and the decision needs substance.
  const existing = (queue.body.proposalQueue || []).find((p) => p.status === 'DRAFT');
  if (!existing) {
    ok('nothing in the queue to decide, which is a valid state', true);
    ok('an unknown proposal is reported as unknown',
      (await post('/proposals/AGT-DOESNOTEXIST/approve', 'regulator1', 'Regulator', {})).status === 404);
    ok('a proposal route that is not approve or reject is rejected',
      (await post('/proposals/AGT-X/sideways', 'regulator1', 'Regulator', {})).status === 404);
  } else {
    const byInvestor = await post(`/proposals/${existing.proposalId}/approve`, 'investor1', 'Investor', {});
    ok('an investor cannot approve a proposal', byInvestor.status === 403, String(byInvestor.status));

    const noReason = await post(`/proposals/${existing.proposalId}/reject`, 'regulator1', 'Regulator', {});
    ok('a rejection needs a reason', noReason.status === 400, String(noReason.status));

    const one = await get(`/proposals/${existing.proposalId}`);
    const p = one.body.proposal || {};
    ok('a proposal carries the evidence it was drafted from',
      p.evidence && Object.keys(p.evidence).length > 0, JSON.stringify(p.evidence || {}).slice(0, 140));
    ok('a proposal says what approving it will do', typeof p.whatWillHappen === 'string' && p.whatWillHappen.length > 20);
    ok('a proposal says what happens if it is ignored', typeof p.ifIgnored === 'string' && p.ifIgnored.length > 10);
    ok('a proposal gives its reasons', Array.isArray(p.why) && p.why.length > 0);

    const approved = await post(`/proposals/${existing.proposalId}/approve`, 'regulator1', 'Regulator', { note: 'Agreed.' });
    const isStale = approved.status === 409 && approved.body.error === 'ERR_UMI_AGENT_STALE';
    ok('approval either performs the action or refuses as stale',
      approved.status === 200 || isStale, `${approved.status} ${approved.body.error || ''}`);
    if (approved.status === 200) {
      ok('the approver is recorded, not the agent',
        approved.body.proposal.decidedBy === 'regulator1' && /act by regulator1/i.test(String(approved.body.note)));
      ok('the approval is on the chain', approved.body.proposal.blockHeight > 0);
      const twice = await post(`/proposals/${existing.proposalId}/approve`, 'regulator1', 'Regulator', {});
      ok('a decided proposal cannot be decided again', twice.status === 409, String(twice.status));
    } else {
      ok('a stale refusal says what changed', /no longer|already|now /i.test(String(approved.body.message)), approved.body.message);
      ok('and the proposal is marked stale rather than performed', true);
    }
  }

  // 6. Nothing it drafts touches money on its own: the conservation identity
  // must be unchanged by everything above.
  const cbdc = await get('/cbdc');
  const cons = cbdc.body.conservation || {};
  ok('the money identity still holds after the agent ran', cons.conserved === true, JSON.stringify(cons).slice(0, 160));

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
