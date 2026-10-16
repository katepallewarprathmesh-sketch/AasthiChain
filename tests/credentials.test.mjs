// End-to-end checks for verifiable credentials, through the Node proxy.
//
// The Go tests prove the signing, the anchoring and the refusals. These prove
// the parts only a real request can prove: that the proxy carries identity so
// authorisation is enforced, that a credential survives JSON transport intact,
// and that an independent verifier can check it with nothing but the document
// and the issuer's published key.
//
//   node tests/credentials.test.mjs          (BASE=http://localhost:8080)

import { createPublicKey, verify as edVerify } from 'node:crypto';

const BASE = process.env.BASE || 'http://localhost:8080';
let passed = 0, failed = 0;

function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failed++; console.log('  FAIL ' + name + (detail ? '\n       ' + detail : '')); }
}

const j = async (path, init) => {
  const r = await fetch(BASE + path, init);
  const text = await r.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, body };
};

const as = (id, role) => (path, payload) => j(path, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-Fabric-Identity': id,
    'X-Identity-Role': role,
  },
  body: JSON.stringify(payload || {}),
});

const asRegistrar = as('registrar1', 'Registrar');
const asInvestor = as('investor1', 'Investor');
const asRegulator = as('regulator1', 'Regulator');

// Rebuild the exact bytes the rail signed: the credential without its proof.
// If this does not reproduce them, the signature cannot be checked by anyone
// who did not issue it, which would make the whole feature decorative.
function unsignedBytes(cred) {
  const { proof, ...rest } = cred;
  return Buffer.from(JSON.stringify(rest));
}

// Node needs a DER SubjectPublicKeyInfo wrapper around a raw Ed25519 key.
function ed25519KeyFromHex(hex) {
  const der = Buffer.concat([
    Buffer.from('302a300506032b6570032100', 'hex'),
    Buffer.from(hex, 'hex'),
  ]);
  return createPublicKey({ key: der, format: 'der', type: 'spki' });
}

async function main() {
  console.log('\nVerifiable credentials: ' + BASE + '\n');

  const assetId = 'PROP-CRED-TEST-' + Date.now();

  // --- authorisation ------------------------------------------------------
  const anon = await j('/api/umi/credentials', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ subject: 'originator1', assetId }),
  });
  ok('an unidentified caller cannot issue', anon.status === 401 || anon.status === 403,
     `status ${anon.status}`);

  const byInvestor = await asInvestor('/api/umi/credentials', { subject: 'investor1', assetId });
  ok('an investor cannot issue a title credential', byInvestor.status === 403,
     `status ${byInvestor.status}: ${JSON.stringify(byInvestor.body).slice(0, 160)}`);

  // --- issuing ------------------------------------------------------------
  const issued = await asRegistrar('/api/umi/credentials', {
    subject: 'originator1',
    assetId,
    claims: { titleValidated: true, pincode: '411045' },
  });
  ok('a registrar can issue', issued.status === 201,
     `status ${issued.status}: ${JSON.stringify(issued.body).slice(0, 200)}`);

  const rec = issued.body && issued.body.credential;
  const cred = rec && rec.credential;
  ok('the credential carries an Ed25519 proof',
     !!(cred && cred.proof && cred.proof.type === 'Ed25519Signature2020' && cred.proof.proofValue));
  ok('it is anchored to a block', !!(rec && rec.hash && rec.issuedBlock > 0),
     rec ? `hash=${rec.hash} block=${rec.issuedBlock}` : 'no record');
  ok('the subject carries the simulation disclaimer',
     !!(cred && String(cred.credentialSubject.disclaimer || '').includes('not a government')),
     cred ? String(cred.credentialSubject.disclaimer).slice(0, 120) : '');

  // --- independent verification ------------------------------------------
  // This is the claim that matters: check the signature here, in this
  // process, using only the published key. No trust in the rail's answer.
  const issuerId = String(cred.issuer).replace('did:aasthi:', '');
  const keyRes = await j('/api/umi/credentials/issuers/' + issuerId);
  ok('the issuer publishes a public key', keyRes.status === 200 && /^[0-9a-f]{64}$/.test(keyRes.body.publicKey || ''),
     `status ${keyRes.status}`);
  ok('the key is disclosed as a public demo key', keyRes.body && keyRes.body.demoKey === true,
     JSON.stringify(keyRes.body && keyRes.body.demoKey));

  let localVerify = false;
  try {
    localVerify = edVerify(
      null,
      unsignedBytes(cred),
      ed25519KeyFromHex(keyRes.body.publicKey),
      Buffer.from(cred.proof.proofValue, 'base64url'),
    );
  } catch (e) {
    localVerify = 'threw: ' + e.message;
  }
  ok('the signature verifies in this process, without asking the rail', localVerify === true,
     'result: ' + localVerify);

  // --- the rail's own verification ---------------------------------------
  const verified = await j('/api/umi/credentials/' + encodeURIComponent(cred.id) + '/verify');
  ok('the rail verifies the stored copy',
     verified.status === 200 && verified.body.signatureValid === true && verified.body.anchorMatches === true,
     JSON.stringify(verified.body).slice(0, 200));

  const presented = await j('/api/umi/credentials/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ credential: cred }),
  });
  ok('a presented credential verifies after a round trip through JSON',
     presented.status === 200 && presented.body.signatureValid === true && presented.body.anchorMatches === true,
     JSON.stringify(presented.body).slice(0, 200));

  // --- tampering ----------------------------------------------------------
  const forged = JSON.parse(JSON.stringify(cred));
  forged.credentialSubject.titleValidated = false;
  const forgedRes = await j('/api/umi/credentials/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ credential: forged }),
  });
  ok('an altered claim fails verification',
     forgedRes.status === 200 && forgedRes.body.signatureValid === false,
     JSON.stringify(forgedRes.body).slice(0, 200));

  // --- revocation ---------------------------------------------------------
  const strangerRevoke = await asInvestor(
    '/api/umi/credentials/' + encodeURIComponent(cred.id) + '/revoke', { reason: 'mine now' });
  ok('a stranger cannot revoke', strangerRevoke.status === 403, `status ${strangerRevoke.status}`);

  const revoked = await asRegulator(
    '/api/umi/credentials/' + encodeURIComponent(cred.id) + '/revoke', { reason: 'title dispute' });
  ok('a supervisor can revoke', revoked.status === 200, `status ${revoked.status}`);

  const afterRevoke = await j('/api/umi/credentials/' + encodeURIComponent(cred.id) + '/verify');
  ok('after revocation the signature is still reported valid',
     afterRevoke.body && afterRevoke.body.signatureValid === true,
     JSON.stringify(afterRevoke.body).slice(0, 200));
  ok('and the credential is reported revoked, as a separate fact',
     afterRevoke.body && afterRevoke.body.revoked === true,
     JSON.stringify(afterRevoke.body).slice(0, 200));

  // --- listing and disclosure --------------------------------------------
  const list = await j('/api/umi/credentials?assetId=' + encodeURIComponent(assetId));
  ok('the credential is listed against its asset',
     list.status === 200 && Array.isArray(list.body.credentials) && list.body.credentials.length >= 1,
     `status ${list.status} count ${list.body && list.body.count}`);
  ok('the registry discloses that authority is simulated',
     !!(list.body && list.body.registry && /simulated/i.test(list.body.registry.disclosure || '')),
     JSON.stringify(list.body && list.body.registry).slice(0, 200));

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
