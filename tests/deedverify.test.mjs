// "Hash the file you were sent" is a dead end on a seeded listing: no deed was
// ever issued, so there is no file, and every attempt reads as a mismatch. The
// panel now says that instead of inviting a check that cannot pass, and the
// hashing command is given for all three operating systems rather than only
// the one the author happened to use.

import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'

let pass = 0, fail = 0
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); pass++ }
  catch (e) { console.log(`  FAIL ${name}: ${e.message}`); fail++ }
}

const page = readFileSync(new URL('../frontend/src/pages/PropertyDetail.jsx', import.meta.url), 'utf8')

check('the seeded placeholder digest is recognised', () => {
  assert.match(page, /SEEDED_DOC_HASHES/)
  assert.match(page, /a3f5c1e8b9d2f4a6c8e0b1d3f5a7c9e1b2d4f6a8c0e2b4d6f8a0c2e4b6d8f0a1/)
})

check('a seeded listing says no document exists', () => {
  assert.match(page, /docIsSeeded && \(/)
  assert.match(page, /no deed was ever issued against it/)
})

check('the comparison is case-insensitive, hashes get pasted in either case', () => {
  assert.match(page, /String\(property\.documentHash \|\| ''\)\.toLowerCase\(\)/)
})

check('the hashing command is given for Windows and macOS too', () => {
  assert.match(page, /certutil -hashfile/)
  assert.match(page, /shasum -a 256/)
  assert.match(page, /sha256sum/)
})

check('the verify box itself is still offered', () => {
  assert.match(page, /verifyPropertyDocument/)
  assert.match(page, /64-character SHA-256/)
})

console.log(`\n  ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
