import React, { useCallback, useEffect, useState } from 'react'
import PageShell, { Card, Tag } from '../components/PageShell.jsx'
import { umiFetch } from '../lib/umiFetch.js'

/**
 * The digital rupee layer, with a screen.
 *
 * Everything here already existed on the rail and could only be seen through
 * the API, which made the two most interesting behaviours invisible: money
 * that refuses to be spent outside its purpose, and a refund that pays itself
 * when an event is attested instead of when somebody files a claim.
 *
 * The page is read-only on purpose. It computes nothing: every number,
 * including the conservation check and both kinds of finality, comes from the
 * rail exactly as the rail reports it.
 */

const money = (paise) => '₹' + (Number(paise || 0) / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })

const FINALITY_TONE = { FINAL: 'live', PROVISIONAL: 'sim' }
const STATUS_TONE = {
  SETTLED: 'live', RELEASED: 'live', OPEN: 'neutral', AWAITING_CLAIM: 'sim',
  AWAITING_FOREIGN_LEG: 'sim', REFUNDED: 'neutral', EXHAUSTED: 'neutral', EXPIRED: 'bad',
}

function Finality({ f }) {
  if (!f) return <span className="pg-card-sub">not recorded</span>
  return (
    <div>
      <Tag tone={FINALITY_TONE[f.financial] || 'neutral'}>
        {f.financial === 'FINAL' ? 'Financially final' : 'Financially provisional'}
      </Tag>{' '}
      <Tag tone="neutral">Block {f.blockHeight}</Tag>
      <p className="pg-card-sub" style={{ marginTop: 6 }}>{f.basis}</p>
      {f.settlementWindow && (
        <p className="pg-card-sub" style={{ marginTop: 4 }}><b>Still open:</b> {f.settlementWindow}</p>
      )}
    </div>
  )
}

function Overview({ status }) {
  if (!status) return null
  const c = status.conservation || {}
  return (
    <Card
      title="What this layer is"
      sub="A simulated digital rupee that lives on the ledger rather than in a table beside it."
      right={<Tag tone="sim">Simulated</Tag>}
    >
      <div className="pg-kv">
        <div>Issued</div><div>{money(c.issuedPaise)}</div>
        <div>Outstanding</div><div>{money(c.outstandingPaise)}</div>
        <div>Held in accounts</div><div>{money(c.heldInWalletsPaise)}</div>
        <div>Reserved for offline use</div><div>{money(c.offlineReservedPaise)}</div>
        <div>Locked against events</div><div>{money(c.lockedInConditions)}</div>
        <div>Supply conserved</div>
        <div>{c.conserved ? <Tag tone="live">Yes, issued equals held plus redeemed</Tag> : <Tag tone="bad">No</Tag>}</div>
      </div>
      <p className="pg-card-sub" style={{ marginTop: 12 }}>{c.meaning}</p>
      {status.finality && (
        <div style={{ marginTop: 14 }}>
          <h3 className="pg-card-title" style={{ fontSize: 16 }}>Two different kinds of final</h3>
          <p className="pg-card-sub" style={{ marginTop: 6 }}><b>Technical:</b> {status.finality.technical}</p>
          <p className="pg-card-sub" style={{ marginTop: 4 }}><b>Financial:</b> {status.finality.financial}</p>
        </div>
      )}
      <p className="pg-card-sub" style={{ marginTop: 12, opacity: 0.85 }}>{status.disclaimer}</p>
    </Card>
  )
}

