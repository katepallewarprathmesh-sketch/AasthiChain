// Property verification: who may validate title, and what a buyer can check.
//
// Two things were wrong before this suite existed. The integrations table
// advertised GET /api/properties/:id/verify as "live" and no such route was
// registered, so the one endpoint a sceptical buyer would reach for returned
// a 404. And /validate accepted any signed-in role, which meant an Originator
// could validate their own listing and mint it immediately afterwards — the
// registrar check that the whole trust story rests on was optional.
//
// Validation also left no block behind, so "validated" was a field in memory
// rather than something the chain could prove.
const BASE = process.env.BASE || 'http://localhost:8080';
let p = 0, f = 0;
const t = (n, c) => { if (c) { p++; console.log('  ok   ' + n); } else { f++; console.log('  FAIL ' + n); } };

const mk = (identityId, mspId, role) => Buffer.from(JSON.stringify({
  identityId, mspId, role, exp: Math.floor(Date.now() / 1000) + 3600,
})).toString('base64');

const owner = { 'content-type': 'application/json', authorization: 'Bearer ' + mk('originator1', 'OriginatorMSP', 'Originator') };
const registrar = { 'content-type': 'application/json', authorization: 'Bearer ' + mk('registrar1', 'RegistrarMSP', 'Registrar') };
const investor = { 'content-type': 'application/json', authorization: 'Bearer ' + mk('investor1', 'InvestorMSP', 'Investor') };

const j = async (u, o) => { const r = await fetch(BASE + u, o); return { s: r.status, b: await r.json().catch(() => ({})) }; };

const stamp = Date.now();
const reg = await j('/api/properties', {
  method: 'POST', headers: owner,
  body: JSON.stringify({
    title: `Verification Suite ${stamp}`, state: 'MH', city: 'Pune',
    pincode: '411001', valuationINR: 7500000,
  }),
});
t('property registered', reg.s === 200 || reg.s === 201);
const assetId = reg.b.assetId;
t('got an assetId', Boolean(assetId));

// --- who is allowed to validate -------------------------------------------
const selfVal = await j(`/api/properties/${assetId}/validate`, {
  method: 'POST', headers: owner, body: JSON.stringify({ decision: 'VALIDATED' }),
});
t('owner cannot validate their own property', selfVal.s === 403);
t('refusal explains why, not just a code', /registrar/i.test(selfVal.b.message || ''));

const investorVal = await j(`/api/properties/${assetId}/validate`, {
  method: 'POST', headers: investor, body: JSON.stringify({ decision: 'VALIDATED' }),
});
t('an investor cannot validate title', investorVal.s === 403);

const junk = await j(`/api/properties/${assetId}/validate`, {
  method: 'POST', headers: registrar, body: JSON.stringify({ decision: 'probably fine' }),
});
t('a nonsense decision is refused', junk.s === 400);

// an unvalidated property must not be mintable
const earlyMint = await j(`/api/properties/${assetId}/mint`, {
  method: 'POST', headers: owner, body: JSON.stringify({ totalTokens: 1000 }),
});
t('cannot mint before validation', earlyMint.s === 400);

// --- the real validation ---------------------------------------------------
const val = await j(`/api/properties/${assetId}/validate`, {
  method: 'POST', headers: registrar,
  body: JSON.stringify({ decision: 'VALIDATED', note: 'Deed checked against the Bhoomi extract' }),
});
t('registrar can validate', val.s === 200);
t('validation records who decided', val.b.validatedBy === 'registrar1');
t('validation records when', Boolean(val.b.validatedAt));
t('validation commits a block', Number.isInteger(val.b.blockHeight));
t('block carries a hash', typeof val.b.blockHash === 'string' && val.b.blockHash.length > 32);

// --- the verification dossier ---------------------------------------------
const v = await j(`/api/properties/${assetId}/verify`);
t('verify endpoint exists (was advertised but missing)', v.s === 200);
t('reports verified true for a clean property', v.b.verified === true);
t('summary is a sentence, not a code', /passed/i.test(v.b.summary || ''));
t('every check carries a plain-English label', (v.b.checks || []).every(c => typeof c.label === 'string' && c.label.length > 3));
t('registrar check passed', (v.b.checks || []).find(c => c.id === 'registrar')?.ok === true);
t('independence check passed', (v.b.checks || []).find(c => c.id === 'independence')?.ok === true);
t('uniqueness check passed', (v.b.checks || []).find(c => c.id === 'uniqueness')?.ok === true);
t('chain check passed', (v.b.checks || []).find(c => c.id === 'chain')?.ok === true);
t('names the independent validator', v.b.validatedBy === 'registrar1' && v.b.owner === 'originator1');
t('cites chain evidence', Array.isArray(v.b.chainEvidence) && v.b.chainEvidence.some(e => e.type === 'PROPERTY_VALIDATED'));
t('verification is public — no auth needed', v.s === 200);

// --- proving a document copy ----------------------------------------------
const good = await j(`/api/properties/${assetId}/verify-document`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ documentHash: v.b.documentHash }),
});
t('the registered hash matches', good.s === 200 && good.b.match === true);

const bad = await j(`/api/properties/${assetId}/verify-document`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ documentHash: 'f'.repeat(64) }),
});
t('a different document does not match', bad.s === 200 && bad.b.match === false);
t('mismatch warns the reader off', /not .*rely|does NOT match/i.test(bad.b.message || ''));

const malformed = await j(`/api/properties/${assetId}/verify-document`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ documentHash: 'not-a-hash' }),
});
t('a malformed hash is refused with instructions', malformed.s === 400 && /sha256sum|64 hex/i.test(malformed.b.message || ''));

const missing = await j('/api/properties/PROP-DOES-NOT-EXIST/verify');
t('unknown property verifies as 404', missing.s === 404);

// --- minting still works after a real validation ---------------------------
const mint = await j(`/api/properties/${assetId}/mint`, {
  method: 'POST', headers: owner, body: JSON.stringify({ totalTokens: 1000 }),
});
t('validated property can be tokenized', mint.s === 200);

console.log(`\n${p}/${p + f} passed`);
process.exit(f ? 1 : 0);
