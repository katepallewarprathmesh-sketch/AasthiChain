// A swap takes tokens out of two wallets, so both owners have to agree.
//
// The old /api/swap did the whole thing in one call: the caller named a
// counterparty, named the ratio, and the server moved both legs immediately.
// Nobody asked the counterparty. In a probe, investor1 handed over 10 tokens
// of one property and helped themselves to 500 tokens of another straight
// out of originator1's wallet — worth lakhs — and the ledger recorded it as
// a legitimate atomic swap.
//
// Proposing and accepting are now two acts, and only the person being asked
// can accept.
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
const ORIGINATOR = tokenFor('originator1', 'Originator', 'OriginatorMSP');
const REGULATOR = tokenFor('regulator1', 'Regulator', 'RegulatorMSP');

async function call(path, token, init = {}) {
  const res = await fetch(API + path, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(init.headers || {}) },
  });
  let body = null;
  try { body = await res.json(); } catch { /* not json */ }
  return { status: res.status, body };
}
const balanceOf = async (assetId, owner) => {
  const r = await call(`/api/balances/${assetId}/${owner}`, REGULATOR);
  return (r.body && Number(r.body.balance)) || 0;
};

console.log(`swap consent (${API})`);

// A swap needs two different properties, both held by originator1 and both
// minted. The seeded catalogue is not the same on every backend, so the
// suite grows its own.
async function freshAsset(label) {
  const reg = await call('/api/properties', ORIGINATOR, {
    method: 'POST',
    body: JSON.stringify({
      title: `Swap Scope ${label} ${randomBytes(3).toString('hex')}`,
      state: 'Maharashtra', city: 'Pune', pincode: '411001', valuationINR: 5000000,
      documentHash: randomBytes(32).toString('hex'),
    }),
  });
  const assetId = reg.body && (reg.body.assetId || (reg.body.property && reg.body.property.assetId));
  if (!assetId) return null;
  await call(`/api/properties/${assetId}/validate`, tokenFor('registrar1', 'Registrar', 'RegistrarMSP'), {
    method: 'POST', body: JSON.stringify({ decision: 'VALIDATED', notes: 'swap scope fixture' }),
  });
  await call(`/api/properties/${assetId}/mint`, ORIGINATOR, { method: 'POST', body: JSON.stringify({ totalTokens: 2000 }) });
  return (await balanceOf(assetId, 'originator1')) > 0 ? assetId : null;
}

const A = await freshAsset('A');
const B = await freshAsset('B');
if (!A || !B) { console.log('\n0 passed, 1 failed — could not create two tokenised properties'); process.exit(1); }

// investor1 needs something of their own to offer.
// `tokens` on one server, `amount` on the other — send both.
const seeded = await call('/api/transfers', ORIGINATOR, {
  method: 'POST', body: JSON.stringify({ assetId: A, toId: 'investor1', tokens: 10, amount: 10 }),
});
if (seeded.status !== 200 && seeded.status !== 201) {
  console.log(`\n0 passed, 1 failed — could not give investor1 something to offer (${seeded.status})`);
  process.exit(1);
}

const victimBefore = await balanceOf(B, 'originator1');
const raiderBefore = await balanceOf(B, 'investor1');

// ---- the hole this suite exists for
const grab = await call('/api/swap', INVESTOR1, {
  method: 'POST',
  body: JSON.stringify({ giveAssetId: A, giveTokens: 1, getAssetId: B, getTokens: 500, counterparty: 'originator1' }),
});
t('a swap can be proposed', grab.status === 201, `got ${grab.status}`);
t('  but it only proposes — nothing is settled yet',
  grab.body && grab.body.status === 'PROPOSED', JSON.stringify(grab.body).slice(0, 140));
t('the counterparty keeps every token until they agree',
  (await balanceOf(B, 'originator1')) === victimBefore,
  `${victimBefore} -> ${await balanceOf(B, 'originator1')}`);
t('and the proposer gains nothing by asking',
  (await balanceOf(B, 'investor1')) === raiderBefore);

const swapId = grab.body && grab.body.swapId;

// The proposer cannot accept on the other side's behalf.
const selfAccept = await call(`/api/swap/${swapId}/accept`, INVESTOR1, { method: 'POST', body: '{}' });
t('the proposer cannot accept their own swap', selfAccept.status === 403, `got ${selfAccept.status}`);
t('  refused as not-your-swap', selfAccept.body && selfAccept.body.error === 'ERR_NOT_YOUR_SWAP',
  JSON.stringify(selfAccept.body));

// Nor can an unrelated third party.
const strangerAccept = await call(`/api/swap/${swapId}/accept`, INVESTOR2, { method: 'POST', body: '{}' });
t('a bystander cannot accept it either', strangerAccept.status === 403, `got ${strangerAccept.status}`);
t('a bystander cannot even read it', (await call(`/api/swap/${swapId}`, INVESTOR2)).status === 403);
t('still nothing has moved', (await balanceOf(B, 'originator1')) === victimBefore);

// ---- the agreed path
const accepted = await call(`/api/swap/${swapId}/accept`, ORIGINATOR, { method: 'POST', body: '{}' });
t('the counterparty can accept', accepted.status === 200 && accepted.body.status === 'SETTLED', `got ${accepted.status}`);
t('both legs move together',
  (await balanceOf(B, 'originator1')) === victimBefore - 500 && (await balanceOf(B, 'investor1')) === raiderBefore + 500,
  `${victimBefore} -> ${await balanceOf(B, 'originator1')}`);
t('and it is written to the chain', accepted.body && Number.isInteger(accepted.body.blockHeight));

// A settled swap cannot be replayed.
const replay = await call(`/api/swap/${swapId}/accept`, ORIGINATOR, { method: 'POST', body: '{}' });
t('accepting twice is refused', replay.status === 409, `got ${replay.status}`);

// ---- cancelling
const second = await call('/api/swap', INVESTOR1, {
  method: 'POST',
  body: JSON.stringify({ giveAssetId: A, giveTokens: 1, getAssetId: B, getTokens: 1, counterparty: 'originator1' }),
});
const cancelId = second.body.swapId;
const strangerCancel = await call(`/api/swap/${cancelId}/cancel`, INVESTOR2, { method: 'POST', body: '{}' });
t('a bystander cannot cancel someone elses swap', strangerCancel.status === 403, `got ${strangerCancel.status}`);
const cancelled = await call(`/api/swap/${cancelId}/cancel`, ORIGINATOR, { method: 'POST', body: '{}' });
t('the person being asked can decline', cancelled.status === 200 && cancelled.body.status === 'CANCELLED', `got ${cancelled.status}`);
const acceptCancelled = await call(`/api/swap/${cancelId}/accept`, ORIGINATOR, { method: 'POST', body: '{}' });
t('a declined swap cannot then be accepted', acceptCancelled.status === 409, `got ${acceptCancelled.status}`);

// ---- listing
const mine = await call('/api/swaps', INVESTOR1);
t('a participant sees their own swaps', mine.status === 200 && mine.body.swaps.some((s) => s.swapId === swapId));
const outsider = await call('/api/swaps', INVESTOR2);
t('an outsider sees none of them',
  outsider.status === 200 && !outsider.body.swaps.some((s) => s.swapId === swapId),
  JSON.stringify(outsider.body).slice(0, 120));
t('a regulator can see them all',
  (await call('/api/swaps', REGULATOR)).body.swaps.some((s) => s.swapId === swapId));

// An unknown swap id is a 404.
t('an unknown swap id is 404', (await call('/api/swap/SWAP-nope/accept', INVESTOR1, { method: 'POST', body: '{}' })).status === 404);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
