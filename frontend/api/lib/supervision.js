// ---------------------------------------------------------------------------
// Supervisory reporting surface — the evidence a regulator actually consumes.
//
// HONESTY CONTRACT (enforced by decorate(), same discipline as umi_sim.js):
//   Nothing here is filed with, submitted to, or connected to SEBI, RBI, NPCI,
//   NSDL or CDSL. No regulator has seen, approved or acknowledged any output of
//   this module. Every response carries:
//       simulated:        true
//       regulatoryStatus: SIMULATED_NOT_CONNECTED
//       filedWith:        null
//
// WHAT THIS MODULE IS FOR
//   A regulator does not expose a socket you can dial. Supervision works the
//   other way round: the supervised entity produces evidence in a defined shape
//   and the regulator consumes it. This module produces that evidence from the
//   platform's own state — cap tables, a tamper-evident audit export, alerts,
//   and an SM REIT gap analysis — so the reporting layer exists and can be
//   inspected long before any regulated relationship does.
//
//   The gap analysis is deliberately allowed to FAIL. A compliance report that
//   always passes is worthless. See schemeReport().
//
// SOURCES FOR THE REPORT SHAPES
//   SEBI (REIT) (Amendment) Regulations 2024, Chapter VIB — Small and Medium
//   REITs: scheme asset value Rs 50 cr-500 cr, minimum 200 unrelated investors,
//   minimum Rs 10 lakh subscription, >=95% in completed rent-generating
//   property, leverage <=49%, investment manager net worth >=Rs 20 cr with 15%
//   co-investment, mandatory listing.
// ---------------------------------------------------------------------------

import crypto from 'crypto'

export const SUPERVISION_VERSION = 'aasthi.supervision-v1'
export const REGULATORY_STATUS = 'SIMULATED_NOT_CONNECTED'

// The signing key is a process-local demo secret. It is NOT an HSM, NOT a
// registered signing certificate, and carries no legal weight. It exists so the
// export's integrity chain can be verified end to end, nothing more.
export const KEY_CUSTODY = 'DEMO_KEY_IN_PROCESS_NOT_AN_HSM'
const DEMO_SIGNING_KEY = process.env.SUPERVISION_DEMO_KEY || 'aasthichain-demo-signing-key-not-a-secret'

export const SEVERITY = { LOW: 'LOW', MEDIUM: 'MEDIUM', HIGH: 'HIGH' }
export const CHECK = { PASS: 'PASS', FAIL: 'FAIL', NOT_MODELLED: 'NOT_MODELLED' }

const CRORE = 10000000
const LAKH = 100000

function sha512(s) {
  return crypto.createHash('sha512').update(String(s)).digest('hex')
}

// Deterministic serialisation — key order must not change the hash.
function canonical(obj) {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj) ?? 'null'
  if (Array.isArray(obj)) return '[' + obj.map(canonical).join(',') + ']'
  return '{' + Object.keys(obj).sort().map(k => JSON.stringify(k) + ':' + canonical(obj[k])).join(',') + '}'
}

function iso(d) {
  if (!d) return null
  const t = d instanceof Date ? d : new Date(d)
  return Number.isNaN(t.getTime()) ? null : t.toISOString()
}

// Every response leaves through here. There is no other exit.
function decorate(payload) {
  return {
    ...payload,
    reportVersion: SUPERVISION_VERSION,
    simulated: true,
    regulatoryStatus: REGULATORY_STATUS,
    filedWith: null,
    generatedAt: new Date().toISOString(),
  }
}

// ---------------------------------------------------------------------------
// Shared supervisory store — freeze/unfreeze actions and alert dispositions.
// Kept on globalThis so the serverless and local servers share one instance.
// ---------------------------------------------------------------------------

export function getStore() {
  if (!globalThis._aasthi_supervision) {
    globalThis._aasthi_supervision = { actions: [], dispositions: {} }
  }
  return globalThis._aasthi_supervision
}

