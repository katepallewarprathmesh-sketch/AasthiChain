// The cross-ledger card used to be a read-only panel: five zeroes and no way
// to move any of them, which made the whole Cacti story a paragraph rather
// than a demonstration. The three transitions are now driven from the UI, so
// this exercises them through the same proxy the browser uses, and checks the
// two rules that make the numbers worth reading:
//
//   - committing is a supervisor action, not something a holder can do to
//     their own locked position
//   - a commit nobody observed is counted as attested, never as verified
//
// It also pins the panel's controls in source, because a lifecycle you cannot
// drive is the bug this suite exists to prevent coming back.

import { readFileSync } from 'node:fs'

const API = process.env.API || 'http://localhost:8080'

let pass = 0, fail = 0
const t = (name, ok, detail) => {
  if (ok) { pass++; console.log(`  ok   ${name}`) }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` - ${detail}` : ''}`) }
}

const call = async (path, { method = 'GET', body, id = 'originator1', role = 'Originator' } = {}) => {
  const res = await fetch(API + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Fabric-Identity': id,
      'X-Identity-Id': id,
      'X-Identity-Role': role,
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  let data = {}
  try { data = await res.json() } catch { data = {} }
  return { status: res.status, data }
}

// A carbon asset is seeded on every rail boot and originator1 holds all of it.
const ASSET = 'CARB-NSK-AGROFOREST-2024'

const own = await call(`/api/umi/ownership/${ASSET}`)
const holder = ((own.data.holders || []).find((h) => h.holder !== 'interop-custody' && h.tokens > 0) || {}).holder
t('a holder with a position exists to lock from', Boolean(holder), JSON.stringify(own.data).slice(0, 120))

const before = await call('/api/umi/interop')
const b = before.data.stats || {}

// ---- lock
const locked = await call('/api/umi/interop/lock', {
  method: 'POST', id: holder, role: 'Originator',
  body: { assetId: ASSET, holder, tokens: 7, remoteLedger: 'evm' },
})
const tr = locked.data.transfer || {}
t('lock immobilises tokens and returns a transfer', locked.status === 201 && /^XCHAIN-/.test(tr.transferId || ''),
  `${locked.status} ${JSON.stringify(locked.data).slice(0, 160)}`)
t('the lock is committed as a block', Number(tr.lockBlockHeight) > 0, String(tr.lockBlockHeight))
t('a locked transfer starts LOCKED and unverified', tr.status === 'LOCKED' && tr.remoteLegVerified === false)

const mid = await call('/api/umi/interop')
t('locked tokens show as immobilised, not as represented elsewhere',
  (mid.data.stats || {}).tokensLockedPending === (b.tokensLockedPending || 0) + 7
  && (mid.data.stats || {}).tokensRepresentedRemotely === (b.tokensRepresentedRemotely || 0),
  JSON.stringify(mid.data.stats))

// ---- a holder cannot close their own transfer as done
const selfCommit = await call(`/api/umi/interop/${tr.transferId}/commit`, {
  method: 'POST', id: holder, role: 'Originator', body: { remoteTxRef: 'self' },
})
t('committing is refused for a non-supervisor', selfCommit.status === 403,
  `${selfCommit.status} ${selfCommit.data.error || ''}`)

// ---- abort returns the tokens
const aborted = await call(`/api/umi/interop/${tr.transferId}/abort`, {
  method: 'POST', id: holder, role: 'Originator', body: { reason: 'test' },
})
t('the holder can abort their own transfer', aborted.status === 200 && (aborted.data.transfer || {}).status === 'ABORTED',
  `${aborted.status} ${JSON.stringify(aborted.data).slice(0, 140)}`)

const afterAbort = await call('/api/umi/interop')
t('an abort returns the tokens rather than leaving them in custody',
  (afterAbort.data.stats || {}).tokensLockedPending === (b.tokensLockedPending || 0),
  JSON.stringify(afterAbort.data.stats))

// ---- commit with no digest is an attestation, never an observation
const second = await call('/api/umi/interop/lock', {
  method: 'POST', id: holder, role: 'Originator',
  body: { assetId: ASSET, holder, tokens: 3, remoteLedger: 'evm' },
})
const t2 = second.data.transfer || {}
const committed = await call(`/api/umi/interop/${t2.transferId}/commit`, {
  method: 'POST', id: 'regulator1', role: 'Regulator', body: { remoteTxRef: 'manual-ref' },
})
const c = committed.data.transfer || {}
t('a supervisor can commit', committed.status === 200 && c.status === 'COMMITTED',
  `${committed.status} ${JSON.stringify(committed.data).slice(0, 140)}`)
t('an unobserved commit is never marked verified', c.remoteLegVerified === false, String(c.remoteLegVerified))

const end = await call('/api/umi/interop')
const e = end.data.stats || {}
t('it is counted as attested only', e.committedAttestedOnly === (b.committedAttestedOnly || 0) + 1
  && e.committedVerified === (b.committedVerified || 0), JSON.stringify(e))
t('committed tokens stay in custody as represented elsewhere',
  e.tokensRepresentedRemotely === (b.tokensRepresentedRemotely || 0) + 3, JSON.stringify(e))

// ---- the panel must actually offer these actions
const panel = readFileSync(new URL('../frontend/src/components/InteropPanel.jsx', import.meta.url), 'utf8')
t('the panel posts a lock', /umiPost\('\/interop\/lock'/.test(panel))
t('the panel posts a commit and an abort',
  /\/commit`/.test(panel) && /\/abort`/.test(panel))
t('the panel reloads after an action rather than trusting its own guess', /await load\(\)/.test(panel))
t('rail refusals are explained in words', /explainRail/.test(panel))

console.log(`\n  ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
