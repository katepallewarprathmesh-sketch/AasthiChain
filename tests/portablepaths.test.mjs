// No tracked script may hardcode one developer's checkout path.
//
// Regression test for a real failure. regression.sh pointed at one
// contributor's own clone for the secret scan, the PayU rig and the suite glob.
// On a fresh clone at any other path the glob matched nothing, the loop
// skipped silently, and the sweep printed "44 passed" instead of running all
// 123 checks. It did not look like a broken suite, it looked like a smaller
// one, which is the dangerous kind of wrong. scripts/api-shape-audit.mjs had
// the same two absolute imports and simply could not run elsewhere.
//
// Paths under a home directory that are optional helpers (scripts/devup.sh
// probes /home/user/.goenv and only sources it when present) are fine: they
// are guarded and the script works without them. A path into a checkout is
// not, so that is what this forbids.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { execSync } from 'node:child_process'
import assert from 'node:assert/strict'

let pass = 0, fail = 0
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); pass++ }
  catch (e) { console.log(`  FAIL ${name}: ${e.message}`); fail++ }
}

const root = new URL('../', import.meta.url)
const rootPath = new URL('.', root).pathname

let tracked = []
try {
  tracked = execSync('git ls-files', { cwd: rootPath, encoding: 'utf8' })
    .split('\n').filter(Boolean)
} catch { /* not a git checkout: the file walk below still runs */ }

if (tracked.length === 0) {
  const walk = (dir, out = []) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', '.git', 'dist', 'vendor'].includes(e.name)) continue
      const p = dir + '/' + e.name
      e.isDirectory() ? walk(p, out) : out.push(p.slice(rootPath.length))
    }
    return out
  }
  tracked = walk(rootPath.replace(/\/$/, ''))
}

const CODE = /\.(sh|mjs|js|cjs|go|yml|yaml)$|^Makefile$|\/Makefile$/
// This file quotes the offending shape in its own assertions, so it is the one
// file that cannot be scanned for it.
const SELF = 'tests/portablepaths.test.mjs'
const candidates = tracked.filter(f => CODE.test(f) && !f.startsWith('docs/') && f !== SELF)

// A checkout path: a home directory followed by a directory segment, as
// opposed to a dotfile probe such as /home/user/.goenv.
const CHECKOUT_PATH = /\/(home|Users)\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_-]+/

check('no tracked script hardcodes a developer checkout path', () => {
  const hits = []
  for (const f of candidates) {
    let body
    try {
      if (statSync(new URL(f, root)).size > 2_000_000) continue
      body = readFileSync(new URL(f, root), 'utf8')
    } catch { continue }
    body.split('\n').forEach((line, i) => {
      const m = line.match(CHECKOUT_PATH)
      if (m) hits.push(`${f}:${i + 1}: ${m[0]}`)
    })
  }
  assert.deepEqual(hits, [], 'hardcoded paths found:\n       ' + hits.join('\n       '))
})

check('regression.sh resolves the repository from its own location', () => {
  const body = readFileSync(new URL('regression.sh', root), 'utf8')
  assert.match(body, /REPO="\$\(cd "\$\(dirname "\$\{BASH_SOURCE\[0\]\}"\)" && pwd\)"/,
    'regression.sh must derive REPO from BASH_SOURCE')
  assert.match(body, /\$REPO\/tests\/\*\.test\.mjs|"\$REPO"\/tests\/\*\.test\.mjs/,
    'the node suite glob must be rooted at $REPO')
})

check('regression.sh fails loudly when it finds no suites', () => {
  const body = readFileSync(new URL('regression.sh', root), 'utf8')
  assert.match(body, /no suites found/,
    'an empty suite glob must be reported as a failure, not skipped')
})

console.log(`\n  ${pass}/${pass + fail} passed`)
process.exit(fail ? 1 : 0)
