// The home page has to describe the system that exists today.
//
// It drifted badly once: it described the first few months of the project
// and nothing after, so the settlement rail, the proof chain and agent
// authority were invisible to anyone who did not already know the URLs. It
// also carried numbers that had long stopped being true. This guards both.

import { readFileSync, readdirSync } from 'node:fs'

const BASE = process.env.BASE || 'http://localhost:8080'
const root = new URL('../', import.meta.url)
const landing = readFileSync(new URL('frontend/src/pages/Landing.jsx', root), 'utf8')

let pass = 0, fail = 0
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ok   ' + name) }
  else { fail++; console.log('  FAIL ' + name + (detail ? '\n       ' + detail : '')) }
}

// Every shipped surface a visitor should be able to find from the front door.
for (const [what, needle] of [
  ['the settlement rail', /Unified Market Interface rail/i],
  ['attestation and credentials', /Attestation and credentials/i],
  ['agent authority', /Authority for software agents/i],
  ['the ledger explorer', /Ledger explorer/i],
  ['resale', /Resale and price discovery/i],
  ['asset servicing', /servicing/i],
  ['cross-chain settlement', /Cross-chain settlement/i],
  ['private data', /Private data between parties/i],
  ['the other asset classes', /Carbon credits/i],
  ['the trust page', /trust/i],
]) {
  ok(`the home page mentions ${what}`, needle.test(landing))
}

for (const to of ['/umi', '/proof', '/ledger', '/market', '/trust']) {
  ok(`the home page links to ${to}`, landing.includes(`to: '${to}'`) || landing.includes(`to="${to}"`) || landing.includes(`href="${to}"`))
}

// Claims that were true once and are not checkable now. A number on the home
// page that no test asserts is a number that will go stale again.
for (const stale of ['216+', 'Track A6', '9 funcs', 'hackathons']) {
  ok(`the home page no longer claims "${stale}"`, !landing.includes(stale))
}

// The honest separation has to survive edits.
ok('the home page still labels the simulation', /SIMULATION/.test(landing))
ok('it does not claim a connection to a real institution',
   !/(live NPCI|RBI integration|connected to RBI|partnership with)/i.test(landing))

// The shared page frame exists and is actually used, which is what keeps the
// inner pages looking like the same product as the front door.
const css = readFileSync(new URL('frontend/src/index.css', root), 'utf8')
ok('the shared page frame is defined once', css.includes('.pg-title') && css.includes('.pg-card'))
const pages = readdirSync(new URL('frontend/src/pages/', root)).filter(f => f.endsWith('.jsx'))
const adopters = pages.filter(f => readFileSync(new URL('frontend/src/pages/' + f, root), 'utf8').includes('pg-title'))
ok('most pages use the shared title style', adopters.length >= 10, `${adopters.length} of ${pages.length}`)

// And the routes the home page promises have to answer.
const get = async (p) => {
  try { const r = await fetch(BASE + p); return r.status } catch { return 0 }
}
for (const p of ['/', '/proof', '/umi', '/ledger', '/trust']) {
  ok(`${p} is served`, (await get(p)) === 200)
}
for (const p of ['/api/umi/credentials', '/api/umi/attestations', '/api/umi/attestors/registrar1']) {
  ok(`${p} answers`, (await get(p)) === 200)
}

console.log(`\n  ${pass} passed, ${fail} failed\n`)
process.exit(fail ? 1 : 0)
