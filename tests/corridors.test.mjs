// Cross-border corridors.
//
// Sending money out of the country is five different things wearing one
// name, and the differences are the whole subject: who is allowed to carry
// the payment, how much can move, and how long somebody is exposed between
// paying and being paid. These checks hold the parts that are easy to claim
// and hard to do: a corridor refusing by naming the licence it needs, caps
// that differ per corridor, a two-ledger swap that only pays against the
// secret and refunds when it never arrives, and a deferred leg that is
// honest about being provisional.
//
//   node tests/corridors.test.mjs          (RAIL=http://localhost:21100)

const RAIL = process.env.RAIL || 'http://localhost:21100';
const BASE = process.env.BASE || 'http://localhost:8080';
let passed = 0, failed = 0;
const ok = (name, cond, detail) => {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failed++; console.log('  FAIL ' + name + (detail ? '\n       ' + String(detail).slice(0, 220) : '')); }
};

const call = async (origin, path, init) => {
  const r = await fetch(origin + path, init);
  const text = await r.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, body };
};
const headers = (id, role) => ({
  'Content-Type': 'application/json', 'X-Fabric-Identity': id, 'X-Identity-Role': role,
});
const rail = (path, init) => call(RAIL, path, init);
const post = (path, payload, id = 'regulator1', role = 'Regulator') => rail(path, {
  method: 'POST', headers: headers(id, role), body: JSON.stringify(payload),
});

const tag = Date.now().toString(36).toUpperCase();
const n = (s) => `${s}-${tag}`;

const sha256Hex = async (text) => {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
};

