// Who may act on a listing.
//
// Validate, freeze, delete, yield distribution and governance all checked
// the caller against the listing owner. Mint did not — and mint is the one
// that sets total supply, which divided into the valuation is the token
// price. Any signed-in user could tokenise another originator's property on
// their own terms. The serverless error text even told people to "switch to
// Originator to mint"; nothing enforced it.
//
// This walks the real lifecycle rather than poking seeded rows, because the
// hole only opened once a listing reached VALIDATED: before that, mint fails
// on state and the authorisation question never gets asked.
import { randomBytes } from 'node:crypto';

const API = process.env.API || 'http://localhost:8080';

let pass = 0, fail = 0;
const t = (name, ok, detail) => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};

const tokenFor = (identityId, role, mspId) =>
  Buffer.from(JSON.stringify({ identityId, mspId, role, exp: Date.now() + 3600000 })).toString('base64');

const ORIGINATOR = tokenFor('originator1', 'Originator', 'OriginatorMSP');
const REGISTRAR = tokenFor('registrar1', 'Registrar', 'RegistrarMSP');
const INVESTOR = tokenFor('investor1', 'Investor', 'InvestorMSP');

async function call(path, token, init = {}) {
  const res = await fetch(API + path, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(init.headers || {}) },
  });
  let body = null;
  try { body = await res.json(); } catch { /* not json */ }
  return { status: res.status, body };
}

const newListing = async (title) => {
  const r = await call('/api/properties', ORIGINATOR, {
    method: 'POST',
    body: JSON.stringify({
      title, location: { city: 'Pune', state: 'Maharashtra', pincode: '411001' },
      propertyType: 'Residential', valuationINR: 1000000, areaSqft: 900,
      // A fresh digest per run: the register treats a repeated document hash
      // as the same deed, so a fixed value made the second run reuse the
      // listing the first run had already tokenised.
      documentHash: randomBytes(32).toString('hex'),
    }),
  });
  return (r.body && (r.body.assetId || (r.body.property && r.body.property.assetId))) || null;
};

const statusOf = async (id) => {
  const r = await call(`/api/properties/${id}`, ORIGINATOR);
  const p = (r.body && (r.body.property || r.body)) || {};
  return { status: p.status, totalTokens: p.totalTokens, validation: p.registrarValidationStatus };
};

console.log(`listing lifecycle authorisation (${API})`);

const id = await newListing(`Scope Probe ${Date.now()}`);
t('originator can create a listing', !!id, 'no assetId returned');
if (!id) { console.log(`\n${pass} passed, ${fail + 1} failed`); process.exit(1); }

// An investor must not be able to wave it through title validation.
const investorValidates = await call(`/api/properties/${id}/validate`, INVESTOR, {
  method: 'POST', body: JSON.stringify({ decision: 'VALIDATED', note: 'mine now' }),
});
t('an investor cannot validate title', investorValidates.status === 403, `got ${investorValidates.status}`);

const validated = await call(`/api/properties/${id}/validate`, REGISTRAR, {
  method: 'POST', body: JSON.stringify({ decision: 'VALIDATED', note: 'checked' }),
});
t('the registrar can validate it', validated.status === 200, `got ${validated.status}`);

// The listing is now VALIDATED: this is where mint used to be wide open.
const investorMints = await call(`/api/properties/${id}/mint`, INVESTOR, {
  method: 'POST', body: JSON.stringify({ totalTokens: 1000 }),
});
t('an investor cannot mint a listing they do not own', investorMints.status === 403, `got ${investorMints.status}`);
t('  the refusal names the owner',
  investorMints.body && /originator1/.test(investorMints.body.message || ''), JSON.stringify(investorMints.body));

const untouched = await statusOf(id);
t('the refused mint changed nothing', untouched.status !== 'TOKENIZED' && !untouched.totalTokens,
  JSON.stringify(untouched));

// The owner's own path must still work, or this is just a broken feature.
const ownerMints = await call(`/api/properties/${id}/mint`, ORIGINATOR, {
  method: 'POST', body: JSON.stringify({ totalTokens: 1000 }),
});
t('the owner can still mint', ownerMints.status === 200, `got ${ownerMints.status}`);
const after = await statusOf(id);
t('and the listing is tokenised', after.status === 'TOKENIZED' && Number(after.totalTokens) === 1000,
  JSON.stringify(after));

// The rest of the lifecycle, confirming the rule is consistent across it.
const second = await newListing(`Scope Probe B ${Date.now()}`);
for (const [name, path, body] of [
  ['freeze', `/api/properties/${second}/freeze`, { frozen: true, reason: 'probe' }],
  ['distribute yield on', `/api/properties/${second}/yield/distribute`, { amountINR: 100 }],
  ['open a governance vote on', `/api/properties/${second}/governance`, { title: 't', description: 'd', options: ['a', 'b'] }],
]) {
  const r = await call(path, INVESTOR, { method: 'POST', body: JSON.stringify(body) });
  t(`an investor cannot ${name} another's listing`, r.status === 403, `got ${r.status}`);
}
const investorDeletes = await call(`/api/properties/${second}`, INVESTOR, { method: 'DELETE' });
t("an investor cannot delete another's listing", investorDeletes.status === 403, `got ${investorDeletes.status}`);

const stillThere = await call(`/api/properties/${second}`, ORIGINATOR);
t('the listing survived all of it', stillThere.status === 200, `got ${stillThere.status}`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
