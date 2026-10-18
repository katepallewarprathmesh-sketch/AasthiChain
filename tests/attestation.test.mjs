// End-to-end checks for attestation accountability.
//
// Minting a token is the easy part. The chain that matters runs upstream:
// real asset, attestation, credential, token. These checks prove the join is
// real: that a holder can ask who vouched for the asset they bought, that
// withdrawing the attestation names the people who were exposed at that
// moment, and that it does not quietly reverse anything.
//
//   node tests/attestation.test.mjs          (BASE=http://localhost:8080)

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

const idHeaders = (id, role) => ({
  'Content-Type': 'application/json', 'X-Fabric-Identity': id, 'X-Identity-Role': role,
});
const railPost = (id, role) => (path, payload) => rail(path, {
  method: 'POST', headers: idHeaders(id, role), body: JSON.stringify(payload || {}),
});
const bearer = (identityId, mspId, role) => 'Bearer ' + Buffer.from(JSON.stringify({
  identityId, mspId, role, exp: Math.floor(Date.now() / 1000) + 3600,
})).toString('base64');

const asRegistrar = railPost('registrar1', 'Registrar');
const asInvestor = railPost('investor1', 'Investor');

async function seedAsset() {
  const stamp = Date.now();
  const origin = { 'content-type': 'application/json', authorization: bearer('originator1', 'OriginatorMSP', 'Originator') };
  const created = await app('/api/properties', {
    method: 'POST', headers: origin,
    body: JSON.stringify({
      title: `Attestation Check ${stamp}`, city: 'Pune', state: 'Maharashtra',
      pincode: '411001', valuationINR: 5000000, propertyType: 'RESIDENTIAL',
    }),
  });
  const assetId = created.body && created.body.assetId;
  await app(`/api/properties/${encodeURIComponent(assetId)}/validate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: bearer('registrar1', 'RegistrarMSP', 'Registrar') },
    body: JSON.stringify({ decision: 'VALIDATED', notes: 'attestation test' }),
  });
  await app(`/api/properties/${encodeURIComponent(assetId)}/mint`, {
    method: 'POST', headers: origin, body: JSON.stringify({ totalTokens: 5000 }),
  });
  return assetId;
}

async function main() {
  console.log('\nAttestation accountability: ' + BASE + '\n');

  const assetId = await seedAsset();
  ok('a tradeable asset was seeded', !!assetId, String(assetId));

  const intro = await rail('/umi/attestations');
  ok('the layer states the chain it is about',
     intro.status === 200 && Array.isArray(intro.body.chain) && intro.body.chain.includes('attestation'),
     `status ${intro.status}`);

  // --- attest, then trade on it -------------------------------------------
  const issued = await asRegistrar('/umi/credentials', {
    subject: 'originator1', assetId, claims: { titleValidated: true },
  });
  ok('a registrar attests the asset', issued.status === 201, `status ${issued.status}`);
  const credId = issued.body.credential.credential.id;

  await asInvestor('/umi/wallets/investor1/fund', { amountINR: 200000 });
  const settled = await asInvestor('/umi/dvp', {
    assetId, seller: 'originator1', buyer: 'investor1', tokens: 50, pricePerTokenINR: 100,
  });
  ok('a trade settles against the attested asset', settled.status === 200 && settled.body.ok === true,
     `status ${settled.status}: ${String(JSON.stringify(settled.body)).slice(0, 160)}`);

  // --- what rests on it ----------------------------------------------------
  const impact = await rail('/umi/attestations/' + encodeURIComponent(credId));
  const im = impact.body && impact.body.impact;
  ok('a holder can ask what rests on the attestation', impact.status === 200 && !!im,
     `status ${impact.status}`);
  ok('it names the attestor', im && im.attestor === 'registrar1', im && im.attestor);
  ok('it names the holders downstream',
     !!(im && im.holderCount >= 2 && im.tokensOutstanding === 5000),
     im && `${im.holderCount} holders, ${im.tokensOutstanding} tokens`);
  ok('it counts the trade that relied on it',
     !!(im && im.tradeCount >= 1 && im.valueSettledPaiseWhileStanding >= 500000),
     im && `${im.tradeCount} trades, ${im.valueSettledPaiseWhileStanding} paise`);
  ok('it spells out what the attestor actually vouched for',
     !!(im && /title record/i.test(im.accountability)), im && String(im.accountability).slice(0, 120));
  ok('it does not claim a recourse that does not exist',
     !!(im && /none is implemented/i.test(im.recourse)), im && String(im.recourse).slice(0, 120));

  const unknown = await rail('/umi/attestations/urn:aasthi:credential:doesnotexist');
  ok('an unknown attestation is a 404, not an empty answer', unknown.status === 404,
     `status ${unknown.status}`);

  // --- the attestor's record ----------------------------------------------
  const before = await rail('/umi/attestors/registrar1');
  ok('an attestor has a readable record',
     before.status === 200 && before.body.attestor.issued >= 1,
     `status ${before.status}`);
  ok('the record publishes the key its signatures can be checked with',
     /^[0-9a-f]{64}$/.test((before.body.attestor || {}).publicKey || ''));

  // --- withdrawal ----------------------------------------------------------
  const withdrawn = await asRegistrar(`/umi/credentials/${encodeURIComponent(credId)}/revoke`, {
    reason: 'a later survey showed a boundary dispute',
  });
  ok('the attestor can withdraw the attestation', withdrawn.status === 200, `status ${withdrawn.status}`);
  ok('withdrawing it names the exposure at that moment',
     !!(withdrawn.body.impact && withdrawn.body.impact.holderCount >= 2 && withdrawn.body.noticeBlock > 0),
     String(JSON.stringify(withdrawn.body.impact)).slice(0, 200));

  // The failure that would matter most: a notice that behaves like a seizure.
  const reread = await rail('/umi/attestations/' + encodeURIComponent(credId));
  const held = ((reread.body.impact || {}).holders || []).find((h) => h.holder === 'investor1');
  ok('the holder still holds their tokens: a notice is not a reversal',
     !!(held && held.tokens === 50), JSON.stringify(held));

  const chain = await rail('/drunix/chain?limit=100');
  ok('the withdrawal notice is on the ledger',
     chain.status === 200 && JSON.stringify(chain.body).includes('UMI_ATTESTATION_WITHDRAWN'));
  ok('the notice says plainly that nothing was reversed',
     JSON.stringify(chain.body).includes('No settled trade is reversed'));

  const after = await rail('/umi/attestors/registrar1');
  ok('the withdrawal shows up in the attestor record',
     after.body.attestor.withdrawn > before.body.attestor.withdrawn,
     `${before.body.attestor.withdrawn} then ${after.body.attestor.withdrawn}`);
  ok('the record does not pretend the rail enforces a penalty',
     /does not enforce/i.test(after.body.attestor.accountability || ''));

  // Verification still has to report the signature and the withdrawal apart.
  const verify = await rail('/umi/credentials/' + encodeURIComponent(credId) + '/verify');
  ok('the signature is still valid after withdrawal, and the two facts stay separate',
     verify.status === 200 && verify.body.signatureValid === true && verify.body.revoked === true,
     String(JSON.stringify(verify.body)).slice(0, 200));

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
