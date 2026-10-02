#!/usr/bin/env node
/**
 * Proves a tab left open across a deploy reloads itself.
 *
 * A fix was deployed four times and the same broken screen kept being
 * reported. The deployed chunk provably did not contain the old code: the tab
 * was running an older bundle and had no way to notice. Vercel keeps previous
 * hashed assets (every old index-<hash>.js still returns 200), so nothing ever
 * 404s and the tab never reloads. Its retry button re-runs the old code and
 * fails identically, which is how a fixed bug looks unfixed.
 *
 * Usage: node scripts/build-staleness-check.mjs
 */

let reloads = 0
let runningSrc = 'https://x.test/assets/index-OLDHASH.js'
let deployedHtml = '<script type="module" src="/assets/index-NEWHASH.js"></script>'

global.document = {
  querySelector: (sel) => sel.includes('/assets/index-') ? { src: runningSrc } : null,
  addEventListener(){}, removeEventListener(){}, visibilityState: 'visible',
}
global.window = {
  location: { origin: 'https://x.test', reload(){ reloads++ } },
  addEventListener(){}, removeEventListener(){},
}
const store = {}
global.sessionStorage = { getItem: k => (k in store ? store[k] : null), setItem: (k,v) => { store[k] = String(v) } }
global.fetch = async () => ({ ok: true, text: async () => deployedHtml })

const { reloadIfStale } = await import(new URL('../frontend/src/lib/buildCheck.js', import.meta.url).href)

let pass = 0, fail = 0
const t = (name, cond, got) => { if (cond) { pass++; console.log(`  PASS  ${name}`) } else { fail++; console.log(`  FAIL  ${name} — ${got}`) } }

t('stale tab reloads', await reloadIfStale() === true)
t('reload called exactly once', reloads === 1, `reloads=${reloads}`)
t('second check does not loop', await reloadIfStale() === false)
t('still only one reload', reloads === 1, `reloads=${reloads}`)

reloads = 0; deployedHtml = '<script type="module" src="/assets/index-OLDHASH.js"></script>'
t('up-to-date tab does not reload', await reloadIfStale() === false)
t('no reload when current', reloads === 0, `reloads=${reloads}`)

reloads = 0
global.fetch = async () => { throw new Error('offline') }
t('offline does not reload', await reloadIfStale() === false)

global.fetch = async () => ({ ok: true, text: async () => deployedHtml })
global.document.querySelector = () => null
t('dev server (no hashed entry) is ignored', await reloadIfStale() === false)

console.log(`\n  ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
