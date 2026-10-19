// End-to-end checks for proof of backing.
//
// The failure these checks exist for is issuance that outruns the asset
// behind it. A named party states how many units exist, with evidence and a
// refresh date; the rail then refuses to issue past that figure, says so on
// the chain, and reports an asset that is already over-issued instead of
// hiding it. It does not claim the statement is true.
//
//   node tests/backing.test.mjs             (BASE=http://localhost:8080)

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
const asRegistrar = post('registrar1', 'Registrar');
const asInvestor = post('investor1', 'Investor');

const hash = (n) => String(n).padStart(64, 'f');
const assetId = 'BACKING-TEST-' + Date.now();

const run = async () => {
  console.log('Proof of backing');

  // 1. A statement needs evidence behind it.
  const noHash = await asRegistrar('/umi/backing', {
    assetId, backedUnits: 100, valuationINR: 100000, method: 'registry extract', evidenceHash: 'nope',
  });
  ok('a statement without a real evidence hash is refused', noHash.status === 400, JSON.stringify(noHash.body));

  const noUnits = await asRegistrar('/umi/backing', {
    assetId, backedUnits: 0, valuationINR: 100000, method: 'registry extract', evidenceHash: hash(1),
  });
  ok('a statement of zero units is refused', noUnits.status === 400, JSON.stringify(noUnits.body));

  // 2. Only a registrar or a supervisor may attest. The figure is worth
  //    something only because the attestor is not the beneficiary.
  const byInvestor = await asInvestor('/umi/backing', {
    assetId, backedUnits: 100, valuationINR: 100000, method: 'registry extract', evidenceHash: hash(2),
  });
  ok('an investor cannot attest to their own backing', byInvestor.status === 403, JSON.stringify(byInvestor.body));

  // 3. A complete statement is accepted and readable.
  const made = await asRegistrar('/umi/backing', {
    assetId, backedUnits: 500, valuationINR: 2500000, method: 'registry extract', evidenceHash: hash(3),
  });
  ok('a registrar can record a statement of backing', made.status === 200 || made.status === 201,
    JSON.stringify(made.body));
  const cov = made.body && made.body.coverage;
  ok('the statement comes back with a status and a refresh date',
    !!cov && typeof cov.status === 'string' && !!cov.nextDueAt, JSON.stringify(made.body));

  const read = await rail('/umi/backing/' + assetId, { headers: headers('investor1', 'Investor') });
  ok('any participant can read the coverage for an asset', read.status === 200, JSON.stringify(read.body));
  ok('coverage names the attestor and the evidence',
    read.body && read.body.coverage && read.body.coverage.attestor === 'registrar1'
      && read.body.coverage.evidenceHash === hash(3), JSON.stringify(read.body));

  // 4. The solvency summary is honest about what it can and cannot check.
  const summary = await rail('/umi/backing', { headers: headers('investor1', 'Investor') });
  ok('the solvency summary lists the attested assets', summary.status === 200 && Array.isArray(summary.body.assets),
    JSON.stringify(summary.body).slice(0, 200));
  ok('the summary says the rail cannot verify the attestation itself',
    typeof summary.body.disclaimer === 'string' && /cannot check/i.test(summary.body.disclaimer),
    String(summary.body && summary.body.disclaimer).slice(0, 160));

  // 5. Withdrawal is notice, not reversal, and only the attestor may give it.
  const stolen = await asInvestor('/umi/backing/' + assetId + '/withdraw', { reason: 'I disagree' });
  ok('a third party cannot withdraw somebody else\u2019s statement', stolen.status === 403, JSON.stringify(stolen.body));

  const pulled = await asRegistrar('/umi/backing/' + assetId + '/withdraw', { reason: 'extract superseded' });
  ok('the attestor can withdraw their statement', pulled.status === 200, JSON.stringify(pulled.body));
  const after = await rail('/umi/backing/' + assetId, { headers: headers('investor1', 'Investor') });
  ok('a withdrawn statement reads WITHDRAWN and refuses further issuance',
    after.body && after.body.coverage && after.body.coverage.status === 'WITHDRAWN'
      && after.body.coverage.mayIssue === false, JSON.stringify(after.body).slice(0, 200));

  // 6. Both events are on the chain, so the gate is auditable.
  const chain = await rail('/drunix/chain?limit=50');
  const types = (chain.body && (chain.body.blocks || chain.body.chain) || []).map((b) => b.type || b.Type);
  ok('the statement was committed as a block', types.includes('UMI_BACKING_ATTESTED'), types.slice(0, 12).join(','));
  ok('the withdrawal was committed as a block', types.includes('UMI_BACKING_WITHDRAWN'), types.slice(0, 12).join(','));

  // 7. The app proxy exposes the same thing without rail logic of its own.
  const proxied = await app('/api/umi/backing');
  ok('the app proxies the solvency summary', proxied.status === 200 && Array.isArray(proxied.body.assets),
    JSON.stringify(proxied.body).slice(0, 160));

  // 8. An asset nobody attested is untouched: the gate binds only where
  //    there is a statement to bind to.
  const unattested = await rail('/umi/backing/NOBODY-ATTESTED-THIS', { headers: headers('investor1', 'Investor') });
  ok('an unattested asset reports UNATTESTED rather than an error',
    unattested.status === 200 && unattested.body.coverage
      && unattested.body.coverage.status === 'UNATTESTED' && unattested.body.coverage.mayIssue === true,
    JSON.stringify(unattested.body).slice(0, 200));

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
};

run().catch((e) => { console.error(e); process.exit(1); });
