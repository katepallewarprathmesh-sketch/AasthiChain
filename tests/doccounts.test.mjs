// Numbers in the docs have to match the repository they describe.
//
// The DEMO note is read aloud at a demo, so a stale count there is said out
// loud to a jury. It claimed 58 suites and 23 Go test files long after both
// had grown, and nothing caught it. This counts the files and compares.
//
// Those two notes are internal and are not part of the published repository,
// so each check runs where its document exists and reports as skipped where
// it does not. A check that silently vanished would be worse than one that
// says why it did not run.

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import assert from 'node:assert/strict'

let pass = 0, fail = 0, skipped = 0
const checkIf = (file, name, fn) => {
  if (!existsSync(new URL(file, root))) {
    console.log(`  skip ${name}: ${file} is not in this checkout (internal note)`)
    skipped++
    return
  }
  check(name, fn)
}
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); pass++ }
  catch (e) { console.log(`  FAIL ${name}: ${e.message}`); fail++ }
}

const root = new URL('../', import.meta.url)
const read = f => readFileSync(new URL(f, root), 'utf8')

const suites = readdirSync(new URL('tests/', root)).filter(f => f.endsWith('.test.mjs')).length
// Walk each module. api-gateway keeps its code in middleware/, store/ and
// fabric/, and a flat read of the module directory counted none of them, so
// this check was comparing the published number against a wrong one.
const goTestsIn = (dir) => {
  let found = []
  let entries = []
  try { entries = readdirSync(new URL(dir + '/', root), { withFileTypes: true }) }
  catch { return found }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (e.name === 'vendor' || e.name === 'node_modules' || e.name.startsWith('.')) continue
      found = found.concat(goTestsIn(dir + '/' + e.name))
    } else if (e.name.endsWith('_test.go')) found.push(dir + '/' + e.name)
  }
  return found
}
const goTests = ['drunix-gateway', 'chaincode', 'payment-gateway', 'api-gateway']
  .flatMap(goTestsIn).length

checkIf('.internal-docs/DEMO.md', 'the DEMO note states the real suite and Go test counts', () => {
  const demo = read('.internal-docs/DEMO.md')
  const m = demo.match(/(\d+) integration\s*\n?>?\s*suites and (\d+) Go test files/)
  assert.ok(m, 'the closing line no longer states both counts')
  assert.equal(Number(m[1]), suites, `DEMO.md says ${m[1]} suites, there are ${suites}`)
  assert.equal(Number(m[2]), goTests, `DEMO.md says ${m[2]} Go test files, there are ${goTests}`)
})

checkIf('.internal-docs/TESTING.md', 'the TESTING note reports a pass count, not a guess', () => {
  const t = read('.internal-docs/TESTING.md')
  assert.match(t, /\*\*\d+ passed, 0 failed\*\*/)
})

console.log(`\n  ${pass} passed, ${fail} failed${skipped ? `, ${skipped} skipped` : ''}  (counted ${suites} suites, ${goTests} Go test files)`)
process.exit(fail ? 1 : 0)
