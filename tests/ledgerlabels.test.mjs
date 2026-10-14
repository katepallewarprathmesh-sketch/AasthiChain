// Every block type the rail can commit must have a label in the explorer.
//
// Regression: unknown types fell back to the GENESIS style, so the page
// labelled 65 of the 243 blocks on the live chain "Genesis" when exactly one
// of them was. The fallback now prints the committed type, and this test
// fails if a new Go block type ships without a label.

import { readFileSync, readdirSync } from 'node:fs'
import assert from 'node:assert/strict'

let pass = 0, fail = 0
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); pass++ }
  catch (e) { console.log(`  FAIL ${name}: ${e.message}`); fail++ }
}

const page = readFileSync(new URL('../frontend/src/pages/LedgerExplorer.jsx', import.meta.url), 'utf8')

const gwDir = new URL('../drunix-gateway/', import.meta.url)
const goTypes = new Set()
for (const f of readdirSync(gwDir)) {
  if (!f.endsWith('.go') || f.endsWith('_test.go')) continue
  const src = readFileSync(new URL(f, gwDir), 'utf8')
  for (const m of src.matchAll(/\bBlock[A-Za-z0-9]*\s*=\s*"([A-Z][A-Z0-9_]+)"/g)) goTypes.add(m[1])
  for (const m of src.matchAll(/c\.Append\("([A-Z][A-Z0-9_]+)"/g)) goTypes.add(m[1])
}

check('the rail declares block types this test can read', () => {
  assert.ok(goTypes.size >= 20, `found only ${goTypes.size} block types`)
  assert.ok(goTypes.has('UMI_BASKET_CREATED'))
})

check('every committed block type has an explorer label', () => {
  const missing = [...goTypes].filter(t => !new RegExp(`\\n\\s*${t}:\\s*\\{`).test(page))
  assert.deepEqual(missing, [], `no label for: ${missing.join(', ')}`)
})

check('an unknown type does not render as Genesis', () => {
  assert.doesNotMatch(page, /TYPE_STYLES\[b\.type\]\s*\|\|\s*TYPE_STYLES\.GENESIS/)
  assert.match(page, /function styleFor\(type\)/)
  assert.match(page, /const st = styleFor\(b\.type\)/)
})

console.log(`\n  ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
