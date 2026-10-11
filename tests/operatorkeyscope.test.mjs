// The operator key reads. It does not act.
//
// Restoring operator access turned the deployment key into a full
// supervisory session, which was more than it should ever have been: with
// the key alone — no sign-in, no person — a caller could register property
// attributed to regulator1 and reach the chain controls. The key is a static
// secret that lives in an env var and is typed into a browser, so treating
// it as a regulator means a leaked key is a leaked regulator.
//
// The rule now: the key opens the operator views, and anything that changes
// state needs a signed-in person, so the action has a name against it. Two
// maintenance routes are the stated exceptions, because they exist for an
// operator with no session and are idempotent and audited.
import { randomBytes } from 'node:crypto';

const API = process.env.API || 'http://localhost:8080';
const ADMIN_KEY = process.env.ADMIN_DASHBOARD_KEY || 'devkey';

let pass = 0, fail = 0;
const t = (name, ok, detail) => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};

async function call(path, { method = 'GET', key, token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (key) headers['x-admin-key'] = key;
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(API + path, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  let parsed = null;
  try { parsed = await res.json(); } catch { /* not json */ }
  return { status: res.status, body: parsed, raw: JSON.stringify(parsed || {}) };
}

const tokenFor = (identityId, role) =>
  Buffer.from(JSON.stringify({ identityId, mspId: 'M', role, exp: Date.now() + 3600000 })).toString('base64');

console.log(`Operator key scope (${API})`);

// ---- it still reads
const ops = await call('/api/admin/ops', { key: ADMIN_KEY });
t('the key opens the operations queue', ops.status === 200, `got ${ops.status}`);

const diag = await call('/api/db/config', { key: ADMIN_KEY });
t('the key opens diagnostics where they exist',
  diag.status === 200 || diag.status === 404, `got ${diag.status}`);

// ---- it does not act
const newProperty = {
  address: 'Key Write House, Pune', valuationINR: 1000000,
  documentHash: randomBytes(32).toString('hex'), totalTokens: 100,
};
const write = await call('/api/properties', { method: 'POST', key: ADMIN_KEY, body: newProperty });
t('the key cannot register a property', write.status === 403, `got ${write.status} ${write.raw.slice(0, 140)}`);
t('  and the refusal says a person is needed',
  /ERR_KEY_IS_READ_ONLY/.test(write.raw), write.raw.slice(0, 160));
t('  and nothing was created', !/assetId/.test(write.raw), write.raw.slice(0, 160));

const tamper = await call('/api/chain/tamper', { method: 'POST', key: ADMIN_KEY, body: {} });
t('the key cannot reach the chain controls',
  tamper.status === 403 || tamper.status === 404, `got ${tamper.status} ${tamper.raw.slice(0, 120)}`);

const transfer = await call('/api/transfers', {
  method: 'POST', key: ADMIN_KEY,
  body: { assetId: 'PROP-GREEN-VALLEY-PUNE-001', fromId: 'originator1', toId: 'investor2', amount: 1, tokens: 1 },
});
t('the key cannot move tokens', transfer.status === 403, `got ${transfer.status}`);

// ---- the stated exception still works
const backfill = await call('/api/npci/rail/backfill', { method: 'POST', key: ADMIN_KEY, body: { dryRun: true } });
t('the maintenance backfill still accepts the key',
  backfill.status === 200 || backfill.status === 404, `got ${backfill.status}`);

// ---- a signed-in operator is unaffected
const regulator = tokenFor('regulator1', 'Regulator');
const signedWrite = await call('/api/properties', {
  method: 'POST', token: regulator, key: ADMIN_KEY,
  body: { ...newProperty, documentHash: randomBytes(32).toString('hex') },
});
t('a signed-in regulator holding the key can still act',
  signedWrite.status < 400, `got ${signedWrite.status} ${signedWrite.raw.slice(0, 140)}`);

// ---- and a wrong key is still nothing at all
const wrong = await call('/api/admin/ops', { key: 'not-the-key' });
t('a wrong key opens nothing', wrong.status === 401 || wrong.status === 403, `got ${wrong.status}`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
