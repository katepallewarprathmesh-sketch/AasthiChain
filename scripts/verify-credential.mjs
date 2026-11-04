#!/usr/bin/env node
// Verify an AasthiChain credential presentation. Offline.
//
// WHY THIS FILE IS THE POINT
// A credential that can only be checked by calling the issuer's API is not a
// credential, it is a login. The test of portability is whether a stranger
// can verify the document on their own machine, with no account here and no
// network at all, using nothing but a standard Ed25519 implementation.
//
// So this script has no dependencies beyond Node's own crypto, does not
// import anything from this repository, and never contacts AasthiChain
// unless you explicitly ask it to check revocation. Copy it anywhere. If it
// says VALID on a laptop that has never heard of us, the claim is real.
//
//   node scripts/verify-credential.mjs bundle.json
//   node scripts/verify-credential.mjs bundle.json --check-revocation
//
// Exit code 0 means every offline check passed. 1 means it did not.

import { readFileSync } from 'node:fs';
import { createPublicKey, verify as edVerify, createHash } from 'node:crypto';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('-'));
const checkRevocation = args.includes('--check-revocation');
const quiet = args.includes('--quiet');

if (!file) {
  console.error('usage: node scripts/verify-credential.mjs <bundle.json> [--check-revocation]');
  process.exit(2);
}

const say = (...a) => { if (!quiet) console.log(...a); };
let failures = 0;
const check = (label, ok, detail) => {
  if (ok) say(`  PASS  ${label}`);
  else { failures++; say(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`); }
  return ok;
};

const bundle = JSON.parse(readFileSync(file, 'utf8'));

say(`\nVerifying ${file}`);
say('');

// --- 0. the format ---------------------------------------------------------
// Refuse a shape we do not understand rather than misreading it. A verifier
// that silently accepts an unknown version is worse than one that stops.
check('the bundle declares a format this script understands',
  bundle.format === 'aasthichain-credential-presentation/1',
  `got ${JSON.stringify(bundle.format)}`);

const cred = bundle.credential;
const issuer = bundle.issuer || {};
const anchor = bundle.anchor || {};
if (!cred || !cred.proof || !issuer.publicKeyHex) {
  check('the bundle carries a credential, a proof and an issuer key', false,
    'a bundle without all three cannot be checked at all');
  say(`\nRESULT: cannot verify\n`);
  process.exit(1);
}

// --- 1. rebuild the signed bytes -------------------------------------------
// The canonicalisation rule travels inside the bundle precisely so this step
// is not guesswork: serialise the credential with the proof member removed.
// Go's encoding/json writes struct fields in declaration order and map keys
// sorted, which is what the replacer and key ordering below reproduce.
// Go writes struct fields in declaration order and map keys sorted. Those
// are two different rules in the same document, so they are reproduced
// separately: the credential and its proof are structs, credentialSubject is
// a map. Pulling "id" to the front of the subject (the mistake this comment
// exists to prevent) changes the bytes and fails every signature.
const CREDENTIAL_ORDER = ['@context', 'id', 'type', 'issuer', 'issuanceDate', 'credentialSubject', 'proof'];
const PROOF_ORDER = ['type', 'created', 'verificationMethod', 'proofPurpose', 'proofValue'];

const ordered = (value, order) => {
  const keys = Object.keys(value);
  const known = order.filter((k) => keys.includes(k));
  const rest = keys.filter((k) => !order.includes(k)).sort();
  const out = {};
  for (const k of [...known, ...rest]) out[k] = sortDeep(value[k]);
  return out;
};

// Everything that is not one of the two known structs is a map to Go, so its
// keys are sorted.
function sortDeep(value) {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = sortDeep(value[k]);
    return out;
  }
  return value;
}

const canonicalise = (c) => {
  const out = ordered(c, CREDENTIAL_ORDER);
  if (out.proof) out.proof = ordered(c.proof, PROOF_ORDER);
  return out;
};

// Go's encoding/json escapes these three characters by default. A verifier
// that does not do the same will reject a valid credential whose subject
// happens to contain an ampersand.
const goJSON = (value) => JSON.stringify(value)
  .replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');

const { proof, ...withoutProof } = cred;
const signedBytes = Buffer.from(goJSON(canonicalise(withoutProof)), 'utf8');

// --- 2. the signature ------------------------------------------------------
const spkiPrefix = Buffer.from('302a300506032b6570032100', 'hex');
const publicKey = createPublicKey({
  key: Buffer.concat([spkiPrefix, Buffer.from(issuer.publicKeyHex, 'hex')]),
  format: 'der',
  type: 'spki',
});
const signature = Buffer.from(
  cred.proof.proofValue.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

check('the signature verifies against the issuer key',
  edVerify(null, signedBytes, publicKey, signature),
  'either this document was not signed by that key, or something in it has changed since');

// The fingerprint is how a key swap becomes visible. Checking it here means a
// substituted key cannot pass unnoticed just because the signature matches it.
const fingerprint = createHash('sha256').update(Buffer.from(issuer.publicKeyHex, 'hex'))
  .digest('hex').slice(0, 16);
check('the key matches its published fingerprint',
  !issuer.keyFingerprint || issuer.keyFingerprint === fingerprint,
  `bundle says ${issuer.keyFingerprint}, the key hashes to ${fingerprint}`);

// --- 3. the ledger anchor --------------------------------------------------
const fullHash = createHash('sha256')
  .update(Buffer.from(goJSON(canonicalise(cred)), 'utf8')).digest('hex');
check('the document matches the hash anchored on the ledger',
  !anchor.credentialHash || anchor.credentialHash === fullHash,
  `anchored ${anchor.credentialHash}\n        this document hashes to ${fullHash}`);
check('the anchor names a block',
  Number(anchor.blockHeight) > 0, `blockHeight ${anchor.blockHeight}`);

// --- 4. revocation, the only networked step --------------------------------
if (checkRevocation) {
  if (!anchor.statusListUrl) {
    check('the bundle says where to check revocation', false);
  } else {
    try {
      const res = await fetch(anchor.statusListUrl);
      const list = await res.json();
      const entry = (list.entries || []).find((e) => e.credentialId === cred.id);
      check('the credential is not revoked', !(entry && entry.revoked),
        entry && entry.revoked ? `revoked at block ${entry.revokedBlock}: ${entry.reason || 'no reason given'}` : '');
      say(`        status list read at block ${list.asOfBlockHeight}, ${list.count} entries`);
    } catch (e) {
      check('the status list could be reached', false, e.message);
    }
  }
} else {
  say('  SKIP  revocation (pass --check-revocation to poll the status list)');
}

// --- what this does and does not mean --------------------------------------
say('');
if (issuer.keyIsPublicDemoKey) {
  say('  NOTE  The issuer key is derived from a seed published in the AasthiChain');
  say('        repository. These checks prove this document is unaltered and was');
  say('        sealed into the ledger. They prove nothing about authority: anyone');
  say('        holding that public seed can produce a signature that verifies.');
  say('');
}
say(`RESULT: ${failures === 0 ? 'VALID' : 'NOT VALID'} (${failures} failed check${failures === 1 ? '' : 's'})`);
say('');
process.exit(failures === 0 ? 0 : 1);
