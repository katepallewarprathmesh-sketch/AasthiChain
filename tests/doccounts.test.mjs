// Numbers in the docs have to match the repository they describe.
//
// docs/DEMO.md is read aloud at a demo, so a stale count there is said out
// loud to a jury. It claimed 58 suites and 23 Go test files long after both
// had grown, and nothing caught it. This counts the files and compares.

import { readFileSync, readdirSync } from 'node:fs'
import assert from 'node:assert/strict'

let pass = 0, fail = 0
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); pass++ }
  catch (e) { console.log(`  FAIL ${name}: ${e.message}`); fail++ }
}

const root = new URL('../', import.meta.url)
const read = f => readFileSync(new URL(f, root), 'utf8')

const suites = readdirSync(new URL('tests/', root)).filter(f => f.endsWith('.test.mjs')).length
const goTests = ['drunix-gateway', 'chaincode', 'payment-gateway', 'api-gateway']
  .flatMap(d => {
    try { return readdirSync(new URL(d + '/', root)).filter(f => f.endsWith('_test.go')) }
    catch { return [] }
  }).length

check('docs/DEMO.md states the real suite and Go test counts', () => {
  const demo = read('docs/DEMO.md')
  const m = demo.match(/(\d+) integration\s*\n?>?\s*suites and (\d+) Go test files/)
  assert.ok(m, 'the closing line no longer states both counts')
  assert.equal(Number(m[1]), suites, `DEMO.md says ${m[1]} suites, there are ${suites}`)
  assert.equal(Number(m[2]), goTests, `DEMO.md says ${m[2]} Go test files, there are ${goTests}`)
})

check('docs/TESTING.md reports a pass count, not a guess', () => {
  const t = read('docs/TESTING.md')
  assert.match(t, /\*\*\d+ passed, 0 failed\*\*/)
})

console.log(`\n  ${pass} passed, ${fail} failed  (counted ${suites} suites, ${goTests} Go test files)`)
process.exit(fail ? 1 : 0)
