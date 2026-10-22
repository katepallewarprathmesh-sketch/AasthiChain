// Electronic KYC: the flow, the refusals, and the data this system will not hold.
//
// The tier used to be whatever the request said. These checks cover the
// change: a tier is now the output of a verification with a route, evidence
// and an expiry. The most important assertions here are refusals, because
// the rules that matter in Indian KYC are mostly prohibitions: an Aadhaar
// number must not be collected at all by an entity with no licensed vault, an
// offline file goes stale in three working days, and only a video session
// with all of its conditions is treated as equal to meeting somebody.
//
//   node tests/kyc.test.mjs                 (BASE=http://localhost:8080)

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
const nowISO = (hoursAgo = 0) => new Date(Date.now() - hoursAgo * 3600 * 1000).toISOString();
const offlineRef = () => '1234' + String(Date.now()).slice(0, 12);

async function main() {
  console.log('\nElectronic KYC\n');

  // 1. The catalogue is public: somebody choosing a route is entitled to know
  // which one caps them.
  const root = await get('/kyc');
  ok('the KYC layer is mounted', root.status === 200, JSON.stringify(root.body).slice(0, 140));
  const st = root.body;
  ok('all five identification routes are published', (st.routes || []).length === 5,
    (st.routes || []).map((r) => r.route).join(','));
  const vcip = (st.routes || []).find((r) => r.route === 'VCIP');
  const otp = (st.routes || []).find((r) => r.route === 'AADHAAR_OTP_EKYC');
  ok('only the video route is face-to-face equivalent',
    vcip?.faceToFaceEquivalent === true && (st.routes || []).filter((r) => r.faceToFaceEquivalent).length === 1);
  ok('the one lakh annual ceiling is attached to the OTP route',
    /1,00,000|100000/.test(String(otp?.annualDebitCap)), String(otp?.annualDebitCap));
  ok('the OTP route carries enhanced due diligence', otp?.enhancedDueDiligence === true);
  ok('periodic updation is published by risk band',
    st.periodicUpdation?.HIGH === 'two years' && st.periodicUpdation?.LOW === 'ten years',
    JSON.stringify(st.periodicUpdation));
  ok('the registry upload window is stated', /ten days/.test(String(st.registryUploadWindow)));
  ok('the Aadhaar policy is refusal, not redaction',
    /does not accept, store or transmit Aadhaar numbers/.test(String(st.aadhaarPolicy)));
  ok('the disclaimer says the verification itself is simulated',
    /no UIDAI authentication call/i.test(String(st.disclaimer)));

  // 2. The refusal that matters most: a twelve digit Aadhaar number is not
  // accepted anywhere, by anybody.
  const withAadhaar = await post('/kyc/verify', 'investor1', 'Investor', {
    holder: 'investor1', route: 'AADHAAR_OFFLINE_XML', consent: true,
    offlineReferenceId: '123456789012', offlineGeneratedAt: nowISO(1),
  });
  ok('an Aadhaar number is refused outright', withAadhaar.status === 422, String(withAadhaar.status));
  ok('the refusal explains why it is not merely redacted',
    /not a licensed user agency|no Aadhaar data vault/i.test(String(withAadhaar.body.message)),
    String(withAadhaar.body.message).slice(0, 180));

  // 3. Consent is not a checkbox nobody reads: without it, nothing happens.
  const noConsent = await post('/kyc/verify', 'investor1', 'Investor', {
    holder: 'investor1', route: 'AADHAAR_OFFLINE_XML', consent: false,
    offlineReferenceId: offlineRef(), offlineGeneratedAt: nowISO(1),
  });
  ok('verification without recorded consent is refused', noConsent.status === 403, String(noConsent.status));
  ok('the refusal says the route is voluntary',
    /voluntary|refused service/i.test(String(noConsent.body.message)), String(noConsent.body.message).slice(0, 160));

  // 4. The offline file expires. Three working days, not whenever.
  const stale = await post('/kyc/verify', 'investor1', 'Investor', {
    holder: 'investor1', route: 'AADHAAR_OFFLINE_XML', consent: true,
    offlineReferenceId: offlineRef(), offlineGeneratedAt: nowISO(100),
  });
  ok('an offline file older than three working days is refused', stale.status === 409, String(stale.status));
  ok('the refusal names the age of the file', /hours ago/.test(String(stale.body.message)), String(stale.body.message).slice(0, 160));

  // 5. A good offline verification: permitted, and capped for being remote.
  const offline = await post('/kyc/verify', 'investor1', 'Investor', {
    holder: 'investor1', route: 'AADHAAR_OFFLINE_XML', consent: true, pan: 'ABCDE1234F',
    offlineReferenceId: offlineRef(), offlineGeneratedAt: nowISO(2), riskBand: 'MEDIUM',
  });
  ok('an offline verification succeeds', offline.status === 201, JSON.stringify(offline.body).slice(0, 160));
  const rec = offline.body.record || {};
  ok('it does not reach face-to-face equivalence', rec.faceToFaceEquivalent === false);
  ok('it leaves the holder on the minimum tier', rec.tier === 'MIN_KYC', rec.tier);
  ok('it keeps only the last four digits', rec.aadhaarLast4 === '1234' && !JSON.stringify(rec).includes('123456789012'));
  ok('the evidence is held as a hash', typeof rec.evidenceHash === 'string' && rec.evidenceHash.length === 64);
  ok('only the last four of the PAN is kept', rec.panLast4 === '234F' && !JSON.stringify(rec).includes('ABCDE1234F'));
  ok('it issues a KYC identifier to hand to the next institution', /^CKYC-/.test(String(rec.kycIdentifier)));
  ok('it expires, and medium risk means eight years',
    new Date(rec.expiresAt).getFullYear() - new Date(rec.verifiedAt).getFullYear() === 8,
    `${rec.verifiedAt} -> ${rec.expiresAt}`);
  ok('the registry upload is declared not done', /NOT UPLOADED/.test(String(rec.registryStatus)));
  ok('the record declares itself simulated', rec.simulated === true);

  const badPan = await post('/kyc/verify', 'investor1', 'Investor', {
    holder: 'investor1', route: 'AADHAAR_OFFLINE_XML', consent: true, pan: 'ABCD1234FG',
    offlineReferenceId: offlineRef(), offlineGeneratedAt: nowISO(2),
  });
  ok('a malformed PAN is caught', badPan.status === 400, String(badPan.status));

  // 6. The video route is the only way to full tier, and only with all of its
  // conditions.
  const halfVideo = await post('/kyc/verify', 'regulator1', 'Regulator', {
    holder: 'investor2', route: 'VCIP', consent: true, videoOfficial: 'officer-7', livenessPassed: false,
    panShownOnCall: true, locationInIndia: true,
  });
  ok('a video session missing liveness is refused', halfVideo.status === 409, String(halfVideo.status));
  ok('the refusal lists what was missing', /liveness/i.test(String(halfVideo.body.message)), String(halfVideo.body.message).slice(0, 160));

  const video = await post('/kyc/verify', 'regulator1', 'Regulator', {
    holder: 'investor2', route: 'VCIP', consent: true, videoOfficial: 'officer-7', livenessPassed: true,
    panShownOnCall: true, locationInIndia: true, riskBand: 'HIGH', pan: 'ABCDE1234F',
  });
  ok('a complete video session verifies', video.status === 201, JSON.stringify(video.body).slice(0, 160));
  const vrec = video.body.record || {};
  ok('it is treated as equal to meeting the holder', vrec.faceToFaceEquivalent === true);
  ok('it reaches the full tier', vrec.tier === 'FULL_KYC', vrec.tier);
  ok('no annual ceiling follows from being remote', !vrec.annualDebitCapPaise);
  ok('high risk means two years', new Date(vrec.expiresAt).getFullYear() - new Date(vrec.verifiedAt).getFullYear() === 2);
  ok('it says no video was actually recorded', /No video was recorded here/i.test(String(vrec.note)));

  // 7. The point of the layer: the wallet tier now comes from verification.
  await post('/cbdc/issue', 'regulator1', 'Regulator', { holder: 'investor2', amountPaise: 100000, kycTier: 'MIN_KYC' });
  const again = await post('/kyc/verify', 'regulator1', 'Regulator', {
    holder: 'investor2', route: 'VCIP', consent: true, videoOfficial: 'officer-7', livenessPassed: true,
    panShownOnCall: true, locationInIndia: true,
  });
  ok('re-verifying an existing holder works', again.status === 201, String(again.status));
  const wallet = await get('/cbdc/accounts/investor2', 'regulator1', 'Regulator');
  ok('the wallet carries the tier the verification produced',
    wallet.body?.account?.kycTier === 'FULL_KYC', JSON.stringify(wallet.body?.account || {}).slice(0, 140));
  ok('and records which route produced it',
    wallet.body?.account?.kycVerifiedBy === 'VCIP', String(wallet.body?.account?.kycVerifiedBy));

  // 8. Records are the holder's own or a supervisor's.
  const mine = await get('/kyc/holders/investor1', 'investor1', 'Investor');
  ok('a holder can read their own record', mine.status === 200 && mine.body.record.holder === 'investor1');
  const nosy = await get('/kyc/holders/investor2', 'investor1', 'Investor');
  ok('a holder cannot read somebody else\'s', nosy.status === 403, String(nosy.status));
  const log = await get('/kyc/records', 'investor1', 'Investor');
  ok('the verification log is supervisor-only', log.status === 403, String(log.status));
  const missing = await get('/kyc/holders/nobody-here', 'regulator1', 'Regulator');
  ok('an unverified holder is reported as unverified', missing.status === 404, String(missing.status));

  // 9. Everything lands on the chain, without the things it must not hold.
  const chain = await (await fetch(BASE + '/api/drunix/chain?limit=60')).json();
  const kycBlocks = (chain.blocks || []).filter((b) => String(b.type).startsWith('UMI_KYC'));
  ok('verifications and refusals are on the chain', kycBlocks.length >= 2, String(kycBlocks.length));
  ok('no block contains a twelve digit number',
    !/\b\d{12}\b/.test(JSON.stringify(kycBlocks)), JSON.stringify(kycBlocks).slice(0, 160));

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
