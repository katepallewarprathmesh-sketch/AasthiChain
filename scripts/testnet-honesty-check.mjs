#!/usr/bin/env node
/**
 * Testnet honesty check.
 *
 * The Sepolia escrow leg once fabricated transaction hashes: it generated a
 * random 32-byte hex string, recorded it with isSimulated:false, and rendered
 * an Etherscan link from it. The link resolved to nothing, because no
 * transaction had ever been broadcast.
 *
 * These assertions make that class of bug fail loudly instead of shipping.
 *
 *   Core invariant: a response may claim isSimulated:false ONLY if it carries
 *   a transaction hash that a chain actually returned. No hash, no claim.
 *
 * Usage: node scripts/testnet-honesty-check.mjs [baseUrl]
 */

const BASE = process.argv[2] || process.env.BASE_URL || 'http://localhost:8080'

let passed = 0
let failed = 0

function check(name, cond, detail = '') {
  if (cond) {
    passed++
    console.log(`  PASS  ${name}`)
  } else {
    failed++
    console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`)
  }
}

// Tokens are HMAC-signed by the server; obtain one rather than minting it.
const TOKEN = await (async () => {
  const res = await fetch(BASE + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identityId: 'investor1', role: 'Investor' })
  })
  if (!res.ok) throw new Error(`login failed: HTTP ${res.status}`)
  return (await res.json()).token
})()

async function post(path, body) {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body)
  })
  let json = null
  try { json = await res.json() } catch {}
  return { status: res.status, json }
}

async function get(path) {
  const res = await fetch(BASE + path, { headers: { Authorization: `Bearer ${TOKEN}` } })
  let json = null
  try { json = await res.json() } catch {}
  return { status: res.status, json }
}

const HASH_RE = /^0x[0-9a-fA-F]{64}$/

console.log(`\nTestnet honesty check → ${BASE}\n`)

// T1 — the exact payload the old frontend sent: asserting a real transaction
// while supplying no hash. The server must not take the client's word for it.
{
  const { json } = await post('/api/testnet/payments/initiate', {
    assetId: 'PROP-GREEN-VALLEY-PUNE-001',
    tokenAmount: 2,
    estimatedEth: '0.0010',
    txHash: '',
    paymentId: 'HONESTY-T1',
    from: '0xabc',
    to: 'originator1',
    isSimulated: false,   // the lie
    realTx: true          // the lie
  })
  check('T1 client claiming realTx with no hash is forced to isSimulated:true',
    json && json.isSimulated === true, `got isSimulated=${json && json.isSimulated}`)
  check('T1 no transaction hash is invented',
    json && (!json.txHash || json.txHash === ''), `got txHash=${json && json.txHash}`)
  check('T1 no explorer link is built',
    json && (!json.sepoliaExplorer || json.sepoliaExplorer === ''),
    `got ${json && json.sepoliaExplorer}`)
}

// T2 — a garbage hash must not be laundered into an explorer link.
{
  const { json } = await post('/api/testnet/payments/initiate', {
    assetId: 'PROP-GREEN-VALLEY-PUNE-001',
    tokenAmount: 1,
    paymentId: 'HONESTY-T2',
    txHash: 'not-a-real-hash',
    isSimulated: false
  })
  check('T2 malformed hash is rejected, not stored',
    json && !json.txHash, `got txHash=${json && json.txHash}`)
  check('T2 malformed hash produces no explorer link',
    json && !json.sepoliaExplorer, `got ${json && json.sepoliaExplorer}`)
  check('T2 record is marked simulated',
    json && json.isSimulated === true)
}

// T3 — the stored record must agree with the response.
{
  const { json } = await get('/api/testnet/payments/HONESTY-T1')
  if (json && json.paymentId === 'HONESTY-T1') {
    check('T3 stored record is simulated', json.isSimulated === true)
    check('T3 stored record has no hash', !json.txHash)
    check('T3 stored record has no explorer link', !json.sepoliaExplorer)
  } else {
    check('T3 stored record retrievable', false, 'record not found')
  }
}

// T4 — release must not upgrade a simulated payment into a real-looking one.
{
  await post('/api/testnet/payments/HONESTY-T1/confirm', { drunixTransferId: 'TXN-TEST' })
  const { json } = await post('/api/testnet/payments/HONESTY-T1/release', {})
  check('T4 release keeps isSimulated:true',
    json && json.isSimulated !== false, `got isSimulated=${json && json.isSimulated}`)
}

// T5 — sweep every stored testnet payment for the core invariant.
{
  const { json } = await get('/api/testnet/payments')
  const list = (json && json.payments) || []
  const liars = list.filter(p => p.isSimulated === false && !HASH_RE.test(p.txHash || ''))
  check('T5 no stored payment claims to be real without a valid hash',
    liars.length === 0, `${liars.length} offender(s): ${liars.map(p => p.paymentId).join(', ')}`)

  const badLinks = list.filter(p => p.sepoliaExplorer && !HASH_RE.test(p.txHash || ''))
  check('T5 no explorer link exists without a valid hash',
    badLinks.length === 0, `${badLinks.length} offender(s)`)
}

// T6 — config must not advertise a deployed contract that does not exist.
{
  const { json } = await get('/api/testnet/config')
  const addr = (json && json.contractAddress) || ''
  const zero = /^0x0+$/.test(addr) || addr === ''
  check('T6 config does not claim a deployed escrow contract',
    zero ? (json.escrowDeployed !== true) : true,
    `address=${addr} escrowDeployed=${json && json.escrowDeployed}`)
  check('T6 config does not promise Etherscan-verifiable transactions',
    !/etherscan-verifiable/i.test(JSON.stringify(json || {})))
}

console.log(`\n${passed} passed, ${failed} failed\n`)
if (failed > 0) {
  console.error('Testnet honesty check FAILED')
  process.exit(1)
}
console.log('Testnet honesty OK')
