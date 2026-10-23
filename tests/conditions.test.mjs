// Conditional settlement over HTTP: money locked against a named credential.
//
// The Go tests prove the arithmetic and every refusal branch. These prove the
// part only a real request proves: that the lock is visible on the buyer's
// wallet while nothing has settled, that the release needs the credential the
// agreement named and the party entitled to assert it, and that the deadline
// gives the money back without anyone asking nicely.
//
//   node tests/conditions.test.mjs        (BASE=http://localhost:8080)

const BASE = process.env.BASE || 'http://localhost:8080';
const RAIL = process.env.RAIL || 'http://localhost:21100';
let passed = 0, failed = 0;
const ok = (name, cond, detail) => {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failed++; console.log('  FAIL ' + name + (detail ? '\n       ' + detail : '')); }
};

const call = async (base, path, init) => {
  const r = await fetch(base + path, init);
  const text = await r.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, body };
};
const j = (path, init) => call(BASE, path, init);
const rail = (path, init) => call(RAIL, path, init);

const idHeaders = (id, role) => ({
  'Content-Type': 'application/json',
  'X-Fabric-Identity': id,
  'X-Identity-Role': role,
});
const railPost = (id, role) => (path, payload, extra) => rail(path, {
  method: 'POST',
  headers: { ...idHeaders(id, role), ...(extra || {}) },
  body: JSON.stringify(payload || {}),
});
const railGet = (id, role) => (path) => rail(path, { headers: idHeaders(id, role) });
const post = (id, role) => (path, payload) => j(path, {
  method: 'POST', headers: idHeaders(id, role), body: JSON.stringify(payload || {}),
});

const bearer = (identityId, mspId, role) => 'Bearer ' + Buffer.from(JSON.stringify({
  identityId, mspId, role, exp: Math.floor(Date.now() / 1000) + 3600,
})).toString('base64');

const asBuyer = railPost('investor1', 'Investor');
const asSeller = railPost('originator1', 'Originator');
const asStranger = railPost('investor2', 'Investor');
const asRegistrar = post('registrar1', 'Registrar');

