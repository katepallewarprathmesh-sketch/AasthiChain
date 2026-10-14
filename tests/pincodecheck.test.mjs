// A listing could claim any address at all.
//
// The marketplace ended up with properties in "City115232" at a pincode no
// post office uses, and nothing in the registration path disagreed. Every new
// listing now has its pincode looked up in the India Post PIN directory
// through the keyless public endpoint, and the answer is stored on the record
// and shown on the listing page.
//
// The check is fail-open on purpose: a third party must never be able to stop
// somebody listing a property. An unreachable directory records "unchecked",
// which is why most assertions below accept UNCHECKED as a valid outcome and
// only the shape and the honesty of the result are mandatory.

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

const listAt = async (city, pincode) => {
  const r = await call('/api/properties', {
    method: 'POST',
    body: JSON.stringify({
      title: `Pincode probe ${city} ${Date.now()}`,
      state: 'Maharashtra', city, pincode,
      valuationINR: 5000000, documentHash: hex64(),
    }),
  })
  if (!r.data.assetId) return null
  const got = await call(`/api/properties/${r.data.assetId}`)
  return got.data.property || got.data
}

// ---- a real Pune pincode
const good = await listAt('Pune', '411045')
t('a new listing carries an address check', !!(good && good.locationCheck), JSON.stringify(good || {}).slice(0, 160))
const gc = (good && good.locationCheck) || {}
t('the check names its source', typeof gc.source === 'string' && /India Post/i.test(gc.source), gc.source)
t('the check records the pincode it looked at', gc.pincode === '411045', gc.pincode)
t('a real Pune pincode verifies, or honestly reports it was not checked',
  gc.status === 'VERIFIED' || gc.status === 'UNCHECKED', `${gc.status} ${gc.detail || ''}`)
if (gc.status === 'VERIFIED') {
  t('a verified check carries the official state', gc.officialState === 'Maharashtra', gc.officialState)
  t('a verified check is marked as actually performed', gc.checked === true)
} else {
  t('an unchecked result does not claim to have been performed', gc.checked !== true)
  t('an unchecked result says why', typeof gc.detail === 'string' && gc.detail.length > 0)
}

// ---- the pincode that produced the junk listings
const junk = await listAt('City115232', '115232')
const jc = (junk && junk.locationCheck) || {}
t('a pincode no post office uses is flagged, not silently accepted',
  jc.status === 'NOT_FOUND' || jc.status === 'UNCHECKED', `${jc.status} ${jc.detail || ''}`)
t('a flagged pincode never comes back as VERIFIED', jc.status !== 'VERIFIED', jc.status)

// ---- a real pincode in the wrong city
const wrong = await listAt('Nagpur', '411045')
const wc = (wrong && wrong.locationCheck) || {}
t('a real pincode under the wrong city is a mismatch, not a pass',
  wc.status === 'MISMATCH' || wc.status === 'UNCHECKED', `${wc.status} ${wc.detail || ''}`)

// ---- malformed input needs no network at all
const bad = await listAt('Pune', '0421')
const bc = (bad && bad.locationCheck) || {}
t('a malformed pincode is rejected locally', bc.status === 'MALFORMED', `${bc.status} ${bc.detail || ''}`)

// ---- the listing still goes through: a third party cannot block listing
t('the junk listing was still created, because the check is fail-open', !!(junk && junk.assetId))

// ---- declared on the trust page, as live
const trust = await call('/api/trust')
const row = (trust.data.integrations || []).find((i) => /India Post|Postal address/i.test(i.name || ''))
t('the address check is declared on the trust page', !!row, JSON.stringify((trust.data.integrations || []).map((i) => i.name)).slice(0, 200))
t('it is declared live, because it genuinely is', row && row.status === 'live', row && row.status)
t('the trust page says it is an address check only and not proof of ownership',
  !!(row && /not that anybody owns anything|address check only/i.test(row.detail || '')), (row && row.detail || '').slice(0, 120))

// ---- both servers behave the same way
for (const f of ['frontend/api/index.js', 'mock-api-server.js']) {
  const src = readFileSync(f, 'utf8')
  t(`${f} performs the lookup`, /api\.postalpincode\.in/.test(src))
  t(`${f} stores the result on the listing`, /locationCheck/.test(src))
  t(`${f} is fail-open`, /UNCHECKED/.test(src))
}

// ---- the listing page shows the result
const ui = readFileSync('frontend/src/pages/PropertyDetail.jsx', 'utf8')
t('the listing page shows the address check', /locationCheckLabel/.test(ui) && /India Post/.test(ui))
t('the listing page warns on a mismatch rather than hiding it', /MISMATCH/.test(ui) && /NOT_FOUND/.test(ui))

console.log(`\npincodecheck: ${pass} passed, ${fail} failed`)
assert.equal(fail, 0)
