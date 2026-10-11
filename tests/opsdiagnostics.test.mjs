// The deployment described itself to anyone who asked.
//
// Two diagnostic routes — the storage configuration and the storage stats —
// answered anonymously with: which backend is live, which credentials are
// configured, the full table and index inventory, row counts per table, and
// the opening characters of the database URL. In production that last field
// named the provider and the database user.
//
// None of it is business data, which is exactly why it was overlooked: a
// reader who only asks "does this leak someone's money?" says no and moves
// on. It is reconnaissance, and it was free.
//
// Operators still need these routes, so they answer to a supervisor session
// or the ops key. Everyone else gets nothing — and the public health route
// is still there for anyone who just wants to know the app is up.
import { randomBytes } from 'node:crypto';

const API = process.env.API || 'http://localhost:8080';
const ADMIN_KEY = process.env.ADMIN_DASHBOARD_KEY || 'devkey';

let pass = 0, fail = 0;
const t = (name, ok, detail) => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};

const tokenFor = (identityId, role, mspId) =>
  Buffer.from(JSON.stringify({ identityId, mspId, role, exp: Date.now() + 3600000 })).toString('base64');
const INVESTOR = tokenFor('ops' + randomBytes(3).toString('hex'), 'Investor', 'InvestorMSP');
const REGULATOR = tokenFor('regulator1', 'Regulator', 'RegulatorMSP');

async function call(path, { token, adminKey } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (adminKey) headers['x-admin-key'] = adminKey;
  const res = await fetch(API + path, { headers });
  let body = null;
  try { body = await res.json(); } catch { /* not json */ }
  return { status: res.status, body, raw: JSON.stringify(body || {}) };
}

console.log(`Deployment diagnostics scope (${API})`);

const probe = await call('/api/db/config', { adminKey: ADMIN_KEY });
if (probe.status === 404) {
  // Not every server implements these routes.
  console.log('  diagnostics routes not implemented here — skipping');
  console.log('\n0 passed, 0 failed');
  process.exit(0);
}

for (const path of ['/api/db/config', '/api/db/stats']) {
  const anon = await call(path);
  // 401 in production; a demo-mode server hands unauthenticated callers a
  // stand-in identity, which is then refused as a non-operator. Either way
  // the caller is turned away and learns nothing.
  t(`${path} refuses an anonymous caller`, anon.status === 401 || anon.status === 403, `got ${anon.status}`);
  t(`${path} leaks nothing while refusing`,
    !/postgres|neondb|hasDatabaseUrl|tables/i.test(anon.raw), anon.raw.slice(0, 160));

  const stranger = await call(path, { token: INVESTOR });
  t(`${path} refuses a signed-in non-operator`, stranger.status === 403, `got ${stranger.status}`);

  const supervisor = await call(path, { token: REGULATOR });
  t(`${path} answers a supervisor`, supervisor.status === 200, `got ${supervisor.status}`);

  const keyed = await call(path, { adminKey: ADMIN_KEY });
  t(`${path} answers the ops key`, keyed.status === 200, `got ${keyed.status}`);
}

// The thing that was actually worth hiding.
const anonConfig = await call('/api/db/config');
t('the database URL prefix is no longer public',
  !/databaseUrlPrefix/.test(anonConfig.raw), anonConfig.raw.slice(0, 160));

// Liveness stays public: refusing to say whether the app is up would be the
// wrong lesson to take from this.
const health = await call('/api/health');
t('the public health route is still open', health.status === 200, `got ${health.status}`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
