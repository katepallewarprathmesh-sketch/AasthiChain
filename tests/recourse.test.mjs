// End-to-end checks for recourse: what a holder actually gets when the thing
// under the token fails.
//
// WHAT THIS SUITE IS GUARDING
// Not the arithmetic. The arithmetic is a loop over an ordered list and the
// Go tests cover it. What is worth protecting is the honesty rule, because
// it is the thing somebody will eventually soften:
//
//   a rank pays only when it names a pot this ledger can see.
//
// Today no asset on this rail has a funded rank, so the correct answer to
// "what would I recover" is zero, and the correct behaviour is to say zero
// loudly rather than to show a confident-looking waterfall of money that
// does not exist. If a future change makes an unfunded rank pay out its
// nominal claim, or lets an issuer write the terms of its own failure, or
// lets a supplied "no gaps" list through, these fail.
//
//   node tests/recourse.test.mjs            (BASE=http://localhost:8080)

const BASE = process.env.BASE || 'http://localhost:8080';
const RAIL = process.env.RAIL || 'http://localhost:21100';
let passed = 0, failed = 0;
const ok = (name, cond, detail) => {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failed++; console.log('  FAIL ' + name + (detail ? '\n       ' + detail : '')); }
};

const headers = (id, role) => ({
  'Content-Type': 'application/json', 'X-Fabric-Identity': id, 'X-Identity-Role': role,
});

// Named get/post, because the coverage census can only count a request it
// can see through a helper it can name. A cleverly abstracted helper makes
// the suite invisible to the measurement and the module reads as untested.
const get = async (path, id, role) => {
  const r = await fetch(RAIL + path, id ? { headers: headers(id, role) } : undefined);
  const text = await r.text();
  let body = null; try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, body };
};
const post = async (path, id, role, payload) => {
  const r = await fetch(RAIL + path, {
    method: 'POST', headers: headers(id, role), body: JSON.stringify(payload || {}),
  });
  const text = await r.text();
  let body = null; try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, body };
};

const ASSET = process.env.UMI_SEED_ASSET || 'PROP-GREEN-VALLEY-PUNE-001';
const HOLDER = 'originator1';

