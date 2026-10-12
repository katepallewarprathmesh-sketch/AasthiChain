// A freeze has to stop the money, not just the transfer route.
//
// Two faults sat on top of each other here.
//
// The first: freezing a property returned 200 FROZEN, set the status in the
// instance's memory, and never persisted it. The next request reloaded
// properties from the persisted copy and the property was tradeable again.
// A regulator could halt an asset, be told it was halted, and watch it keep
// trading — the strongest control in the system was cosmetic.
//
// The second: even where the freeze did hold, /api/swap never looked at the
// property status at all. A transfer of a frozen asset was refused, so the
// halt was really just a longer route — propose a swap, have the other side
// accept, and the same tokens moved. The same money was reachable through a
// second route family that had never been told the rule.
//
// And a freeze with no way back is a trap, so lifting one is tested too.
import { randomBytes } from 'node:crypto';

const API = process.env.API || 'http://localhost:8080';

let pass = 0, fail = 0;
const t = (name, ok, detail) => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};

const tok = (id, role) =>
  Buffer.from(JSON.stringify({ identityId: id, mspId: 'M', role, exp: Date.now() + 3600000 })).toString('base64');

const AS = {
  originator: { token: tok('originator1', 'Originator'), id: 'originator1' },
  registrar: { token: tok('registrar1', 'Registrar'), id: 'registrar1' },
  regulator: { token: tok('regulator1', 'Regulator'), id: 'regulator1' },
  investor1: { token: tok('investor1', 'Investor'), id: 'investor1' },
  investor2: { token: tok('investor2', 'Investor'), id: 'investor2' },
};

