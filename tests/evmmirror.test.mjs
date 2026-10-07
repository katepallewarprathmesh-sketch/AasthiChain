// Does the public-chain mirror actually hold what we claim?
//
// Every assertion here reads the contract directly over JSON-RPC with ethers.
// Nothing in this file asks the AasthiChain API whether a document is genuine
// — that is the entire point. A counterparty with the chain address and this
// script can audit us without our cooperation.
//
// Skips cleanly when no chain is configured, so the normal gate is unaffected:
//   EVM_RPC_URL=http://127.0.0.1:8545 \
//   EVM_REGISTRY_ADDRESS=0x... node tests/evmmirror.test.mjs

const RPC = process.env.EVM_RPC_URL || 'http://127.0.0.1:8545'
const ADDRESS = process.env.EVM_REGISTRY_ADDRESS || ''
const BASE = process.env.BASE || 'http://localhost:8080'

let ethers
try {
  ethers = await import('ethers')
} catch {
  console.log('\n  ethers is not installed — skipping the public-chain mirror test.')
  console.log('  install it with: npm i --no-save ethers@6\n')
  process.exit(0)
}
if (!ADDRESS) {
  console.log('\n  EVM_REGISTRY_ADDRESS is not set — skipping the public-chain mirror test.')
  console.log('  deploy with: node contracts/deploy-local.mjs\n')
  process.exit(0)
}

let passed = 0
let failed = 0
function ok(label, cond, detail = '') {
  if (cond) { passed++; console.log(`  ok   ${label}`) }
  else { failed++; console.log(`  FAIL ${label}${detail ? ' — ' + detail : ''}`) }
}

const ABI = [
  'function verify(string cid) view returns (bool anchored, uint8 status, bool expired, tuple(bytes32 assetId,bytes32 sha256Digest,string cid,string docType,address anchoredBy,uint64 anchoredAt,uint64 validFrom,uint64 validTo,uint8 status,string supersededBy,string statusReason,uint64 statusAt) doc)',
  'function verifyDigest(bytes32 sha256Digest) view returns (bool anchored, uint8 status, tuple(bytes32 assetId,bytes32 sha256Digest,string cid,string docType,address anchoredBy,uint64 anchoredAt,uint64 validFrom,uint64 validTo,uint8 status,string supersededBy,string statusReason,uint64 statusAt) doc)',
  'function documentsOf(bytes32 assetId) view returns (bytes32[])',
  'function total() view returns (uint256)',
]

const provider = new ethers.JsonRpcProvider(RPC)
const registry = new ethers.Contract(ADDRESS, ABI, provider)

// Drive a full property lifecycle through the app, then audit the result
// against the chain.
const tok = (identityId, mspId, role) =>
  Buffer.from(JSON.stringify({ identityId, mspId, role, exp: Date.now() + 9e6 })).toString('base64')
const originator = tok('originator1', 'OriginatorMSP', 'Originator')
const registrar = tok('registrar1', 'RegistrarMSP', 'Registrar')
const J = t => ({ 'Content-Type': 'application/json', Authorization: 'Bearer ' + t })

const deedHash = [...crypto.getRandomValues(new Uint8Array(32))]
  .map(b => b.toString(16).padStart(2, '0')).join('')

const created = await (await fetch(BASE + '/api/properties', {
  method: 'POST', headers: J(originator),
  body: JSON.stringify({
    // Unique per run: the app refuses a second listing with the same
    // title+city+pincode, which is correct behaviour and would otherwise make
    // this test pass only the first time it is ever run.
    title: `Chain mirror audit ${Date.now()}`, state: 'MH', city: 'Pune', pincode: '411001',
    valuationINR: 9000000, documentHash: deedHash,
  }),
})).json()
const assetId = created.assetId
ok('a property can still be registered with the mirror switched on',
   !!assetId && !created.error, JSON.stringify(created).slice(0, 160))

const validated = await fetch(`${BASE}/api/properties/${assetId}/validate`, {
  method: 'POST', headers: J(registrar),
  body: JSON.stringify({ decision: 'VALIDATED', note: 'Title clear' }),
})
ok('a registrar can validate it', validated.status === 200, `status ${validated.status}`)
await fetch(`${BASE}/api/properties/${assetId}/mint`, {
  method: 'POST', headers: J(originator), body: JSON.stringify({ totalTokens: 1000 }),
})

