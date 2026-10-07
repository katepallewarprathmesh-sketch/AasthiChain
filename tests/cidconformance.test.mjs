// Do our CIDs match real IPFS?
//
// Everything in the document subsystem rests on one claim: the CID we compute
// in Go is the same CID a real IPFS node would compute for the same bytes. If
// that is off by anything, "fetch it from any public gateway" quietly stops
// working and our tamper-proofing becomes a promise nobody can check.
//
// Our own Go tests cannot catch this — they would only confirm our maths
// agrees with itself. So this compares against ipfs-only-hash, the reference
// JS implementation of the same spec, with the settings our pin store uses
// (cid-version=1, raw-leaves=true).
//
// The interesting sizes are around the 262144-byte chunk boundary: below it a
// file is a single raw block, above it the root becomes a dag-pb node whose
// link table has to be laid out exactly right.
//
//   node tests/cidconformance.test.mjs
//   RAIL=http://localhost:21100 node tests/cidconformance.test.mjs

const RAIL = process.env.RAIL || 'http://localhost:21100'

let Hash
try {
  Hash = (await import('ipfs-only-hash')).default
} catch {
  console.log('\n  ipfs-only-hash is not installed — skipping CID conformance.')
  console.log('  install it with: npm i --no-save ipfs-only-hash@4.0.0\n')
  process.exit(0)
}

let passed = 0
let failed = 0
function ok(label, cond, detail = '') {
  if (cond) { passed++; console.log(`  ok   ${label}`) }
  else { failed++; console.log(`  FAIL ${label}${detail ? ' — ' + detail : ''}`) }
}

const CHUNK = 262144

// The register refuses to anchor the same bytes twice — correctly, that is
// what stops one encumbrance certificate being reused across listings. So
// every run must generate fresh bytes while keeping the exact lengths that
// make these cases interesting. A per-run seed does both.
const RUN = (Date.now() ^ (Math.random() * 0xffffffff)) >>> 0

// Deterministic pseudo-random bytes, so a failure is reproducible.
function bytes(n, seed = 1) {
  const out = Buffer.alloc(n)
  let x = (seed ^ RUN) >>> 0
  for (let i = 0; i < n; i++) {
    x = (x * 1664525 + 1013904223) >>> 0
    out[i] = x >>> 24
  }
  return out
}

const CASES = [
  ['a single byte', bytes(1)],
  ['a short certificate', Buffer.from(`Title validation certificate\nasset: PROP-${RUN}\n`)],
  ['text with non-ASCII (₹ and an em dash)', Buffer.from(`Consideration ₹45,00,000 — paid in full, ref ${RUN}`)],
  ['one byte under the chunk boundary', bytes(CHUNK - 1, 7)],
  ['exactly the chunk boundary', bytes(CHUNK, 11)],
  ['one byte over the chunk boundary', bytes(CHUNK + 1, 13)],
  ['a three-chunk file', bytes(CHUNK * 2 + 5000, 17)],
]

let railUp = true
try {
  const h = await fetch(RAIL + '/') // the endpoint directory; the rail has no /umi/health
  railUp = h.ok
} catch { railUp = false }

if (!railUp) {
  console.log(`\n  rail is not running at ${RAIL} — skipping CID conformance.\n`)
  process.exit(0)
}

for (const [label, content] of CASES) {
  // What a real IPFS node would call these bytes.
  const expected = await Hash.of(content, { cidVersion: 1, rawLeaves: true })

  // What our Go implementation calls them. Anchoring is the only path that
  // exercises the production code, so use it and then read the CID back.
  const res = await fetch(RAIL + '/umi/documents', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Identity-Id': 'registrar1', 'X-Identity-Role': 'Registrar' },
    body: JSON.stringify({
      assetId: `PROP-CID-CONFORMANCE-${RUN}-${content.length}`,
      docType: 'TEST_FIXTURE',
      title: label,
      visibility: 'public',
      contentBase64: content.toString('base64'),
    }),
  })
  const body = await res.json()

  // A duplicate from an earlier run is fine: the error names the CID it
  // clashed with, which is exactly the value under test.
  const ours = body?.document?.cid || body?.cid || body?.existingCid

  if (!ours) {
    ok(`${label} (${content.length} B)`, false, `no CID in response: ${JSON.stringify(body).slice(0, 180)}`)
    continue
  }
  ok(`${label} (${content.length} B) → ${expected.slice(0, 16)}…`,
     ours === expected,
     `real IPFS says ${expected}, we say ${ours}`)
}

// A raw single-chunk file must be a raw-codec CID, a multi-chunk one dag-pb.
// Getting this backwards is the classic way to produce a CID that looks
// plausible and resolves to nothing.
const small = await Hash.of(bytes(100, 3), { cidVersion: 1, rawLeaves: true })
const big = await Hash.of(bytes(CHUNK * 2, 3), { cidVersion: 1, rawLeaves: true })
ok('a small file is a raw block (bafkrei…)', small.startsWith('bafkrei'), small)
ok('a chunked file is a dag-pb node (bafybei…)', big.startsWith('bafybei'), big)

console.log(`\n  cid conformance: ${passed} passed, ${failed} failed\n`)
process.exit(failed === 0 ? 0 : 1)