// A freeze without a recorded reason and actor is not a supervisory act, it is
// just a status change. This is what makes it reviewable after the fact.
export function recordAction({ assetId, action, reason, actor, actorRole }) {
  if (!assetId) throw badRequest('ERR_ASSET_REQUIRED', 'assetId is required')
  if (!reason || !String(reason).trim()) {
    throw badRequest('ERR_REASON_REQUIRED', 'a written reason is required for every supervisory action')
  }
  if (!actor) throw badRequest('ERR_ACTOR_REQUIRED', 'actor identity is required')

  const store = getStore()
  const at = new Date().toISOString()
  const seq = store.actions.length + 1
  const prevHash = store.actions.length ? store.actions[store.actions.length - 1].hash : 'GENESIS'
  const record = {
    actionId: 'SUP-' + sha512(`${assetId}|${action}|${actor}|${at}|${seq}`).slice(0, 16).toUpperCase(),
    seq,
    assetId,
    action,
    reason: String(reason).trim(),
    actor,
    actorRole: actorRole || null,
    at,
  }
  record.prevHash = prevHash
  record.hash = sha512(prevHash + canonical(record))
  store.actions.push(record)
  return record
}

export function listActions(assetId) {
  const all = getStore().actions
  return assetId ? all.filter(a => a.assetId === assetId) : all.slice()
}

function badRequest(code, message) {
  const e = new Error(message)
  e.code = code
  e.http = 400
  return e
}

function notFound(code, message) {
  const e = new Error(message)
  e.code = code
  e.http = 404
  return e
}

// ---------------------------------------------------------------------------
// State normalisation — both servers hold the same shapes in different objects.
// ---------------------------------------------------------------------------

function normalise(state) {
  return {
    properties: Object.values(state.properties || {}),
    balances: Object.values(state.balances || {}),
    transfers: Object.values(state.transfers || {}),
    payments: Object.values(state.payments || {}),
    kyc: state.kyc || {},
    chain: state.chain || [],
  }
}

// ---------------------------------------------------------------------------
// 1. CAP TABLE — who holds what, as of a point in time.
//
// "As of" is a real replay, not a relabelled current balance: holdings are
// rolled backwards through every transfer that happened after the cutoff. A
// cap table you cannot re-derive for a past date is not evidence.
// ---------------------------------------------------------------------------

export function capTable(state, { assetId, asOf } = {}) {
  const s = normalise(state)
  if (!assetId) throw badRequest('ERR_ASSET_REQUIRED', 'assetId is required')

  const property = s.properties.find(p => p.assetId === assetId)
  if (!property) throw notFound('ERR_ASSET_NOT_FOUND', `no property with assetId ${assetId}`)

  const cutoff = asOf ? new Date(asOf) : null
  if (cutoff && Number.isNaN(cutoff.getTime())) {
    throw badRequest('ERR_INVALID_ASOF', 'asOf must be an ISO-8601 timestamp')
  }

  const holdings = {}
  for (const b of s.balances) {
    if (b.assetId !== assetId) continue
    holdings[b.ownerId] = (holdings[b.ownerId] || 0) + (b.balance || 0)
  }

  let rewound = 0
  if (cutoff) {
    for (const t of s.transfers) {
      if (t.assetId !== assetId) continue
      const ts = new Date(t.txTimestamp || t.createdAt || 0)
      if (ts <= cutoff) continue
      holdings[t.fromId] = (holdings[t.fromId] || 0) + (t.amount || 0)
      holdings[t.toId] = (holdings[t.toId] || 0) - (t.amount || 0)
      rewound++
    }
  }

  const totalTokens = property.totalTokens || 0
  const tokenPriceINR = totalTokens ? Math.floor((property.valuationINR || 0) / totalTokens) : 0
  const held = Object.entries(holdings)
    .filter(([, tokens]) => tokens > 0)
    .map(([ownerId, tokens]) => ({
      ownerId,
      tokens,
      percentOfIssued: totalTokens ? round2((tokens / totalTokens) * 100) : 0,
      valueINR: tokens * tokenPriceINR,
      kycStatus: (s.kyc[ownerId] || s.kyc[String(ownerId).toLowerCase()] || {}).kycStatus || 'UNKNOWN',
    }))
    .sort((a, b) => b.tokens - a.tokens)

  const issued = held.reduce((n, h) => n + h.tokens, 0)
  const pcts = held.map(h => h.percentOfIssued)

  return decorate({
    reportType: 'CAP_TABLE',
    assetId,
    asOf: cutoff ? cutoff.toISOString() : new Date().toISOString(),
    asOfMode: cutoff ? 'REPLAYED_TO_CUTOFF' : 'CURRENT',
    transfersRewound: rewound,
    property: {
      title: property.title,
      status: property.status,
      valuationINR: property.valuationINR,
      totalTokens,
      tokenPriceINR,
      location: property.location || null,
      registrarValidationStatus: property.registrarValidationStatus || null,
    },
    holderCount: held.length,
    holders: held,
    concentration: {
      largestHolderPercent: pcts.length ? pcts[0] : 0,
      topFivePercent: round2(pcts.slice(0, 5).reduce((a, b) => a + b, 0)),
      // Herfindahl-Hirschman Index over percentage shares; >2500 is concentrated.
      hhi: Math.round(pcts.reduce((a, p) => a + p * p, 0)),
    },
    reconciliation: {
      // Tokens the issuer minted vs tokens actually accounted for in holdings.
      // A non-zero difference means the ledger and the cap table disagree.
      issuedTokens: issued,
      mintedTokens: totalTokens,
      unallocatedTokens: totalTokens - issued,
      balanced: issued <= totalTokens,
    },
  })
}