const run = async () => {
  console.log('Recourse');

  // 1. The layer explains itself, including why every answer is zero.
  const root = await get('/umi/recourse');
  ok('the recourse layer is mounted and describes itself', root.status === 200, JSON.stringify(root.body));
  const r = root.body || {};
  ok('it states the rule that keeps it honest',
    typeof r.theRuleThatKeepsItHonest === 'string' && /pot this ledger can see/.test(r.theRuleThatKeepsItHonest),
    JSON.stringify(r.theRuleThatKeepsItHonest));
  ok('it says up front that every answer today is zero, and that this is the answer not a placeholder',
    typeof r.whyEveryAnswerIsZeroToday === 'string' && /not a placeholder/.test(r.whyEveryAnswerIsZeroToday),
    JSON.stringify(r.whyEveryAnswerIsZeroToday));
  ok('it names four triggers and three funding sources',
    Array.isArray(r.triggers) && r.triggers.length === 4 && Array.isArray(r.funding) && r.funding.length === 3,
    JSON.stringify({ t: r.triggers, f: r.funding }));

  // 2. An asset nobody wrote terms for gets the house defaults, marked as such.
  const terms = await get(`/umi/recourse/${ASSET}`);
  ok('terms are readable without logging in', terms.status === 200, JSON.stringify(terms.body));
  const t = (terms.body && terms.body.terms) || {};
  ok('terms nobody registered are labelled the house default', t.houseDefault === true, JSON.stringify(t.houseDefault));
  ok('the default priority ranks the secured creditor first and the platform last',
    Array.isArray(t.claimPriority) && t.claimPriority.length >= 3 &&
    /secured creditor/i.test(t.claimPriority[0].claimant) &&
    /platform/i.test(t.claimPriority[t.claimPriority.length - 1].claimant),
    JSON.stringify(t.claimPriority && t.claimPriority.map(x => x.claimant)));
  ok('no rank in the defaults claims funding it does not have',
    Array.isArray(t.claimPriority) && t.claimPriority.every(x => x.funding === 'none'),
    JSON.stringify(t.claimPriority && t.claimPriority.map(x => x.funding)));
  ok('the terms list their own gaps rather than leaving them to be discovered',
    Array.isArray(t.gapsInTheseTerms) && t.gapsInTheseTerms.length >= 3, JSON.stringify(t.gapsInTheseTerms));
  ok('the absence of an SPV is stated, not omitted',
    typeof t.vehicle === 'string' && /^None/.test(t.vehicle), JSON.stringify(t.vehicle));

  // 3. Every trigger carries an observable test and a named declarer, and
  //    the two with no owner say "nobody" instead of implying somebody.
  const triggers = t.triggers || [];
  ok('every trigger states the observable fact that fires it',
    triggers.length === 4 && triggers.every(x => typeof x.test === 'string' && x.test.length > 25),
    JSON.stringify(triggers.map(x => x.id)));
  ok('a trigger this rail can see names the endpoint that shows it',
    triggers.filter(x => x.observableOnThisRail).every(x => typeof x.source === 'string' && x.source.includes('/umi/')),
    JSON.stringify(triggers.map(x => [x.id, x.source])));
  ok('a trigger nobody may declare says so rather than implying somebody will',
    triggers.some(x => x.declaredBy === 'nobody'),
    JSON.stringify(triggers.map(x => [x.id, x.declaredBy])));

  // 4. The simulation. This is the headline and it must be zero today.
  const sim = await post('/umi/recourse/simulate', 'investor1', 'Investor',
    { assetId: ASSET, trigger: 'ISSUER_DEFAULT', holder: HOLDER });
  ok('a holder can simulate what they would recover', sim.status === 200, JSON.stringify(sim.body));
  const s = (sim.body && sim.body.simulation) || {};
  ok('the recovery today is zero', s.recoveryPaise === 0, JSON.stringify(s.recoveryPaise));
  ok('the verdict leads with the zero and explains it',
    typeof s.verdict === 'string' && /recover nothing/.test(s.verdict) && /does not exist/.test(s.verdict),
    JSON.stringify(s.verdict));
  ok('the pool is reported as nothing, with a reason',
    s.recoverablePoolPaise === 0 && /no pool/i.test(String(s.recoverablePoolSource)),
    JSON.stringify([s.recoverablePoolPaise, s.recoverablePoolSource]));
  ok('every rank in the waterfall explains its own number',
    Array.isArray(s.waterfall) && s.waterfall.length >= 3 && s.waterfall.every(x => typeof x.why === 'string' && x.why.length > 20),
    JSON.stringify(s.waterfall && s.waterfall.map(x => x.why)));
  ok('no rank pays while unfunded',
    Array.isArray(s.waterfall) && s.waterfall.every(x => x.funded === true || x.paidPaise === 0),
    JSON.stringify(s.waterfall && s.waterfall.map(x => [x.funded, x.paidPaise])));
  ok('the holder sees their own position and share',
    s.holderTokens > 0 && s.tokensOutstanding >= s.holderTokens && typeof s.holderSharePercent === 'string',
    JSON.stringify([s.holderTokens, s.tokensOutstanding, s.holderSharePercent]));
  ok('the disclaimer refuses to describe this as protection',
    typeof s.disclaimer === 'string' && /has been underwritten/.test(s.disclaimer), JSON.stringify(s.disclaimer));
  ok('issuer default is reported as unobservable and owned by nobody',
    s.triggerObservableOnThisRail === false && s.triggerDeclaredBy === 'nobody',
    JSON.stringify([s.triggerObservableOnThisRail, s.triggerDeclaredBy]));

  // 5. Refusals that matter more than the happy path.
  const stranger = await post('/umi/recourse/simulate', 'investor1', 'Investor',
    { assetId: ASSET, trigger: 'ISSUER_DEFAULT', holder: 'nobody-holds-anything' });
  ok('somebody holding nothing is told so rather than shown a zero waterfall',
    stranger.status === 404, JSON.stringify(stranger.body));

  const madeUp = await post('/umi/recourse/simulate', 'investor1', 'Investor',
    { assetId: ASSET, trigger: 'MARKET_SENTIMENT', holder: HOLDER });
  ok('an invented trigger is refused and the known ones are named',
    madeUp.status === 400 && /ISSUER_DEFAULT/.test(JSON.stringify(madeUp.body)), JSON.stringify(madeUp.body));

  const byIssuer = await post('/umi/recourse/terms', 'originator1', 'Originator', {
    assetId: ASSET,
    claimPriority: [{ rank: 1, claimant: 'Token holders', remedy: 'Everything, immediately.', funding: 'none' }],
  });
  ok('the issuer cannot write the terms of its own failure', byIssuer.status === 403, JSON.stringify(byIssuer.body));

  const invented = await post('/umi/recourse/terms', 'registrar1', 'Registrar', {
    assetId: 'RECOURSE-TEST-' + Date.now(),
    claimPriority: [{ rank: 1, claimant: 'Token holders', remedy: 'Covered by insurance.', funding: 'insurance-policy' }],
  });
  ok('a funding source this ledger cannot check is refused outright, not recorded and ignored',
    invented.status === 400, JSON.stringify(invented.body));

  // 6. A registrar may set terms, and the gap list is recomputed rather than
  //    believed. "Investors are fully protected" must not survive the round trip.
  const asset2 = 'RECOURSE-TEST-' + Date.now();
  const set = await post('/umi/recourse/terms', 'registrar1', 'Registrar', {
    assetId: asset2,
    jurisdiction: 'India, Maharashtra',
    claimPriority: [{ rank: 1, claimant: 'Token holders, pro rata', remedy: 'A share of the proceeds.', funding: 'none' }],
    gapsInTheseTerms: ['None. Investors are fully protected.'],
  });
  ok('a registrar can record terms', set.status === 200, JSON.stringify(set.body));
  const st = (set.body && set.body.terms) || {};
  ok('a flattering gap list supplied by the caller is discarded',
    Array.isArray(st.gapsInTheseTerms) && !st.gapsInTheseTerms.some(g => /fully protected/i.test(g)),
    JSON.stringify(st.gapsInTheseTerms));
  ok('the recomputed gaps say the terms are unfunded',
    Array.isArray(st.gapsInTheseTerms) && st.gapsInTheseTerms.some(g => /No rank is funded/i.test(g)),
    JSON.stringify(st.gapsInTheseTerms));
  ok('recorded terms are anchored to a block', typeof st.block === 'number' && st.block > 0, JSON.stringify(st.block));
  ok('recorded terms stop reporting as the house default', st.houseDefault === false, JSON.stringify(st.houseDefault));

  // 7. Declaring a trigger fixes the facts and pays nobody.
  const byInvestor = await post(`/umi/recourse/${ASSET}/declare`, 'investor1', 'Investor',
    { trigger: 'ASSET_IMPAIRMENT', reason: 'I would like my money back.' });
  ok('a non-supervisor cannot declare a failure', byInvestor.status === 403, JSON.stringify(byInvestor.body));

  const declared = await post(`/umi/recourse/${ASSET}/declare`, 'regulator1', 'Regulator',
    { trigger: 'ASSET_IMPAIRMENT', reason: 'Valuation fell below tokens outstanding.' });
  ok('a supervisor can declare a trigger', declared.status === 200, JSON.stringify(declared.body));
  ok('the declaration is on the ledger, so when it happened is provable',
    declared.body && typeof declared.body.block === 'number' && declared.body.block > 0,
    JSON.stringify(declared.body && declared.body.block));
  ok('the declaration says plainly that it moved no money',
    declared.body && /No money moved/i.test(String(declared.body.effect)),
    JSON.stringify(declared.body && declared.body.effect));

  // 8. The proxy carries it, so the screen can reach it.
  const viaProxy = await fetch(`${BASE}/api/umi/recourse/${ASSET}`);
  ok('the layer is reachable through the API proxy the frontend uses', viaProxy.status === 200, String(viaProxy.status));

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
};

run().catch((e) => { console.error(e); process.exit(1); });
