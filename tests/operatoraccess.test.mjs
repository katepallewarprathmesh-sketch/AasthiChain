// Closing the header hole locked the deployment's owner out of their own
// panels.
//
// Before the audit, naming yourself regulator1 in X-Fabric-Identity made you
// a regulator. That had to go. But nothing replaced it: on a deployment
// without demo auth, every signed-in person fell through to investor1, so
// the ops queue answered ERR_NOT_REGISTRAR, deployment diagnostics answered
// ERR_UNAUTHORIZED and the insights dashboard demanded a key — to the very
// people whose role those panels exist for.
//
// There are now two ways to be an operator, both verifiable server-side:
//   1. x-admin-key, the deployment's own key
//   2. a session the deployment has named (SUPERVISOR_EMAILS /
//      SUPERVISOR_CLERK_IDS) or that carries a role in its claims
//
// A plain signed-in investor still gets nothing, and neither does a caller
// with the wrong key.
const API = process.env.API || 'http://localhost:8080';
const ADMIN_KEY = process.env.ADMIN_DASHBOARD_KEY || 'devkey';

let pass = 0, fail = 0;
const t = (name, ok, detail) => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};

const tokenFor = (identityId, role) =>
  Buffer.from(JSON.stringify({ identityId, mspId: 'M', role, exp: Date.now() + 3600000 })).toString('base64');

async function call(path, { token, key, identity } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (key) headers['x-admin-key'] = key;
  if (identity) headers['X-Fabric-Identity'] = identity;
  const res = await fetch(API + path, { headers });
  let body = null;
  try { body = await res.json(); } catch { /* not json */ }
  return { status: res.status, body, raw: JSON.stringify(body || {}) };
}

console.log(`Operator access (${API})`);

const OPS = '/api/admin/ops';
const DIAG = '/api/db/config';
const INSIGHTS = '/api/admin/insights';

// ---- the roles the panels are for
for (const [who, role] of [['registrar1', 'Registrar'], ['regulator1', 'Regulator']]) {
  const r = await call(OPS, { token: tokenFor(who, role), identity: who });
  t(`${role} can open the operations queue`, r.status === 200, `got ${r.status} ${r.raw.slice(0, 120)}`);
}

const regulator = tokenFor('regulator1', 'Regulator');
// Deployment diagnostics only exist on the serverless handler; the Express
// rig has never implemented /api/db/*, so skip rather than fail there.
const diag = await call(DIAG, { token: regulator, identity: 'regulator1' });
const HAS_DIAG = diag.status !== 404;
if (HAS_DIAG) t('Regulator can read deployment diagnostics', diag.status === 200, `got ${diag.status}`);
else console.log('  --   deployment diagnostics not implemented here, skipping those checks');

const ins = await call(INSIGHTS, { token: regulator, identity: 'regulator1' });
t('Regulator can open insights without pasting the key',
  ins.status === 200 || ins.status === 503, `got ${ins.status} ${ins.raw.slice(0, 120)}`);

// ---- the operator key works with no session at all
const keyedOps = await call(OPS, { key: ADMIN_KEY });
t('the operator key alone opens the operations queue', keyedOps.status === 200, `got ${keyedOps.status}`);
if (HAS_DIAG) {
  const keyedDiag = await call(DIAG, { key: ADMIN_KEY });
  t('the operator key alone opens diagnostics', keyedDiag.status === 200, `got ${keyedDiag.status}`);
}

// ---- and none of this re-opens the door
const investor = tokenFor('investor2', 'Investor');
const nosyOps = await call(OPS, { token: investor, identity: 'investor2' });
t('an investor still cannot open the operations queue', nosyOps.status === 403, `got ${nosyOps.status}`);
t('  and is told how access is granted', /x-admin-key|registrar|regulator/i.test(nosyOps.raw), nosyOps.raw.slice(0, 160));

if (HAS_DIAG) {
  const nosyDiag = await call(DIAG, { token: investor, identity: 'investor2' });
  t('an investor still cannot read diagnostics', nosyDiag.status === 403 || nosyDiag.status === 401, `got ${nosyDiag.status}`);

  const wrongKey = await call(DIAG, { key: 'not-the-key' });
  t('a wrong operator key is refused', wrongKey.status === 401 || wrongKey.status === 403, `got ${wrongKey.status}`);
} else {
  const wrongKeyOps = await call(OPS, { key: 'not-the-key' });
  t('a wrong operator key is refused', wrongKeyOps.status === 401 || wrongKeyOps.status === 403, `got ${wrongKeyOps.status}`);
}

const anonOps = await call(OPS, {});
t('an anonymous visitor is refused', anonOps.status === 401 || anonOps.status === 403, `got ${anonOps.status}`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
