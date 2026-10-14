// Two UI faults a user hit in the same sitting.
//
// 1. The navbar highlighted Resale while Marketplace was open, because the
//    active check was a bare startsWith and '/marketplace' starts with
//    '/market'. The same bug lit Admin and Ops together on /admin/ops.
//
// 2. Create Tokens was offered on a listing the signed-in identity does not
//    own. The rail refuses that correctly (minting sets the supply, which
//    sets the price), so the only thing the click produced was "Failed to
//    create tokens", which reads as a broken button rather than a rule.
//
// Both are checked in source. The nav rule is also executed here against the
// real paths, because the regression is a string comparison and that is
// exactly the kind of thing a reader nods at and gets wrong.

import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'

let pass = 0, fail = 0
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); pass++ }
  catch (e) { console.log(`  FAIL ${name}: ${e.message}`); fail++ }
}

const app = readFileSync(new URL('../frontend/src/App.jsx', import.meta.url), 'utf8')
const admin = readFileSync(new URL('../frontend/src/pages/Admin.jsx', import.meta.url), 'utf8')

// ---------- nav
check('the active check is not a bare startsWith', () => {
  assert.ok(!/const isActive = \(p\) => location\.pathname === p \|\| location\.pathname\.startsWith\(p\)/.test(app),
    'the prefix bug is back')
  assert.match(app, /startsWith\(p \+ '\/'\)/)
})

// The real rule, lifted from App.jsx, run against the real nav paths.
const paths = ['/dashboard', '/marketplace', '/wallet', '/ledger', '/market', '/umi', '/admin', '/admin/ops', '/regulator']
const navMatches = (pathname, p) => (p === '/'
  ? pathname === '/'
  : pathname === p || pathname.startsWith(p + '/'))
const activeFor = (pathname) => paths.filter((p) =>
  navMatches(pathname, p) && !paths.some((o) => o !== p && o.length > p.length && navMatches(pathname, o)))

check('Marketplace alone is active on /marketplace', () => {
  assert.deepEqual(activeFor('/marketplace'), ['/marketplace'])
})

check('Resale alone is active on /market', () => {
  assert.deepEqual(activeFor('/market'), ['/market'])
})

check('only Ops is active on /admin/ops, not Admin as well', () => {
  assert.deepEqual(activeFor('/admin/ops'), ['/admin/ops'])
})

check('a child route still lights its parent tab', () => {
  assert.deepEqual(activeFor('/marketplace/PROP-1'), ['/marketplace'])
})

check('exactly one tab is active on every nav path', () => {
  for (const p of paths) assert.equal(activeFor(p).length, 1, p)
})

// ---------- mint ownership
check('the mint button is gated on ownership, not only on validation', () => {
  assert.match(admin, /const canMintThis =/)
  assert.match(admin, /const mintable = validationStatus === 'VALIDATED' && canMintThis/)
  assert.match(admin, /disabled=\{!mintable\}/)
})

check('the rule matches the server: owner, Originator or Regulator', () => {
  assert.match(admin, /ownerId === user\?\.identityId \|\| \['Originator', 'Regulator'\]\.includes/)
})

check('the owner of the selected listing is read and remembered', () => {
  assert.match(admin, /setOwnerId\(prop\.originatorId \|\| ''\)/)
})

check('the reason names the owner before the click', () => {
  assert.match(admin, /This listing was created by/)
  assert.match(admin, /\{ownerId\}/)
})

// Investors have no minting screen, so an investor-owned demo listing could
// never be tokenised by anybody while the rule was owner-or-Regulator.
check('both servers allow an Originator to mint a listing they do not own', () => {
  for (const [name, src] of [
    ['serverless', readFileSync(new URL('../frontend/api/index.js', import.meta.url), 'utf8')],
    ['mock-api', readFileSync(new URL('../mock-api-server.js', import.meta.url), 'utf8')],
  ]) {
    assert.match(src, /minterRole !== 'regulator' && minterRole !== 'originator'/, name)
  }
})

check('an Investor still cannot mint somebody else\'s listing', () => {
  const src = readFileSync(new URL('../frontend/api/index.js', import.meta.url), 'utf8')
  // The guard is a deny-list of two roles: anything else that is not the
  // owner is still refused, which is what keeps this narrower than "any
  // signed-in caller".
  assert.ok(!/minterRole !== 'investor'/.test(src))
  assert.match(src, /error: 'ERR_NOT_ALLOWED'/)
})

check('the handler refuses too, so a stale render cannot post it anyway', () => {
  assert.match(admin, /if \(!canMintThis\) \{/)
})

console.log(`\n  ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
