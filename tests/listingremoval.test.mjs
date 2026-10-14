// Removing a listing did not remove it.
//
// The handler deleted the key from the in-memory map and called
// saveAllPersisted, which only ever UPDATES rows in the backing store and
// never drops them, so the next cold lambda loaded the listing straight back.
// The marketplace and the regulator view kept showing it, and a second
// attempt hit an instance that had already forgotten it, which is where the
// ERR_ASSET_NOT_FOUND came from. The browser made it worse: a local cache of
// created properties was merged back over the server's answer.
//
// Removal is now recorded on the record (which does persist), filtered out of
// every read path, and anyone holding tokens is bought out first, because
// withdrawing a listing must not strand the people who funded it.

import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

const API = process.env.API || 'http://localhost:8080'
let pass = 0, fail = 0
const t = (name, ok, detail) => {
  if (ok) { pass++; console.log(`  ok   ${name}`) }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` - ${detail}` : ''}`) }
}

const H = (id = 'originator1', role = 'Originator') => ({
  'Content-Type': 'application/json', 'X-Fabric-Identity': id, 'X-Identity-Id': id, 'X-Identity-Role': role,
})
const call = async (path, opts = {}) => {
  const res = await fetch(API + path, { ...opts, headers: opts.headers || H() })
  let data = {}
  try { data = await res.json() } catch { data = {} }
  return { status: res.status, data }
}
const hex64 = () => (randomUUID() + randomUUID()).replace(/-/g, '').slice(0, 64)

const makeListing = async (title) => {
  const r = await call('/api/properties', {
    method: 'POST',
    body: JSON.stringify({
      title, state: 'Maharashtra', city: 'Pune', pincode: '4110' + Math.floor(10 + Math.random() * 89),
      valuationINR: 5000000, documentHash: hex64(),
    }),
  })
  return r.data.assetId
}

// ---- a listing nobody holds goes directly
const empty = await makeListing('Removal probe empty ' + Date.now())
const goneDirect = await call(`/api/properties/${empty}`, { method: 'DELETE' })
t('an unheld listing is removed directly', goneDirect.status === 200 && goneDirect.data.deleted === true
  && (goneDirect.data.refunds || []).length === 0, JSON.stringify(goneDirect.data).slice(0, 160))

const afterEmpty = await call('/api/properties')
t('it disappears from the marketplace', !(afterEmpty.data.properties || []).some((p) => p.assetId === empty))

const asRegulator = await call('/api/properties', { headers: H('regulator1', 'Regulator') })
t('it disappears from the regulator view as well',
  !(asRegulator.data.properties || []).some((p) => p.assetId === empty))

// This is the exact symptom the user reported: pressing Remove a second time.
const twice = await call(`/api/properties/${empty}`, { method: 'DELETE' })
t('removing it again is not an ERR_ASSET_NOT_FOUND', twice.status === 200 && twice.data.deleted === true,
  `${twice.status} ${twice.data.error || ''}`)

// ---- a listing with investors refunds them first
const held = await makeListing('Removal probe held ' + Date.now())
await call(`/api/properties/${held}/validate`, {
  method: 'POST', headers: H('registrar1', 'Registrar'), body: JSON.stringify({ decision: 'VALIDATED' }),
})
await call(`/api/properties/${held}/mint`, { method: 'POST', body: JSON.stringify({ totalTokens: 10000 }) })
await call('/api/transfers', { method: 'POST', body: JSON.stringify({ assetId: held, toId: 'investor1', amount: 400 }) })

const removed = await call(`/api/properties/${held}`, { method: 'DELETE' })
const refunds = removed.data.refunds || []
t('a holder is refunded when the listing is withdrawn', removed.status === 200 && refunds.length === 1,
  JSON.stringify(removed.data).slice(0, 200))
t('the refund is the token count at the listing price',
  refunds[0] && refunds[0].tokens === 400 && refunds[0].amountINR === 400 * 500,
  JSON.stringify(refunds[0]))
t('the refund is recorded as a ledger transfer, not just a number',
  Boolean(refunds[0] && /^TX-REFUND-/.test(refunds[0].transferId)), JSON.stringify(refunds[0]))
t('the tokens go back to the listing owner', removed.data.tokensReturned === 400, String(removed.data.tokensReturned))

const bal = await call(`/api/balances/${held}/investor1`)
t('the investor no longer holds tokens in a withdrawn listing', Number(bal.data.balance) === 0, JSON.stringify(bal.data))

// ---- the browser cache cannot resurrect it either
const hook = readFileSync(new URL('../frontend/src/hooks/useProperties.js', import.meta.url), 'utf8')
t('removed ids are remembered in the browser', /export function rememberRemoved/.test(hook))
t('the local cache merge skips removed listings', /if \(removed\.includes\(cachedProp\.assetId\)\) return/.test(hook))
for (const [name, file] of [['Admin', 'pages/Admin.jsx'], ['Regulator', 'pages/Regulator.jsx']]) {
  const src = readFileSync(new URL('../frontend/src/' + file, import.meta.url), 'utf8')
  t(`${name} records the removal locally`, /rememberRemoved\(/.test(src))
}

console.log(`\n  ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