async function call(path, { as = AS.investor1, method = 'GET', body } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${as.token}`,
      'X-Fabric-Identity': as.id,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let parsed = null;
  try { parsed = await res.json(); } catch { /* not json */ }
  return { status: res.status, body: parsed || {}, raw: JSON.stringify(parsed || {}) };
}

async function tokenisedAsset(label) {
  const made = await call('/api/properties', {
    as: AS.originator, method: 'POST',
    body: { address: label, valuationINR: 500000, documentHash: randomBytes(32).toString('hex'), totalTokens: 1000 },
  });
  const assetId = made.body.assetId;
  if (!assetId) return null;
  await call(`/api/properties/${assetId}/validate`, { as: AS.registrar, method: 'POST', body: { decision: 'VALIDATED' } });
  await call(`/api/properties/${assetId}/mint`, { as: AS.originator, method: 'POST', body: { totalTokens: 1000 } });
  return assetId;
}

const statusOf = async (assetId) => {
  const list = await call('/api/properties');
  const found = (list.body.properties || []).find(p => p.assetId === assetId);
  return found ? found.status : null;
};

console.log(`Freeze scope (${API})`);

const frozen = await tokenisedAsset('Freeze Scope A');
const clean = await tokenisedAsset('Freeze Scope B');

if (!frozen || !clean) {
  t('two properties could be created to test against', false, 'property creation failed');
} else {
  await call('/api/transfers', {
    as: AS.originator, method: 'POST',
    body: { assetId: frozen, fromId: 'originator1', toId: 'investor1', amount: 100, tokens: 100 },
  });
  await call('/api/transfers', {
    as: AS.originator, method: 'POST',
    body: { assetId: clean, fromId: 'originator1', toId: 'investor2', amount: 100, tokens: 100 },
  });

  // ---- only a supervisor may freeze
  const investorFreeze = await call(`/api/properties/${frozen}/freeze`, {
    as: AS.investor1, method: 'POST', body: { reason: 'I feel like it' },
  });
  t('an investor cannot freeze a property', investorFreeze.status === 403, `got ${investorFreeze.status}`);

  const froze = await call(`/api/properties/${frozen}/freeze`, {
    as: AS.regulator, method: 'POST', body: { reason: 'under investigation' },
  });
  t('a regulator can freeze a property', froze.status === 200, `got ${froze.status}`);

  // ---- and the freeze has to survive the next request
  t('  and the freeze is still there on the next request',
    (await statusOf(frozen)) === 'FROZEN', `status is ${await statusOf(frozen)}`);

  // ---- every route that moves tokens must honour it
  const transfer = await call('/api/transfers', {
    as: AS.investor1, method: 'POST',
    body: { assetId: frozen, fromId: 'investor1', toId: 'investor2', amount: 10, tokens: 10 },
  });
  t('a transfer of frozen tokens is refused',
    transfer.status >= 400 && /FROZEN/i.test(transfer.raw), `${transfer.status} ${transfer.raw.slice(0, 120)}`);

  const swap = await call('/api/swap', {
    as: AS.investor1, method: 'POST',
    body: { giveAssetId: frozen, giveTokens: 10, getAssetId: clean, getTokens: 5, counterparty: 'investor2' },
  });
  t('a swap of frozen tokens is refused too',
    swap.status >= 400 && /FROZEN/i.test(swap.raw), `${swap.status} ${swap.raw.slice(0, 140)}`);
  t('  and no swap was created', !swap.body.swapId, swap.raw.slice(0, 120));

  const reverseSwap = await call('/api/swap', {
    as: AS.investor2, method: 'POST',
    body: { giveAssetId: clean, giveTokens: 5, getAssetId: frozen, getTokens: 10, counterparty: 'investor1' },
  });
  t('a swap is refused whichever leg the frozen asset is on',
    reverseSwap.status >= 400 && /FROZEN/i.test(reverseSwap.raw), `${reverseSwap.status}`);

  // ---- the race: frozen after a proposal exists, before it is accepted
  const second = await tokenisedAsset('Freeze Scope C');
  await call('/api/transfers', {
    as: AS.originator, method: 'POST',
    body: { assetId: second, fromId: 'originator1', toId: 'investor1', amount: 50, tokens: 50 },
  });
  const pending = await call('/api/swap', {
    as: AS.investor1, method: 'POST',
    body: { giveAssetId: second, giveTokens: 10, getAssetId: clean, getTokens: 5, counterparty: 'investor2' },
  });
  if (!pending.body.swapId) {
    t('a swap could be proposed for the race check', false, pending.raw.slice(0, 140));
  } else {
    await call(`/api/properties/${second}/freeze`, { as: AS.regulator, method: 'POST', body: { reason: 'mid-swap' } });
    const accepted = await call(`/api/swap/${pending.body.swapId}/accept`, { as: AS.investor2, method: 'POST', body: {} });
    t('a swap frozen after proposal cannot be accepted',
      accepted.status >= 400 && /FROZEN/i.test(accepted.raw), `${accepted.status} ${accepted.raw.slice(0, 140)}`);
    t('  and the tokens did not move',
      (await call(`/api/balances/${second}/investor2`)).status === 404 ||
      Number((await call(`/api/balances/${second}/investor2`)).body.balance || 0) === 0);
  }

  // ---- a freeze must be liftable, by the right people only
  const investorLift = await call(`/api/properties/${frozen}/unfreeze`, { as: AS.investor1, method: 'POST', body: {} });
  t('an investor cannot lift a freeze', investorLift.status === 403, `got ${investorLift.status}`);

  const lifted = await call(`/api/properties/${frozen}/unfreeze`, { as: AS.regulator, method: 'POST', body: {} });
  t('a regulator can lift a freeze', lifted.status === 200, `${lifted.status} ${lifted.raw.slice(0, 120)}`);
  t('  and the property goes back to what it was before',
    lifted.body.status === 'TOKENIZED', lifted.raw.slice(0, 120));
  t('  and it survives the next request', (await statusOf(frozen)) === 'TOKENIZED');

  const tradeAgain = await call('/api/swap', {
    as: AS.investor1, method: 'POST',
    body: { giveAssetId: frozen, giveTokens: 10, getAssetId: clean, getTokens: 5, counterparty: 'investor2' },
  });
  t('  and trading works again afterwards', tradeAgain.status === 201 || tradeAgain.status === 200,
    `${tradeAgain.status} ${tradeAgain.raw.slice(0, 120)}`);

  const liftAgain = await call(`/api/properties/${frozen}/unfreeze`, { as: AS.regulator, method: 'POST', body: {} });
  t('lifting a freeze that is not there is refused', liftAgain.status === 409, `got ${liftAgain.status}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
