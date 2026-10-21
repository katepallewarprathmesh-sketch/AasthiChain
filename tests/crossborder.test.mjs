// End-to-end checks for the cross-border funding leg.
//
// The thing these checks defend is a legal fact, not a feature. Indian
// immovable property cannot be bought with cryptocurrency: the consideration
// has to arrive in rupees through banking channels, and a foreign national of
// non-Indian origin resident outside India cannot buy at all whatever they
// pay with. So the rail takes a stablecoin, has it converted outside India,
// and credits rupees only against an attestation that an inward remittance
// landed. There must be no route through it that pays a seller in tokens.
//
//   node tests/crossborder.test.mjs         (BASE=http://localhost:8080)

const BASE = process.env.BASE || 'http://localhost:8080';
const RAIL = process.env.RAIL || 'http://localhost:21100';
let passed = 0, failed = 0;
const ok = (name, cond, detail) => {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failed++; console.log('  FAIL ' + name + (detail ? '\n       ' + detail : '')); }
};

const call = async (origin, path, init) => {
  const r = await fetch(origin + path, init);
  const text = await r.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, body };
};
const app = (path, init) => call(BASE, path, init);
const rail = (path, init) => call(RAIL, path, init);
const headers = (id, role) => ({
  'Content-Type': 'application/json', 'X-Fabric-Identity': id, 'X-Identity-Role': role,
});
const post = (id, role) => (path, payload) => rail(path, {
  method: 'POST', headers: headers(id, role), body: JSON.stringify(payload || {}),
});
const asBuyer = post('investor1', 'Investor');
const asRegulator = post('regulator1', 'Regulator');
const get = (path, id, role) => rail(path, { headers: headers(id, role) });

const party = (name) => ({
  name, address: '1 Example Street, Dubai', country: 'AE',
  accountRef: '0xabc0000000000000000000000000000000000001',
});
const quote = (over) => ({
  assetId: 'PROP-GREEN-VALLEY-PUNE-001',
  amountINR: 885000,
  stablecoin: 'USDC',
  buyerStatus: 'NRI',
  nationality: 'INDIA',
  kycRef: 'KYC-7781',
  originator: party('Buyer One'),
  beneficiary: party('Off-ramp Provider'),
  ...(over || {}),
});