function round2(n) {
  return Math.round(n * 100) / 100
}

// ---------------------------------------------------------------------------
// 2. AUDIT EXPORT — tamper-evident record of everything that moved.
//
// Every record is hashed, and each hash folds in the previous one, so removing
// or editing any single row breaks every hash after it. The final chain head is
// signed. verifyAuditExport() below re-derives the whole thing independently.
// ---------------------------------------------------------------------------

export function auditExport(state, { assetId, from, to } = {}) {
  const s = normalise(state)
  const fromT = from ? new Date(from) : null
  const toT = to ? new Date(to) : null
  if ((from && Number.isNaN(fromT.getTime())) || (to && Number.isNaN(toT.getTime()))) {
    throw badRequest('ERR_INVALID_RANGE', 'from and to must be ISO-8601 timestamps')
  }

  const inRange = (d) => {
    const t = new Date(d || 0)
    if (fromT && t < fromT) return false
    if (toT && t > toT) return false
    return true
  }

  const events = []

  for (const t of s.transfers) {
    if (assetId && t.assetId !== assetId) continue
    if (!inRange(t.txTimestamp)) continue
    events.push({
      type: 'TOKEN_TRANSFER',
      occurredAt: iso(t.txTimestamp),
      assetId: t.assetId,
      ref: t.transferId,
      fromParty: t.fromId,
      toParty: t.toId,
      tokens: t.amount || 0,
      amountINR: null,
      status: t.status || null,
      detail: null,
    })
  }

  for (const p of s.payments) {
    if (assetId && p.assetId !== assetId) continue
    if (!inRange(p.createdAt)) continue
    events.push({
      type: 'PAYMENT',
      occurredAt: iso(p.createdAt),
      assetId: p.assetId || null,
      ref: p.paymentId,
      fromParty: p.payerId || p.payerVpa || null,
      toParty: p.payeeId || p.payeeVpa || null,
      tokens: p.tokenAmount || 0,
      amountINR: p.amountINR || 0,
      status: p.status || null,
      detail: {
        utr: p.utr || null,
        rrn: p.rrn || null,
        riskScore: p.risk ? p.risk.score : null,
        riskDecision: p.risk ? p.risk.decision : null,
        settlementRail: p.settlementRail || 'UPI_SIM',
        simulated: true,
      },
    })
  }

  for (const a of listActions(assetId)) {
    if (!inRange(a.at)) continue
    events.push({
      type: 'SUPERVISORY_ACTION',
      occurredAt: a.at,
      assetId: a.assetId,
      ref: a.actionId,
      fromParty: a.actor,
      toParty: null,
      tokens: 0,
      amountINR: null,
      status: a.action,
      detail: { reason: a.reason, actorRole: a.actorRole },
    })
  }

  events.sort((a, b) => new Date(a.occurredAt || 0) - new Date(b.occurredAt || 0))

  let prev = 'GENESIS'
  const records = events.map((e, i) => {
    const body = { ...e, seq: i + 1 }
    const recordHash = sha512(canonical(body))
    const chainHash = sha512(prev + recordHash)
    prev = chainHash
    return { ...body, recordHash, prevChainHash: i === 0 ? 'GENESIS' : undefined, chainHash }
  })

  const head = prev
  const signature = crypto.createHmac('sha512', DEMO_SIGNING_KEY).update(head).digest('hex')

  return decorate({
    reportType: 'AUDIT_EXPORT',
    scope: { assetId: assetId || 'ALL', from: fromT ? fromT.toISOString() : null, to: toT ? toT.toISOString() : null },
    recordCount: records.length,
    records,
    integrity: {
      algorithm: 'SHA-512 hash chain',
      chainHead: head,
      signature,
      signatureAlgorithm: 'HMAC-SHA512',
      keyCustody: KEY_CUSTODY,
      // Stated plainly so nobody mistakes this for a legally recognised signature.
      legalWeight: 'NONE — demo key held in process memory, not an HSM or a registered signing certificate',
      verifyWith: 'GET /api/regulator/audit-export then POST the document to /api/regulator/audit-verify',
    },
  })
}

