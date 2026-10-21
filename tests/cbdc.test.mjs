// Central bank digital currency as the settlement asset.
//
// The claim this layer makes is that the money itself is on the ledger, not
// beside it, and that it behaves the way the pilot behaves: purpose-bound
// where the sponsor binds it, spendable offline within bounds, released by a
// rule rather than by a claim form, and honest about which kind of finality
// it has actually reached.
//
// These checks hold the parts that would be easy to fake: supply has to be
// conserved, a refused spend has to be on the chain, a double-spent offline
// voucher has to be caught, and a payment that is only technically final must
// not be reported as settled.
//
//   node tests/cbdc.test.mjs               (RAIL=http://localhost:21100)

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
const post = (path, id, role, payload) => rail(path, {
  method: 'POST', headers: headers(id, role), body: JSON.stringify(payload),
});

const tag = Date.now().toString(36).toUpperCase();
const n = (s) => `${s}-${tag}`;

const run = async () => {
  console.log('CBDC settlement layer');

  // 1. The layer describes itself, including that it is a simulation.
  const status = await rail('/umi/cbdc');
  ok('the layer publishes its policy', status.status === 200 && status.body.policy, JSON.stringify(status.body).slice(0, 180));
  ok('it declares that no central bank money is issued',
    /no central bank money is issued/i.test(String(status.body.disclaimer)));
  ok('it describes both finalities separately',
    status.body.finality && status.body.finality.technical && status.body.finality.financial);
  ok('it publishes the offline bounds and the KYC caps',
    !!status.body.policy.offline && !!status.body.policy.kycTiers);

  // 2. Issuance is the central bank's act.
  const bad = await post('/umi/cbdc/issue', 'investor1', 'Investor', { holder: n('x'), amountPaise: 100 });
  ok('an ordinary participant cannot create money', bad.status === 403, JSON.stringify(bad.body).slice(0, 140));

  const treasury = n('treasury');
  const issued = await post('/umi/cbdc/issue', 'regulator1', 'Regulator', {
    holder: treasury, segment: 'WHOLESALE', kycTier: 'FULL_KYC', amountPaise: 50000000,
  });
  ok('the regulator can issue', issued.status === 201 && issued.body.account.balancePaise === 50000000,
    JSON.stringify(issued.body).slice(0, 180));
  ok('a direct issue is financially final',
    issued.body.movement.finality.financial === 'FINAL' && issued.body.movement.finality.technical === 'FINAL_ON_LEDGER');
  ok('finality cites the block that carries it',
    issued.body.movement.finality.blockHash && issued.body.movement.finality.blockHeight > 0);

  // 3. A bank-funded issue is technically final and financially provisional.
  const prov = await post('/umi/cbdc/issue', 'regulator1', 'Regulator', {
    holder: n('bankfunded'), segment: 'WHOLESALE', kycTier: 'FULL_KYC', amountPaise: 100000, fundedByBankRail: true,
  });
  ok('a bank-funded issue stays provisional', prov.body?.movement?.finality?.financial === 'PROVISIONAL');
  ok('and names the window that would close it', !!prov.body?.movement?.finality?.settlementWindow);

  // 4. Programmable money: the conditions bind, and refusals are visible.
  const beneficiary = n('beneficiary');
  const grant = await post('/umi/cbdc/grants', 'regulator1', 'Regulator', {
    sponsor: treasury, beneficiary, amountPaise: 500000,
    condition: { purpose: 'PDS food subsidy', merchantCategories: ['FAIR_PRICE_SHOP'], allowedStates: ['Maharashtra'] },
  });
  ok('money can be bound to a purpose', grant.status === 201 && grant.body.grant.grantId,
    JSON.stringify(grant.body).slice(0, 180));
  const grantId = grant.body?.grant?.grantId;

  const wrongShop = await post(`/umi/cbdc/grants/${grantId}/spend`, 'regulator1', 'Regulator', {
    merchant: n('liquor'), merchantCategory: 'LIQUOR', state: 'Maharashtra', amountPaise: 10000,
  });
  ok('a spend outside the purpose is refused', wrongShop.status === 409, JSON.stringify(wrongShop.body).slice(0, 160));
  ok('the refusal explains itself in words', /spendable only at/i.test(String(wrongShop.body?.message)));

  const wrongState = await post(`/umi/cbdc/grants/${grantId}/spend`, 'regulator1', 'Regulator', {
    merchant: n('fps-goa'), merchantCategory: 'FAIR_PRICE_SHOP', state: 'Goa', amountPaise: 10000,
  });
  ok('geography binds too', wrongState.status === 409);

  const merchant = n('fps-pune');
  const good = await post(`/umi/cbdc/grants/${grantId}/spend`, 'regulator1', 'Regulator', {
    merchant, merchantCategory: 'FAIR_PRICE_SHOP', state: 'Maharashtra', amountPaise: 120000,
  });
  ok('a compliant spend goes through', good.status === 201 && good.body.grant.spentPaise === 120000,
    JSON.stringify(good.body).slice(0, 160));
  const shop = await rail(`/umi/cbdc/accounts/${merchant}`);
  ok('the merchant actually holds the money', shop.body?.account?.balancePaise === 120000);

  // 5. The offline path.
  const villager = n('villager');
  await post('/umi/cbdc/issue', 'regulator1', 'Regulator', {
    holder: villager, segment: 'RETAIL', kycTier: 'FULL_KYC', amountPaise: 200000,
  });
  const voucher = await post('/umi/cbdc/offline/issue', 'regulator1', 'Regulator', {
    holder: villager, device: 'phone-nfc-' + tag, amountPaise: 30000,
  });
  ok('value can be reserved as an offline voucher', voucher.status === 201 && voucher.body.voucher.signature,
    JSON.stringify(voucher.body).slice(0, 160));
  const after = await rail(`/umi/cbdc/accounts/${villager}`);
  ok('the reserved value leaves the online balance',
    after.body?.account?.offlineReservedPaise === 30000 && after.body?.availablePaise === 170000,
    JSON.stringify(after.body).slice(0, 160));

  const tooBig = await post('/umi/cbdc/offline/issue', 'regulator1', 'Regulator', {
    holder: villager, device: 'phone-nfc-' + tag, amountPaise: 90000,
  });
  ok('the small-value cap binds', tooBig.status === 409, JSON.stringify(tooBig.body).slice(0, 140));

  const kirana = n('kirana');
  const redeem = await post('/umi/cbdc/offline/redeem', 'regulator1', 'Regulator', {
    voucher: voucher.body.voucher, payee: kirana,
  });
  ok('an offline payment reconciles when the signal returns',
    redeem.status === 201 && redeem.body.movement.mode === 'OFFLINE', JSON.stringify(redeem.body).slice(0, 160));

  const again = await post('/umi/cbdc/offline/redeem', 'regulator1', 'Regulator', {
    voucher: voucher.body.voucher, payee: n('kirana2'),
  });
  ok('the same voucher cannot be spent twice',
    again.status === 409 && /DOUBLE_SPEND/.test(JSON.stringify(again.body)), JSON.stringify(again.body).slice(0, 160));

  // 6. Conditional release: the cancelled flight pays its own refund.
  const insurer = n('insurer');
  const passenger = n('passenger');
  await post('/umi/cbdc/issue', 'regulator1', 'Regulator', {
    holder: insurer, segment: 'WHOLESALE', kycTier: 'FULL_KYC', amountPaise: 2000000,
  });
  const flight = 'FLT-' + tag;
  const cond = await post('/umi/cbdc/conditions', 'regulator1', 'Regulator', {
    payer: insurer, payee: passenger, amountPaise: 750000,
    eventType: 'FLIGHT_CANCELLED', eventKey: flight, attestor: 'registrar1', deadlineHours: 24,
  });
  ok('money can be locked against an event', cond.status === 201 && cond.body.condition.status === 'OPEN',
    JSON.stringify(cond.body).slice(0, 160));

  const wrongParty = await post('/umi/cbdc/events', 'investor1', 'Investor', {
    eventType: 'FLIGHT_CANCELLED', eventKey: flight,
  });
  ok('only the named attestor can trigger the payout', wrongParty.body?.count === 0,
    JSON.stringify(wrongParty.body).slice(0, 160));

  const attested = await post('/umi/cbdc/events', 'registrar1', 'Registrar', {
    eventType: 'FLIGHT_CANCELLED', eventKey: flight,
  });
  ok('the attested event releases the money', attested.body?.count === 1,
    JSON.stringify(attested.body).slice(0, 160));
  const paid = await rail(`/umi/cbdc/accounts/${passenger}`);
  ok('the passenger was refunded without filing a claim', paid.body?.account?.balancePaise === 750000);
  ok('the payout is financially final, not provisional',
    attested.body?.released?.[0]?.finality?.financial === 'FINAL');

  // 7. Supply conservation, the invariant anybody can check.
  const cons = await rail('/umi/cbdc');
  ok('supply is conserved across everything above', cons.body?.conservation?.conserved === true,
    JSON.stringify(cons.body?.conservation).slice(0, 200));

  // 8. Screening travels with movements.
  const moves = await rail('/umi/cbdc/movements?limit=50');
  const withAml = (moves.body?.movements || []).filter((m) => m.aml && m.aml.decision);
  ok('every movement carries its screening', withAml.length === (moves.body?.movements || []).length && withAml.length > 0);
  ok('screening reports the rules and the model',
    withAml.some((m) => typeof m.aml.ruleScore === 'number' && typeof m.aml.modelScore === 'number'));

  // 9. Refusals reach the chain, where an auditor can see them.
  const chain = await rail('/drunix/chain?limit=400');
  const blocks = chain.body?.blocks || chain.body?.chain || [];
  const types = blocks.map((b) => b.type);
  ok('refusals are committed, not only returned', types.includes('UMI_CBDC_REFUSED'),
    [...new Set(types)].join(',').slice(0, 200));
  ok('the programmable and offline paths are on the chain',
    types.includes('UMI_CBDC_GRANTED') && types.includes('UMI_CBDC_OFFLINE_ISSUED')
      && types.includes('UMI_CBDC_CONDITION_RELEASED'));

  // 10. The app proxies it with no logic of its own.
  const proxied = await call(BASE, '/api/umi/cbdc');
  ok('the app proxies the CBDC status', proxied.status === 200 && !!proxied.body.policy);

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
};

run().catch((e) => { console.error(e); process.exit(1); });
