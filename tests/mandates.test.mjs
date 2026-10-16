// End-to-end checks for delegated authority: an agent settling for a human.
//
// The Go tests prove the bounds and the arithmetic. These prove the part only
// a real request proves: that the mandate is what lets an agent spend someone
// else's wallet, that it spends no more than it was given, and that pulling
// the mandate stops it mid-stream.
//
//   node tests/mandates.test.mjs          (BASE=http://localhost:8080)

const BASE = process.env.BASE || 'http://localhost:8080';
// Agent calls go straight to the Go rail. The web proxy only knows the five
// named demo identities and files anything else as investor1, so an agent
// identity cannot survive the hop; the rail is where the mandate is enforced
// anyway, and that is what these checks are about.
const RAIL = process.env.RAIL || 'http://localhost:21100';
let passed = 0, failed = 0;
const ok = (name, cond, detail) => {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failed++; console.log('  FAIL ' + name + (detail ? '\n       ' + detail : '')); }
};

const j = async (path, init) => {
  const r = await fetch(BASE + path, init);
  const text = await r.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, body };
};

const idHeaders = (id, role) => ({
  'Content-Type': 'application/json',
  'X-Fabric-Identity': id,
  'X-Identity-Role': role,
});
const rail = async (path, init) => {
  const r = await fetch(RAIL + path, init);
  const text = await r.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, body };
};

const railPost = (id, role) => (path, payload, extra) => rail(path, {
  method: 'POST',
  headers: { ...idHeaders(id, role), ...(extra || {}) },
  body: JSON.stringify(payload || {}),
});
const railGet = (id, role) => (path) => rail(path, { headers: idHeaders(id, role) });

const post = (id, role) => (path, payload, extra) => j(path, {
  method: 'POST',
  headers: { ...idHeaders(id, role), ...(extra || {}) },
  body: JSON.stringify(payload || {}),
});
const get = (id, role) => (path) => j(path, { headers: idHeaders(id, role) });

const bearer = (identityId, mspId, role) => 'Bearer ' + Buffer.from(JSON.stringify({
  identityId, mspId, role, exp: Math.floor(Date.now() / 1000) + 3600,
})).toString('base64');

const asInvestor = railPost('investor1', 'Investor');
const asAgent = railPost('agent:test-desk', 'Investor');

const AGENT = 'agent:test-desk';

