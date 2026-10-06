import { useState, useEffect, useCallback } from 'react'
import { Link } from 'react-router-dom'
import api from '../lib/api.js'

// The operations view answers one question: what is stuck, and who has to act.
// It deliberately does not duplicate /admin (which walks a single property
// through its lifecycle) or /insights (which is a private analytics read).
// Everything here is a queue with an owner and, where possible, the action
// that clears it.

const C = {
  navy: '#1E3A5F', paper: '#F7F5F0', line: '#E5E7EB',
  mut: '#6B7280', bad: '#B91C1C', warn: '#B45309', ok: '#047857',
}

const money = (n) => '₹' + Number(n || 0).toLocaleString('en-IN')
const age = (m) => (m == null ? '—' : m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h` : `${Math.floor(m / 1440)}d`)

function Card({ title, sub, count, tone, children }) {
  const colour = tone === 'bad' ? C.bad : tone === 'warn' ? C.warn : C.navy
  return (
    <section style={{
      background: '#fff', border: `1px solid ${C.line}`, borderRadius: 12,
      padding: '16px 18px', marginBottom: 14,
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 4 }}>
        <h2 style={{ fontSize: 15, fontWeight: 700, color: '#111827', margin: 0 }}>{title}</h2>
        <span style={{
          fontSize: 12, fontWeight: 700, color: '#fff', background: count ? colour : '#9CA3AF',
          borderRadius: 999, padding: '1px 9px',
        }}>{count}</span>
      </div>
      {sub && <p style={{ fontSize: 12.5, color: C.mut, margin: '0 0 10px' }}>{sub}</p>}
      {children}
    </section>
  )
}

function Empty({ children }) {
  return <p style={{ fontSize: 13, color: C.ok, margin: 0 }}>{children}</p>
}

function Row({ children }) {
  return (
    <div style={{
      display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12,
      padding: '8px 0', borderTop: `1px solid ${C.line}`, fontSize: 13,
    }}>{children}</div>
  )
}

export default function AdminOps({ user }) {
  const [data, setData] = useState(null)
  const [err, setErr] = useState(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true); setErr(null)
    try {
      setData(await api.getAdminOps())
    } catch (e) {
      setErr(e.message || 'Could not load the operations queue')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const role = user && user.role
  const allowed = ['Registrar', 'Regulator'].includes(role)

  if (!allowed) {
    return (
      <div style={{ maxWidth: 760, margin: '40px auto', padding: '0 20px' }}>
        <h1 style={{ fontSize: 24, fontWeight: 800, color: '#111827' }}>Operations</h1>
        <p style={{ fontSize: 14, color: C.mut }}>
          This view is for Registrars and Regulators. You are signed in as {role || 'a guest'}.
          {' '}<Link to="/dashboard" style={{ color: C.navy }}>Go to your dashboard</Link>.
        </p>
      </div>
    )
  }

  const q = (data && data.queues) || {}
  const rail = (data && data.rail) || {}

  return (
    <div style={{ maxWidth: 980, margin: '0 auto', padding: '28px 20px 60px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 6 }}>
        <div>
          <h1 style={{ fontSize: 26, fontWeight: 800, color: '#111827', margin: 0 }}>Operations</h1>
          <p style={{ fontSize: 13.5, color: C.mut, margin: '4px 0 0' }}>
            {data
              ? data.actionable === 0
                ? 'Nothing is waiting on a human right now.'
                : `${data.actionable} item${data.actionable === 1 ? '' : 's'} need attention.`
              : 'Loading the queues…'}
          </p>
        </div>
        <button
          onClick={load} disabled={loading}
          style={{
            border: `1px solid ${C.line}`, background: '#fff', borderRadius: 8,
            padding: '7px 13px', fontSize: 13, cursor: loading ? 'default' : 'pointer',
          }}>
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {err && (
        <div style={{ background: '#FEF2F2', border: '1px solid #FECACA', color: C.bad,
          borderRadius: 10, padding: '10px 14px', fontSize: 13, margin: '12px 0' }}>
          {err}
        </div>
      )}

      {data && (
        <>
          <Card
            title="Titles awaiting validation"
            sub="A registrar has to approve or reject each of these before any tokens can exist."
            count={(q.awaitingValidation || []).length}
            tone="warn">
            {(q.awaitingValidation || []).length === 0
              ? <Empty>No title is waiting.</Empty>
              : q.awaitingValidation.map(p => (
                <Row key={p.assetId}>
                  <span>
                    <strong>{p.title || p.assetId}</strong>
                    <span style={{ color: C.mut }}> · {p.owner} · waiting {age(p.ageMins)}</span>
                  </span>
                  <Link to="/admin" style={{ color: C.navy, fontWeight: 600 }}>Review</Link>
                </Row>
              ))}
          </Card>

          <Card
            title="Validated but not tokenised"
            sub="The title passed validation and the owner has not minted. Nothing is wrong — it is just unfinished."
            count={(q.validatedNotMinted || []).length}>
            {(q.validatedNotMinted || []).length === 0
              ? <Empty>Nothing pending.</Empty>
              : q.validatedNotMinted.map(p => (
                <Row key={p.assetId}>
                  <span><strong>{p.title || p.assetId}</strong>
                    <span style={{ color: C.mut }}> · {p.owner} · {age(p.ageMins)} since approval</span></span>
                </Row>
              ))}
          </Card>

          <Card
            title="Payments confirmed but not released"
            sub="The money moved and the tokens did not. This is the queue worth watching."
            count={(q.stuckPayments || []).length}
            tone="bad">
            {(q.stuckPayments || []).length === 0
              ? <Empty>Every confirmed payment has been released.</Empty>
              : q.stuckPayments.map(p => (
                <Row key={p.paymentId}>
                  <span>
                    <code style={{ color: C.navy }}>{p.paymentId.slice(0, 18)}</code>
                    <span style={{ color: C.mut }}> · {p.payerId} · {money(p.amountINR)} for {p.tokenAmount} tokens · stuck {age(p.ageMins)}</span>
                  </span>
                </Row>
              ))}
          </Card>

          <Card
            title="Settlements that failed for want of cash"
            sub="The rail refused these because the buyer's wallet was short. Both legs rolled back, so topping up and retrying is safe. Grouped by wallet — repeated attempts by one buyer are one job, not many."
            count={(rail.recoverable || []).length}
            tone="warn">
            {!rail.reachable
              ? <p style={{ fontSize: 13, color: C.bad, margin: 0 }}>
                  The settlement rail is unreachable, so this queue is unknown. Everything above is unaffected.
                </p>
              : (rail.recoverable || []).length === 0
                ? <Empty>No recoverable settlement failures.</Empty>
                : rail.recoverable.map(r => (
                  <Row key={r.buyer}>
                    <span>
                      <strong>{r.buyer}</strong>
                      <span style={{ color: C.mut }}>
                        {' '}short {money(r.largestShortfallINR)}
                        {r.instructions > 1 && ` · ${r.instructions} attempts`}
                        {' · '}{r.assets.length === 1 ? r.assets[0] : `${r.assets.length} assets`}
                      </span>
                    </span>
                    <Link to="/umi" style={{ color: C.navy, fontWeight: 600 }}>Settle</Link>
                  </Row>
                ))}
          </Card>

          <Card
            title="Frozen assets"
            sub="Transfers are halted on these until a regulator lifts the freeze."
            count={(q.frozen || []).length}
            tone="bad">
            {(q.frozen || []).length === 0
              ? <Empty>No asset is frozen.</Empty>
              : q.frozen.map(p => (
                <Row key={p.assetId}>
                  <span><strong>{p.title || p.assetId}</strong>
                    <span style={{ color: C.mut }}> · frozen {age(p.ageMins)} ago</span></span>
                  <Link to="/regulator" style={{ color: C.navy, fontWeight: 600 }}>Open</Link>
                </Row>
              ))}
          </Card>

          <section style={{
            background: '#fff', border: `1px solid ${C.line}`, borderRadius: 12,
            padding: '14px 18px', fontSize: 13, color: C.mut,
            display: 'flex', gap: 24, flexWrap: 'wrap',
          }}>
            <span>Ledger <strong style={{ color: data.chain.valid ? C.ok : C.bad }}>
              {data.chain.valid ? 'verified' : 'TAMPERED'}</strong> · {data.chain.blocks} blocks</span>
            <span>Rail <strong style={{ color: rail.reachable ? C.ok : C.bad }}>
              {rail.reachable ? 'reachable' : 'down'}</strong>
              {rail.reachable && ` · ${rail.settled} settled, ${rail.failed} failed`}</span>
            <span>Pending KYC <strong>{(q.pendingKyc || []).length}</strong></span>
            <span>Expired payment requests <strong>{(q.expiredPending || []).length}</strong></span>
          </section>
        </>
      )}
    </div>
  )
}
