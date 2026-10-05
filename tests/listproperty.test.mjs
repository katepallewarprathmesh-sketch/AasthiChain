// The listing form sent one hardcoded documentHash - the SHA-256 of an empty
// string - for every property. The server dedupes on that hash, so the first
// property ever listed claimed it and every later listing was refused as a
// duplicate, however different. These tests pin both halves: the guard must
// still catch real duplicates, and must not catch distinct properties.
import crypto from 'crypto';

const BASE = 'http://localhost:8080';
const tok = Buffer.from(JSON.stringify({
  identityId: 'originator1', mspId: 'OriginatorMSP', role: 'Originator', exp: Date.now() + 9e6,
})).toString('base64');

const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const EMPTY_HASH = sha('');            // what the form used to send
const uniq = Math.random().toString(36).slice(2, 8);

async function list(body) {
  const r = await fetch(`${BASE}/api/properties`, {
    method: 'POST',
    headers: { authorization: 'Bearer ' + tok, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
}

// Mirrors the client fingerprint for a property with no document attached.
const fingerprint = f => sha(['aasthichain-property-v1', f.title, f.city, f.state,
  f.pincode, f.valuationINR, 'originator1'].map(v => String(v || '').trim().toLowerCase()).join('|'));

const prop = (n, over = {}) => ({
  title: `Test ${n} ${uniq}`, state: 'Maharashtra', city: `City${n}${uniq}`,
  pincode: `4${n}0001`, valuationINR: 5000000 + n * 100000, ...over,
});

let p = 0, f = 0;
const t = (n, c) => { if (c) { p++; console.log('  ok   ' + n); } else { f++; console.log('  FAIL ' + n); } };

// --- the regression itself -------------------------------------------------
const a = prop(1), b = prop(2);
const r1 = await list({ ...a, documentHash: fingerprint(a) });
const r2 = await list({ ...b, documentHash: fingerprint(b) });
t('first new property lists', r1.status === 201);
t('SECOND distinct property also lists (the bug)', r2.status === 201);
t('they get different asset ids', r1.body.assetId !== r2.body.assetId);

// --- the guard must still work ---------------------------------------------
const same = await list({ ...a, documentHash: fingerprint(a) });
t('re-listing the identical property is refused', same.status === 409);
t('refusal names the rule', same.body.matchedOn === 'documentHash' || same.body.matchedOn === 'title+city+pincode');

const c = prop(3);
const d1 = await list({ ...c, documentHash: sha('deed-' + uniq) });
const d2 = await list({ ...prop(4), documentHash: sha('deed-' + uniq) });
t('a genuinely shared document is refused', d1.status === 201 && d2.status === 409);
t('shared-document refusal is attributed to the hash', d2.body.matchedOn === 'documentHash');
t('message explains how to fix it', /attach its own document/.test(d2.body.message || ''));

// same name+city+pincode, different document
const e1 = await list({ ...prop(5), documentHash: sha('x1-' + uniq) });
const dupName = { ...prop(5), documentHash: sha('x2-' + uniq) };
const e2 = await list(dupName);
t('same name at same city+pincode is refused', e1.status === 201 && e2.status === 409);
t('name clash is attributed to name, not document', e2.body.matchedOn === 'title+city+pincode');

// --- the old constant hash ---------------------------------------------------
// This assertion used to read "two properties sharing the empty-string hash
// still collide". That was the OLD behaviour and it is exactly what locked the
// registry: a placeholder is not a document, so it must never be matched as
// one. The server now normalises it away.
const z1 = await list({ ...prop(6), documentHash: EMPTY_HASH });
const z2 = await list({ ...prop(7), documentHash: EMPTY_HASH });
t('empty-string hash is NOT treated as a document', z1.status === 201 && z2.status === 201);
t('the two placeholder listings are distinct', z1.body.assetId !== z2.body.assetId);

// --- a STALE cached browser ---------------------------------------------
// Users keep old JS in cache. The pre-fix bundle sends the empty-string hash
// for every property, so the server must treat a placeholder as "no document"
// and fingerprint the property instead. Without this, a cached client can
// never list anything again, no matter how many times the frontend is fixed.
const s1 = await list({ ...prop(8), documentHash: EMPTY_HASH });
const s2 = await list({ ...prop(9), documentHash: EMPTY_HASH });
t('stale client: first listing works', s1.status === 201);
t('stale client: SECOND distinct listing also works', s2.status === 201);
t('stale client: distinct asset ids', s1.body.assetId !== s2.body.assetId);

const allZero = await list({ ...prop(10), documentHash: '0'.repeat(64) });
t('all-zero placeholder also normalised', allZero.status === 201);

// ...but an identical resubmission from a stale client is STILL caught,
// because the fingerprint is deterministic.
const again = await list({ ...prop(8), documentHash: EMPTY_HASH });
t('stale client: identical property still refused', again.status === 409);

// a real document hash is never rewritten
const realDoc = sha('a-genuine-deed-' + uniq);
const g1 = await list({ ...prop(11), documentHash: realDoc });
const g2 = await list({ ...prop(12), documentHash: realDoc });
t('real document still enforces one-deed-one-tokenization', g1.status === 201 && g2.status === 409);

console.log(`\n${p}/${p + f} passed`);
process.exit(f ? 1 : 0);