const run = async () => {
  console.log('Cross-border funding');

  // 1. The rules are readable before anybody hands over identity data.
  const rules = await rail('/umi/crossborder/rules');
  ok('the rules are public', rules.status === 200 && rules.body.settlementCurrency === 'INR',
    JSON.stringify(rules.body).slice(0, 160));
  ok('the rules name the prohibited payment method',
    String(rules.body.prohibited || '').includes('cryptocurrency or digital tokens'));
  ok('the rules say a foreign national cannot buy at all',
    String(rules.body.ineligibleReason || '').includes('cannot purchase'));
  ok('the leg labels itself simulated', String(rules.body.disclaimer || '').includes('Simulated'));

  // 2. A foreign national of non-Indian origin is refused, with the reason.
  const foreign = await asBuyer('/umi/crossborder',
    quote({ buyerStatus: 'FOREIGN_NATIONAL', nationality: 'GERMANY' }));
  ok('a foreign national is refused with 403',
    foreign.status === 403 && foreign.body.error === 'ERR_UMI_CBX_INELIGIBLE',
    JSON.stringify(foreign.body).slice(0, 200));

  // 3. A restricted nationality needs prior permission.
  const restricted = await asBuyer('/umi/crossborder', quote({ nationality: 'CHINA' }));
  ok('a restricted nationality is refused',
    restricted.status === 403 && restricted.body.error === 'ERR_UMI_CBX_RESTRICTED_NATIONALITY',
    JSON.stringify(restricted.body).slice(0, 200));

  // 4. No KYC, no quote.
  const noKyc = await asBuyer('/umi/crossborder', quote({ kycRef: '' }));
  ok('a quote needs KYC first',
    noKyc.status === 403 && noKyc.body.error === 'ERR_UMI_CBX_KYC_REQUIRED');

  // 5. Travel Rule data is mandatory above the threshold.
  const noTravel = await asBuyer('/umi/crossborder', quote({ originator: { name: 'Buyer One' } }));
  ok('the travel rule record is enforced above the threshold',
    noTravel.status === 400 && noTravel.body.error === 'ERR_UMI_CBX_TRAVEL_RULE');

  // 6. An unauthorised stablecoin is refused.
  const usdt = await asBuyer('/umi/crossborder', quote({ stablecoin: 'USDT' }));
  ok('only authorised stablecoins are accepted', usdt.status === 400,
    JSON.stringify(usdt.body).slice(0, 160));

  // 7. An eligible buyer gets a quote pointed at the off-ramp.
  const quoted = await asBuyer('/umi/crossborder', quote());
  const intent = quoted.body && quoted.body.intent;
  ok('an eligible NRI gets a quote', quoted.status === 200 && intent && intent.status === 'QUOTED',
    JSON.stringify(quoted.body).slice(0, 200));
  ok('the quote is priced in the stablecoin with an expiry',
    !!intent && intent.amountCoin > 0 && !!intent.expiresAt && intent.rateINRPerUnit > 0);
  ok('payment is directed at the off-ramp and not the seller',
    !!intent && String(intent.payTo).startsWith('offramp:') && String(intent.payToIs).includes('never the seller'),
    intent && intent.payTo);
  ok('the travel rule is flagged on a large transfer', !!intent && intent.travelRuleApplied === true);
  ok('TDS is shown for information', !!intent && intent.indicativeTDSINR > 0);

  const id = intent && intent.id;

  // 8. Only the buyer may report paying.
  const stranger = await post('investor2', 'Investor')('/umi/crossborder/' + id + '/payment',
    { transferRef: '0xdead' });
  ok('a stranger cannot report the payment',
    stranger.status === 403 && stranger.body.error === 'ERR_UMI_CBX_NOT_BUYER');

  // 9. Off-ramp before a payment is recorded is a conflict, not a credit.
  const early = await asRegulator('/umi/crossborder/' + id + '/offramp', {});
  ok('nothing is credited before a payment is recorded',
    early.status === 409 && early.body.error === 'ERR_UMI_CBX_STATE');

  // 10. Record the transfer. The rail must not claim to have verified it.
  const paid = await asBuyer('/umi/crossborder/' + id + '/payment', { transferRef: '0xfeed1234' });
  ok('the buyer records the transfer reference',
    paid.status === 200 && paid.body.intent && paid.body.intent.status === 'PAYMENT_RECORDED',
    JSON.stringify(paid.body).slice(0, 200));
  ok('the rail does not claim to have verified the transfer',
    String(paid.body.note || '').includes('No chain is connected'));

  // 11. The off-ramp credits rupees, with a bank advice and a purpose code.
  const before = await get('/umi/wallets/investor1', 'investor1', 'Investor');
  const offramped = await asRegulator('/umi/crossborder/' + id + '/offramp', {});
  const done = offramped.body && offramped.body.intent;
  ok('the off-ramp settles the leg', offramped.status === 200 && done && done.status === 'OFFRAMPED',
    JSON.stringify(offramped.body).slice(0, 200));
  ok('the attestation carries a bank advice and a purpose code',
    !!done && !!done.offrampAdviceRef && !!done.purposeCode);
  ok('rupees credited are net of the provider spread',
    !!done && done.creditedINR > 0 && done.creditedINR < done.amountINR,
    done && String(done.creditedINR));
  const after = await get('/umi/wallets/investor1', 'investor1', 'Investor');
  const bal = (r) => (r.body && r.body.wallet && r.body.wallet.balanceINR) || 0;
  ok('the rupee wallet is credited by the off-ramp', bal(after) > bal(before),
    bal(before) + ' -> ' + bal(after));

  // 12. Twice is a conflict, not a second credit.
  const again = await asRegulator('/umi/crossborder/' + id + '/offramp', {});
  ok('an off-ramp cannot be replayed', again.status === 409);

  // 13. Every step is on the chain.
  const chain = await rail('/drunix/chain?limit=80');
  const types = (chain.body && (chain.body.blocks || chain.body.chain) || []).map((b) => b.type || b.Type);
  ok('the quote, the payment and the off-ramp are all blocks',
    types.includes('UMI_CBX_QUOTED') && types.includes('UMI_CBX_PAYMENT_RECORDED')
      && types.includes('UMI_CBX_OFFRAMPED'), types.slice(0, 12).join(','));
  ok('refusals are committed too', types.includes('UMI_CBX_REFUSED'));

  // 14. The list is scoped to the buyer, and the proxy carries it unchanged.
  const mine = await get('/umi/crossborder', 'investor1', 'Investor');
  ok('a buyer sees their own intents',
    mine.status === 200 && Array.isArray(mine.body.intents)
      && mine.body.intents.every((i) => i.buyer === 'investor1'),
    JSON.stringify(mine.body).slice(0, 160));
  const proxied = await app('/api/umi/crossborder/rules');
  ok('the app proxies the rules without logic of its own',
    proxied.status === 200 && proxied.body.settlementCurrency === 'INR',
    JSON.stringify(proxied.body).slice(0, 160));

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
};

run().catch((e) => { console.error(e); process.exit(1); });
