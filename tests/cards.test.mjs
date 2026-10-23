// Card rail economics and the dispute ladder, against the running rail.
//
// Two things make a card different from every other corridor here, and both
// were previously prose:
//
//   1. The merchant never receives what the cardholder paid. The issuer, the
//      network and the acquirer take their cut first, and in India some of
//      those cuts are fixed by law. The invariant worth guarding is that the
//      three shares sum to the merchant discount rate to the paise, because
//      a model that does not balance produces a settlement file nobody can
//      reconcile.
//   2. An approval is not a payment. It can be reversed for 120 days, longer
//      on delivery grounds, by a party who was not in the transaction. The
//      deadlines differ per network and liability moves depending on how the
//      cardholder was authenticated.
//
//   node tests/cards.test.mjs              (RAIL=http://localhost:21100)

const RAIL = process.env.RAIL || 'http://localhost:21100';
let passed = 0, failed = 0;
const ok = (name, cond, detail) => {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failed++; console.log('  FAIL ' + name + (detail ? '\n       ' + detail : '')); }
};

const call = async (path, init) => {
  const r = await fetch(RAIL + path, init);
  const text = await r.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, body };
};
const post = (path, payload) => call(path, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Identity-Id': 'originator1', 'X-Fabric-Identity': 'originator1' },
  body: JSON.stringify(payload || {}),
});

