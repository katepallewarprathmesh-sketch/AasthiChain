// AML: a list, a match, a case, and a report that exists as a file.
//
// What was called AML before was a fraud score and a reporting threshold.
// These checks cover what was actually missing: screening against a named
// list, a case somebody has to review and sign, and a suspicious transaction
// report that is a document with its hash on the ledger. They also pin the
// honesty of it, which is the part most easily lost: the shipped list is
// synthetic and must say so everywhere, and no report is filed with anybody.
//
//   node tests/aml.test.mjs                 (BASE=http://localhost:8080)

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
  const r = await fetch(BASE + '/api/umi' + path, {
    method: 'POST', headers: headers(id, role), body: JSON.stringify(payload || {}),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

async function main() {
  console.log('\nAML screening, cases and reports\n');

  // 1. The layer exists and declares what it is screening against.
  const status = await get('/aml');
  ok('the AML layer is mounted', status.status === 200, JSON.stringify(status.body).slice(0, 160));
  const st = status.body;
  ok('it names the list it loaded', typeof st.listName === 'string' && st.listName.length > 3, st.listName);
  ok('it declares the shipped list synthetic', st.listIsSynthetic === true);
  ok('the list is not empty', st.listSize >= 5, String(st.listSize));
  ok('it counts sanctions and politically exposed entries separately',
    st.sanctionEntries > 0 && st.pepEntries > 0, `${st.sanctionEntries} / ${st.pepEntries}`);
  ok('it publishes the two thresholds and what they mean',
    st.thresholds && st.thresholds.block > st.thresholds.review && /a question rather than an answer/.test(st.thresholds.meaning));
  ok('it says nothing here is filed with an authority',
    /has been filed with the Financial Intelligence Unit/i.test(String(st.disclaimer)));

  // 2. The list is public. A person refused by a screen can see why.
  const list = await get('/aml/watchlist');
  ok('the watchlist is readable without a supervisor role', list.status === 200);
  ok('every entry says which list it came from and why it is listed',
    (list.body.entries || []).every((e) => e.source && e.programme && e.kind), JSON.stringify(list.body.entries || []).slice(0, 140));
  ok('the list states that it designates nobody real',
    /no real person|invented|synthetic/i.test(JSON.stringify(list.body).toLowerCase()));

  // 3. Matching: the obvious case, the awkward case, and the false positive.
  const screen = async (name) => (await post('/aml/screen', 'investor1', 'Investor', { name })).body.screening || {};
  const exact = await screen('Dmitri Volkanov');
  ok('a listed name is blocked', exact.decision === 'BLOCK', JSON.stringify(exact).slice(0, 160));
  ok('the block names the match and scores it',
    exact.matches.length > 0 && exact.matches[0].score >= 0.9 && !!exact.matches[0].why,
    JSON.stringify(exact.matches[0] || {}).slice(0, 160));

  const punctuated = await screen('Mr. Dmitri  Volkanov');
  ok('honorifics and spacing do not defeat the screen', punctuated.decision === 'BLOCK', punctuated.decision);

  const transliterated = await screen('Dimitri Volkanoff');
  ok('a listed alternative spelling is caught', transliterated.decision === 'BLOCK', transliterated.decision);

  const partial = await screen('Ana Ferreira');
  ok('a dropped middle name is a review, not a block', partial.decision === 'REVIEW', partial.decision);

  const common = await screen('Kumar');
  ok('a common surname alone does not stop a payment', common.decision === 'CLEAR', common.decision);

  const unrelated = await screen('Priya Shankar');
  ok('an unrelated name is clear', unrelated.decision === 'CLEAR', unrelated.decision);
  ok('a clear result still names the list it cleared against',
    /No name on /.test(String(unrelated.note)), unrelated.note);

  // 4. Cases are supervisor-only, because they carry names and suspicions.
  const asInvestor = await get('/aml/cases', 'investor1', 'Investor');
  ok('an investor cannot read AML cases', asInvestor.status === 403, String(asInvestor.status));

  const opened = await post('/aml/cases', 'regulator1', 'Regulator', {
    name: 'Arvex Metals Trading FZE', relatedRef: 'TEST-AML', counterparty: 'investor1', amountPaise: 2500000,
  });
  ok('a regulator can open a case', opened.status === 201, JSON.stringify(opened.body).slice(0, 160));
  const caseId = opened.body.case && opened.body.case.caseId;
  ok('the case records the screening that caused it',
    !!caseId && opened.body.case.matches.length > 0 && opened.body.case.status === 'OPEN');

  const readOne = await get(`/aml/cases/${caseId}`, 'regulator1', 'Regulator');
  ok('a single case can be read by its reference',
    readOne.status === 200 && readOne.body.case.caseId === caseId, String(readOne.status));

  // 5. The lifecycle, including the refusals that make it a control.
  const noGrounds = await post(`/aml/cases/${caseId}/clear`, 'regulator1', 'Regulator', {});
  ok('a case cannot be cleared without grounds', noGrounds.status === 400, String(noGrounds.status));

  const reviewed = await post(`/aml/cases/${caseId}/review`, 'regulator1', 'Regulator', { text: 'Checking the counterparty.' });
  ok('a case can be picked up for review',
    reviewed.status === 200 && reviewed.body.case.status === 'UNDER_REVIEW' && reviewed.body.case.reviewer === 'regulator1');

  const reported = await post(`/aml/cases/${caseId}/report`, 'regulator1', 'Regulator', {
    grounds: ['Name matches a listed entity', 'Purpose inconsistent with the stated business'],
    narrative: 'Payment to an entity whose name matches a listed party, with no supporting documentation.',
  });
  ok('a case escalates into a report', reported.status === 201, JSON.stringify(reported.body).slice(0, 180));
  const report = reported.body.report || {};
  ok('the report carries the subject, the grounds and the narrative',
    report.subject && (report.grounds || []).length === 2 && report.narrative);
  ok('the report is hashed', typeof report.hash === 'string' && report.hash.length === 64, report.hash);
  ok('the hash is committed to a block', report.blockHeight > 0, String(report.blockHeight));
  ok('the report says it has not been filed with anybody', /not been filed/i.test(String(report.disclaimer)));
  ok('the case now points at its report',
    reported.body.case.status === 'REPORTED' && reported.body.case.reportId === report.reportId);

  const twice = await post(`/aml/cases/${caseId}/report`, 'regulator1', 'Regulator', {
    grounds: ['again'], narrative: 'again',
  });
  ok('a case cannot be reported twice', twice.status === 409, String(twice.status));

  const fetched = await get(`/aml/reports/${report.reportId}`, 'regulator1', 'Regulator');
  ok('the report can be read back as a document', fetched.status === 200 && fetched.body.report.hash === report.hash);
  ok('the response says how to verify the hash', /Recompute the hash/i.test(String(fetched.body.verify)));
  const reportToInvestor = await get(`/aml/reports/${report.reportId}`, 'investor1', 'Investor');
  ok('an investor cannot read a report', reportToInvestor.status === 403, String(reportToInvestor.status));

  // 6. Every step is on the chain, with a label.
  const chain = await (await fetch(BASE + '/api/drunix/chain?limit=60')).json();
  const types = (chain.blocks || []).map((b) => b.type);
  ok('opening a case writes a block', types.includes('UMI_AML_CASE_OPENED') || types.includes('UMI_AML_REFUSED'), types.slice(-8).join(','));
  ok('filing a report writes a block', types.includes('UMI_AML_REPORT_FILED'), types.slice(-8).join(','));

  // 7. The payment path uses it: a listed beneficiary does not travel.
  const corridors = await get('/corridors');
  const usable = (corridors.body.corridors || []).find((c) => !((corridors.body.blockedCorridors || {})[c.id]) && c.id === 'BANK-CORRESPONDENT');
  if (!usable) {
    ok('a usable corridor exists to test screening on', false, JSON.stringify(Object.keys(corridors.body.blockedCorridors || {})));
  } else {
    await post('/cbdc/issue', 'regulator1', 'Regulator', { holder: 'investor1', amountPaise: 20000000, kycTier: 'FULL_KYC' });
    const blocked = await post('/corridors/send', 'investor1', 'Investor', {
      corridorId: usable.id, payer: 'investor1', payee: 'originator1', amountPaise: 1000000,
      purposeCode: 'IMPORT_GOODS', originator: 'Investor One', beneficiary: 'Dmitri Volkanov',
    });
    ok('a payment to a listed beneficiary is refused', blocked.status === 403, `${blocked.status} ${blocked.body.error}`);
    ok('the refusal names the list and the match',
      /Volkanov/.test(String(blocked.body.message)), String(blocked.body.message).slice(0, 180));

    const cases = await get('/aml/cases', 'regulator1', 'Regulator');
    const fromPayment = (cases.body.cases || []).find((c) => c.relatedRef === usable.id);
    ok('the refusal opened a case for somebody to review', !!fromPayment,
      (cases.body.cases || []).map((c) => c.relatedRef).join(','));

    const allowed = await post('/corridors/send', 'investor1', 'Investor', {
      corridorId: usable.id, payer: 'investor1', payee: 'originator1', amountPaise: 1000000,
      purposeCode: 'IMPORT_GOODS', originator: 'Investor One', beneficiary: 'Priya Shankar',
    });
    ok('an unlisted beneficiary still travels', allowed.status === 201, `${allowed.status} ${JSON.stringify(allowed.body).slice(0, 140)}`);
  }

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
