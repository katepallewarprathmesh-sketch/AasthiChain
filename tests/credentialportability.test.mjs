// Can a stranger verify one of our credentials without us?
//
// WHAT THIS GUARDS
// The registry has always signed credentials and anchored their hashes. That
// is worth nothing on its own: if verification requires calling our API, the
// credential is a login, and a holder arriving at a second venue re-onboards
// exactly as they would have with no credential at all. The feature is the
// portability, not the signature.
//
// So this suite does the thing a second venue would do. It downloads a
// presentation bundle, runs scripts/verify-credential.mjs as a separate
// process with no access to anything of ours beyond that one file, and
// insists the verifier says VALID. Then it tampers with one character of the
// document and insists the same script says NOT VALID, because a verifier
// that accepts everything is not a verifier.
//
// The revocation list is checked the same way: it is the one fact a bundle
// cannot carry, so a revoked credential must still verify cryptographically
// and must still be refused by the list.
//
//   node tests/credentialportability.test.mjs      (API=http://localhost:8080)

import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const API = process.env.API || 'http://localhost:8080';
const VERIFIER = new URL('../scripts/verify-credential.mjs', import.meta.url).pathname;

let pass = 0, fail = 0;
const t = (name, ok, detail) => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ''}`); }
};

const tokenFor = (identityId, role, mspId) =>
  Buffer.from(JSON.stringify({ identityId, mspId, role, exp: Date.now() + 3600000 })).toString('base64');
const REGISTRAR = tokenFor('registrar1', 'Registrar', 'RegistrarMSP');
const INVESTOR = tokenFor('investor2', 'Investor', 'InvestorMSP');

async function call(path, token, init = {}) {
  const headers = { 'Content-Type': 'application/json', ...(init.headers || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(API + path, { ...init, headers });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: res.status, body, text, headers: res.headers };
}

// Named get/post wrappers rather than bare call(): the coverage census reads
// suite sources to work out which rail actions are exercised, and it can only
// see a method it can name.
const get = (path, token) => call(path, token);
const post = (path, token, payload) =>
  call(path, token, { method: 'POST', body: JSON.stringify(payload) });

// Run the verifier as a child process. Nothing of ours is in scope for it
// beyond the bundle file, which is the whole point.
const verify = (file, extra = []) => {
  try {
    const out = execFileSync('node', [VERIFIER, file, ...extra], { encoding: 'utf8' });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status ?? 1, out: (e.stdout || '') + (e.stderr || '') };
  }
};

console.log(`Credential portability (${API})`);

const health = await get('/api/umi/credentials', REGISTRAR);
if (health.status === 503) {
  console.log('  rail unreachable, skipping');
  console.log('\n0 passed, 0 failed');
  process.exit(0);
}

const dir = mkdtempSync(join(tmpdir(), 'cred-'));
const tag = randomBytes(3).toString('hex');

// --- issue --------------------------------------------------------------
const issued = await post('/api/umi/credentials', REGISTRAR, {
  type: 'TitleValidationCredential',
  subject: `holder-${tag}`,
  assetId: 'PROP-GREEN-VALLEY-PUNE-001',
  claims: { surveyNumber: `42/${tag}` },
});
t('a registrar can issue a credential', issued.status === 200 || issued.status === 201,
  `got ${issued.status}`);
const rec = issued.body && (issued.body.record || issued.body.credential);
const id = rec && rec.credential && rec.credential.id;
t('the issued credential has an id', Boolean(id));
if (!id) { console.log(`\n  ${pass}/${pass + fail} passed`); process.exit(1); }

// --- the bundle ---------------------------------------------------------
const bundleRes = await get(`/api/umi/credentials/${encodeURIComponent(id)}/presentation`, null);
t('the presentation bundle is public, as a verifiable credential must be',
  bundleRes.status === 200, `got ${bundleRes.status}`);
const bundle = bundleRes.body;
t('the bundle declares its format', bundle && bundle.format === 'aasthichain-credential-presentation/1');
t('the bundle carries the issuer public key and fingerprint',
  Boolean(bundle && bundle.issuer && bundle.issuer.publicKeyHex && bundle.issuer.keyFingerprint));
t('the bundle carries the ledger anchor and its block',
  Boolean(bundle && bundle.anchor && bundle.anchor.credentialHash && bundle.anchor.blockHeight > 0));
t('the bundle states the canonicalisation rule, so a verifier need not guess',
  Boolean(bundle && bundle.canonicalisation && bundle.canonicalisation.signedOver));
t('the bundle points at the revocation list',
  Boolean(bundle && bundle.anchor && /\/credentials\/status$/.test(bundle.anchor.statusListUrl || '')));
t('the bundle says what it cannot prove',
  Array.isArray(bundle && bundle.whatThisDoesNotProve) && bundle.whatThisDoesNotProve.length >= 2);
t('the demo key carries its caveat inside the bundle, not only in the docs',
  !bundle.issuer.keyIsPublicDemoKey || /proves integrity/i.test(bundle.issuer.keyCaveat || ''));

// --- the actual claim: verify it with no network ------------------------
const file = join(dir, 'bundle.json');
writeFileSync(file, JSON.stringify(bundle));
const clean = verify(file);
t('the offline verifier accepts a genuine bundle', clean.code === 0,
  clean.out.split('\n').filter(l => /FAIL/.test(l)).join('\n       '));
t('the verifier reports every offline check', /signature verifies/.test(clean.out) &&
  /anchored on the ledger/.test(clean.out));
t('the verifier skips revocation unless asked, so it works with no network',
  /SKIP\s+revocation/.test(clean.out));

// --- and rejects a forgery ----------------------------------------------
const tampered = JSON.parse(JSON.stringify(bundle));
tampered.credential.credentialSubject.surveyNumber = 'not-the-number-that-was-signed';
const tamperedFile = join(dir, 'tampered.json');
writeFileSync(tamperedFile, JSON.stringify(tampered));
const forged = verify(tamperedFile);
t('the offline verifier rejects an altered document', forged.code !== 0);
t('it says which check failed rather than only that something is wrong',
  /FAIL\s+the signature verifies/.test(forged.out));

// A substituted key must not pass just because the signature matches it.
const swapped = JSON.parse(JSON.stringify(bundle));
swapped.issuer.keyFingerprint = '0000000000000000';
const swappedFile = join(dir, 'swapped.json');
writeFileSync(swappedFile, JSON.stringify(swapped));
t('a key that does not match its fingerprint is refused', verify(swappedFile).code !== 0);

// --- the status list ----------------------------------------------------
const list = await get('/api/umi/credentials/status', null);
t('the status list is public', list.status === 200, `got ${list.status}`);
t('the status list declares its format and the height it was read at',
  Boolean(list.body && list.body.format === 'aasthichain-credential-status/1' && list.body.asOfBlockHeight > 0));
t('the status list is a whole list, not a per-credential lookup',
  Array.isArray(list.body && list.body.entries) && list.body.count === list.body.entries.length);
t('the new credential appears in it, not revoked',
  Boolean((list.body.entries || []).find(e => e.credentialId === id && e.revoked === false)));

// --- revocation ---------------------------------------------------------
const byStranger = await post(`/api/umi/credentials/${encodeURIComponent(id)}/revoke`, INVESTOR,
  { reason: 'not mine to revoke' });
t('a stranger cannot revoke someone else\'s credential', byStranger.status === 403,
  `got ${byStranger.status}`);

const revoked = await post(`/api/umi/credentials/${encodeURIComponent(id)}/revoke`, REGISTRAR,
  { reason: 'superseded by a later survey' });
t('the issuer can revoke it', revoked.status === 200, `got ${revoked.status}`);

const after = await get('/api/umi/credentials/status', null);
const entry = (after.body.entries || []).find(e => e.credentialId === id);
t('the status list now reports it revoked', Boolean(entry && entry.revoked));
t('the list says why and at which block',
  Boolean(entry && entry.revokedBlock > 0 && entry.revokedReason));

// The cryptography has not changed, and should not pretend to have: a
// revoked credential is still a genuinely signed document. Only the list
// knows it is no longer good, which is exactly why the list exists.
const stillSigned = verify(file);
t('a revoked credential still verifies cryptographically offline', stillSigned.code === 0);
const withRevocation = verify(file, ['--check-revocation']);
t('but the verifier refuses it once it polls the status list', withRevocation.code !== 0,
  withRevocation.out.split('\n').filter(l => /revok/i.test(l)).join('\n       '));

// --- the download is usable ---------------------------------------------
t('the bundle is served as a named download, so it survives on disk',
  /attachment; filename=/.test(bundleRes.headers.get('content-disposition') || ''),
  bundleRes.headers.get('content-disposition'));

// --- the script is standalone -------------------------------------------
const verifierSrc = readFileSync(VERIFIER, 'utf8');
t('the verifier imports nothing from this repository',
  !/from '\.\.?\//.test(verifierSrc.replace(/^#!.*$/m, '')));
t('the verifier only reaches the network for revocation',
  (verifierSrc.match(/fetch\(/g) || []).length === 1);

console.log(`\n  ${pass}/${pass + fail} passed`);
process.exit(fail === 0 ? 0 : 1);
