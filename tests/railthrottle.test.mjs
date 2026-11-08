// The rail brake: does a 429 actually stop the clockwork?
//
// The production failure this guards against is a feedback loop rather than a
// crash. The rail is hosted behind a low inbound rate limit; the settlement
// page fanned out to two dozen endpoints per load and then polled six times a
// minute per panel, with no notion that it had been refused. A 429 therefore
// provoked more traffic, which held the 429 open, which is why the page only
// recovered when the service was restarted and why it came back soon after.
//
// These checks pin the three properties that break the loop: a 429 opens the
// brake, background traffic is suppressed while it is open, and a person
// pressing a button is still allowed through.

import assert from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
let passed = 0
let failed = 0
const check = (name, fn) => {
  try { fn(); passed++; console.log(`  ok  ${name}`) } catch (e) { failed++; console.log(`FAIL  ${name}\n      ${e.message}`) }
}

const throttleSrc = readFileSync(join(root, 'frontend/src/lib/railThrottle.js'), 'utf8')
const pollSrc = readFileSync(join(root, 'frontend/src/lib/usePoll.js'), 'utf8')
const fetchSrc = readFileSync(join(root, 'frontend/src/lib/umiFetch.js'), 'utf8')
const proxySrc = readFileSync(join(root, 'frontend/api/index.js'), 'utf8')
const mockSrc = readFileSync(join(root, 'mock-api-server.js'), 'utf8')
const uiSrc = readFileSync(join(root, 'frontend/src/pages/UMISettlement.jsx'), 'utf8')

console.log('rail throttle')

// The brake itself, exercised rather than grepped.
const mod = await import(new URL('../frontend/src/lib/railThrottle.js', import.meta.url))

check('a plain 429 opens the brake', () => {
  mod.resetRailThrottleForTests()
  assert.equal(mod.isRailThrottled(), false, 'should start closed')
  mod.noteRailResponse({ status: 429 })
  assert.equal(mod.isRailThrottled(), true, 'a 429 must open the brake')
})

check('a 429 wrapped by the proxy opens the brake too', () => {
  mod.resetRailThrottleForTests()
  // This is the exact shape production returns: the proxy reports its own
  // status and puts the host's underneath. Reading only `status` missed it.
  mod.noteRailResponse({ status: 502, upstreamStatus: 429 })
  assert.equal(mod.isRailThrottled(), true, 'upstreamStatus 429 must count')
})

check('a success closes the brake', () => {
  mod.resetRailThrottleForTests()
  mod.noteRailResponse({ status: 429 })
  mod.noteRailResponse({ status: 200 })
  assert.equal(mod.isRailThrottled(), false, 'a good answer must clear it')
})

check('repeated refusals back off further, and stay capped', () => {
  mod.resetRailThrottleForTests()
  mod.noteRailResponse({ status: 429 })
  const first = mod.railRetryInMs()
  mod.noteRailResponse({ status: 429 })
  const second = mod.railRetryInMs()
  assert.ok(second > first, `backoff must grow: ${first} -> ${second}`)
  for (let i = 0; i < 20; i++) mod.noteRailResponse({ status: 429 })
  assert.ok(mod.railRetryInMs() <= 300000, 'backoff must stay capped so the UI is never parked for long')
})

check('Retry-After is honoured when the host sends one', () => {
  mod.resetRailThrottleForTests()
  mod.noteRailResponse({ status: 429, retryAfter: '120' })
  const ms = mod.railRetryInMs()
  assert.ok(ms > 110000 && ms <= 120000, `expected about 120s, got ${ms}ms`)
})

check('an absurd Retry-After cannot park the page for an hour', () => {
  mod.resetRailThrottleForTests()
  mod.noteRailResponse({ status: 429, retryAfter: '99999' })
  assert.ok(mod.railRetryInMs() <= 300000, 'an upstream must not be able to disable the page')
})

check('a person pressing retry clears the brake', () => {
  mod.resetRailThrottleForTests()
  mod.noteRailResponse({ status: 429 })
  mod.clearRailThrottle()
  assert.equal(mod.isRailThrottled(), false, 'a deliberate retry must not be blocked')
})