// Independent re-derivation. Feeds on the exported document alone.
export function verifyAuditExport(doc) {
  if (!doc || !Array.isArray(doc.records)) {
    throw badRequest('ERR_INVALID_DOCUMENT', 'document must contain a records array')
  }

  let prev = 'GENESIS'
  const failures = []

  doc.records.forEach((r, i) => {
    const { recordHash, chainHash, prevChainHash, ...body } = r
    const expectedRecord = sha512(canonical(body))
    const expectedChain = sha512(prev + expectedRecord)
    if (expectedRecord !== recordHash) {
      failures.push({ seq: i + 1, ref: r.ref, problem: 'RECORD_ALTERED', expected: expectedRecord, found: recordHash })
    } else if (expectedChain !== chainHash) {
      failures.push({ seq: i + 1, ref: r.ref, problem: 'CHAIN_BROKEN', expected: expectedChain, found: chainHash })
    }
    prev = chainHash
  })

  const head = doc.records.length ? doc.records[doc.records.length - 1].chainHash : 'GENESIS'
  const expectedSig = crypto.createHmac('sha512', DEMO_SIGNING_KEY).update(head).digest('hex')
  const signatureValid = Boolean(doc.integrity && doc.integrity.signature === expectedSig)

  return decorate({
    reportType: 'AUDIT_VERIFICATION',
    recordCount: doc.records.length,
    chainIntact: failures.length === 0,
    signatureValid,
    verified: failures.length === 0 && signatureValid,
    failures,
  })
}

