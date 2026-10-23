// Per-jurisdiction rule sets, tested against the running rail.
//
// The gap this closes: the statutory basis for what this system allows was
// described in prose on a few screens and enforced by a Go switch nobody
// outside the repository could read. A rule nobody can enumerate is not a
// rule, it is a claim. These checks hold the rail to three things.
//
//   1. The rule set is readable before a transaction, and every rule cites
//      the instrument it comes from. A refusal that cannot name its
//      authority is indistinguishable from a bug.
//   2. Evaluation runs every applicable rule, not only the first failure,
//      so a caller sees the shape of the regime rather than one obstacle.
//   3. An undeclared jurisdiction refuses. The dangerous failure here is a
//      transaction in a place nobody modelled succeeding quietly.
//
//   node tests/jurisdiction.test.mjs        (RAIL=http://localhost:21100)

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
  headers: { 'Content-Type': 'application/json', 'X-Identity-Id': 'investor1', 'X-Fabric-Identity': 'investor1' },
  body: JSON.stringify(payload),
});

const run = async () => {
  console.log('Jurisdiction rule sets');

  // ---------------------------------------------------------- the register
  const list = await call('/umi/jurisdictions', { method: 'GET' });
  ok('the declared jurisdictions are readable without signing in', list.status === 200, 'status ' + list.status);
  const js = (list.body && list.body.jurisdictions) || [];
  ok('more than one jurisdiction is declared', js.length >= 2, 'got ' + js.length);
  ok('at least one is designated', js.some(j => j.designation === 'DESIGNATED'));
  ok('designation is a declared state, not implied',
    js.every(j => ['DESIGNATED', 'OBSERVED', 'SUSPENDED'].includes(j.designation)));
  ok('the register says what an undeclared jurisdiction does',
    /refus/i.test((list.body && list.body.default) || ''));

  const mh = await call('/umi/jurisdictions/IN-MH', { method: 'GET' });
  ok('one jurisdiction reads back with its rules', mh.status === 200 && (mh.body.rules || []).length >= 7,
    'got ' + ((mh.body && mh.body.rules) || []).length + ' rules');
  ok('every declared rule cites an instrument',
    (mh.body.rules || []).every(r => r.instrument && r.instrument.trim().length > 4));
  ok('a rule that is simplified says so',
    (mh.body.rules || []).some(r => r.simplifiedTo && r.simplifiedTo.length > 10));
  ok('the jurisdiction declares its statutory charges',
    mh.body.jurisdiction && mh.body.jurisdiction.stampDutyBps > 0);

  // ----------------------------------------------------- the permitted case
  const good = await post('/umi/jurisdictions/evaluate', {
    kind: 'ACQUISITION', jurisdiction: 'IN-MH', buyerStatus: 'RESIDENT', nationality: 'INDIA',
    assetKind: 'RESIDENTIAL', consideration: 'INR_BANKING_CHANNEL', amountPaise: 1000000000,
  });
  ok('an eligible resident passes', good.status === 200 && good.body.allowed === true,
    JSON.stringify(good.body && good.body.results || good.body).slice(0, 300));
  ok('the decision reports how many rules actually ran', (good.body.rulesRun || 0) >= 5);
  ok('stamp duty is computed at the declared rate',
    good.body.indicativeCosts && good.body.indicativeCosts.stampDutyPaise === 60000000,
    JSON.stringify(good.body.indicativeCosts));
  ok('the registration fee respects the state cap',
    good.body.indicativeCosts && good.body.indicativeCosts.registrationFeePaise === 3000000);
  ok('the evaluation is written to the ledger', (good.body.block || 0) > 0);
  ok('the decision states its own boundary', /not legal advice/i.test(good.body.disclaimer || ''));

  // ------------------------------------------------------- refusal: rules
  const bad = await post('/umi/jurisdictions/evaluate', {
    kind: 'ACQUISITION', jurisdiction: 'IN-KA', buyerStatus: 'FOREIGN_NATIONAL', nationality: 'PAKISTAN',
    assetKind: 'AGRICULTURAL', consideration: 'CRYPTO', amountPaise: 5000000000,
  });
  ok('a refusal is still a successful evaluation', bad.status === 200);
  ok('the transaction is not permitted', bad.body.allowed === false);
  ok('every failing rule is reported, not only the first', (bad.body.failed || 0) >= 4,
    'failed = ' + bad.body.failed);
  ok('each failure gives a reason a person can act on',
    (bad.body.results || []).filter(r => !r.passed).every(r => (r.reason || '').length > 20));
  ok('each failure names its instrument',
    (bad.body.results || []).filter(r => !r.passed).every(r => (r.instrument || '').length > 4));
  const ids = (bad.body.results || []).filter(r => !r.passed).map(r => r.id);
  ok('the FEMA eligibility rule is among them', ids.includes('FEMA-ACQUISITION-ELIGIBILITY'), ids.join(','));
  ok('the restricted-nationality rule is among them', ids.includes('FEMA-RESTRICTED-NATIONALITY'));
  ok('the consideration-channel rule is among them', ids.includes('FEMA-CONSIDERATION-CHANNEL'));

  // --------------------------------------------- refusal: undeclared place
  const nowhere = await post('/umi/jurisdictions/evaluate', {
    kind: 'ACQUISITION', jurisdiction: 'XX-NOWHERE', buyerStatus: 'RESIDENT',
    consideration: 'INR_BANKING_CHANNEL',
  });
  ok('an undeclared jurisdiction refuses rather than defaulting to permitted', nowhere.status === 404,
    'status ' + nowhere.status);
  ok('the refusal carries a sentinel code',
    (nowhere.body && nowhere.body.error) === 'ERR_UMI_JURISDICTION_UNKNOWN', JSON.stringify(nowhere.body));

  const noCode = await post('/umi/jurisdictions/evaluate', { kind: 'ACQUISITION' });
  ok('a missing jurisdiction is a field error, not a silent pass', noCode.status === 400);

  // ---------------------------------------------------------- the open route
  const lease = await post('/umi/jurisdictions/evaluate', {
    kind: 'LEASE', jurisdiction: 'IN-MH', buyerStatus: 'FOREIGN_NATIONAL', nationality: 'FRANCE', leaseYears: 5,
  });
  ok('a five-year lease is open to a foreign national', lease.body.allowed === true,
    JSON.stringify(lease.body.results || lease.body).slice(0, 300));
  const longLease = await post('/umi/jurisdictions/evaluate', {
    kind: 'LEASE', jurisdiction: 'IN-MH', buyerStatus: 'FOREIGN_NATIONAL', nationality: 'FRANCE', leaseYears: 9,
  });
  ok('nine years closes it', longLease.body.allowed === false);

  // --------------------------------- the quote is actually tested against it
  const quote = await post('/umi/crossborder', {
    assetId: 'PROP-GREEN-VALLEY-PUNE-001', amountINR: 885000, stablecoin: 'USDC',
    buyerStatus: 'NRI', nationality: 'INDIA', kycRef: 'KYC-7781', assetKind: 'AGRICULTURAL',
    originator: { name: 'Buyer', address: '1 Example Street, Dubai', country: 'AE', accountRef: '0xabc' },
    beneficiary: { name: 'Off-ramp', address: '1 Example Street, Dubai', country: 'AE', accountRef: '0xabc' },
  });
  ok('a cross-border quote is tested against the rule set, not only the eligibility switch',
    quote.status >= 400, 'status ' + quote.status + ' ' + JSON.stringify(quote.body).slice(0, 200));

  const nowhereQuote = await post('/umi/crossborder', {
    assetId: 'PROP-GREEN-VALLEY-PUNE-001', amountINR: 885000, stablecoin: 'USDC',
    buyerStatus: 'NRI', nationality: 'INDIA', kycRef: 'KYC-7781', jurisdiction: 'XX-NOWHERE',
    originator: { name: 'Buyer', address: '1 Example Street, Dubai', country: 'AE', accountRef: '0xabc' },
    beneficiary: { name: 'Off-ramp', address: '1 Example Street, Dubai', country: 'AE', accountRef: '0xabc' },
  });
  ok('a quote in an undeclared jurisdiction refuses', nowhereQuote.status >= 400,
    'status ' + nowhereQuote.status);

  // ------------------------------------------------------ the screen exists
  const { readFileSync } = await import('node:fs');
  const page = readFileSync(new URL('../frontend/src/pages/CrossBorder.jsx', import.meta.url), 'utf8');
  ok('a screen reads the rule set', /['"`]\/jurisdictions/.test(page));
  ok('the screen can evaluate a transaction', page.includes('/jurisdictions/evaluate'));
  ok('the screen shows the instrument behind each rule', /r\.instrument/.test(page));
  ok('the screen offers the undeclared jurisdiction so the refusal can be seen',
    page.includes('XX-NOWHERE'));
  ok('the screen states what the model does not cover', /What this is not/.test(page));

  console.log(`\n  ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
};

run().catch(e => { console.error(e); process.exit(1); });
