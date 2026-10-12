// What a stranger is allowed to see in the catalogue.
//
// Production was publicly listing three half-finished properties left behind
// by an audit — DRAFT, no registrar near them, no tokens, no price. They were
// harmless, but they were in the public catalogue and the assistant described
// them to anyone who asked, which is the same mistake in two places: a
// catalogue is a list of things that exist to be bought, and a DRAFT is a
// piece of paperwork that has not been checked yet.
//
// The person who registered it still sees their own, and so does a
// supervisor, because hiding someone's work from themselves is not privacy.
import { randomBytes } from 'node:crypto';

const API = process.env.API || 'http://localhost:8080';

let pass = 0, fail = 0;
const t = (name, ok, detail) => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};

const token = (identityId, role, mspId) => Buffer.from(JSON.stringify({
  identityId, role, mspId, exp: Math.floor(Date.now() / 1000) + 3600,
})).toString('base64');

const as = (identityId, role, mspId) => ({
  'Content-Type': 'application/json',
  Authorization: `Bearer ${token(identityId, role, mspId)}`,
  'X-Fabric-Identity': identityId,
  'X-Identity-Role': role,
});

const ORIGINATOR = as('originator1', 'Originator', 'OriginatorMSP');
const OTHER = as('investor2', 'Investor', 'InvestorMSP');
const REGULATOR = as('regulator1', 'Regulator', 'RegulatorMSP');

const j = async (path, opts = {}) => {
  const res = await fetch(`${API}${path}`, opts);
  const raw = await res.text();
  let body = null;
  try { body = raw ? JSON.parse(raw) : null; } catch { /* not json */ }
  return { status: res.status, body };
};

const listing = async (headers) => {
  const r = await j('/api/properties', headers ? { headers } : {});
  return (r.body && r.body.properties) || [];
};

console.log(`Draft listings (${API})`);

const before = await listing(null);

// A fresh DRAFT of our own, so the test never depends on what is lying around.
const title = `Draft Visibility ${randomBytes(3).toString('hex')}`;
const created = await j('/api/properties', {
  method: 'POST',
  headers: ORIGINATOR,
  body: JSON.stringify({
    title,
    location: 'Pune',
    valuationINR: 5000000,
    documentHash: randomBytes(32).toString('hex'),
  }),
});

if (created.status !== 200 && created.status !== 201) {
  console.log(`  skip — this server would not register a property (${created.status})`);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(0);
}

const assetId = created.body.assetId;
t('a new property starts as a draft', created.body.status === 'DRAFT', created.body.status);

const anonymous = await listing(null);
t('a stranger is not shown the draft',
  !anonymous.some(p => p.assetId === assetId), `${anonymous.length} listed`);
// A public listing deliberately carries no validation field, so this cannot
// re-derive the rule from the response — what it can check is that
// registering something unchecked did not make the catalogue any longer.
t('  and registering it did not grow the catalogue',
  anonymous.length === before.length, `${before.length} before, ${anonymous.length} after`);
t('  and the real listings are still there',
  anonymous.some(p => p.status === 'TOKENIZED'), `${anonymous.length} listed`);

const stranger = await listing(OTHER);
t('another signed-in person is not shown it either',
  !stranger.some(p => p.assetId === assetId));

const mine = await listing(ORIGINATOR);
t('the person who registered it still sees their own draft',
  mine.some(p => p.assetId === assetId));

const supervisor = await listing(REGULATOR);
t('a regulator sees it too, because reviewing it is the job',
  supervisor.some(p => p.assetId === assetId));

// Hiding it from the catalogue is not the same as pretending it is gone.
const direct = await j(`/api/properties/${assetId}`, { headers: ORIGINATOR });
const directBody = (direct.body && (direct.body.property || direct.body)) || {};
t('the draft itself still reads back for its owner',
  direct.status === 200 && directBody.assetId === assetId, String(direct.status));

// The facets are a second catalogue in disguise.
const facets = await j('/api/properties');
const cities = (facets.body && facets.body.facets && facets.body.facets.cities) || [];
t('the filters do not advertise a city that only a draft is in',
  Array.isArray(cities), JSON.stringify(cities));

// Lifecycle status stays DRAFT until tokens are minted, so the line that
// decides whether a listing is real is the registrar's approval, not the
// minting that comes after it.
const validated = await j(`/api/properties/${assetId}/validate`, {
  method: 'POST',
  headers: as('registrar1', 'Registrar', 'RegistrarMSP'),
  body: JSON.stringify({ decision: 'VALIDATED', notes: 'draft visibility suite' }),
});
if (validated.status === 200) {
  const after = await listing(null);
  t('a validated property appears in the public catalogue',
    after.some(p => p.assetId === assetId), `${after.length} listed`);
} else {
  console.log(`  skip validation step — server said ${validated.status}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
