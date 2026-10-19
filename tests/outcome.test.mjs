// Outcome-based settlement over HTTP.
//
// Billing for effort breaks once the work is done by something fast, and
// outcome pricing only works if somebody can check the outcome without an
// argument. These checks prove the whole path end to end: terms fixed when
// the engagement opens, money escrowed, release only through a named
// verifier, and a dispute window that the clock, not goodwill, closes.
//
//   node tests/outcome.test.mjs              (RAIL=http://localhost:21100)

const RAIL = process.env.RAIL || 'http://localhost:21100';
let passed = 0, failed = 0;
const ok = (name, cond, detail) => {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failed++; console.log('  FAIL ' + name + (detail ? '\n       ' + detail : '')); }
};

const call = async (path, init) => {
  const r = await fetch(RAIL + path, init);
  const text = await r.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, body };
};
const idHeaders = (id, role) => ({
  'Content-Type': 'application/json', 'X-Fabric-Identity': id, 'X-Identity-Role': role,
});
const post = (id, role) => (path, payload) => call(path, {
  method: 'POST', headers: idHeaders(id, role), body: JSON.stringify(payload || {}),
});

const asFunder = post('investor1', 'Investor');
const asWorker = post('originator1', 'Originator');
const asVerifier = post('registrar1', 'Registrar');
const asStranger = post('investor2', 'Investor');

async function openOrder(overrides) {
  await asFunder('/umi/wallets/investor1/fund', { amountINR: 50000 });
  const created = await asFunder('/umi/work', Object.assign({
    assetId: 'PROP-OUTCOME-HTTP',
    title: 'Structural survey',
    spec: 'Visit the site and sign off the load calculations.',
    category: 'INSPECTION',
    feeINR: 2500,
    funder: 'investor1',
    verifier: 'registrar1',
    checks: [
      { name: 'site-visit-evidence', required: true },
      { name: 'report-signed-off', required: true },
    ],
    disputeWindow: '1s',
  }, overrides || {}));
  return created;
}

async function main() {
  console.log('\nOutcome-based settlement\n');

  const created = await openOrder();
  ok('an order can be opened with acceptance criteria attached',
     created.status === 200 || created.status === 201,
     JSON.stringify(created.body).slice(0, 220));
  const order = created.body.order || created.body;
  const id = order.orderId || order.OrderID;
  ok('the agreed terms come back on the order',
     !!(order.outcome && order.outcome.verifier === 'registrar1' && (order.outcome.checks || []).length === 2),
     JSON.stringify(order.outcome).slice(0, 220));

  const noVerifier = await openOrder({ checks: [{ name: 'x', required: true }], verifier: '' });
  ok('criteria without a named verifier are refused',
     noVerifier.status >= 400, String(noVerifier.status));

  await asFunder('/umi/work/' + id + '/fund', {});
  const assigned = await asFunder('/umi/work/' + id + '/assign', { worker: 'originator1' });
  ok('the order can be funded and assigned', assigned.status === 200,
     JSON.stringify(assigned.body).slice(0, 200));

  // Nothing to verify before the work is handed in.
  const early = await asVerifier('/umi/work/' + id + '/check', { check: 'site-visit-evidence', passed: true });
  ok('a check cannot be recorded before anything is delivered', early.status >= 400, String(early.status));

  const hash = 'b'.repeat(64);
  const submitted = await asWorker('/umi/work/' + id + '/submit', {
    deliverableHash: hash, deliverableUri: 'ipfs://survey', note: 'report attached',
  });
  ok('the worker can hand in the deliverable', submitted.status === 200,
     JSON.stringify(submitted.body).slice(0, 200));

  const byWorker = await asWorker('/umi/work/' + id + '/check', { check: 'site-visit-evidence', passed: true });
  ok('the worker cannot mark its own work as verified', byWorker.status === 403, String(byWorker.status));
  const byStranger = await asStranger('/umi/work/' + id + '/check', { check: 'site-visit-evidence', passed: true });
  ok('a bystander cannot record a check', byStranger.status === 403, String(byStranger.status));
  const byFunder = await asFunder('/umi/work/' + id + '/check', { check: 'site-visit-evidence', passed: true });
  ok('the funder cannot record its own verdict either', byFunder.status === 403, String(byFunder.status));

  const first = await asVerifier('/umi/work/' + id + '/check', {
    check: 'site-visit-evidence', passed: true, evidence: hash,
  });
  ok('the named verifier can record a check', first.status === 200,
     JSON.stringify(first.body).slice(0, 200));
  ok('one of two required checks does not verify the order',
     (first.body.order || first.body).status === 'SUBMITTED',
     (first.body.order || first.body).status);

  const second = await asVerifier('/umi/work/' + id + '/check', { check: 'report-signed-off', passed: true });
  const verified = second.body.order || second.body;
  ok('all required checks passing moves the order to VERIFIED', verified.status === 'VERIFIED', verified.status);
  ok('verification does not release the money on its own', verified.escrowed === true,
     JSON.stringify(verified.outcome).slice(0, 220));

  const earlyPull = await asStranger('/umi/work/' + id + '/finalise', {});
  ok('nobody can pull the payment forward while the window is open',
     earlyPull.status === 409, String(earlyPull.status));

  await new Promise((r) => setTimeout(r, 1500));
  const released = await asStranger('/umi/work/' + id + '/finalise', {});
  const done = released.body.order || released.body;
  ok('once the window closes the release goes through', released.status === 200 && done.escrowed === false,
     JSON.stringify(done).slice(0, 220));
  ok('the record says why the money moved',
     !!(done.outcome && done.outcome.releaseTrigger), JSON.stringify(done.outcome).slice(0, 220));

  const chain = await call('/drunix/chain?limit=200');
  const text = JSON.stringify(chain.body);
  ok('the verification is on the ledger', text.includes('WORK_CHECK_RECORDED') && text.includes('WORK_VERIFIED'));
  ok('the release is on the ledger', text.includes('WORK_FINALISED'));

  // A failed required check must freeze rather than pay.
  const bad = await openOrder({ title: 'Second survey' });
  const badOrder = bad.body.order || bad.body;
  const badId = badOrder.orderId || badOrder.OrderID;
  await asFunder('/umi/work/' + badId + '/fund', {});
  await asFunder('/umi/work/' + badId + '/assign', { worker: 'originator1' });
  await asWorker('/umi/work/' + badId + '/submit', { deliverableHash: 'c'.repeat(64) });
  const failedCheck = await asVerifier('/umi/work/' + badId + '/check', {
    check: 'report-signed-off', passed: false, detail: 'no load calculations',
  });
  const frozen = failedCheck.body.order || failedCheck.body;
  ok('a failed required check disputes the order instead of paying',
     frozen.status === 'DISPUTED' && frozen.escrowed === true, JSON.stringify(frozen.status));
  const forced = await asFunder('/umi/work/' + badId + '/accept', { note: 'pay anyway' });
  ok('the funder cannot accept around a failed check', forced.status >= 400, String(forced.status));

  const index = await call('/umi/work', { headers: idHeaders('investor1', 'Investor') });
  const summary = (index.body || {}).outcome || {};
  ok('the index reports the outcome layer honestly',
     typeof summary.ordersWithOutcomeTerms === 'number' && /not an adjudicator/i.test(summary.disclaimer || ''),
     JSON.stringify(summary).slice(0, 220));

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