// The wiring. These are the parts that make the brake reach real traffic.
check('umiFetch feeds every response to the brake', () => {
  assert.ok(/noteRailResponse\(\{/.test(fetchSrc), 'umiFetch must report responses to the brake')
  assert.ok(/upstreamStatus: data && data\.upstreamStatus/.test(fetchSrc), 'it must pass the wrapped status through')
  assert.ok(/retryAfter: res\.headers\.get\('retry-after'\)/.test(fetchSrc), 'it must pass Retry-After through')
})

check('background calls are suppressed while the brake is open', () => {
  assert.ok(/options\.background && isRailThrottled\(\)/.test(fetchSrc), 'background traffic must be held back')
  assert.ok(/ERR_RAIL_THROTTLED/.test(fetchSrc), 'a suppressed call must say why')
})

check('foreground calls are never suppressed', () => {
  // The guard must test `background`; a guard on isRailThrottled() alone
  // would also block the person pressing the retry button.
  const guard = fetchSrc.match(/if \((.*isRailThrottled\(\))\)/)
  assert.ok(guard, 'expected a throttle guard in umiFetch')
  assert.ok(/background/.test(guard[1]), `the guard must be limited to background calls, got: ${guard[1]}`)
})

check('polling pauses on a hidden tab and stands down when refused', () => {
  assert.ok(/document\.hidden/.test(pollSrc), 'usePoll must pause on a hidden tab')
  assert.ok(/isRailThrottled\(\)/.test(pollSrc), 'usePoll must respect the brake')
  assert.ok(/visibilitychange/.test(pollSrc), 'usePoll must resume when the tab is seen again')
})

check('no rail panel polls with a bare setInterval any more', () => {
  for (const f of ['frontend/src/components/PathSpeedPanel.jsx', 'frontend/src/components/ThroughputPanel.jsx']) {
    const src = readFileSync(join(root, f), 'utf8')
    assert.ok(!/setInterval\(/.test(src), `${f} must poll through usePoll, not a bare setInterval`)
    assert.ok(/usePoll\(/.test(src), `${f} must use usePoll`)
    assert.ok(/background: true/.test(src), `${f} must mark its polls as background traffic`)
    // A skipped poll is not a dead panel: treating it as one hid the panel
    // permanently the first time the rail was busy.
    assert.ok(/r\.skipped/.test(src), `${f} must not treat a suppressed poll as an error`)
  }
})

check('the ledger stream fallback does not poll a hidden tab or a busy rail', () => {
  const src = readFileSync(join(root, 'frontend/src/lib/useLedgerStream.js'), 'utf8')
  assert.ok(/document\.hidden/.test(src), 'the fallback poll must pause on a hidden tab')
  assert.ok(/isRailThrottled\(\)/.test(src), 'the fallback poll must respect the brake')
})

check('both proxies cache the same identity-independent reads', () => {
  for (const [name, src] of [['frontend/api/index.js', proxySrc], ['mock-api-server.js', mockSrc]]) {
    assert.ok(/CACHEABLE_RAIL_READS/.test(src), `${name} must define the cacheable read list`)
    assert.ok(/'\/config': 300/.test(src), `${name} must cache /config`)
    assert.ok(/CDN-Cache-Control/.test(src), `${name} must cache at the edge, not in the browser`)
    assert.ok(/s-maxage=\$\{cacheSeconds\}/.test(src), `${name} must set a shared-cache lifetime`)
    // stale-while-revalidate on Cache-Control makes the BROWSER fire a second
    // background request per poll, doubling the traffic this exists to cut.
    assert.ok(!/Cache-Control', `public, max-age=0/.test(src), `${name} must not put stale-while-revalidate on the browser's Cache-Control`)
    assert.ok(/retry-after/i.test(src), `${name} must forward Retry-After`)
    // A cached 429 would outlive the throttle that produced it.
    assert.ok(/upstream\.ok/.test(src) && /no-store/.test(src), `${name} must never cache a failed answer`)
  }
})

check('no identity-scoped route is ever shared-cached', () => {
  // A shared cache serving one participant's record to another would be a
  // far worse bug than the one being fixed here.
  const list = proxySrc.match(/CACHEABLE_RAIL_READS = \{([\s\S]*?)\}/)
  assert.ok(list, 'expected the cacheable list')
  const paths = [...list[1].matchAll(/'([^']+)'\s*:/g)].map(m => m[1])
  const scoped = ['/wallets', '/instructions', '/conditions', '/mandates', '/notifications', '/agents', '/work']
  for (const p of paths) {
    assert.ok(!scoped.some(s => p.startsWith(s)), `${p} is identity-scoped and must not be shared-cached`)
  }
})

check('the page calls a 429 throttling, not an offline rail', () => {
  assert.ok(/upstreamStatus === 429/.test(uiSrc), 'the page must read why the rail refused')
  assert.ok(/Rail busy\./.test(uiSrc), 'a throttled rail must not be described as offline')
  // Telling a visitor on the deployed site to run the gateway locally is
  // advice they cannot act on and that does not address a rate limit.
  const block = uiSrc.slice(uiSrc.indexOf('if (railDown)'), uiSrc.indexOf('if (railDown)') + 2600)
  const goRun = block.indexOf('go run ./cmd/gateway')
  assert.ok(goRun > -1, 'expected the local instructions to still exist for a genuinely absent rail')
  assert.ok(/\{!throttled && \(/.test(block), 'the local instructions must be hidden when the rail is merely throttled')
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