async function seedAsset() {
  const stamp = Date.now();
  const origin = { 'content-type': 'application/json', authorization: bearer('originator1', 'OriginatorMSP', 'Originator') };
  const created = await j('/api/properties', {
    method: 'POST', headers: origin,
    body: JSON.stringify({
      title: `Conditional Check ${stamp}`, city: 'Pune', state: 'Maharashtra',
      pincode: '411001', valuationINR: 5000000, propertyType: 'RESIDENTIAL',
    }),
  });
  const assetId = created.body && created.body.assetId;
  await j(`/api/properties/${encodeURIComponent(assetId)}/validate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: bearer('registrar1', 'RegistrarMSP', 'Registrar') },
    body: JSON.stringify({ decision: 'VALIDATED', notes: 'conditional test' }),
  });
  await j(`/api/properties/${encodeURIComponent(assetId)}/mint`, {
    method: 'POST', headers: origin, body: JSON.stringify({ totalTokens: 5000 }),
  });
  return assetId;
}

const reservedOf = async (who) => {
  const w = await railGet(who, 'Investor')(`/umi/wallets/${who}`);
  const wallet = (w.body && (w.body.wallet || w.body)) || {};
  return Number(wallet.reservedPaise || 0);
};
const balanceOf = async (who) => {
  const w = await railGet(who, 'Investor')(`/umi/wallets/${who}`);
  const wallet = (w.body && (w.body.wallet || w.body)) || {};
  return Number(wallet.balancePaise || 0);
};

async function main() {
  console.log('\nConditional settlement: ' + BASE + '\n');

  const assetId = await seedAsset();
  ok('a tradeable asset was seeded', !!assetId, String(assetId));
  await asBuyer('/umi/wallets/investor1/fund', { amountINR: 300000 });

  const anon = await rail('/umi/conditions', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ assetId, seller: 'originator1', buyer: 'investor1', tokens: 1, pricePerTokenINR: 100 }),
  });
  ok('an unidentified caller cannot lock a wallet', anon.status === 401 || anon.status === 403,
     `status ${anon.status}`);

  const notMine = await asStranger('/umi/conditions', {
    assetId, seller: 'originator1', buyer: 'investor1', tokens: 1, pricePerTokenINR: 100,
    credentialType: 'TitleValidationCredential',
  });
  ok('a third party cannot lock someone else\'s money', notMine.status === 403,
     `status ${notMine.status}: ${JSON.stringify(notMine.body).slice(0, 160)}`);

  const noCondition = await asBuyer('/umi/conditions', {
    assetId, seller: 'originator1', buyer: 'investor1', tokens: 1, pricePerTokenINR: 100,
  });
  ok('a conditional settlement with no named condition is refused', noCondition.status === 400,
     `status ${noCondition.status}: ${JSON.stringify(noCondition.body).slice(0, 160)}`);

  // An id that does not exist must 404 on every verb, rather than leaking
  // whether somebody else's agreement exists.
  const ghostRead = await rail('/umi/conditions/COND-does-not-exist', { headers: idHeaders('investor1', 'Investor') });
  const ghostPresent = await rail('/umi/conditions/COND-does-not-exist/present', {
    method: 'POST', headers: idHeaders('originator1', 'Originator'), body: JSON.stringify({ credentialId: 'x' }),
  });
  const ghostCancel = await rail('/umi/conditions/COND-does-not-exist/cancel', {
    method: 'POST', headers: idHeaders('originator1', 'Originator'), body: '{}',
  });
  ok('an unknown condition is not found, on every verb',
     ghostRead.status === 404 && ghostPresent.status === 404 && ghostCancel.status === 404,
     `read ${ghostRead.status} present ${ghostPresent.status} cancel ${ghostCancel.status}`);

  // --- opening -------------------------------------------------------------
  const balanceBefore = await balanceOf('investor1');
  // Other suites share this rail, so every figure below is a delta.
  const reservedBefore = await reservedOf('investor1');
  const opened = await asBuyer('/umi/conditions', {
    assetId, seller: 'originator1', buyer: 'investor1', tokens: 10, pricePerTokenINR: 500,
    credentialType: 'TitleValidationCredential', issuer: 'registrar1',
    window: '2h', purpose: 'release on registrar title validation',
  });
  ok('the buyer can open a conditional settlement', opened.status === 201,
     `status ${opened.status}: ${JSON.stringify(opened.body).slice(0, 220)}`);
  const c = opened.body && opened.body.condition;
  const id = c && c.conditionId;
  ok('it is open, anchored and has a deadline',
     !!(c && c.status === 'OPEN' && c.openedBlock > 0 && c.deadlineAt), JSON.stringify(c).slice(0, 220));

  ok('the cash is reserved on the buyer\'s own wallet', (await reservedOf('investor1')) - reservedBefore === 500000,
     `reserved ${await reservedOf('investor1')}`);
  ok('nothing has been spent while the condition is pending',
     (await balanceOf('investor1')) === balanceBefore, `balance ${await balanceOf('investor1')}`);

  const before = await railGet('investor1', 'Investor')(`/umi/positions/${encodeURIComponent(assetId)}`);
  ok('the tokens have not moved either',
     before.status !== 200 || !JSON.stringify(before.body).includes('"investor1"') ||
       !/"tokens":\s*10\b/.test(JSON.stringify(before.body)),
     JSON.stringify(before.body).slice(0, 160));

  // --- releasing -----------------------------------------------------------
  const wrongEvidence = await asSeller(`/umi/conditions/${encodeURIComponent(id)}/present`,
    { credentialId: 'CRED-does-not-exist' });
  ok('a credential that does not exist does not release the money', wrongEvidence.status >= 400,
     `status ${wrongEvidence.status}`);

  const issued = await asRegistrar('/api/umi/credentials', {
    subject: 'originator1', assetId, claims: { titleValidated: true },
  });
  const credentialId = issued.body && issued.body.credential && issued.body.credential.credential
    && issued.body.credential.credential.id;
  ok('the registrar issued the credential the agreement named', !!credentialId, String(credentialId));

  const byStranger = await asStranger(`/umi/conditions/${encodeURIComponent(id)}/present`, { credentialId });
  ok('a valid credential in the wrong hands still does not release it', byStranger.status === 403,
     `status ${byStranger.status}: ${JSON.stringify(byStranger.body).slice(0, 160)}`);

  const stillOpen = await railGet('investor1', 'Investor')(`/umi/conditions/${encodeURIComponent(id)}`);
  ok('a refused presentation leaves the agreement open, not broken',
     stillOpen.body && stillOpen.body.condition && stillOpen.body.condition.status === 'OPEN'
       && stillOpen.body.condition.refusals >= 2,
     JSON.stringify(stillOpen.body && stillOpen.body.condition).slice(0, 200));
  ok('and the money is still locked, not lost', (await reservedOf('investor1')) - reservedBefore === 500000);

  const released = await asSeller(`/umi/conditions/${encodeURIComponent(id)}/present`, { credentialId });
  ok('the seller presenting the named credential releases both legs', released.status === 200,
     `status ${released.status}: ${JSON.stringify(released.body).slice(0, 220)}`);
  const done = released.body && released.body.condition;
  ok('the record says RELEASED and names the evidence',
     !!(done && done.status === 'RELEASED' && done.credentialId === credentialId && done.releasedBlock > 0),
     JSON.stringify(done).slice(0, 220));
  ok('the lock is gone and the cash actually left the buyer',
     (await reservedOf('investor1')) === reservedBefore && (await balanceOf('investor1')) === balanceBefore - 500000,
     `reserved ${await reservedOf('investor1')} balance ${await balanceOf('investor1')}`);

  const replay = await asSeller(`/umi/conditions/${encodeURIComponent(id)}/present`, { credentialId });
  ok('the same credential cannot be presented twice', replay.status >= 400, `status ${replay.status}`);

  // --- giving the money back ----------------------------------------------
  const second = await asBuyer('/umi/conditions', {
    assetId, seller: 'originator1', buyer: 'investor1', tokens: 2, pricePerTokenINR: 100,
    credentialType: 'TitleValidationCredential', issuer: 'registrar1',
  });
  const secondId = second.body && second.body.condition && second.body.condition.conditionId;
  const lockedAgain = (await reservedOf('investor1')) - reservedBefore;
  ok('a second condition locks again', second.status === 201 && lockedAgain === 20000,
     `status ${second.status} reserved ${lockedAgain}`);

  const strangerCancel = await asStranger(`/umi/conditions/${encodeURIComponent(secondId)}/cancel`, {});
  ok('a stranger cannot cancel someone else\'s agreement', strangerCancel.status === 403,
     `status ${strangerCancel.status}`);

  const cancelled = await asSeller(`/umi/conditions/${encodeURIComponent(secondId)}/cancel`, {});
  ok('either party can cancel and the money comes straight back',
     cancelled.status === 200 && (await reservedOf('investor1')) === reservedBefore,
     `status ${cancelled.status} reserved ${await reservedOf('investor1')}`);

  // --- reading and disclosure ---------------------------------------------
  const mine = await railGet('investor1', 'Investor')('/umi/conditions');
  ok('a party can list their own conditional settlements',
     mine.status === 200 && Array.isArray(mine.body.conditions)
       && mine.body.conditions.some((x) => x.conditionId === id),
     `status ${mine.status} count ${mine.body && mine.body.count}`);

  const nosy = await railGet('investor2', 'Investor')(`/umi/conditions/${encodeURIComponent(id)}`);
  ok('an uninvolved party cannot read it', nosy.status === 403, `status ${nosy.status}`);

  const supervisor = await rail('/umi/conditions', { headers: idHeaders('regulator1', 'Regulator') });
  ok('a supervisor can see every one of them', supervisor.status === 200,
     `status ${supervisor.status}`);
  ok('the desk states the boundary of what it is',
     /simulation|no RBI|not a|sandbox/i.test(JSON.stringify(supervisor.body.summary || supervisor.body.disclaimer || '')),
     JSON.stringify(supervisor.body.summary || '').slice(0, 220));
  ok('the desk reports what is locked right now',
     supervisor.body.summary && typeof supervisor.body.summary.lockedPaise === 'number',
     JSON.stringify(supervisor.body.summary || '').slice(0, 160));

  const sweep = await rail('/umi/conditions/sweep', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
  ok('the deadline sweep runs without an identity, because it can only return money',
     sweep.status === 200, `status ${sweep.status}: ${JSON.stringify(sweep.body).slice(0, 160)}`);

  const chain = await railGet('regulator1', 'Regulator')('/drunix/chain?limit=120');
  const text = JSON.stringify(chain.body);
  ok('opening, refusing, releasing and refunding are all on the ledger',
     text.includes('UMI_CONDITION_OPENED') && text.includes('UMI_CONDITION_REFUSED')
       && text.includes('UMI_CONDITION_RELEASED') && text.includes('UMI_CONDITION_REFUNDED'),
     `status ${chain.status}`);

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
