// The proof page, end to end and in source.
//
// The page shipped calling fetch directly with no identity headers, so every
// participant-scoped read answered ERR_UMI_NO_IDENTITY and the agent
// authority tab showed a permission error to everyone. These checks pin the
// fix: the reads it makes must work for a signed-in participant, and the page
// must not grow a bare fetch again.
//
//   node tests/proofpage.test.mjs            (BASE=http://localhost:8080)

import { readFileSync } from 'node:fs'

const BASE = process.env.BASE || 'http://localhost:8080'
const SRC = new URL('../frontend/src/pages/ProofChain.jsx', import.meta.url)
let passed = 0, failed = 0
const ok = (name, cond, detail) => {
  if (cond) { passed++; console.log('  ok   ' + name) }
  else { failed++; console.log('  FAIL ' + name + (detail ? '\n       ' + detail : '')) }
}

const asInvestor = (path) => fetch(BASE + path, {
  headers: { 'X-Fabric-Identity': 'investor1', 'X-Identity-Role': 'Investor' },
})

async function main() {
  console.log('\nProof page\n')

  const src = readFileSync(SRC, 'utf8')

  // 1. The bug itself: no unheadered fetch may come back.
  ok('the page does not call fetch directly',
     !/\bfetch\s*\(/.test(src.replace(/umiFetch\s*\(/g, '')),
     'a bare fetch sends no identity, which is what broke the mandate tab')
  ok('reads go through the shared rail helper', /umiFetch/.test(src))

  // 2. Every tab the page offers must correspond to a route that answers.
  const tabs = [...src.matchAll(/\{ id: '([a-z]+)', label: '([^']+)' \}/g)].map(m => m[1])
  ok('the page still offers its four original tabs',
     ['credentials', 'impact', 'attestor', 'mandates'].every(t => tabs.includes(t)), tabs.join(','))
  ok('verified delivery is on the page', tabs.includes('delivery'), tabs.join(','))

  const reads = [
    ['credentials', '/api/umi/credentials?limit=50'],
    ['attestor record', '/api/umi/attestors/registrar1'],
    ['agent authority', '/api/umi/mandates?limit=50'],
    ['verified delivery', '/api/umi/work'],
  ]
  for (const [what, path] of reads) {
    const r = await asInvestor(path)
    ok(`${what} answers a signed-in participant`, r.status === 200, `${path} gave ${r.status}`)
  }

  // 3. The impact tab must be usable without knowing a credential id, which
  //    means the list it offers has to contain ids that actually resolve.
  const list = await (await asInvestor('/api/umi/credentials?limit=50')).json()
  const attested = (list.credentials || [])
    .map(rec => rec.credential || {})
    .filter(c => (c.credentialSubject || {}).assetId)
  ok('at least one credential is issued against an asset, so the picker is not empty',
     attested.length > 0, `${(list.credentials || []).length} credentials, none asset-scoped`)

  if (attested.length) {
    const id = attested[0].id
    const r = await asInvestor('/api/umi/attestations/' + encodeURIComponent(id))
    const body = await r.json()
    ok('a credential the picker offers resolves to an attestation impact',
       r.status === 200 && !!body.impact, `${r.status} ${JSON.stringify(body).slice(0, 160)}`)
    ok('the impact states its recourse rather than implying one',
       typeof (body.impact || {}).recourse === 'string' && body.impact.recourse.length > 0)
  }

  // 4. The delivery tab reports the outcome layer, and reports it honestly.
  const work = await (await asInvestor('/api/umi/work')).json()
  const summary = work.outcome || {}
  ok('the work desk reports the outcome summary the delivery tab renders',
     typeof summary.ordersWithOutcomeTerms === 'number', JSON.stringify(summary).slice(0, 160))
  ok('the page says the verifier has no legal standing',
     /not an adjudicator/i.test(src) || /not an adjudicator/i.test(summary.disclaimer || ''))

  console.log(`\n  ${passed} passed, ${failed} failed\n`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(1) })
