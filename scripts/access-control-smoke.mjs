#!/usr/bin/env node
/**
 * Access-control smoke test.
 *
 * Before this existed, an audit found that any logged-in user could read any
 * other user's payments, wallet, portfolio and KYC, and that identity itself
 * was forgeable: tokens were unsigned base64, and authMiddleware had a
 * catch-all that ADMITTED requests carrying an unparseable token, taking the
 * identity from the client-supplied x-fabric-identity header.
 *
 * These assertions pin both properties:
 *   AUTHENTICATION — an unsigned, tampered or junk token is rejected.
 *   AUTHORISATION  — a valid token for user A cannot read user B's data.
 *
 * Usage: node scripts/access-control-smoke.mjs [baseUrl]
 */

const BASE = process.argv[2] || process.env.BASE_URL || 'http://localhost:8080'
const ASSET = 'PROP-GREEN-VALLEY-PUNE-001'

let passed = 0
let failed = 0
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  PASS  ${name}`) }
  else { failed++; console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`) }
}

async function login(identityId, role) {
  const res = await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identityId, role })
  })
  if (!res.ok) throw new Error(`login failed for ${identityId}: HTTP ${res.status}`)
  return (await res.json()).token
}

async function req(path, token, { method = 'GET', body, headers = {} } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
      ...headers
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  })
  let json = null
  try { json = await res.json() } catch {}
  return { status: res.status, json }
}

console.log(`\nAccess-control smoke test → ${BASE}\n`)

const inv1 = await login('investor1', 'Investor')
const inv2 = await login('investor2', 'Investor')
const reg = await login('regulator1', 'Regulator')

// ---------------------------------------------------------------- AUTHENTICATION
console.log('  -- authentication --')
{
  const unsigned = Buffer.from(JSON.stringify({
    identityId: 'regulator1', mspId: 'RegulatorMSP', role: 'Regulator'
  })).toString('base64')
  const { status } = await req('/api/npci/payments', unsigned)
  check('A1 self-minted unsigned token is rejected', status === 401, `HTTP ${status}`)
}
{
  // The exact escalation from the audit: junk token + a role header.
  const { status } = await req('/api/npci/payments', 'not-a-token', {
    headers: { 'X-Fabric-Identity': 'regulator1' }
  })
  check('A2 junk token is NOT upgraded via x-fabric-identity header', status === 401, `HTTP ${status}`)
}
{
  const [p, s] = inv1.split('.')
  const tamperedPayload = Buffer.from(JSON.stringify({
    identityId: 'regulator1', mspId: 'RegulatorMSP', role: 'Regulator', exp: Date.now() + 3600000
  })).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  const { status } = await req('/api/npci/payments', `${tamperedPayload}.${s}`)
  check('A3 payload swapped onto a valid signature is rejected', status === 401, `HTTP ${status}`)
  const { status: s2 } = await req('/api/npci/payments', `${p}.deadbeef`)
  check('A4 valid payload with a forged signature is rejected', s2 === 401, `HTTP ${s2}`)
}
{
  const { status } = await req('/api/npci/payments', null)
  check('A5 missing token is rejected', status === 401, `HTTP ${status}`)
}
{
  const { status } = await req('/api/npci/payments', inv1)
  check('A6 a properly signed token still works', status === 200, `HTTP ${status}`)
}

// ---------------------------------------------------------------- AUTHORISATION
console.log('  -- authorisation: investor2 must not read investor1 --')

// investor1 creates a payment that belongs to them.
const created = await req('/api/npci/collect', inv1, {
  method: 'POST',
  body: {
    amountINR: 4321, payerVpa: 'inv1secret@okhdfcbank', payeeVpa: 'seller@okicici',
    tokenAmount: 1, assetId: ASSET
  }
})
const pid = created.json && created.json.paymentId
check('B0 investor1 can create their own payment', !!pid, `HTTP ${created.status}`)

{
  const { status } = await req(`/api/npci/payments/${pid}`, inv2)
  check('B1 investor2 cannot read investor1 payment', status === 403, `HTTP ${status}`)
}
{
  const { status, json } = await req(`/api/npci/payments/${pid}`, inv1)
  check('B2 investor1 CAN read their own payment', status === 200, `HTTP ${status}`)
  check('B2 own payment still carries its detail', !!(json && (json.payment || json).amountINR))
}
{
  const { json } = await req('/api/npci/payments', inv2)
  const list = (json && json.payments) || []
  const leaked = list.filter(p => p.payerId !== 'investor2' && p.payeeId !== 'investor2')
  check('B3 payments list is scoped to the caller', leaked.length === 0,
    `${leaked.length} foreign payment(s) visible`)
}
{
  const { status } = await req('/api/balances/wallet/investor1', inv2)
  check('B4 investor2 cannot read investor1 wallet', status === 403, `HTTP ${status}`)
  const { status: own } = await req('/api/balances/wallet/investor2', inv2)
  check('B5 investor2 CAN read their own wallet', own === 200, `HTTP ${own}`)
}
{
  const { status } = await req(`/api/balances/${ASSET}/investor1`, inv2)
  check('B6 investor2 cannot read investor1 asset balance', status === 403, `HTTP ${status}`)
}
{
  const { status } = await req('/api/portfolio/investor1/nav', inv2)
  check('B7 investor2 cannot read investor1 portfolio NAV', status === 403, `HTTP ${status}`)
}
{
  // KYC status is legitimately visible to a counterparty; the record is not.
  const { status, json } = await req('/api/kyc/investor1', inv2)
  check('B8 counterparty sees KYC status only', status === 200 && json && json.scope === 'counterparty-view',
    `HTTP ${status} scope=${json && json.scope}`)
  check('B8 counterparty view leaks no verifiedAt/provider detail',
    json && json.verifiedAt === undefined)
  const { json: selfView } = await req('/api/kyc/investor1', inv1)
  check('B9 the subject sees their own full KYC record', selfView && selfView.verifiedAt !== undefined)
}

// ---------------------------------------------------------------- SUPERVISION
console.log('  -- regulator may look across users --')
{
  const { status } = await req(`/api/npci/payments/${pid}`, reg)
  check('C1 regulator can read any payment', status === 200, `HTTP ${status}`)
  const { json } = await req('/api/npci/payments', reg)
  check('C2 regulator list is marked as scope=all', json && json.scope === 'all', `scope=${json && json.scope}`)
}
{
  const { status } = await req('/api/balances/wallet/investor1', reg)
  check('C3 regulator can read a wallet', status === 200, `HTTP ${status}`)
}

// ---------------------------------------------------------------- OWNERSHIP SPOOFING
console.log('  -- ownership cannot be assigned from the request body --')
{
  const r = await req('/api/npci/collect', inv2, {
    method: 'POST',
    body: {
      amountINR: 999, payerVpa: 'inv2@okhdfcbank', payeeVpa: 'seller@okicici',
      tokenAmount: 1, assetId: ASSET,
      payerId: 'investor1'          // the spoof
    }
  })
  const spoofed = r.json && r.json.paymentId
  const { status } = await req(`/api/npci/payments/${spoofed}`, inv1)
  check('D1 payerId from the body is ignored; payment belongs to the caller',
    status === 403, `investor1 got HTTP ${status} on a payment investor2 created`)
  const { status: mine } = await req(`/api/npci/payments/${spoofed}`, inv2)
  check('D2 the real creator can read it', mine === 200, `HTTP ${mine}`)
}

console.log(`\n${passed} passed, ${failed} failed\n`)
if (failed > 0) { console.error('Access-control smoke test FAILED'); process.exit(1) }
console.log('Access control OK')