// CSV rendering for supervisors who live in spreadsheets, which is most of them.
export function auditExportCSV(report) {
  const cols = ['seq', 'occurredAt', 'type', 'assetId', 'ref', 'fromParty', 'toParty', 'tokens', 'amountINR', 'status', 'recordHash']
  const esc = (v) => {
    if (v === null || v === undefined) return ''
    const s = String(v)
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
  }
  const lines = [cols.join(',')]
  for (const r of report.records) lines.push(cols.map(c => esc(r[c])).join(','))
  lines.push('')
  lines.push(`# chainHead,${report.integrity.chainHead}`)
  lines.push(`# signature,${report.integrity.signature}`)
  lines.push(`# keyCustody,${report.integrity.keyCustody}`)
  lines.push('# simulated,true')
  lines.push('# regulatoryStatus,SIMULATED_NOT_CONNECTED')
  lines.push('# filedWith,')
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// 3. SUSPICIOUS ACTIVITY — six rules over live state.
//
// Each alert carries the evidence that triggered it, so a reviewer can argue
// with the machine instead of taking its word.
// ---------------------------------------------------------------------------

const RULES = [
  { id: 'SAR-01', name: 'Payment blocked or flagged by the fraud engine', severity: SEVERITY.HIGH },
  { id: 'SAR-02', name: 'Holder concentration above 25% of issued tokens', severity: SEVERITY.MEDIUM },
  { id: 'SAR-03', name: 'Transfer velocity above 5 transfers in 24 hours', severity: SEVERITY.MEDIUM },
  { id: 'SAR-04', name: 'Tokens held by a party without verified KYC', severity: SEVERITY.HIGH },
  { id: 'SAR-05', name: 'Possible structuring — repeated payments just under a threshold', severity: SEVERITY.MEDIUM },
  { id: 'SAR-06', name: 'Activity recorded against a frozen asset', severity: SEVERITY.HIGH },
]

export function suspiciousActivity(state, { assetId } = {}) {
  const s = normalise(state)
  const store = getStore()
  const alerts = []
  const now = Date.now()

  const add = (ruleId, subject, evidence, recommendedAction) => {
    const rule = RULES.find(r => r.id === ruleId)
    const alertId = 'ALERT-' + sha512(`${ruleId}|${canonical(subject)}|${canonical(evidence)}`).slice(0, 12).toUpperCase()
    alerts.push({
      alertId,
      rule: rule.id,
      ruleName: rule.name,
      severity: rule.severity,
      subject,
      evidence,
      recommendedAction,
      disposition: store.dispositions[alertId] || 'OPEN',
    })
  }

  // SAR-01 — the fraud engine already scored these; surface them for review.
  for (const p of s.payments) {
    if (assetId && p.assetId !== assetId) continue
    const decision = p.risk && p.risk.decision
    if (decision === 'BLOCK' || decision === 'REVIEW') {
      add('SAR-01',
        { paymentId: p.paymentId, party: p.payerId || p.payerVpa, assetId: p.assetId || null },
        {
          decision,
          score: p.risk.score,
          band: p.risk.band,
          factors: (p.risk.factors || []).map(f => f.code),
          amountINR: p.amountINR,
          model: p.risk.model,
        },
        decision === 'BLOCK' ? 'Payment already blocked — confirm the payer identity before any retry' : 'Manual review before release')
    }
  }

  // SAR-02 — concentration. Relevant because SM REIT schemes require a spread
  // of at least 200 unrelated investors.
  for (const prop of s.properties) {
    if (assetId && prop.assetId !== assetId) continue
    const total = prop.totalTokens || 0
    if (!total) continue
    for (const b of s.balances) {
      if (b.assetId !== prop.assetId || !(b.balance > 0)) continue
      const pct = (b.balance / total) * 100
      if (pct > 25 && b.ownerId !== prop.originatorId) {
        add('SAR-02',
          { ownerId: b.ownerId, assetId: prop.assetId },
          { tokens: b.balance, percentOfIssued: round2(pct), threshold: 25 },
          'Confirm source of funds and whether the holder is acting in concert with others')
      }
    }
  }

  // SAR-03 — velocity.
  const byParty = {}
  for (const t of s.transfers) {
    if (assetId && t.assetId !== assetId) continue
    const ts = new Date(t.txTimestamp || 0).getTime()
    if (now - ts > 24 * 3600 * 1000) continue
    byParty[t.fromId] = byParty[t.fromId] || []
    byParty[t.fromId].push(t.transferId)
  }
  for (const [party, ids] of Object.entries(byParty)) {
    if (ids.length > 5) {
      add('SAR-03',
        { ownerId: party },
        { transfersIn24h: ids.length, threshold: 5, transferIds: ids.slice(0, 10) },
        'Check for layering or wash trading between related accounts')
    }
  }

  // SAR-04 — holders without verified KYC.
  for (const b of s.balances) {
    if (assetId && b.assetId !== assetId) continue
    if (!(b.balance > 0)) continue
    const rec = s.kyc[b.ownerId] || s.kyc[String(b.ownerId).toLowerCase()]
    const status = rec ? rec.kycStatus : 'MISSING'
    if (status !== 'VERIFIED') {
      add('SAR-04',
        { ownerId: b.ownerId, assetId: b.assetId },
        { kycStatus: status, tokensHeld: b.balance },
        'Freeze the holding until KYC is completed and verified')
    }
  }

  // SAR-05 — structuring below the Rs 50,000 reporting threshold.
  const byPayer = {}
  for (const p of s.payments) {
    if (assetId && p.assetId !== assetId) continue
    const amt = p.amountINR || 0
    if (amt >= 40000 && amt < 50000) {
      const k = p.payerId || p.payerVpa || 'unknown'
      byPayer[k] = byPayer[k] || []
      byPayer[k].push({ paymentId: p.paymentId, amountINR: amt })
    }
  }
  for (const [payer, list] of Object.entries(byPayer)) {
    if (list.length >= 3) {
      add('SAR-05',
        { party: payer },
        { paymentsJustUnderThreshold: list.length, thresholdINR: 50000, payments: list.slice(0, 10) },
        'Aggregate the payments and assess against the reporting threshold as a single transaction')
    }
  }

  // SAR-06 — anything moving on a frozen asset.
  const frozen = new Set(s.properties.filter(p => p.status === 'FROZEN').map(p => p.assetId))
  for (const t of s.transfers) {
    if (assetId && t.assetId !== assetId) continue
    if (!frozen.has(t.assetId)) continue
    const freezeAt = listActions(t.assetId).filter(a => a.action === 'FREEZE').map(a => new Date(a.at).getTime()).sort().pop()
    const ts = new Date(t.txTimestamp || 0).getTime()
    if (freezeAt && ts > freezeAt) {
      add('SAR-06',
        { assetId: t.assetId, transferId: t.transferId },
        { transferAt: iso(t.txTimestamp), frozenAt: iso(new Date(freezeAt)) },
        'Escalate immediately — a freeze was not enforced')
    }
  }

  const bySeverity = { HIGH: 0, MEDIUM: 0, LOW: 0 }
  for (const a of alerts) if (a.disposition === 'OPEN') bySeverity[a.severity]++

  return decorate({
    reportType: 'SUSPICIOUS_ACTIVITY',
    scope: { assetId: assetId || 'ALL' },
    rules: RULES,
    alertCount: alerts.length,
    openBySeverity: bySeverity,
    alerts: alerts.sort((a, b) => {
      const order = { HIGH: 0, MEDIUM: 1, LOW: 2 }
      return order[a.severity] - order[b.severity]
    }),
  })
}

export function setDisposition(alertId, disposition, note, actor) {
  const allowed = ['OPEN', 'UNDER_REVIEW', 'CLEARED', 'ESCALATED']
  if (!allowed.includes(disposition)) {
    throw badRequest('ERR_INVALID_DISPOSITION', `disposition must be one of ${allowed.join(', ')}`)
  }
  if (!actor) throw badRequest('ERR_ACTOR_REQUIRED', 'actor identity is required')
  const store = getStore()
  store.dispositions[alertId] = disposition
  return decorate({
    reportType: 'ALERT_DISPOSITION',
    alertId,
    disposition,
    note: note || null,
    actor,
    recordedAt: new Date().toISOString(),
  })
}

// ---------------------------------------------------------------------------
// 4. SM REIT SCHEME REPORT — gap analysis against SEBI Chapter VIB.
//
// This is written to fail. The demo does not meet most of these requirements
// and the report says so in the regulator's own vocabulary. A compliance
// report that always returns PASS is theatre.
// ---------------------------------------------------------------------------

export function schemeReport(state, { assetId } = {}) {
  const s = normalise(state)
  if (!assetId) throw badRequest('ERR_ASSET_REQUIRED', 'assetId is required')
  const property = s.properties.find(p => p.assetId === assetId)
  if (!property) throw notFound('ERR_ASSET_NOT_FOUND', `no property with assetId ${assetId}`)

  const table = capTable(state, { assetId })
  const value = property.valuationINR || 0
  const holders = table.holders.filter(h => h.ownerId !== property.originatorId)
  const tokenPrice = table.property.tokenPriceINR
  const smallestTicket = holders.length ? Math.min(...holders.map(h => h.valueINR)) : 0

  const checks = [
    check('SCHEME_ASSET_VALUE', 'Scheme asset value between Rs 50 crore and Rs 500 crore',
      'Reg. 26T, Chapter VIB',
      `Rs ${(value / CRORE).toFixed(2)} crore`,
      value >= 50 * CRORE && value <= 500 * CRORE ? CHECK.PASS : CHECK.FAIL,
      value < 50 * CRORE ? `Below the floor by Rs ${((50 * CRORE - value) / CRORE).toFixed(2)} crore` : null),

    check('MIN_INVESTORS', 'At least 200 unrelated investors per scheme',
      'Reg. 26U, Chapter VIB',
      `${holders.length} holders (excluding the originator)`,
      holders.length >= 200 ? CHECK.PASS : CHECK.FAIL,
      holders.length < 200 ? `Short by ${200 - holders.length} investors` : null),

    check('MIN_SUBSCRIPTION', 'Minimum subscription of Rs 10 lakh per investor',
      'Reg. 26U(2), Chapter VIB',
      holders.length ? `Smallest holding is Rs ${(smallestTicket / LAKH).toFixed(2)} lakh (token price Rs ${tokenPrice})` : 'no third-party holders',
      smallestTicket >= 10 * LAKH ? CHECK.PASS : CHECK.FAIL,
      smallestTicket < 10 * LAKH ? 'The Rs 500 minimum in this demo exists to show divisibility. A real SM REIT scheme cannot accept it.' : null),

    check('COMPLETED_RENT_GENERATING', 'At least 95% of scheme assets in completed, rent-generating property',
      'Reg. 26V, Chapter VIB',
      'Not modelled — the platform holds no rent roll or occupancy data',
      CHECK.NOT_MODELLED,
      'Would require lease-level data ingestion per property'),

    check('LEVERAGE', 'Scheme leverage not exceeding 49% of asset value',
      'Reg. 26W, Chapter VIB',
      'Not modelled — no debt is recorded against any scheme',
      CHECK.NOT_MODELLED,
      'Would require a liabilities register alongside the cap table'),

    check('MANAGER_NET_WORTH', 'Investment manager net worth of at least Rs 20 crore',
      'Reg. 26S, Chapter VIB',
      'Not modelled — no investment manager entity exists',
      CHECK.NOT_MODELLED,
      'Requires an incorporated investment manager and audited accounts'),

    check('MANAGER_CO_INVESTMENT', 'Investment manager co-investment of 15% where leverage is used',
      'Reg. 26W, Chapter VIB',
      'Not modelled',
      CHECK.NOT_MODELLED,
      'Dependent on the leverage register above'),

    check('LISTING', 'Mandatory listing of scheme units on a recognised stock exchange',
      'Reg. 26X, Chapter VIB',
      'Not modelled — units exist only on this permissioned ledger',
      CHECK.NOT_MODELLED,
      'Requires an exchange relationship and a registered RTA'),

    check('SPV_STRUCTURE', 'Each scheme held through a separate special purpose vehicle',
      'Reg. 26R, Chapter VIB',
      'Not modelled — assets are recorded directly against the platform',
      CHECK.NOT_MODELLED,
      'Structural, not a software change'),

    check('CAP_TABLE_RECONCILES', 'Unit register reconciles with issued units',
      'General record-keeping obligation',
      `${table.reconciliation.issuedTokens} of ${table.reconciliation.mintedTokens} tokens accounted for`,
      table.reconciliation.balanced ? CHECK.PASS : CHECK.FAIL,
      table.reconciliation.balanced ? null : 'Holdings exceed the minted supply — investigate before any further issuance'),

    check('AUDIT_TRAIL', 'Complete, tamper-evident audit trail of all unit movements',
      'General record-keeping obligation',
      'Hash-chained export available at /api/regulator/audit-export',
      CHECK.PASS,
      'Integrity chain is real; the signing key is a demo key, not an HSM'),

    check('KYC_ALL_HOLDERS', 'All unit holders KYC verified',
      'SEBI KYC (KRA) Regulations 2011',
      kycSummary(table.holders),
      table.holders.every(h => h.kycStatus === 'VERIFIED') ? CHECK.PASS : CHECK.FAIL,
      table.holders.every(h => h.kycStatus === 'VERIFIED') ? null : 'Unverified holders must be frozen until KYC completes'),
  ]

  const counts = {
    pass: checks.filter(c => c.status === CHECK.PASS).length,
    fail: checks.filter(c => c.status === CHECK.FAIL).length,
    notModelled: checks.filter(c => c.status === CHECK.NOT_MODELLED).length,
  }

  return decorate({
    reportType: 'SM_REIT_SCHEME_GAP_ANALYSIS',
    complianceMode: 'GAP_ANALYSIS',
    framework: 'SEBI (Real Estate Investment Trusts) Regulations 2014, Chapter VIB — Small and Medium REITs, inserted by the 2024 Amendment',
    assetId,
    scheme: {
      title: property.title,
      valuationINR: value,
      valuationCrore: round2(value / CRORE),
      totalTokens: property.totalTokens || 0,
      investorCount: holders.length,
      smallestHoldingINR: smallestTicket,
    },
    summary: {
      ...counts,
      eligibleToday: counts.fail === 0 && counts.notModelled === 0,
      // Stated flatly so the number cannot be quoted out of context.
      plainReading: `This scheme would not be registrable as an SM REIT today: ${counts.fail} requirement(s) fail and ${counts.notModelled} are not modelled by the platform at all.`,
    },
    checks,
  })
}

function check(id, requirement, source, observed, status, note) {
  return { id, requirement, source, observed, status, note: note || null }
}

function kycSummary(holders) {
  const counts = {}
  for (const h of holders) counts[h.kycStatus] = (counts[h.kycStatus] || 0) + 1
  return Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ') || 'no holders'
}

// ---------------------------------------------------------------------------
// 5. CAPABILITIES — what this surface does and does not do.
// ---------------------------------------------------------------------------

export function capabilities() {
  return decorate({
    surface: 'Supervisory reporting',
    purpose: 'Produce the evidence a securities regulator consumes, in the shape it consumes it.',
    modelled: [
      'Cap table with point-in-time replay and concentration measures',
      'Hash-chained, signed audit export with independent verification',
      'Six-rule suspicious activity screen with recorded dispositions',
      'SM REIT Chapter VIB gap analysis that is allowed to fail',
      'Freeze and unfreeze with a mandatory written reason and named actor',
    ],
    notModelled: [
      'Any filing, submission or transmission to a regulator',
      'Regulator acknowledgement, approval or registration of any kind',
      'Hardware-backed or legally recognised digital signatures',
      'Rent rolls, lease data, debt registers or audited financial statements',
      'Exchange listing, RTA or depository connectivity',
    ],
    legalNote:
      'AasthiChain is not a SEBI-registered intermediary and holds no SM REIT registration. These reports are generated from demo data for engineering and design review. They have not been filed with, seen by, or approved by SEBI, RBI, NPCI, NSDL or CDSL.',
    endpoints: [
      { method: 'GET', path: '/api/regulator/capabilities', access: 'public' },
      { method: 'GET', path: '/api/regulator/cap-table?assetId=&asOf=', access: 'Regulator' },
      { method: 'GET', path: '/api/regulator/audit-export?assetId=&from=&to=&format=json|csv', access: 'Regulator' },
      { method: 'POST', path: '/api/regulator/audit-verify', access: 'Regulator' },
      { method: 'GET', path: '/api/regulator/alerts?assetId=', access: 'Regulator' },
      { method: 'POST', path: '/api/regulator/alerts/disposition', access: 'Regulator' },
      { method: 'GET', path: '/api/regulator/scheme-report?assetId=', access: 'Regulator' },
      { method: 'GET', path: '/api/regulator/actions?assetId=', access: 'Regulator' },
      { method: 'POST', path: '/api/regulator/freeze', access: 'Regulator' },
      { method: 'POST', path: '/api/regulator/unfreeze', access: 'Regulator' },
    ],
    references: [
      { title: 'SEBI (REIT) Regulations 2014, Chapter VIB — Small and Medium REITs', url: 'https://www.sebi.gov.in/legal/regulations/mar-2024/securities-and-exchange-board-of-india-real-estate-investment-trusts-amendment-regulations-2024_82388.html' },
      { title: 'SEBI Innovation Sandbox', url: 'https://www.sebi.gov.in/sebiweb/other/OtherAction.do?doInnovationSandbox=yes' },
    ],
  })
}

export const SUPERVISION_ERRORS = { badRequest, notFound }