// Certificates are filed in the background and then mirrored in the
// background again, so poll rather than guessing at a sleep. Two independent
// async hops is exactly the kind of thing a fixed delay gets wrong on a slow
// machine and right on a fast one.
async function waitFor(check, label, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const v = await check()
    if (v) return v
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await new Promise(r => setTimeout(r, 400))
  }
}

const docs = await waitFor(async () => {
  const r = await (await fetch(`${BASE}/api/umi/documents/${assetId}`)).json()
  const d = r.documents || []
  return d.some(x => x.docType === 'VALIDATION_CERTIFICATE') ? d : null
}, 'the validation certificate to be filed')
const cert = docs.find(d => d.docType === 'VALIDATION_CERTIFICATE')
ok('our register produced a validation certificate', !!cert)

// --- the part that matters: ask the chain, not us ------------------------
const onChain = await waitFor(
  async () => { const r = await registry.verify(cert.cid); return r[0] ? r : null },
  'the EVM mirror to confirm the anchor',
)
ok('the chain independently confirms that CID is anchored', onChain[0] === true)
ok('the chain reports it ACTIVE', Number(onChain[1]) === 1, `status ${onChain[1]}`)
ok('the chain does not consider it expired', onChain[2] === false)

const doc = onChain[3]
ok('the digest on the chain matches the digest in our register',
   doc.sha256Digest.toLowerCase() === '0x' + cert.sha256.toLowerCase(),
   `${doc.sha256Digest} vs 0x${cert.sha256}`)
ok('the chain stored the document type', doc.docType === 'VALIDATION_CERTIFICATE', doc.docType)
ok('the chain records which registrar anchored it', /^0x[0-9a-fA-F]{40}$/.test(doc.anchoredBy))

// The asset id is hashed before it is sent, so the chain is queryable by
// anyone who knows the id but readable by nobody who does not.
const assetKey = ethers.keccak256(ethers.toUtf8Bytes(assetId))
// ethers returns uint64s as BigInt, so stringify with a replacer rather than
// letting JSON.stringify throw.
const docText = JSON.stringify(doc, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))
ok('the asset id on the chain is a hash, not the readable id',
   doc.assetId === assetKey && !docText.includes(assetId))

const listed = await registry.documentsOf(assetKey)
ok('the chain can list this asset\'s documents without our help', listed.length >= 1, `${listed.length}`)

// Verification by digest alone — the path someone takes when all they have
// is the file itself.
const byDigest = await registry.verifyDigest('0x' + cert.sha256)
ok('a holder of the file can verify it by digest alone', byDigest[0] === true)

// A document nobody anchored must not verify.
const fake = '0x' + 'ab'.repeat(32)
const bogus = await registry.verifyDigest(fake)
ok('an unknown digest is not anchored on the chain', bogus[0] === false)

// Tamper detection: change one byte of the real digest.
const flipped = '0x' + cert.sha256.slice(0, 62) + (cert.sha256.slice(62) === 'ff' ? '00' : 'ff')
const tampered = await registry.verifyDigest(flipped)
ok('a digest one byte different is rejected', tampered[0] === false)

// --- privacy: what must NOT be on the chain ------------------------------
const deed = docs.find(d => d.docType === 'TITLE_DEED')
if (deed) {
  const deedOnChain = await registry.verify(deed.cid)
  ok('digest-only records are kept off the public chain entirely',
     deedOnChain[0] === false,
     'a digestOnly document reached the EVM mirror')
}

// --- the second opinion, as the /verify page shows it --------------------
// The gateway asks the chain on the user's behalf and reports whether the two
// sources agree. A user should not have to run ethers to get that.
const verifyRes = await (await fetch(`${BASE}/api/umi/documents/verify`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ sha256: cert.sha256 }),
})).json()
const chainSays = verifyRes.onChain
ok('verifying through the API also reports a public-chain check', !!chainSays,
   JSON.stringify(verifyRes).slice(0, 160))
ok('that check reached the chain', chainSays?.checked === true, chainSays?.error)
ok('and the two independent sources agree',
   chainSays?.anchored === true && chainSays?.agreesWithOurRegister === true)
ok('it names the contract the user can check for themselves',
   /^0x[0-9a-fA-F]{40}$/.test(chainSays?.contract || ''), chainSays?.contract)

const total = await registry.total()
ok('the contract counts the documents it holds', Number(total) >= 1, `${total}`)

console.log(`\n  evm mirror: ${passed} passed, ${failed} failed\n`)
process.exit(failed === 0 ? 0 : 1)
