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
const z1 = await list({ ...prop(6), documentHash: EMPTY_HASH });
const z2 = await list({ ...prop(7), documentHash: EMPTY_HASH });
t('two properties sharing the empty-string hash still collide (guard is right)',
  z1.status === 201 && z2.status === 409);
t('...which is exactly why the form must not send a constant',
  (z2.body.matchedOn || '') === 'documentHash');

console.log(`\n${p}/${p + f} passed`);
process.exit(f ? 1 : 0);
