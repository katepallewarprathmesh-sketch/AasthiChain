// End-to-end check of the supervisory surface against a running server.
//   node scripts/supervision-smoke.mjs [baseUrl]
// Exits non-zero on the first failure so CI can gate on it.

const BASE = process.argv[2] || process.env.BASE_URL || 'http://localhost:8080'
const ASSET = 'PROP-GREEN-VALLEY-PUNE-001'

// Mock JWT, same base64 shape the server issues for its demo identities.
const tok = (id, msp, role) =>
  Buffer.from(JSON.stringify({ identityId: id, mspId: msp, role })).toString('base64')

const REGULATOR = tok('regulator1', 'RegulatorMSP', 'Regulator')
const INVESTOR = tok('investor1', 'InvestorMSP', 'Investor')

let passed = 0
const failures = []

function check(name, condition, detail) {
  if (condition) {
    passed++
    console.log(`  PASS  ${name}`)
  } else {
    failures.push(name)
    console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`)
  }
}

async function call(path, { method = 'GET', body, token = REGULATOR, raw = false } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + token,
      'X-Fabric-Identity': token === REGULATOR ? 'regulator1' : 'investor1',
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: res.status, data: raw ? await res.text() : await res.json().catch(() => ({})) }
}

console.log(`\nSupervisory surface smoke test → ${BASE}\n`)

// S1 — capabilities are public and disclose what is not modelled.
{
  const r = await fetch(BASE + '/api/regulator/capabilities')
  const d = await r.json()
  check('S1 capabilities public', r.status === 200, `status ${r.status}`)
  check('S1 declares simulated', d.simulated === true && d.regulatoryStatus === 'SIMULATED_NOT_CONNECTED')
  check('S1 filedWith is null', d.filedWith === null)
  check('S1 discloses gaps', Array.isArray(d.notModelled) && d.notModelled.length >= 5)
}

// S2 — non-regulators are refused.
{
  const r = await call('/api/regulator/cap-table?assetId=' + ASSET, { token: INVESTOR })
  check('S2 investor blocked from cap table', r.status === 403, `status ${r.status}`)
  check('S2 refusal names the required role', r.data.error === 'ERR_NOT_A_REGULATOR')
}

// S3 — cap table reconciles and measures concentration.
{
  const r = await call('/api/regulator/cap-table?assetId=' + ASSET)
  check('S3 cap table returns', r.status === 200, `status ${r.status}`)
  const d = r.data
  check('S3 has holders', Array.isArray(d.holders) && d.holders.length > 0)
  const summed = d.holders.reduce((n, h) => n + h.tokens, 0)
  check('S3 holdings sum equals reported issued', summed === d.reconciliation.issuedTokens,
    `${summed} vs ${d.reconciliation.issuedTokens}`)
  check('S3 issued does not exceed minted', d.reconciliation.balanced === true)
  check('S3 HHI computed', typeof d.concentration.hhi === 'number')
}

// S4 — point-in-time replay actually moves the numbers backwards.
{
  const now = await call('/api/regulator/cap-table?assetId=' + ASSET)
  const past = new Date(Date.now() - 20 * 3600 * 1000).toISOString()
  const then = await call(`/api/regulator/cap-table?assetId=${ASSET}&asOf=${encodeURIComponent(past)}`)
  check('S4 replay accepted', then.status === 200, `status ${then.status}`)
  check('S4 replay is labelled', then.data.asOfMode === 'REPLAYED_TO_CUTOFF')
  check('S4 transfers were rewound', then.data.transfersRewound > 0, `rewound ${then.data.transfersRewound}`)
  const nowInv = (now.data.holders.find(h => h.ownerId === 'investor1') || {}).tokens || 0
  const thenInv = (then.data.holders.find(h => h.ownerId === 'investor1') || {}).tokens || 0
  check('S4 past holding differs from present', thenInv !== nowInv, `then ${thenInv}, now ${nowInv}`)
}

// S5 — audit export is hash-chained and verifies.
let exported = null
{
  const r = await call('/api/regulator/audit-export')
  exported = r.data
  check('S5 export returns', r.status === 200, `status ${r.status}`)
  check('S5 has records', exported.recordCount > 0, `count ${exported.recordCount}`)
  check('S5 chain head present', typeof exported.integrity.chainHead === 'string' && exported.integrity.chainHead.length === 128)
  check('S5 key custody disclosed', exported.integrity.keyCustody === 'DEMO_KEY_IN_PROCESS_NOT_AN_HSM')
  check('S5 legal weight disclosed as none', /NONE/.test(exported.integrity.legalWeight))

  const v = await call('/api/regulator/audit-verify', { method: 'POST', body: exported })
  check('S5 untouched export verifies', v.data.verified === true, JSON.stringify(v.data.failures || []))
}

// S6 — tampering is detected. This is the whole point of the chain.
{
  const tampered = JSON.parse(JSON.stringify(exported))
  if (tampered.records.length > 1) {
    tampered.records[1].tokens = (tampered.records[1].tokens || 0) + 1
    const v = await call('/api/regulator/audit-verify', { method: 'POST', body: tampered })
    check('S6 edited record is caught', v.data.verified === false)
    check('S6 failure identifies the row', (v.data.failures || []).some(f => f.problem === 'RECORD_ALTERED'))
  }

  const dropped = JSON.parse(JSON.stringify(exported))
  if (dropped.records.length > 2) {
    dropped.records.splice(1, 1)
    const v = await call('/api/regulator/audit-verify', { method: 'POST', body: dropped })
    check('S6 deleted record breaks the chain', v.data.verified === false)
  }
}

// S7 — CSV export carries the disclosure footer.
{
  const r = await call('/api/regulator/audit-export?format=csv', { raw: true })
  check('S7 csv returns', r.status === 200)
  check('S7 csv has header row', r.data.startsWith('seq,occurredAt,type'))
  check('S7 csv discloses simulation', r.data.includes('# simulated,true'))
  check('S7 csv carries the chain head', r.data.includes('# chainHead,'))
}

// S8 — alerts fire on real state.
{
  const r = await call('/api/regulator/alerts')
  check('S8 alerts return', r.status === 200, `status ${r.status}`)
  check('S8 rules are published', Array.isArray(r.data.rules) && r.data.rules.length === 6)
  check('S8 every alert carries evidence', (r.data.alerts || []).every(a => a.evidence && a.recommendedAction))
  // The seeded book has 25 transfers from the originator inside 24h.
  check('S8 velocity rule fires on the seeded book', (r.data.alerts || []).some(a => a.rule === 'SAR-03'))
  // No holder is above 25% and all holders are KYC verified, so these must be
  // silent. A screen that alerts on clean data is as useless as one that never does.
  check('S8 no false concentration alert', !(r.data.alerts || []).some(a => a.rule === 'SAR-02'))
  check('S8 no false KYC alert', !(r.data.alerts || []).some(a => a.rule === 'SAR-04'))
}

// S8b — create the concentration the rule is meant to catch, then undo it.
{
  const move = async (from, to, amount) => call('/api/transfers', {
    method: 'POST',
    body: { assetId: ASSET, fromId: from, toId: to, amount },
  })

  const before = await call('/api/regulator/cap-table?assetId=' + ASSET)
  const inv2Before = (before.data.holders.find(h => h.ownerId === 'investor2') || {}).tokens || 0

  // 4,000 more tokens puts investor2 at 5,000 of 15,000 = 33%, over the 25% line.
  const t = await move('originator1', 'investor2', 4000)
  check('S8b regulator can stage the position', t.status === 200, `status ${t.status}`)

  const after = await call('/api/regulator/alerts')
  const hit = (after.data.alerts || []).find(a => a.rule === 'SAR-02' && a.subject.ownerId === 'investor2')
  check('S8b concentration alert now fires', Boolean(hit))
  check('S8b alert reports the real percentage', hit && hit.evidence.percentOfIssued > 25,
    hit ? String(hit.evidence.percentOfIssued) : 'no alert')

  if (hit) {
    const d = await call('/api/regulator/alerts/disposition', {
      method: 'POST',
      body: { alertId: hit.alertId, disposition: 'UNDER_REVIEW', note: 'smoke test' },
    })
    check('S8b disposition recorded', d.status === 200 && d.data.disposition === 'UNDER_REVIEW')
    const recheck = await call('/api/regulator/alerts')
    const again = (recheck.data.alerts || []).find(a => a.alertId === hit.alertId)
    check('S8b disposition persists across reads', again && again.disposition === 'UNDER_REVIEW')
  }

  await move('investor2', 'originator1', 4000)
  const restored = await call('/api/regulator/cap-table?assetId=' + ASSET)
  const inv2After = (restored.data.holders.find(h => h.ownerId === 'investor2') || {}).tokens || 0
  check('S8b position restored', inv2After === inv2Before, `${inv2After} vs ${inv2Before}`)
}

// S9 — a freeze without a reason is refused; with one it is recorded.
{
  const bad = await call('/api/regulator/freeze', { method: 'POST', body: { assetId: ASSET } })
  check('S9 freeze without a reason refused', bad.status === 400 && bad.data.error === 'ERR_REASON_REQUIRED',
    `status ${bad.status} ${bad.data.error}`)

  const good = await call('/api/regulator/freeze', {
    method: 'POST',
    body: { assetId: ASSET, reason: 'Smoke test — verifying the supervisory action log' },
  })
  check('S9 freeze with a reason accepted', good.status === 200, `status ${good.status}`)
  check('S9 action records the actor', good.data.actor === 'regulator1')
  check('S9 action is hash linked', typeof good.data.hash === 'string' && good.data.prevHash)

  const log = await call('/api/regulator/actions?assetId=' + ASSET)
  check('S9 action appears in the log', (log.data.actions || []).some(a => a.actionId === good.data.actionId))

  const un = await call('/api/regulator/unfreeze', {
    method: 'POST',
    body: { assetId: ASSET, reason: 'Smoke test complete — restoring state' },
  })
  check('S9 unfreeze restores status', un.status === 200 && un.data.assetStatus !== 'FROZEN', `status ${un.data.assetStatus}`)

  const twice = await call('/api/regulator/unfreeze', { method: 'POST', body: { assetId: ASSET, reason: 'again' } })
  check('S9 double unfreeze refused', twice.status === 409)
}

// S10 — the gap analysis is allowed to fail, and does.
{
  const r = await call('/api/regulator/scheme-report?assetId=' + ASSET)
  check('S10 scheme report returns', r.status === 200, `status ${r.status}`)
  const d = r.data
  check('S10 cites Chapter VIB', /Chapter VIB/.test(d.framework))
  check('S10 reports failures honestly', d.summary.fail > 0, 'a report that always passes is theatre')
  check('S10 marks unmodelled requirements', d.summary.notModelled > 0)
  check('S10 not eligible today', d.summary.eligibleToday === false)
  check('S10 flags the Rs 500 ticket', d.checks.some(c => c.id === 'MIN_SUBSCRIPTION' && c.status === 'FAIL'))
  check('S10 every check cites a source', d.checks.every(c => c.source))
}

console.log(`\n${passed} passed, ${failures.length} failed\n`)
if (failures.length) {
  console.log('Failed: ' + failures.join('; '))
  process.exit(1)
}
console.log('Supervisory surface OK')
