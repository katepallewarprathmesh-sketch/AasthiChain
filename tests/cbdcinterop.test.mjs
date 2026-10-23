// Interoperability: paying somebody who holds a different kind of money.
//
// A digital rupee that can only pay another digital rupee wallet is a closed
// loop. These checks cover the three questions every instrument pair raises,
// because the failure mode of an interoperability feature is answering none
// of them and calling the result instant: which leg is final and when, who
// holds the claim in the gap, and whether the total changed.
//
//   node tests/cbdcinterop.test.mjs          (BASE=http://localhost:8080)

const BASE = process.env.BASE || 'http://localhost:8080';
let passed = 0, failed = 0;
const ok = (name, cond, detail) => {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failed++; console.log('  FAIL ' + name + (detail ? '\n       ' + detail : '')); }
};
const headers = (id, role) => ({ 'Content-Type': 'application/json', 'X-Fabric-Identity': id, 'X-Identity-Role': role });
const get = async (path, id, role) => {
  const r = await fetch(BASE + '/api/umi' + path, { headers: headers(id || 'investor1', role || 'Investor') });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const post = async (path, id, role, payload) => {
  const r = await fetch(BASE + '/api/umi' + path, { method: 'POST', headers: headers(id, role), body: JSON.stringify(payload || {}) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

async function main() {
  console.log('\nCBDC interoperability\n');

  const tag = Date.now();
  // A known demo identity: unverified identities are refused by the rail
  // before any of this layer's own rules get a chance to run.
  const payer = 'investor1';
  const shopkeeper = `interop-shop-${tag}`;

  // 1. The matrix, published rather than described.
  const root = await get('/cbdc/interop');
  ok('the interoperability layer is mounted', root.status === 200, JSON.stringify(root.body).slice(0, 140));
  const st = root.body;
  const routes = st.routes || [];
  ok('every instrument pair is published with its finality',
    routes.length >= 6 && routes.every((r) => r.from && r.to && r.nearLegFinality && r.farLegFinality),
    JSON.stringify(routes.map((r) => `${r.from}->${r.to}`)));
  const toBank = routes.find((r) => r.from === 'E_RUPEE' && r.to === 'BANK_ACCOUNT_UPI');
  ok('paying a bank account is supported but not final on both legs',
    toBank?.supported === true && toBank.nearLegFinality === 'FINAL' && toBank.farLegFinality === 'PROVISIONAL');
  ok('and it names who holds the claim in the gap',
    /suspense/i.test(String(toBank?.whoHoldsTheGap)), String(toBank?.whoHoldsTheGap));
  const fromBank = routes.find((r) => r.from === 'BANK_ACCOUNT_UPI' && r.to === 'E_RUPEE');
  ok('pulling from a bank account is declared unsupported, with the reason',
    fromBank?.supported === false && /authorisation it does not hold|not connected/i.test(String(fromBank?.how)));
  ok('the three questions are stated rather than implied', (st.theThreeQuestions || []).length === 3);
  ok('the disclaimer says no scheme or bank is connected',
    /No payment scheme, bank or second central bank is connected/i.test(String(st.disclaimer)));

  // 2. Digital rupee to digital rupee: one movement, final.
  await post('/cbdc/issue', 'regulator1', 'Regulator', { holder: payer, amountPaise: 1000000, kycTier: 'FULL_KYC' });
  const sameRail = await post('/cbdc/interop/pay', payer, 'Investor', {
    payer, payee: shopkeeper, fromInstrument: 'E_RUPEE', toInstrument: 'E_RUPEE', amountPaise: 100000,
  });
  ok('a payment between two wallets settles at once',
    sameRail.status === 201 && sameRail.body.payment.status === 'SETTLED',
    `${sameRail.status} ${JSON.stringify(sameRail.body).slice(0, 140)}`);
  ok('and it is final on both legs', sameRail.body.payment?.finality?.financial === 'FINAL');

  // 3. Digital rupee to a bank account: final here, provisional there, with
  // the money visibly in suspense in between.
  const before = await get('/cbdc/interop');
  const suspenseBefore = before.body.suspense.balancePaise;
  const crossRail = await post('/cbdc/interop/pay', payer, 'Investor', {
    payer, payee: 'shopkeeper@bank', fromInstrument: 'E_RUPEE', toInstrument: 'BANK_ACCOUNT_UPI',
    amountPaise: 250000, acceptedVia: 'the shop\'s existing QR code',
  });
  ok('a payment to a bank account is accepted', crossRail.status === 201,
    `${crossRail.status} ${JSON.stringify(crossRail.body).slice(0, 160)}`);
  const p = crossRail.body.payment || {};
  ok('it waits for the scheme rather than claiming to be done', p.status === 'AWAITING_SCHEME_SETTLEMENT', p.status);
  ok('the ledger leg is final and the payment is not',
    p.finality?.technical === 'FINAL_ON_LEDGER' && p.finality?.financial === 'PROVISIONAL',
    JSON.stringify(p.finality || {}).slice(0, 140));
  ok('it names the settlement window', !!p.finality?.settlementWindow, String(p.finality?.settlementWindow));
  ok('it records that the shopkeeper did not have to adopt anything',
    /QR/i.test(String(p.acceptedVia)), String(p.acceptedVia));

  const mid = await get('/cbdc/interop');
  ok('the money is visibly in suspense while the far leg is outstanding',
    mid.body.suspense.balancePaise === suspenseBefore + 250000,
    `${suspenseBefore} -> ${mid.body.suspense.balancePaise}`);

  // 4. Settlement is somebody's act, recorded as one.
  const byPayer = await post(`/cbdc/interop/payments/${p.paymentId}/settle`, payer, 'Investor', {});
  ok('a payer cannot declare the scheme settled', byPayer.status === 403, String(byPayer.status));
  const settled = await post(`/cbdc/interop/payments/${p.paymentId}/settle`, 'regulator1', 'Regulator', {});
  ok('a supervisor can record the scheme settlement', settled.status === 200, String(settled.status));
  ok('the payment becomes final on both legs',
    settled.body.payment.status === 'SETTLED' && settled.body.payment.finality.financial === 'FINAL');
  ok('the record says a person said so, not that the rail observed it',
    /Nothing here observed a scheme settling/i.test(String(settled.body.note)));
  const twice = await post(`/cbdc/interop/payments/${p.paymentId}/settle`, 'regulator1', 'Regulator', {});
  ok('it cannot be settled twice', twice.status === 409, String(twice.status));

  const after = await get('/cbdc/interop');
  ok('the suspense account empties when the far leg lands',
    after.body.suspense.balancePaise === suspenseBefore, `${after.body.suspense.balancePaise}`);

  // 5. A conversion is not a payment, and the refusal explains the difference.
  const wrongWay = await post('/cbdc/interop/pay', payer, 'Investor', {
    payer, payee: payer, fromInstrument: 'TOKENISED_DEPOSIT', toInstrument: 'E_RUPEE', amountPaise: 1000,
  });
  ok('converting through the payment path is refused', wrongWay.status === 409, String(wrongWay.status));
  ok('and the refusal points at the conversion path',
    /conversion, not a payment/i.test(String(wrongWay.body.message)), String(wrongWay.body.message).slice(0, 160));
  const foreign = await post('/cbdc/interop/pay', payer, 'Investor', {
    payer, payee: 'someone', fromInstrument: 'E_RUPEE', toInstrument: 'FOREIGN_CBDC', amountPaise: 1000,
  });
  ok('paying another central bank\'s money is sent to the corridor layer',
    foreign.status === 409 && /corridor/i.test(String(foreign.body.message)), String(foreign.body.message).slice(0, 140));
  const pulling = await post('/cbdc/interop/pay', payer, 'Investor', {
    payer, payee: payer, fromInstrument: 'BANK_ACCOUNT_UPI', toInstrument: 'E_RUPEE', amountPaise: 1000,
  });
  ok('pulling from a bank is refused with the missing authorisation named',
    pulling.status === 409 && /authorisation it does not hold/i.test(String(pulling.body.message)));

  // 6. The conversion itself: the total must not move.
  //
  // This section uses a holder of its own. The rail outlives a single run
  // and other suites credit the shared demo accounts, so an absolute
  // balance here would be asserting about state this test did not create.
  // A fresh holder makes every figure below a consequence of this run.
  // The holder is fresh, the caller is the supervisor: only five demo
  // identities can authenticate against the app, so a new account cannot
  // speak for itself, and a conversion on behalf of a holder is a
  // supervisory act the rail already allows.
  const converter = 'investor-convert-' + Date.now().toString(36);
  // The tier has to exist before a conversion will create money into the
  // account, so issue a token amount first and read the supply after it.
  await post('/cbdc/issue', 'regulator1', 'Regulator', { holder: converter, amountPaise: 100, kycTier: 'FULL_KYC' });
  const supplyBefore = (await get('/cbdc')).body.conservation;
  const credited = await post('/cbdc/interop/deposits', 'regulator1', 'Regulator', { holder: converter, amountPaise: 400000 });
  ok('a tokenised deposit can be credited for the demonstration', credited.status === 201, String(credited.status));
  ok('and it says no bank was involved', /No bank was involved/i.test(String(credited.body.note)));

  const tooMuch = await post('/cbdc/interop/convert', 'regulator1', 'Regulator', {
    holder: converter, direction: 'DEPOSIT_TO_E_RUPEE', amountPaise: 900000,
  });
  ok('converting more deposit than exists is refused', tooMuch.status === 409, String(tooMuch.status));

  const converted = await post('/cbdc/interop/convert', 'regulator1', 'Regulator', {
    holder: converter, direction: 'DEPOSIT_TO_E_RUPEE', amountPaise: 300000,
  });
  ok('a deposit converts into central bank money', converted.status === 200,
    `${converted.status} ${JSON.stringify(converted.body).slice(0, 140)}`);
  ok('the deposit is destroyed by exactly what was converted',
    converted.body.depositBalancePaise === 100000, String(converted.body.depositBalancePaise));
  ok('the money identity holds after the conversion', converted.body.conservation?.conserved === true,
    JSON.stringify(converted.body.conservation || {}).slice(0, 140));
  ok('the issued total rose by the converted amount',
    converted.body.conservation.issuedPaise === supplyBefore.issuedPaise + 300000,
    `${supplyBefore.issuedPaise} -> ${converted.body.conservation.issuedPaise}`);

  const back = await post('/cbdc/interop/convert', 'regulator1', 'Regulator', {
    holder: converter, direction: 'E_RUPEE_TO_DEPOSIT', amountPaise: 300000,
  });
  ok('and it converts back the other way', back.status === 200, String(back.status));
  ok('the deposit is restored', back.body.depositBalancePaise === 400000, String(back.body.depositBalancePaise));
  ok('the identity still holds after the round trip', back.body.conservation?.conserved === true);

  // 7. Everything is on the chain.
  const chain = await (await fetch(BASE + '/api/drunix/chain?limit=60')).json();
  const types = (chain.blocks || []).map((b) => b.type);
  ok('a cross-instrument payment writes a block', types.includes('UMI_CBDC_INTEROP_PAID'));
  ok('the scheme settlement writes its own block', types.includes('UMI_CBDC_INTEROP_SETTLED'));
  ok('a conversion writes its own block', types.includes('UMI_CBDC_INTEROP_CONVERTED'));

  const list = await get('/cbdc/interop/payments?limit=5');
  ok('payments can be listed', list.status === 200 && Array.isArray(list.body.payments));
  const one = await get(`/cbdc/interop/payments/${p.paymentId}`);
  ok('and one can be read by its reference', one.status === 200 && one.body.payment.paymentId === p.paymentId);
  const missing = await get('/cbdc/interop/payments/CBIX-NOPE');
  ok('an unknown reference is reported as unknown', missing.status === 404, String(missing.status));

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
