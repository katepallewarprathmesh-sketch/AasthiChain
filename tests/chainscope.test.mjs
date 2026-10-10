// Two leftovers from the audit sweep.
//
// 1. POST /api/chain/tamper and /api/chain/restore took no credentials at
//    all. They are a tamper-evidence demonstration — the chain is restorable
//    — but an anonymous caller being able to rewrite committed blocks on a
//    public deployment is not a demonstration anyone asked for.
// 2. Testnet escrow recorded `from` straight off the request body, so there
//    was no record of who actually started a payment, and confirm/release
//    accepted any signed-in user for any payment id. Same shape as the
//    /api/npci payment hole, in the secondary rail.
import { randomBytes } from 'node:crypto';

const API = process.env.API || 'http://localhost:8080';

let pass = 0, fail = 0;
const t = (name, ok, detail) => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};

const tokenFor = (identityId, role, mspId) =>
  Buffer.from(JSON.stringify({ identityId, mspId, role, exp: Date.now() + 3600000 })).toString('base64');
const INVESTOR1 = tokenFor('investor1', 'Investor', 'InvestorMSP');
const INVESTOR2 = tokenFor('investor2', 'Investor', 'InvestorMSP');
const REGULATOR = tokenFor('regulator1', 'Regulator', 'RegulatorMSP');

async function call(path, token, init = {}) {
  const headers = { 'Content-Type': 'application/json', ...(init.headers || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(API + path, { ...init, headers });
  let body = null;
  try { body = await res.json(); } catch { /* not json */ }
  return { status: res.status, body };
}

console.log(`chain + testnet escrow scope (${API})`);

// ---- chain tamper/restore
const headBefore = (await call('/api/chain/head', null)).body;

const anon = await call('/api/chain/tamper', null, { method: 'POST', body: JSON.stringify({ height: 1 }) });
t('an anonymous caller cannot tamper with the chain', anon.status === 401, `got ${anon.status}`);

const investorTamper = await call('/api/chain/tamper', INVESTOR1, { method: 'POST', body: JSON.stringify({ height: 1 }) });
t('an ordinary user cannot tamper with the chain', investorTamper.status === 403, `got ${investorTamper.status}`);
t('  refused as not-regulator', investorTamper.body && investorTamper.body.error === 'ERR_NOT_REGULATOR',
  JSON.stringify(investorTamper.body));

const investorRestore = await call('/api/chain/restore', INVESTOR1, { method: 'POST', body: JSON.stringify({}) });
t('an ordinary user cannot restore it either', investorRestore.status === 403, `got ${investorRestore.status}`);

const verifyAfter = await call('/api/chain/verify', null);
t('the chain is still intact after the refusals',
  verifyAfter.body && (verifyAfter.body.valid === true || verifyAfter.body.intact === true),
  JSON.stringify(verifyAfter.body).slice(0, 120));

// The regulator's demo must still work, and must still be reversible. A
// freshly booted server may only have genesis, which is not tamperable by
// design, so commit a block first.
if (!headBefore || headBefore.height < 1) {
  await call('/api/properties', tokenFor('originator1', 'Originator', 'OriginatorMSP'), {
    method: 'POST',
    body: JSON.stringify({
      title: `Chain Scope ${randomBytes(3).toString('hex')}`,
      location: 'Pune', totalValueINR: 5000000, totalTokens: 1000,
      documentHash: randomBytes(32).toString('hex'),
    }),
  });
}
const regTamper = await call('/api/chain/tamper', REGULATOR, { method: 'POST', body: JSON.stringify({}) });
// A chain holding nothing but genesis has nothing tamperable in it, and says
// so with 400 — what matters is that the regulator is never turned away on
// authorisation grounds.
t('a regulator can still run the tamper demo',
  regTamper.status === 200 || (regTamper.status === 400 && regTamper.body.error === 'ERR_CANNOT_TAMPER'),
  `got ${regTamper.status} ${JSON.stringify(regTamper.body)}`);
const regRestore = await call('/api/chain/restore', REGULATOR, { method: 'POST', body: JSON.stringify({}) });
t('and restore it afterwards', regRestore.status === 200, `got ${regRestore.status}`);
const verifyEnd = await call('/api/chain/verify', null);
t('leaving the chain verifiable again',
  verifyEnd.body && (verifyEnd.body.valid === true || verifyEnd.body.intact === true),
  JSON.stringify(verifyEnd.body).slice(0, 120));
t('and at the height it started at',
  !headBefore || (await call('/api/chain/head', null)).body.height === headBefore.height);

// ---- testnet escrow
const pid = 'SIM-' + randomBytes(4).toString('hex').toUpperCase();
const started = await call('/api/testnet/payments/initiate', INVESTOR1, {
  method: 'POST',
  body: JSON.stringify({ assetId: 'PROP-GREEN-VALLEY-PUNE-001', tokenAmount: 2, paymentId: pid, from: 'investor1', to: 'originator1', isSimulated: true }),
});
t('investor1 can start a testnet escrow', started.status === 200, `got ${started.status}`);

const stealRelease = await call(`/api/testnet/payments/${pid}/release`, INVESTOR2, { method: 'POST', body: JSON.stringify({}) });
t('a stranger cannot release it', stealRelease.status === 403, `got ${stealRelease.status}`);
t('  refused as not-your-payment', stealRelease.body && stealRelease.body.error === 'ERR_NOT_YOUR_PAYMENT',
  JSON.stringify(stealRelease.body));

const stealConfirm = await call(`/api/testnet/payments/${pid}/confirm`, INVESTOR2, {
  method: 'POST', body: JSON.stringify({ drunixTransferId: 'forged' }),
});
t('a stranger cannot confirm it', stealConfirm.status === 403, `got ${stealConfirm.status}`);

const stillPending = await call(`/api/testnet/payments/${pid}`, INVESTOR1);
t('the escrow is untouched by the refused calls',
  stillPending.body && stillPending.body.status === 'PENDING' && !stillPending.body.drunixTransferId,
  JSON.stringify(stillPending.body && { s: stillPending.body.status, d: stillPending.body.drunixTransferId }));

// The person who started it still owns the flow end to end.
const ownConfirm = await call(`/api/testnet/payments/${pid}/confirm`, INVESTOR1, {
  method: 'POST', body: JSON.stringify({ drunixTransferId: 'tx-ok' }),
});
t('the initiator can confirm', ownConfirm.status === 200, `got ${ownConfirm.status}`);
const ownRelease = await call(`/api/testnet/payments/${pid}/release`, INVESTOR1, { method: 'POST', body: JSON.stringify({}) });
t('and release', ownRelease.status === 200 && ownRelease.body.status === 'RELEASED', `got ${ownRelease.status}`);

// An escrow id that does not exist is a 404, not a silent 200.
const ghost = await call('/api/testnet/payments/SIM-NOPE/release', INVESTOR1, { method: 'POST', body: JSON.stringify({}) });
t('an unknown escrow id is 404', ghost.status === 404, `got ${ghost.status}`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
