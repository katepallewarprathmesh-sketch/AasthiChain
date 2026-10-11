// Two lists that answered with everybody's business: the user directory
// (every registered person's email address) and the testnet escrow book
// (who is paying for what). Being signed in was the whole test.
const BASE = process.env.API || 'http://localhost:8080';
const J = { 'Content-Type': 'application/json' };

let pass = 0, fail = 0;
const t = (name, ok, extra = '') => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${extra}`); }
};

const token = (identityId, role) => Buffer.from(JSON.stringify({
  identityId, mspId: role + 'MSP', role, exp: Date.now() + 3600000,
})).toString('base64');
const as = (identityId, role) => ({
  ...J, Authorization: 'Bearer ' + token(identityId, role),
  'X-Identity-Id': identityId, 'X-Fabric-Identity': identityId, 'X-Identity-Role': role,
});
const get = (path, headers) => fetch(BASE + path, { headers });
const post = (path, body, headers = J) =>
  fetch(BASE + path, { method: 'POST', headers, body: JSON.stringify(body) });

// Two people exist.
await post('/api/auth/login', { identityId: 'investor1', role: 'Investor' });
await post('/api/auth/login', { identityId: 'originator1', role: 'Originator' });

// --- the user directory ---
const anon = await get('/api/auth/users');
t('anonymous cannot list users', anon.status === 401, `got ${anon.status}`);

const mine = await (await get('/api/auth/users', as('investor1', 'Investor'))).json();
const ids = (mine.users || []).map(u => u.id);
t('an investor sees only themselves', ids.length <= 1 && !ids.includes('originator1'),
  JSON.stringify(ids));
t('and no stranger emails come back',
  !JSON.stringify(mine).includes('originator1@'), JSON.stringify(mine).slice(0, 160));

const sup = await (await get('/api/auth/users', as('regulator1', 'Regulator'))).json();
t('a regulator still sees the directory', (sup.users || []).length >= 2,
  String((sup.users || []).length));

// --- the testnet escrow book ---
const opened = await post('/api/testnet/payments/initiate',
  { assetId: 'PROP-GREEN-VALLEY-PUNE-001', tokenAmount: 1, amountINR: 100 },
  as('investor1', 'Investor'));
const esc = await opened.json().catch(() => ({}));
if (!esc.paymentId) {
  t('an escrow could be opened', false, JSON.stringify(esc).slice(0, 160));
} else {
  const theirs = await (await get('/api/testnet/payments', as('investor2', 'Investor'))).json();
  const seen = (theirs.payments || []).map(p => p.paymentId);
  t('a stranger does not see your escrow', !seen.includes(esc.paymentId), JSON.stringify(seen));

  const own = await (await get('/api/testnet/payments', as('investor1', 'Investor'))).json();
  t('you still see your own', (own.payments || []).some(p => p.paymentId === esc.paymentId));

  const reg = await (await get('/api/testnet/payments', as('regulator1', 'Regulator'))).json();
  t('a regulator sees it too', (reg.payments || []).some(p => p.paymentId === esc.paymentId));
}

console.log(`\ndirectoryscope: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
