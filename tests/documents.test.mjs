// End-to-end checks for the document register, through the Node proxy.
//
// The Go tests prove the register's logic. These prove the parts only a real
// request can prove: that the proxy does not mangle a binary body, that the
// integrity headers survive the hop, and that a document fetched over HTTP
// still hashes to the CID it was asked for.
//
//   node tests/documents.test.mjs            (BASE=http://localhost:8080)

import { createHash } from 'node:crypto';

const BASE = process.env.BASE || 'http://localhost:8080';
let passed = 0, failed = 0;

function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failed++; console.log('  FAIL ' + name + (detail ? '\n       ' + detail : '')); }
}

const j = async (path, init) => {
  const r = await fetch(BASE + path, init);
  const text = await r.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, body, headers: r.headers };
};

const post = (path, payload) => j(path, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(payload),
});

// A deterministic-but-unique document per run, so re-running the suite does
// not trip the duplicate rule.
const stamp = Date.now();
const DEED = `TITLE DEED\nSurvey 112/4, Pune\nConsideration: INR 50,00,000\nrun:${stamp}`;
const PLAN = `APPROVED PLAN\nblueprint bytes\nrun:${stamp}`;

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

async function main() {
  console.log('\nDocument register — ' + BASE + '\n');

  // --- anchoring ---------------------------------------------------------
  const anchored = await post('/api/umi/documents', {
    assetId: 'PROP-DOC-TEST', docType: 'TITLE_DEED', submittedBy: 'originator1',
    visibility: 'public', mediaType: 'text/plain', content: DEED,
  });
  ok('a document can be anchored', anchored.status === 201,
     `status ${anchored.status}: ${JSON.stringify(anchored.body).slice(0, 200)}`);

  const doc = anchored.body && anchored.body.document;
  ok('it comes back with an IPFS CID', !!(doc && /^bafkrei[a-z2-7]+$/.test(doc.cid)),
     doc && doc.cid);
  ok('and the SHA-256 the chaincode speaks', !!(doc && doc.sha256 === sha256(DEED)),
     doc && doc.sha256);
  ok('anchoring commits a ledger block',
     !!(anchored.body && anchored.body.block && anchored.body.block.height > 0));

  const cid = doc ? doc.cid : '';

  // --- the duplicate rule ------------------------------------------------
  const dupe = await post('/api/umi/documents', {
    assetId: 'PROP-OTHER', docType: 'TITLE_DEED', submittedBy: 'originator2',
    visibility: 'public', content: DEED,
  });
  ok('the same bytes cannot back a second property', dupe.status === 409,
     `status ${dupe.status}`);
  ok('and the rejection names the property that already claims them',
     typeof dupe.body?.message === 'string' && dupe.body.message.includes('PROP-DOC-TEST'),
     dupe.body?.message);

  // --- verification ------------------------------------------------------
  const good = await post('/api/umi/documents/verify', { content: DEED });
  ok('the genuine document verifies',
     good.body?.verification?.anchored === true &&
     good.body?.verification?.verdict?.includes('current'),
     JSON.stringify(good.body?.verification));

  const tampered = await post('/api/umi/documents/verify', {
    content: DEED.replace('50,00,000', '90,00,000'),
  });
  ok('a document with one figure changed does not verify',
     tampered.body?.verification?.anchored === false,
     JSON.stringify(tampered.body?.verification));

  const byCid = await post('/api/umi/documents/verify', { cid });
  ok('verification by CID alone works', byCid.body?.verification?.anchored === true);

  const byHash = await post('/api/umi/documents/verify', { sha256: sha256(DEED) });
  ok('verification by SHA-256 works, so the old hash path still answers',
     byHash.body?.verification?.anchored === true);

  // --- retrieval, and the headers that make it checkable -----------------
  const fetched = await fetch(BASE + '/api/umi/documents/fetch/' + cid);
  const bytes = Buffer.from(await fetched.arrayBuffer());
  ok('the document can be fetched back', fetched.status === 200, `status ${fetched.status}`);
  ok('the proxy returns the file, not a JSON error envelope',
     bytes.toString('utf8') === DEED,
     bytes.toString('utf8').slice(0, 120));
  ok('the CID header survives the proxy hop',
     fetched.headers.get('x-document-cid') === cid,
     fetched.headers.get('x-document-cid'));
  ok('and the bytes received really do hash to that CID',
     sha256(bytes.toString('utf8')) === doc.sha256);
  ok('content addressing is declared immutable to caches',
     (fetched.headers.get('cache-control') || '').includes('immutable'));

  // --- listing -----------------------------------------------------------
  await post('/api/umi/documents', {
    assetId: 'PROP-DOC-TEST', docType: 'APPROVED_PLAN', submittedBy: 'originator1',
    visibility: 'public', content: PLAN,
  });
  const listed = await j('/api/umi/documents/PROP-DOC-TEST');
  ok('every document for a property is listed together',
     Array.isArray(listed.body?.documents) && listed.body.documents.length >= 2,
     JSON.stringify(listed.body).slice(0, 160));

  // --- privacy -----------------------------------------------------------
  const kyc = await post('/api/umi/documents', {
    subject: 'investor1', docType: 'KYC_EVIDENCE', submittedBy: 'investor1',
    visibility: 'public', // asking for public must not make it public
    content: `AADHAAR XML 9999-8888-${stamp}`,
  });
  ok('KYC evidence can be anchored', kyc.status === 201, `status ${kyc.status}`);
  ok('but it is forced to digest-only however it was submitted',
     kyc.body?.document?.visibility === 'digestOnly',
     kyc.body?.document?.visibility);
  ok('and its content is never pinned', kyc.body?.document?.pinned === false);

  const kycFetch = await fetch(BASE + '/api/umi/documents/fetch/' + kyc.body?.document?.cid);
  ok('fetching KYC content is impossible, not merely forbidden',
     kycFetch.status === 410, `status ${kycFetch.status}`);

  const restricted = await post('/api/umi/documents', {
    assetId: 'PROP-DOC-TEST', docType: 'SALE_AGREEMENT', submittedBy: 'originator1',
    content: `names and signatures ${stamp}`, // no visibility given
  });
  ok('a document with no stated visibility defaults to restricted',
     restricted.body?.document?.visibility === 'restricted',
     restricted.body?.document?.visibility);
  const peek = await fetch(BASE + '/api/umi/documents/fetch/' + restricted.body?.document?.cid);
  ok('and an anonymous caller cannot read it', peek.status === 403, `status ${peek.status}`);

  // --- lifecycle ---------------------------------------------------------
  const revoked = await post('/api/umi/documents/' + cid + '/revoke', {
    reason: 'registrar found a forged attestation', by: 'registrar1',
  });
  ok('a document can be revoked', revoked.status === 200, `status ${revoked.status}`);
  ok('revocation commits its own block',
     revoked.body?.block?.height > (anchored.body?.block?.height || 0));

  const after = await post('/api/umi/documents/verify', { content: DEED });
  ok('a revoked document is still on the register — nothing is erased',
     after.body?.verification?.anchored === true);
  ok('but it is clearly marked as revoked',
     after.body?.verification?.verdict?.includes('REVOKED'),
     after.body?.verification?.verdict);
  ok('its original anchoring block is unchanged',
     after.body?.verification?.blockHeight === doc.blockHeight,
     `${after.body?.verification?.blockHeight} vs ${doc.blockHeight}`);

  const twice = await post('/api/umi/documents/' + cid + '/revoke', { reason: 'again' });
  ok('and it cannot be revoked twice', twice.status === 409, `status ${twice.status}`);

  // --- the ledger is still sound ----------------------------------------
  const chain = await j('/api/drunix/chain?limit=5');
  ok('document blocks are on the same chain as settlement',
     Array.isArray(chain.body?.blocks) &&
     chain.body.blocks.some(b => String(b.type).startsWith('UMI_DOC_')),
     JSON.stringify(chain.body?.blocks?.map(b => b.type)));

  const metrics = await fetch(BASE + '/api/umi/metrics');
  const text = await metrics.text();
  ok('no CID leaked into a metric label', !text.includes(cid));

  console.log(`\n  documents: ${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
