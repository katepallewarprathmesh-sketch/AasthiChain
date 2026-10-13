// A hosted JSON-RPC provider puts its API key in the URL. The rail prints its
// endpoint in the connector status prose, and that prose is public. Three
// layers now strip it: the rail at source, this proxy in the middle, and the
// panel at paint time. This suite covers the middle one, plus a static check
// on the panel, because a rail that has not been redeployed still sends the
// key and the proxy is the last place we control before a browser sees it.

import http from 'node:http'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

let pass = 0, fail = 0
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); pass++ }
  catch (e) { console.log(`  FAIL ${name}: ${e.message}`); fail++ }
}

const KEY = 'BLE19jcEKgty8__DCg68YbHyQnrT-u3k'
const LEAKY = `https://eth-sepolia.g.alchemy.com/v2/${KEY}`

// A rail on an older build: it still prints the raw endpoint.
const rail = http.createServer((req, res) => {
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify({
    connectors: [
      { ledger: 'drunix', configured: true, kind: 'fork', status: 'The local hash-chained ledger.' },
      {
        ledger: 'evm', configured: true, kind: 'evm (JSON-RPC)',
        status: `public-chain mirror: ${LEAKY} at 0x1a304c671307d322e7b24cd1004f436b20dece9f, anchors go to a chain we do not control`,
      },
    ],
    repo: 'https://github.com/katepallewarprathmesh-sketch/AasthiChain',
    stats: { committed: 0 },
  }))
})
await new Promise((r) => rail.listen(0, '127.0.0.1', r))

process.env.UMI_GATEWAY_URL = `http://127.0.0.1:${rail.address().port}`
process.env.DEMO_AUTH = 'true'

const { default: handler } = await import('../frontend/api/index.js')

let sent = null
const res = {
  statusCode: 200,
  setHeader() {}, writeHead() {}, end() {},
  status(c) { this.statusCode = c; return this },
  json(p) { sent = JSON.stringify(p); return this },
  send(p) { sent = typeof p === 'string' ? p : JSON.stringify(p); return this },
}
await handler({ method: 'GET', url: '/api/umi/interop', headers: {}, query: {} }, res)

check('the proxy answers the interop read', () => {
  assert.ok(sent, 'no body')
  const d = JSON.parse(sent)
  assert.ok(Array.isArray(d.connectors), 'connectors missing')
})

check('the provider api key never reaches the client', () => {
  assert.ok(!sent.includes(KEY), 'API KEY LEAKED THROUGH THE PROXY')
})

check('the host is still shown, so the page stays informative', () => {
  const evm = JSON.parse(sent).connectors.find((c) => c.ledger === 'evm')
  assert.match(evm.status, /eth-sepolia\.g\.alchemy\.com/)
  assert.ok(!/\/v2\//.test(evm.status), evm.status)
})

check('the contract address survives, it is public by nature', () => {
  assert.match(sent, /0x1a304c671307d322e7b24cd1004f436b20dece9f/)
})

check('ordinary links are left alone', () => {
  assert.match(JSON.parse(sent).repo, /github\.com\/katepallewarprathmesh-sketch\/AasthiChain/)
})

// The endpoint prose is no longer shown in the UI at all, so the only way a
// URL can appear on screen is if someone puts it back.
const panel = readFileSync(new URL('../frontend/src/components/InteropPanel.jsx', import.meta.url), 'utf8')
check('the panel does not paint the connector status prose at all', () => {
  assert.ok(!/\{c\.status\}/.test(panel), 'connector status is rendered again')
  assert.ok(!/\{safeStatus\(/.test(panel), 'scrubbed status is rendered again')
  // The badge is what the card is for, so it must survive the removal.
  assert.match(panel, /c\.configured \? 'configured' : 'not configured'/)
})

rail.close()
console.log(`\n  ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