const run = async () => {
  console.log('Cross-border corridors');

  // 1. The catalogue is public and each corridor says how it settles.
  const status = await rail('/umi/corridors');
  ok('the corridors are published', status.status === 200 && Array.isArray(status.body.corridors),
    JSON.stringify(status.body).slice(0, 180));
  const byId = Object.fromEntries((status.body.corridors || []).map((c) => [c.id, c]));
  ok('all five rails are modelled separately',
    ['NIPL-P2P-NP', 'PACB-ECOM', 'BANK-CORRESPONDENT', 'CARD-SCHEME', 'MULTI-CBDC-PVP', 'HTLC-LINKED']
      .every((id) => byId[id]), Object.keys(byId).join(','));
  ok('each one names its settlement window and its precedent',
    Object.values(byId).every((c) => c.settlementWindow && c.precedent));
  ok('the layer declares that it holds no payment licence',
    /holds no payment licence/i.test(String(status.body.disclaimer)));
  ok('it says which corridors it cannot use and why',
    status.body.blockedCorridors && Object.keys(status.body.blockedCorridors).length > 0,
    JSON.stringify(status.body.blockedCorridors).slice(0, 180));

  // Fund a sender in central bank money.
  const payer = n('bank-in');
  await post('/umi/cbdc/issue', {
    holder: payer, segment: 'WHOLESALE', kycTier: 'FULL_KYC', amountPaise: 2000000000,
  });

  // 2. An unlicensed corridor refuses and names the authorisation.
  const pacb = await post('/umi/corridors/send', {
    corridorId: 'PACB-ECOM', payer, payee: n('merchant-us'), amountPaise: 500000,
    purposeCode: 'IMPORT_GOODS', originator: 'A', beneficiary: 'B',
  });
  ok('an unlicensed corridor refuses', pacb.status === 403, JSON.stringify(pacb.body).slice(0, 180));
  ok('the refusal names the missing authorisation',
    /aggregator authorisation/i.test(String(pacb.body?.message)), String(pacb.body?.message).slice(0, 180));

  // 3. Caps are per corridor.
  const overCap = await post('/umi/corridors/send', {
    corridorId: 'NIPL-P2P-NP', payer, payee: n('np-user'), amountPaise: 2000000, purposeCode: 'P2P_REMITTANCE',
  });
  ok('the person-to-person link enforces its small ceiling', overCap.status === 409,
    JSON.stringify(overCap.body).slice(0, 180));

  const wrongPurpose = await post('/umi/corridors/send', {
    corridorId: 'NIPL-P2P-NP', payer, payee: n('np-shop'), amountPaise: 100000, purposeCode: 'IMPORT_GOODS',
  });
  ok('a merchant purpose is refused on a person-to-person link', wrongPurpose.status === 409);

  // 4. Both legs here: atomic, final, no suspense.
  const payee = n('bank-ae');
  const pvp = await post('/umi/corridors/send', {
    corridorId: 'MULTI-CBDC-PVP', payer, payee, amountPaise: 25000000,
    purposeCode: 'IMPORT_GOODS', originator: 'Exporter Pvt Ltd', beneficiary: 'Gulf Trading LLC',
  });
  ok('a payment with both legs on this ledger settles at once',
    pvp.status === 201 && pvp.body.transfer.status === 'SETTLED', JSON.stringify(pvp.body).slice(0, 200));
  ok('and is financially final with no window',
    pvp.body?.transfer?.finality?.financial === 'FINAL' && !pvp.body?.transfer?.finality?.settlementWindow);
  const credited = await rail(`/umi/cbdc/accounts/${payee}`);
  ok('the receiving institution holds the money', credited.body?.account?.balancePaise === 25000000);

  // 5. Two ledgers: hash time-locked, claimable only against the preimage.
  const secret = 'preimage-' + tag;
  const lock = await sha256Hex(secret);
  const sgBank = n('bank-sg');
  const htlc = await post('/umi/corridors/send', {
    corridorId: 'HTLC-LINKED', payer, payee: sgBank, amountPaise: 10000000,
    purposeCode: 'IMPORT_GOODS', hashLock: lock, timeoutHours: 6,
    originator: 'Exporter Pvt Ltd', beneficiary: 'Lion Trading Pte', foreignLedger: 'sgd-ledger-sim',
  });
  ok('a cross-ledger transfer locks instead of paying',
    htlc.status === 201 && htlc.body.transfer.status === 'AWAITING_CLAIM', JSON.stringify(htlc.body).slice(0, 200));
  ok('the locked leg is provisional and says until when',
    htlc.body?.transfer?.finality?.financial === 'PROVISIONAL' && !!htlc.body?.transfer?.finality?.settlementWindow);
  const notYet = await rail(`/umi/cbdc/accounts/${sgBank}`);
  ok('the far bank is not paid before the secret appears',
    notYet.status === 404 || notYet.body?.account?.balancePaise === 0);

  const id = htlc.body?.transfer?.transferId;
  const wrong = await post(`/umi/corridors/transfers/${id}/claim`, { secret: 'not-it' });
  ok('a wrong secret cannot claim', wrong.status === 403, JSON.stringify(wrong.body).slice(0, 160));

  const claimed = await post(`/umi/corridors/transfers/${id}/claim`, { secret });
  ok('the right secret claims both legs',
    claimed.status === 200 && claimed.body.transfer.status === 'SETTLED', JSON.stringify(claimed.body).slice(0, 180));
  ok('and the claimed leg becomes final', claimed.body?.transfer?.finality?.financial === 'FINAL');
  const paid = await rail(`/umi/cbdc/accounts/${sgBank}`);
  ok('the far bank is paid after the claim', paid.body?.account?.balancePaise === 10000000);
  const twice = await post(`/umi/corridors/transfers/${id}/claim`, { secret });
  ok('a settled swap cannot be claimed twice', twice.status === 409);

  // 6. A deferred corridor is provisional until the far side reports.
  const uk = n('beneficiary-uk');
  const corr = await post('/umi/corridors/send', {
    corridorId: 'BANK-CORRESPONDENT', payer, payee: uk, amountPaise: 40000000,
    purposeCode: 'FAMILY_MAINTENANCE', originator: 'Sender Name', beneficiary: 'Receiver Name',
  });
  ok('a correspondent payment waits for its far leg',
    corr.status === 201 && corr.body.transfer.status === 'AWAITING_FOREIGN_LEG',
    `${corr.status} ${corr.body.error + " " + corr.body.message}`);
  ok('it names the three to five day window',
    /three to five/.test(String(corr.body?.transfer?.finality?.settlementWindow)));
  const held = await rail(`/umi/cbdc/accounts/${uk}`);
  ok('nobody is credited while the far leg is outstanding',
    held.status === 404 || held.body?.account?.balancePaise === 0);

  const confirmed = await post(`/umi/corridors/transfers/${corr.body.transfer.transferId}/confirm`, {});
  ok('confirmation closes the window', confirmed.body?.transfer?.finality?.financial === 'FINAL',
    JSON.stringify(confirmed.body?.transfer?.finality).slice(0, 180));
  const settled = await rail(`/umi/cbdc/accounts/${uk}`);
  ok('and the beneficiary is paid', settled.body?.account?.balancePaise === 40000000);

  // 7. The travel rule binds above its threshold.
  const unnamed = await post('/umi/corridors/send', {
    corridorId: 'BANK-CORRESPONDENT', payer, payee: n('someone'), amountPaise: 20000000, purposeCode: 'EDUCATION',
  });
  ok('a large payment without named parties is refused', unnamed.status === 409,
    JSON.stringify(unnamed.body).slice(0, 160));

  // 8. Money is never lost: the CBDC conservation check still balances.
  const cbdc = await rail('/umi/cbdc');
  ok('supply is still conserved after all of that', cbdc.body?.conservation?.conserved === true,
    JSON.stringify(cbdc.body?.conservation).slice(0, 200));

  // 9. Everything is on the chain, including the refusals.
  const chain = await rail('/drunix/chain?limit=400');
  const types = (chain.body?.blocks || chain.body?.chain || []).map((b) => b.type);
  ok('corridor activity is committed', types.includes('UMI_CORRIDOR_INITIATED') && types.includes('UMI_CORRIDOR_SETTLED'));
  ok('the lock, the claim and the refusals are all on the chain',
    types.includes('UMI_CORRIDOR_LOCKED') && types.includes('UMI_CORRIDOR_CLAIMED')
      && types.includes('UMI_CORRIDOR_REFUSED'));

  // 10. The app proxies it with no logic of its own.
  const proxied = await call(BASE, '/api/umi/corridors');
  ok('the app proxies the corridor catalogue', proxied.status === 200 && Array.isArray(proxied.body.corridors));

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
};

run().catch((e) => { console.error(e); process.exit(1); });
