// The EVM connector is configured on the rail host, not on the serverless
// app, so /api/trust must describe it from what the rail reports rather than
// from its own environment. Three states have to read differently: rail
// reachable and configured, rail reachable and unconfigured, rail unreachable.
//
// The failure this guards against is the page confidently saying "no EVM
// endpoint is configured" while the rail is in fact talking to a public
// testnet. A wrong honesty page is worse than no honesty page.

import http from 'node:http'
import assert from 'node:assert/strict'

let pass = 0, fail = 0
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); pass++ }
  catch (e) { console.log(`  FAIL ${name}: ${e.message}`); fail++ }
}

// A stand-in rail. `state` decides what GET /umi/interop answers.
let state = 'configured'
const rail = http.createServer((req, res) => {
  if (!req.url.startsWith('/umi/interop')) { res.statusCode = 404; return res.end('{}') }
  if (state === 'down') { res.statusCode = 500; return res.end('{}') }
  const evm = state === 'configured'
    ? {
        ledger: 'evm', kind: 'evm (JSON-RPC)', configured: true,
        status: 'public-chain mirror: https://eth-sepolia.g.alchemy.com at 0x1a304c671307d322e7b24cd1004f436b20dece9f, document anchors are written to a chain we do not control',
      }
    : { ledger: 'evm', kind: 'evm (JSON-RPC)', configured: false, status: 'Not configured.' }
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify({ connectors: [{ ledger: 'drunix', configured: true, status: 'local' }, evm] }))
})
await new Promise((r) => rail.listen(0, '127.0.0.1', r))
const port = rail.address().port

process.env.UMI_GATEWAY_URL = `http://127.0.0.1:${port}`
process.env.DEMO_AUTH = 'true'
// Deliberately set here and NOT on the rail: the page must ignore its own
// environment for this boundary, because this process is not the rail.
delete process.env.EVM_RPC_URL
delete process.env.EVM_REGISTRY_ADDRESS

const { default: handler } = await import('../frontend/api/index.js')

async function trust() {
  let body = null
  const res = {
    statusCode: 200,
    setHeader() {}, writeHead() {}, end() {},
    status(c) { this.statusCode = c; return this },
    json(p) { body = p; return this },
    send(p) { body = p; return this },
  }
  await handler({ method: 'GET', url: '/api/trust', headers: {}, query: {} }, res)
  return body
}

const rowFor = (b, name) => (b.integrations || []).find((i) => i.name === name)

state = 'configured'
const cfg = await trust()
const cfgMirror = rowFor(cfg, 'Public chain mirror (EVM)')
const cfgCacti = rowFor(cfg, 'Cross-ledger transfer (Cacti pattern)')

check('configured rail: the mirror row stops saying it is unconfigured', () => {
  assert.ok(cfgMirror, 'mirror row missing')
  assert.ok(!/Not configured/i.test(cfgMirror.detail), cfgMirror.detail)
  assert.match(cfgMirror.detail, /real public testnet registry/i)
})

check('configured rail: the mirror row names the chain it points at', () => {
  assert.match(cfgMirror.detail, /0x1a304c671307d322e7b24cd1004f436b20dece9f/)
})

check('configured rail: writes are still declared as not working', () => {
  assert.match(cfgMirror.detail, /local signing is not written|holds nothing we put there/i)
})

check('configured rail: the cacti row stops claiming no endpoint is configured', () => {
  assert.ok(!/with no EVM endpoint configured/i.test(cfgCacti.detail), cfgCacti.detail)
  assert.match(cfgCacti.detail, /refused rather than recorded/i)
})

check('a configured connector does not promote either row to live', () => {
  assert.equal(cfgMirror.status, 'simulated')
  assert.equal(cfgCacti.status, 'simulated')
})

state = 'unconfigured'
const un = await trust()
check('unconfigured rail: the row says so plainly', () => {
  assert.match(rowFor(un, 'Public chain mirror (EVM)').detail, /Not configured on the rail/i)
  assert.match(rowFor(un, 'Cross-ledger transfer (Cacti pattern)').detail, /No EVM endpoint is configured/i)
})

state = 'down'
const dn = await trust()
check('unreachable rail: unknown, never guessed as unconfigured', () => {
  const m = rowFor(dn, 'Public chain mirror (EVM)')
  assert.match(m.detail, /unknown on this page/i)
  assert.ok(!/Not configured on the rail/i.test(m.detail), m.detail)
})

check('an unreachable rail still returns the rest of the page', () => {
  assert.ok(Array.isArray(dn.integrations) && dn.integrations.length > 10)
  assert.equal(typeof dn.statement, 'string')
})

rail.close()
console.log(`\n  ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