async function seedAsset() {
  const stamp = Date.now();
  const origin = { 'content-type': 'application/json', authorization: bearer('originator1', 'OriginatorMSP', 'Originator') };
  const created = await j('/api/properties', {
    method: 'POST', headers: origin,
    body: JSON.stringify({
      title: `Mandate Check ${stamp}`, city: 'Pune', state: 'Maharashtra',
      pincode: '411001', valuationINR: 5000000, propertyType: 'RESIDENTIAL',
    }),
  });
  const assetId = created.body && created.body.assetId;
  await j(`/api/properties/${encodeURIComponent(assetId)}/validate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: bearer('registrar1', 'RegistrarMSP', 'Registrar') },
    body: JSON.stringify({ decision: 'VALIDATED', notes: 'mandate test' }),
  });
  await j(`/api/properties/${encodeURIComponent(assetId)}/mint`, {
    method: 'POST', headers: origin, body: JSON.stringify({ totalTokens: 5000 }),
  });
  return assetId;
}

async function main() {
  console.log('\nDelegated authority for agents: ' + BASE + '\n');

  const assetId = await seedAsset();
  ok('a tradeable asset was seeded', !!assetId, String(assetId));
  await asInvestor('/umi/wallets/investor1/fund', { amountINR: 200000 });

  // --- granting ------------------------------------------------------------
  const anon = await rail('/umi/mandates', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent: AGENT, actions: ['SETTLE_DVP'], limitINR: 1000 }),
  });
  ok('an unidentified caller cannot grant authority', anon.status === 401 || anon.status === 403,
     `status ${anon.status}`);

  const granted = await asInvestor('/umi/mandates', {
    agent: AGENT,
    actions: ['SETTLE_DVP'],
    limitINR: 10000,
    assets: [assetId],
    purpose: 'rebalance the test desk',
  });
  ok('an investor can grant an agent bounded authority', granted.status === 201,
     `status ${granted.status}: ${JSON.stringify(granted.body).slice(0, 200)}`);
  const m = granted.body && granted.body.mandate;
  ok('the principal is the caller, not the body', m && m.principal === 'investor1',
     m && m.principal);
  ok('the grant is anchored to a block', !!(m && m.grantedBlock > 0), m && String(m.grantedBlock));
  ok('it has a hard expiry', !!(m && m.expiresAt), m && m.expiresAt);
  ok('it is mirrored as a signed credential the agent can present',
     !!(m && m.credentialId), m && m.credentialId);

  // A body-supplied principal must not be honoured: that would be the whole
  // feature backwards, an agent writing itself a cheque on another wallet.
  const spoof = await asAgent('/umi/mandates', {
    principal: 'investor1', agent: AGENT, actions: ['SETTLE_DVP'], limitINR: 999999,
  });
  ok('an agent cannot grant itself authority over another wallet',
     spoof.status !== 201 || (spoof.body.mandate && spoof.body.mandate.principal === AGENT),
     `status ${spoof.status}: ${JSON.stringify(spoof.body).slice(0, 160)}`);

  const id = m.mandateId;
  const mandateHeader = { 'X-Agent-Mandate': id };

  // --- the settlement path -------------------------------------------------
  const noMandate = await asAgent('/umi/dvp', {
    assetId, seller: 'originator1', buyer: 'investor1', tokens: 1, pricePerTokenINR: 100,
  });
  ok('without a mandate the agent cannot spend the investor wallet',
     noMandate.status === 403, `status ${noMandate.status}: ${JSON.stringify(noMandate.body).slice(0, 160)}`);

  const settled = await asAgent('/umi/dvp', {
    assetId, seller: 'originator1', buyer: 'investor1', tokens: 10, pricePerTokenINR: 100,
  }, mandateHeader);
  ok('with a mandate the same request settles', settled.status === 200 && settled.body.ok === true,
     `status ${settled.status}: ${JSON.stringify(settled.body).slice(0, 200)}`);
  ok('the response reports what is left of the budget',
     !!(settled.body && settled.body.mandate && settled.body.mandate.spentPaise === 100000),
     String(JSON.stringify(settled.body && settled.body.mandate)).slice(0, 200));

  const wrongAsset = await asAgent('/umi/dvp', {
    assetId: 'PROP-NOT-IN-MANDATE', seller: 'originator1', buyer: 'investor1',
    tokens: 1, pricePerTokenINR: 100,
  }, mandateHeader);
  ok('the mandate does not reach an asset it does not name',
     wrongAsset.status === 403 && wrongAsset.body.error === 'ERR_UMI_MANDATE_ASSET',
     `status ${wrongAsset.status}: ${JSON.stringify(wrongAsset.body).slice(0, 160)}`);

  const overBudget = await asAgent('/umi/dvp', {
    assetId, seller: 'originator1', buyer: 'investor1', tokens: 100, pricePerTokenINR: 500,
  }, mandateHeader);
  ok('a trade past the limit is refused before any money moves',
     overBudget.status === 403 && overBudget.body.error === 'ERR_UMI_MANDATE_LIMIT',
     `status ${overBudget.status}: ${JSON.stringify(overBudget.body).slice(0, 160)}`);

  const otherPrincipal = await asAgent('/umi/dvp', {
    assetId, seller: 'originator1', buyer: 'investor2', tokens: 1, pricePerTokenINR: 100,
  }, mandateHeader);
  ok('the mandate cannot be turned on a third party wallet',
     otherPrincipal.status === 403,
     `status ${otherPrincipal.status}: ${JSON.stringify(otherPrincipal.body).slice(0, 160)}`);

  const bogus = await asAgent('/umi/dvp', {
    assetId, seller: 'originator1', buyer: 'investor1', tokens: 1, pricePerTokenINR: 100,
  }, { 'X-Agent-Mandate': 'MANDATE-0-nobody' });
  ok('an invented mandate id is refused rather than ignored', bogus.status === 404 || bogus.status === 403,
     `status ${bogus.status}`);

  // --- withdrawal ----------------------------------------------------------
  const agentRevoke = await asAgent(`/umi/mandates/${encodeURIComponent(id)}/revoke`, {});
  ok('an agent cannot revoke the mandate it acts under', agentRevoke.status === 403,
     `status ${agentRevoke.status}`);

  const revoked = await asInvestor(`/umi/mandates/${encodeURIComponent(id)}/revoke`, {});
  ok('the principal can withdraw authority', revoked.status === 200,
     `status ${revoked.status}: ${JSON.stringify(revoked.body).slice(0, 160)}`);

  const afterRevoke = await asAgent('/umi/dvp', {
    assetId, seller: 'originator1', buyer: 'investor1', tokens: 1, pricePerTokenINR: 100,
  }, mandateHeader);
  ok('the next action under it is refused immediately',
     afterRevoke.status === 403 && afterRevoke.body.error === 'ERR_UMI_MANDATE_REVOKED',
     `status ${afterRevoke.status}: ${JSON.stringify(afterRevoke.body).slice(0, 160)}`);

  // --- reading -------------------------------------------------------------
  const mine = await railGet('investor1', 'Investor')('/umi/mandates');
  ok('a principal can read the grants made from their own wallet',
     mine.status === 200 && Array.isArray(mine.body.mandates) && mine.body.mandates.some((x) => x.mandateId === id),
     `status ${mine.status} count ${mine.body && mine.body.count}`);

  const nosy = await railGet('investor2', 'Investor')(`/umi/mandates/${encodeURIComponent(id)}`);
  ok('an uninvolved party cannot read someone else\'s mandate', nosy.status === 403,
     `status ${nosy.status}`);

  ok('the registry discloses that nothing autonomous actually runs here',
     !!(mine.body && /no autonomous agent/i.test(JSON.stringify(mine.body.registry || mine.body.disclaimer || ''))),
     JSON.stringify(mine.body && mine.body.registry).slice(0, 200));

  // The spend has to be attributable on the ledger, not just in memory.
  const used = await railGet('regulator1', 'Regulator')('/drunix/chain?limit=100');
  ok('the agent action is recorded on the ledger',
     used.status === 200 && JSON.stringify(used.body).includes(id),
     `status ${used.status}`);

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