const run = async () => {
  console.log('Card rail economics and disputes');

  // ---------------------------------------------------------- the posture
  const posture = await call('/umi/cards/posture', { method: 'GET' });
  ok('the fee schedule is published before anyone transacts', posture.status === 200,
    'status ' + posture.status);
  ok('every published rate cites its authority',
    (posture.body.schedules || []).every(s => (s.authority || '').length > 10));
  ok('both networks are published with their own clocks', (posture.body.networks || []).length === 2);
  const visa = (posture.body.networks || []).find(n => n.network === 'VISA') || {};
  const mc = (posture.body.networks || []).find(n => n.network === 'MASTERCARD') || {};
  ok('the two networks give merchants different response windows',
    visa.merchantResponseDays === 30 && mc.merchantResponseDays === 45,
    JSON.stringify([visa.merchantResponseDays, mc.merchantResponseDays]));
  ok('the arbitration case fees are published', visa.arbitrationFeeUSD === 600 && mc.arbitrationFeeUSD === 575);
  ok('the reason codes are published with the evidence that answers them',
    (posture.body.reasonCodes || []).length >= 8 &&
    (posture.body.reasonCodes || []).every(c => (c.evidenceThatDefendsIt || '').length > 10));
  ok('the desk declares that it is not connected to a scheme',
    /no card scheme membership/i.test(posture.body.simulated || ''));

  // ------------------------------------------------------- the arithmetic
  const price = async (payload) => (await post('/umi/cards/price', payload)).body;

  const credit = await price({ amountPaise: 10000000, instrument: 'CREDIT', channel: 'ONLINE' });
  ok('the split sums to the merchant discount rate exactly',
    credit.interchangePaise + credit.schemeFeePaise + credit.acquirerMarginPaise === credit.mdrPaise,
    JSON.stringify(credit));
  ok('the merchant side reconciles against the ticket',
    credit.merchantReceivesPaise + credit.mdrPaise + credit.gstOnFeePaise === credit.amountPaise);
  ok('the issuer takes the largest share', credit.interchangePaise > credit.schemeFeePaise);
  ok('GST is charged on top of the fee, not out of it', credit.gstOnFeePaise === Math.floor(credit.mdrPaise * 0.18));

  const rupay = await price({ amountPaise: 10000000, instrument: 'RUPAY_DEBIT', channel: 'POS' });
  ok('RuPay debit carries no fee at all', rupay.mdrPaise === 0 && rupay.gstOnFeePaise === 0);
  ok('the prohibition cites the statute rather than asserting itself',
    /section 10A/.test(rupay.authority || ''), rupay.authority);
  ok('the merchant receives the whole amount on a charge-free instrument',
    rupay.merchantReceivesPaise === rupay.amountPaise);

  const bigDebit = await price({ amountPaise: 100000000, instrument: 'OTHER_DEBIT', channel: 'POS' });
  ok('the RBI per-transaction ceiling bites before the percentage does',
    bigDebit.perTransactionCapApplied === true && bigDebit.mdrPaise === 100000,
    JSON.stringify({ cap: bigDebit.perTransactionCapApplied, mdr: bigDebit.mdrPaise }));
  ok('when the cap bites the acquirer absorbs it, not the issuer',
    bigDebit.acquirerMarginPaise === 0 &&
    bigDebit.interchangePaise + bigDebit.schemeFeePaise === bigDebit.mdrPaise);

  const small = await price({ amountPaise: 100000000, instrument: 'OTHER_DEBIT', channel: 'POS', smallMerchant: true });
  ok('a small merchant is capped lower still', small.mdrPaise === 20000, 'got ' + small.mdrPaise);
  const qr = await price({ amountPaise: 1000000, instrument: 'OTHER_DEBIT', channel: 'QR' });
  ok('QR acceptance is priced below a terminal', qr.mdrBps < bigDebit.mdrBps);

  const xb = await price({ amountPaise: 10000000, instrument: 'CREDIT_CROSS_BORDER', channel: 'ONLINE' });
  ok('a cross-border card bills the cardholder more than the ticket',
    xb.cardholderPaysPaise > xb.amountPaise);
  ok('the issuer currency markup is the largest single charge',
    xb.issuerFXMarkupPaise > (xb.amountPaise - xb.merchantReceivesPaise),
    JSON.stringify({ fx: xb.issuerFXMarkupPaise, merchantCost: xb.amountPaise - xb.merchantReceivesPaise }));

  const nonsense = await post('/umi/cards/price', { amountPaise: 1000, instrument: 'COWRIE_SHELL' });
  ok('an instrument with no published rate refuses rather than guessing', nonsense.status === 400,
    'status ' + nonsense.status);

  // ----------------------------------------------------------- the ladder
  const present = async (network, authenticated) => (await post('/umi/cards', {
    network, amountPaise: 5000000, instrument: 'CREDIT', channel: 'ONLINE',
    threeDSAuthenticated: authenticated,
  }));

  const p1 = await present('VISA', false);
  ok('a payment can be presented', p1.status === 201 && p1.body.status === 'PRESENTED',
    'status ' + p1.status);
  const id = p1.body.paymentId;
  ok('presentment is recorded as a block', (p1.body.history || []).length === 1);

  const listed = await call('/umi/cards', { method: 'GET' });
  ok('the desk lists what it holds', listed.status === 200 && (listed.body.payments || []).length > 0);
  const readBack = await call(`/umi/cards/${id}`, { method: 'GET' });
  ok('one payment reads back with its history', readBack.status === 200 && readBack.body.paymentId === id);

  const cb = await post(`/umi/cards/${id}/chargeback`, { reasonCode: '10.4' });
  ok('an unauthenticated fraud ground can be charged back', cb.status === 200 &&
    cb.body.status === 'CHARGED_BACK', JSON.stringify(cb.body).slice(0, 200));
  ok('the merchant is debited at that rung', cb.body.liableParty === 'MERCHANT');
  ok('the next deadline is stated, not left to be discovered',
    !!cb.body.nextDeadlineAt && /dispute response/.test(cb.body.nextDeadlineFor || ''));

  const early = await post(`/umi/cards/${id}/arbitrate`, { merchantWins: true });
  ok('arbitration cannot be reached by skipping the ladder', early.status === 409,
    'status ' + early.status);

  const rep = await post(`/umi/cards/${id}/represent`, { evidence: 'Signed delivery at the billing address.' });
  ok('the merchant can answer with evidence', rep.status === 200 && rep.body.status === 'REPRESENTED');
  ok('liability moves back on a filed answer', rep.body.liableParty === 'ISSUER');

  const bare = await post(`/umi/cards/${id}/prearbitrate`, { detail: 'The cardholder maintains non-receipt.' });
  ok('the issuer can pre-arbitrate', bare.status === 200 && bare.body.status === 'PRE_ARBITRATION');

  const fin = await post(`/umi/cards/${id}/arbitrate`, { merchantWins: false });
  ok('the network rules and the case closes', fin.status === 200 && fin.body.status === 'RESOLVED_ISSUER');
  ok('the losing side is named along with the fee it pays',
    fin.body.liableParty === 'MERCHANT' && fin.body.arbitrationFeeUSD === 600);
  ok('every rung is on the ledger', (fin.body.history || []).length === 5 &&
    (fin.body.history || []).slice(1).every(h => h.block > 0));

  // ------------------------------------------------- refusals that matter
  const auth = await present('VISA', true);
  const authId = auth.body.paymentId;
  const shifted = await post(`/umi/cards/${authId}/chargeback`, { reasonCode: '10.4' });
  ok('3-D Secure closes the fraud route against the merchant', shifted.status === 409 &&
    shifted.body.error === 'ERR_UMI_CARD_LIABILITY_SHIFTED', JSON.stringify(shifted.body).slice(0, 200));
  ok('the refusal still records where liability landed',
    shifted.body.payment && shifted.body.payment.liableParty === 'ISSUER');

  const notFraud = await post(`/umi/cards/${authId}/chargeback`, { reasonCode: '13.1' });
  ok('authentication does nothing against a goods-not-received ground',
    notFraud.status === 200 && notFraud.body.status === 'CHARGED_BACK');

  const mcPay = await present('MASTERCARD', false);
  const wrongCode = await post(`/umi/cards/${mcPay.body.paymentId}/chargeback`, { reasonCode: '10.4' });
  ok('a Visa code on a Mastercard payment is refused', wrongCode.status === 400 &&
    wrongCode.body.error === 'ERR_UMI_CARD_REASON_CODE');
  const invented = await post(`/umi/cards/${mcPay.body.paymentId}/chargeback`, { reasonCode: '99.9' });
  ok('an invented reason code is refused', invented.status === 400);

  const missing = await post('/umi/cards/CARD-9999/chargeback', { reasonCode: '10.4' });
  ok('an unknown payment is a 404', missing.status === 404);

  // ------------------------------------------------------ the screen
  const { readFileSync } = await import('node:fs');
  const page = readFileSync(new URL('../frontend/src/pages/Cards.jsx', import.meta.url), 'utf8');
  ok('a screen prices a payment', /['"`]\/cards\/price/.test(page));
  ok('the screen reads the published posture', page.includes('/cards/posture'));
  ok('the screen can drive every rung of the ladder',
    ['/chargeback', '/represent', '/prearbitrate', '/arbitrate'].every(s => page.includes(s)));
  ok('the screen shows the three-way split', /interchangePaise/.test(page) && /acquirerMarginPaise/.test(page));
  ok('the screen offers 3-D Secure so the liability shift can be seen',
    /threeDSAuthenticated/.test(page));
  ok('the screen states what it cannot do', /What this screen cannot do/.test(page));

  console.log(`\n  ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
};

run().catch(e => { console.error(e); process.exit(1); });
