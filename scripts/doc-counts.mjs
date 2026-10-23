#!/usr/bin/env node
// Keep the published test census honest without hand-editing three files.
//
// The counts (integration suites, Go test files, total checks) appear in
// README.md, docs/TESTING.md and docs/DEMO.md. Adding one suite file makes
// all three wrong, tests/doccounts.test.mjs fails, and the fix is a
// sixty-second full run followed by three edits in three places. That has
// happened often enough to be worth a tool.
//
//   node scripts/doc-counts.mjs           report the counts and any drift
//   node scripts/doc-counts.mjs --fix     rewrite the published figures
//   node scripts/doc-counts.mjs --fix --checks 148
//
// The suite and Go file counts are counted from the repository. The total
// check count cannot be: it is the result of a run, and inventing it would
// be exactly the dishonesty the census exists to prevent. Pass --checks with
// the number a real `make test-fresh` reported, or leave it alone.

import { readFileSync, writeFileSync, readdirSync } from 'node:fs'

const root = new URL('../', import.meta.url)
const read = (f) => readFileSync(new URL(f, root), 'utf8')
const write = (f, s) => writeFileSync(new URL(f, root), s)

const args = process.argv.slice(2)
const fix = args.includes('--fix')
const checksArg = args.includes('--checks') ? Number(args[args.indexOf('--checks') + 1]) : null

const suites = readdirSync(new URL('tests/', root)).filter((f) => f.endsWith('.test.mjs')).length
// Walk each module rather than reading its top directory: api-gateway keeps
// its code in middleware/, store/ and fabric/, so a flat read counted zero
// test files there and the published census was wrong by however many lived
// one level down.
const goTestsIn = (dir) => {
  let found = []
  let entries = []
  try { entries = readdirSync(new URL(dir + '/', root), { withFileTypes: true }) }
  catch { return found }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (e.name === 'vendor' || e.name === 'node_modules' || e.name.startsWith('.')) continue
      found = found.concat(goTestsIn(dir + '/' + e.name))
    } else if (e.name.endsWith('_test.go')) {
      found.push(dir + '/' + e.name)
    }
  }
  return found
}
const goTests = ['drunix-gateway', 'chaincode', 'payment-gateway', 'api-gateway']
  .flatMap(goTestsIn).length

// Each edit is a narrow pattern with a named reason, so a --fix can never
// rewrite a number that happens to look similar somewhere else in the prose.
const rules = [
  {
    file: 'README.md',
    what: 'the sweep line',
    re: /(\d+) checks across (\d+) suite files/,
    to: (m, checks) => `${checks ?? m[1]} checks across ${suites} suite files`,
  },
  {
    file: 'docs/TESTING.md',
    what: 'the command comment',
    re: /integration sweep:\s+(\d+) checks, 0 failed/,
    to: (m, checks) => `integration sweep:  ${checks ?? m[1]} checks, 0 failed`,
  },
  {
    file: 'docs/TESTING.md',
    what: 'the suite-file row',
    re: /\| Suite files \| \*\*(\d+)\*\* in `tests\/` \|/,
    to: () => `| Suite files | **${suites}** in \`tests/\` |`,
  },
  {
    file: 'docs/TESTING.md',
    what: 'the reported result row',
    re: /\*\*(\d+) passed, 0 failed\*\*/,
    to: (m, checks) => `**${checks ?? m[1]} passed, 0 failed**`,
  },
  {
    file: 'docs/DEMO.md',
    what: 'the closing line read aloud at a demo',
    re: /(\d+) integration\s*\n?>?\s*suites and (\d+) Go test files/,
    to: (m) => m[0].replace(/\d+ integration/, `${suites} integration`)
      .replace(/\d+ Go test files/, `${goTests} Go test files`),
  },
]

console.log(`counted ${suites} suite files, ${goTests} Go test files`)
if (checksArg) console.log(`using ${checksArg} as the reported check total`)
else console.log('check total left as published (pass --checks N after a real run to change it)')
console.log()

let drift = 0
const edited = new Map()
for (const rule of rules) {
  const src = edited.get(rule.file) ?? read(rule.file)
  const m = src.match(rule.re)
  if (!m) {
    console.log(`  MISSING ${rule.file}: ${rule.what} no longer matches; fix the rule or the doc`)
    drift++
    continue
  }
  const next = rule.to(m, checksArg)
  if (next === m[0]) {
    console.log(`  ok      ${rule.file}: ${rule.what}`)
    continue
  }
  drift++
  console.log(`  drift   ${rule.file}: ${rule.what}`)
  console.log(`            ${m[0].replace(/\n\s*>?\s*/g, ' ')}`)
  console.log(`         -> ${next.replace(/\n\s*>?\s*/g, ' ')}`)
  if (fix) edited.set(rule.file, src.replace(rule.re, () => next))
}

if (fix && edited.size) {
  for (const [file, src] of edited) write(file, src)
  console.log(`\nrewrote ${edited.size} file(s). Regenerate the assistant index if a doc changed:`)
  console.log('  node scripts/build-knowledge.mjs')
} else if (drift) {
  console.log('\nrun again with --fix to apply')
}

process.exit(fix ? 0 : drift ? 1 : 0)