function Accounts({ accounts }) {
  if (!accounts.length) return null
  return (
    <Card title="Accounts" sub="Balances in integer paise. Reserved and locked value sits inside the balance, not beside it.">
      <div style={{ overflowX: 'auto' }}>
        <table className="pg-table">
          <thead>
            <tr><th>Holder</th><th>Segment</th><th>KYC</th><th>Balance</th><th>Offline</th><th>Locked</th></tr>
          </thead>
          <tbody>
            {accounts.map((a) => (
              <tr key={a.holder}>
                <td>{a.holder}</td>
                <td>{a.segment === 'WHOLESALE' ? 'Wholesale' : 'Retail'}</td>
                <td>{a.kycTier === 'FULL_KYC' ? 'Full' : 'Minimal'}</td>
                <td>{money(a.balancePaise)}</td>
                <td>{a.offlineReservedPaise ? money(a.offlineReservedPaise) : '-'}</td>
                <td>{a.lockedPaise ? money(a.lockedPaise) : '-'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  )
}

function Grants({ grants }) {
  if (!grants.length) return null
  return (
    <Card
      title="Money that can only be spent one way"
      sub="A sponsor binds funds to a purpose. The rail refuses a spend outside the rule at the point of sale, rather than reconciling it afterwards."
    >
      {grants.map((g) => {
        const cond = g.condition || {}
        return (
          <div key={g.grantId} className="pg-row" style={{ padding: '12px 0', borderTop: '1px solid #E2E8F0' }}>
            <div><b>{cond.purpose || 'Purpose-bound'}</b> {' '}
              <Tag tone={STATUS_TONE[g.status] || 'neutral'}>{g.status}</Tag>
            </div>
            <p className="pg-card-sub" style={{ marginTop: 4 }}>
              {money(g.amountPaise)} to {g.beneficiary}, {money(g.amountPaise - g.spentPaise)} left.
            </p>
            <p className="pg-card-sub" style={{ marginTop: 4 }}>
              Spendable at {(cond.merchantCategories || ['any merchant']).join(', ')}
              {cond.allowedStates && cond.allowedStates.length ? ' in ' + cond.allowedStates.join(', ') : ''}
              {cond.expiresAt ? ', until ' + new Date(cond.expiresAt).toLocaleDateString() : ''}.
            </p>
          </div>
        )
      })}
    </Card>
  )
}

function Conditions({ conditions }) {
  if (!conditions.length) return null
  return (
    <Card
      title="Refunds that pay themselves"
      sub="Money locked against an event. When the named party attests the event the payment happens immediately, with no claim filed and no form submitted. If the deadline passes without one, the money returns to the payer."
    >
      {conditions.map((c) => (
        <div key={c.conditionId} className="pg-row" style={{ padding: '12px 0', borderTop: '1px solid #E2E8F0' }}>
          <div>
            <b>{c.eventType.replace(/_/g, ' ').toLowerCase()}</b>{' '}
            <span className="pg-card-sub">{c.eventKey}</span>{' '}
            <Tag tone={STATUS_TONE[c.status] || 'neutral'}>{c.status}</Tag>
          </div>
          <p className="pg-card-sub" style={{ marginTop: 4 }}>
            {money(c.amountPaise)} from {c.payer} to {c.payee}, attested by {c.attestor}.
            {c.status === 'OPEN' ? ' Deadline ' + new Date(c.deadline).toLocaleString() + '.' : ''}
            {c.status === 'RELEASED' ? ' Paid ' + new Date(c.settledAt).toLocaleString() + '.' : ''}
            {c.status === 'REFUNDED' ? ' Returned to the payer when nobody attested the event.' : ''}
          </p>
          {c.finality && <Finality f={c.finality} />}
        </div>
      ))}
    </Card>
  )
}

function Corridors({ corridors, blocked }) {
  if (!corridors.length) return null
  return (
    <Card
      title="Crossing a border"
      sub="Five rails, each with its own authorisation, ceilings and settlement model. A payment is refused by the corridor that cannot carry it, and the missing authorisation is named."
    >
      <div style={{ overflowX: 'auto' }}>
        <table className="pg-table">
          <thead>
            <tr><th>Corridor</th><th>Settles</th><th>Ceiling</th><th>Usable here</th></tr>
          </thead>
          <tbody>
            {corridors.map((c) => {
              const missing = (blocked || {})[c.id]
              return (
                <tr key={c.id}>
                  <td>
                    <b>{c.name}</b>
                    <div className="pg-card-sub">{c.settlementWindow}</div>
                  </td>
                  <td>{c.settlementModel === 'ATOMIC_ON_LEDGER' ? 'Atomically, here'
                    : c.settlementModel === 'HTLC_CROSS_LEDGER' ? 'Across two ledgers, hash-locked'
                      : 'Later, on somebody else\'s clock'}</td>
                  <td>{c.perTransactionCapPaise ? money(c.perTransactionCapPaise) : 'no fixed ceiling'}</td>
                  <td>{missing
                    ? <><Tag tone="bad">No</Tag><div className="pg-card-sub">needs {missing.join(', ')}</div></>
                    : <Tag tone="live">Yes</Tag>}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </Card>
  )
}

function Transfers({ transfers }) {
  if (!transfers.length) return null
  return (
    <Card title="Cross-border payments" sub="Where each one actually sits, rather than whether a screen said done.">
      {transfers.map((t) => (
        <div key={t.transferId} className="pg-row" style={{ padding: '12px 0', borderTop: '1px solid #E2E8F0' }}>
          <div>
            <b>{money(t.amountPaise)}</b> {t.payer} to {t.payee}{' '}
            <Tag tone={STATUS_TONE[t.status] || 'neutral'}>{t.status.replace(/_/g, ' ').toLowerCase()}</Tag>
          </div>
          <p className="pg-card-sub" style={{ marginTop: 4 }}>{t.corridorId} · {t.purposeCode}{t.travelRuleApplied ? ' · originator and beneficiary recorded' : ''}{t.reportable ? ' · reportable' : ''}</p>
          <Finality f={t.finality} />
        </div>
      ))}
    </Card>
  )
}

function Movements({ movements }) {
  if (!movements.length) return null
  return (
    <Card title="Recent movements" sub="Every movement carries its screening and both finalities.">
      <div style={{ overflowX: 'auto' }}>
        <table className="pg-table">
          <thead>
            <tr><th>Kind</th><th>Amount</th><th>From</th><th>To</th><th>Mode</th><th>Final</th><th>Screening</th></tr>
          </thead>
          <tbody>
            {movements.map((m) => (
              <tr key={m.movementId}>
                <td>{m.kind.replace(/_/g, ' ').toLowerCase()}</td>
                <td>{money(m.amountPaise)}</td>
                <td>{m.from || "-"}</td>
                <td>{m.to || "-"}</td>
                <td>{m.mode === 'OFFLINE' ? 'Offline' : 'Online'}</td>
                <td><Tag tone={FINALITY_TONE[m.finality?.financial] || 'neutral'}>{m.finality?.financial || "-"}</Tag></td>
                <td>
                  {m.aml?.decision || "-"}
                  {m.aml?.reportable ? <div className="pg-card-sub">reportable</div> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  )
}

export default function DigitalRupee() {
  const [status, setStatus] = useState(null)
  const [accounts, setAccounts] = useState([])
  const [grants, setGrants] = useState([])
  const [conditions, setConditions] = useState([])
  const [movements, setMovements] = useState([])
  const [corridors, setCorridors] = useState(null)
  const [transfers, setTransfers] = useState([])
  const [err, setErr] = useState('')
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    const get = async (path, fallback) => {
      const { ok, data } = await umiFetch(path)
      return ok ? data : fallback
    }
    const [st, acc, gr, co, mv, cor, tr] = await Promise.all([
      get('/cbdc', null),
      get('/cbdc/accounts', {}),
      get('/cbdc/grants', {}),
      get('/cbdc/conditions', {}),
      get('/cbdc/movements?limit=25', {}),
      get('/corridors', null),
      get('/corridors/transfers?limit=15', {}),
    ])
    if (!st) setErr('This deployment does not have the digital rupee layer mounted.')
    setStatus(st)
    setAccounts(acc.accounts || [])
    setGrants(gr.grants || [])
    setConditions(co.conditions || [])
    setMovements(mv.movements || [])
    setCorridors(cor)
    setTransfers(tr.transfers || [])
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  return (
    <PageShell
      eyebrow="Digital rupee"
      title="Central bank money, on the ledger"
      lede="Money that can be bound to a purpose, carried offline, and released by a rule rather than a claim form. Both kinds of finality are shown separately, because a ledger entry and a settled payment are not the same thing."
      badge={<Tag tone="sim">Simulated. No central bank money is issued here.</Tag>}
    >
      {err && <Card title="Not available"><p className="pg-card-sub">{err}</p></Card>}
      {loading && !status && <Card title="Loading"><p className="pg-card-sub">Reading the rail.</p></Card>}
      <Overview status={status} />
      <Conditions conditions={conditions} />
      <Grants grants={grants} />
      <Accounts accounts={accounts} />
      <Corridors corridors={(corridors && corridors.corridors) || []} blocked={corridors && corridors.blockedCorridors} />
      <Transfers transfers={transfers} />
      <Movements movements={movements} />
      {status && accounts.length === 0 && (
        <Card title="Nothing has happened yet">
          <p className="pg-card-sub">
            No digital rupees have been issued on this deployment. The layer is mounted and the rules are
            enforced; there is simply nothing to show until money is issued.
          </p>
        </Card>
      )}
    </PageShell>
  )
}
