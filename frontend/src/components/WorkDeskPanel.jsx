// Work orders — escrowed property upkeep, paid against delivered evidence.
//
// A tokenised building still needs inspecting, repairing and revaluing, and
// until now that cost sat outside the model entirely. This panel drives the Go
// work desk (/api/umi/work/*): the fee is reserved on the funder's e₹-W wallet
// when the order is funded, and it only moves when an anchored deliverable is
// accepted.
//
// All logic is in Go (drunix-gateway/work.go). This is a thin client.

import React, { useCallback, useEffect, useState } from 'react'
import { umiFetch, umiPost, explainRail } from '../lib/umiFetch'

const C = {
  navy: '#1E3A5F', line: '#E5E7EB', mut: '#6B7280',
  ok: '#047857', okBg: '#ECFDF5', okLine: '#A7F3D0',
  bad: '#B91C1C', badBg: '#FEF2F2', badLine: '#FECACA',
  warn: '#B45309', warnBg: '#FFFBEB', warnLine: '#FDE68A',
}

const money = (n) => '₹' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })
const input = { padding: '8px 10px', border: `1px solid ${C.line}`, borderRadius: 8, fontSize: 13, width: '100%' }

const STATUS_TONE = {
  CREATED: 'mut', FUNDED: 'warn', ASSIGNED: 'warn', SUBMITTED: 'warn',
  ACCEPTED: 'ok', DISPUTED: 'bad', REFUNDED: 'mut', CANCELLED: 'mut',
}

// What the money is doing in each state, in words rather than a status badge.
const ESCROW_NOTE = {
  CREATED: 'nothing is held yet',
  FUNDED: 'the fee is reserved and cannot be spent elsewhere',
  ASSIGNED: 'the fee is reserved against this worker',
  SUBMITTED: 'the fee is reserved; the deliverable is anchored and waiting on you',
  ACCEPTED: 'paid to the worker in the same block that carries the deliverable hash',
  DISPUTED: 'frozen until someone resolves it',
  REFUNDED: 'returned to the funder',
  CANCELLED: 'never left the funder',
}

function Tag({ tone = 'mut', children }) {
  const map = {
    ok: { c: C.ok, bg: C.okBg, b: C.okLine }, bad: { c: C.bad, bg: C.badBg, b: C.badLine },
    warn: { c: C.warn, bg: C.warnBg, b: C.warnLine }, mut: { c: C.mut, bg: '#F9FAFB', b: C.line },
  }[tone] || { c: C.mut, bg: '#F9FAFB', b: C.line }
  return <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: .3, color: map.c, background: map.bg, border: `1px solid ${map.b}`, borderRadius: 999, padding: '2px 9px', whiteSpace: 'nowrap' }}>{children}</span>
}

export default function WorkDeskPanel({ properties = [], participants = [], propLabel = (x) => x }) {
  const [orders, setOrders] = useState([])
  const [summary, setSummary] = useState(null)
  const [provider, setProvider] = useState(null)
  const [flash, setFlash] = useState(null)
  const [busy, setBusy] = useState(false)
  const [unavailable, setUnavailable] = useState(false)
  const [open, setOpen] = useState(false)

  const [assetId, setAssetId] = useState('')
  const [title, setTitle] = useState('Annual structural inspection')
  const [category, setCategory] = useState('INSPECTION')
  const [fee, setFee] = useState(9000)
  const [spec, setSpec] = useState('Walk every floor, photograph any damp, report in a signed PDF.')
  const [criteria, setCriteria] = useState('photographs of every floor\nsigned PDF report')

  const refresh = useCallback(async () => {
    const [list, prov] = await Promise.all([umiFetch('/work'), umiFetch('/work/provider')])
    if (list.status === 404 || prov.status === 404) { setUnavailable(true); return }
    setUnavailable(false)
    if (list.ok) { setOrders(list.data.orders || []); setSummary(list.data.summary || null) }
    if (prov.ok) setProvider(prov.data)
  }, [])

  useEffect(() => { refresh() }, [refresh])
  useEffect(() => { if (!assetId && properties.length) setAssetId(properties[0].assetId) }, [properties, assetId])

  if (unavailable) return null

  const act = async (fn, okMsg) => {
    setBusy(true); setFlash(null)
    try {
      const res = await fn()
      if (res.ok) setFlash({ kind: 'ok', text: typeof okMsg === 'function' ? okMsg(res.data) : okMsg })
      else setFlash({ kind: 'err', text: explainRail(res.data) })
      await refresh()
    } catch (e) {
      setFlash({ kind: 'err', text: e.message })
    } finally { setBusy(false) }
  }

  const create = () => act(
    () => umiPost('/work', {
      assetId, title, category, spec, feeINR: Number(fee),
      acceptanceCriteria: criteria.split('\n').map(s => s.trim()).filter(Boolean),
    }),
    (d) => `Work order ${d.order.orderId} opened. No money is held until you fund it.`)

  const fund = (id) => act(() => umiPost(`/work/${id}/fund`),
    (d) => `${money(d.order.feeINR)} reserved on the funder's e₹-W wallet and held against delivery.`)

  const assign = (id, worker) => worker && act(() => umiPost(`/work/${id}/assign`, { worker }),
    (d) => `${d.order.worker} is now engaged on ${d.order.orderId}.`)

  const accept = (id) => act(() => umiPost(`/work/${id}/accept`),
    (d) => `Accepted — ${money(d.order.feeINR)} released to ${d.order.worker}, committed as block #${d.order.blockHeight}.`)

  const dispute = (id) => {
    const reason = window.prompt('What is wrong with the delivery?')
    if (reason) act(() => umiPost(`/work/${id}/dispute`, { reason }), 'Disputed. The escrow stays frozen until it is resolved.')
  }

  const refund = (id) => {
    const reason = window.prompt('Why is this being refunded?') || 'no reason given'
    act(() => umiPost(`/work/${id}/refund`, { reason }),
      (d) => `${money(d.order.feeINR)} released back to ${d.order.funder}.`)
  }

  const live = provider && provider.mode === 'live'

  return (
    <section style={{ background: 'white', border: `1px solid ${C.line}`, borderRadius: 14, padding: 18, marginBottom: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h2 style={{ margin: 0, fontFamily: 'Fraunces, Georgia, serif', fontSize: 18, color: C.navy }}>
            8 · Work orders: upkeep paid on delivery
          </h2>
          <p style={{ margin: '4px 0 0', fontSize: 12.5, color: C.mut, maxWidth: 760 }}>
            A tokenised building still has to be inspected, repaired and revalued. The fee is reserved on the
            funder's e₹-W wallet when the order is funded, and it moves to the worker in the same step that
            anchors the deliverable's hash to the ledger — the same delivery-versus-payment discipline as a trade,
            with a report in place of a security.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <Tag tone={live ? 'ok' : 'warn'}>{live ? 'Talent provider live' : 'Talent provider simulated'}</Tag>
          <Tag>Go · work.go</Tag>
        </div>
      </div>

      {summary && (
        <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', marginTop: 14, fontSize: 13 }}>
          <div><strong style={{ color: C.navy }}>{summary.orders}</strong> <span style={{ color: C.mut }}>order(s)</span></div>
          <div><strong style={{ color: C.warn }}>{money(summary.inEscrowINR)}</strong> <span style={{ color: C.mut }}>held in escrow</span></div>
          <div><strong style={{ color: C.ok }}>{money(summary.paidOutINR)}</strong> <span style={{ color: C.mut }}>paid out on accepted work</span></div>
        </div>
      )}

      {provider && (
        <p style={{ fontSize: 12, color: C.mut, marginTop: 10, marginBottom: 0 }}>
          {live
            ? 'Orders are published to the partner platform and workers come back with a provider reference.'
            : 'The partner link is not configured, so the roster below is a local simulation. Setting WORK_PROVIDER_URL and WORK_PROVIDER_KEY turns the same code live — no other change.'}
        </p>
      )}

      <button onClick={() => setOpen(o => !o)}
        style={{ marginTop: 12, padding: '8px 14px', borderRadius: 9, border: `1px solid ${C.line}`, background: 'white', color: C.navy, fontWeight: 600, fontSize: 13, cursor: 'pointer' }}>
        {open ? 'Close' : 'Open a work order'}
      </button>

      {open && (
        <div style={{ marginTop: 14, display: 'grid', gap: 10, gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))' }}>
          <label style={{ display: 'block' }}>
            <span style={{ display: 'block', fontSize: 11.5, fontWeight: 700, color: C.navy, marginBottom: 4 }}>Property</span>
            {properties.length
              ? <select style={input} value={assetId} onChange={e => setAssetId(e.target.value)}>
                  {properties.map(p => <option key={p.assetId} value={p.assetId}>{propLabel(p.assetId)}</option>)}
                </select>
              : <input style={input} value={assetId} onChange={e => setAssetId(e.target.value)} />}
          </label>
          <label style={{ display: 'block' }}>
            <span style={{ display: 'block', fontSize: 11.5, fontWeight: 700, color: C.navy, marginBottom: 4 }}>What needs doing</span>
            <input style={input} value={title} onChange={e => setTitle(e.target.value)} />
          </label>
          <label style={{ display: 'block' }}>
            <span style={{ display: 'block', fontSize: 11.5, fontWeight: 700, color: C.navy, marginBottom: 4 }}>Kind of work</span>
            <select style={input} value={category} onChange={e => setCategory(e.target.value)}>
              {(summary?.categories || ['INSPECTION']).map(c => <option key={c} value={c}>{c.replace(/_/g, ' ').toLowerCase()}</option>)}
            </select>
          </label>
          <label style={{ display: 'block' }}>
            <span style={{ display: 'block', fontSize: 11.5, fontWeight: 700, color: C.navy, marginBottom: 4 }}>Fee (₹)</span>
            <input style={input} type="number" value={fee} onChange={e => setFee(e.target.value)} />
          </label>
          <label style={{ display: 'block', gridColumn: '1 / -1' }}>
            <span style={{ display: 'block', fontSize: 11.5, fontWeight: 700, color: C.navy, marginBottom: 4 }}>Specification</span>
            <textarea style={{ ...input, minHeight: 56 }} value={spec} onChange={e => setSpec(e.target.value)} />
          </label>
          <label style={{ display: 'block', gridColumn: '1 / -1' }}>
            <span style={{ display: 'block', fontSize: 11.5, fontWeight: 700, color: C.navy, marginBottom: 4 }}>Acceptance criteria — one per line</span>
            <textarea style={{ ...input, minHeight: 56 }} value={criteria} onChange={e => setCriteria(e.target.value)} />
            <span style={{ display: 'block', fontSize: 11, color: C.mut, marginTop: 3 }}>
              These travel with the order to the worker and are what acceptance is judged against.
            </span>
          </label>
          <div style={{ gridColumn: '1 / -1' }}>
            <button onClick={create} disabled={busy || !assetId || !title.trim()}
              style={{ padding: '10px 16px', borderRadius: 10, border: 'none', background: (!assetId || !title.trim()) ? '#9CA3AF' : C.navy, color: 'white', fontWeight: 600, fontSize: 13.5, cursor: busy ? 'wait' : 'pointer' }}>
              {busy ? 'Working…' : 'Open the order'}
            </button>
          </div>
        </div>
      )}

      {flash && (
        <div role="status" aria-live="polite" style={{
          marginTop: 12, padding: '10px 12px', borderRadius: 10, fontSize: 13,
          background: flash.kind === 'ok' ? C.okBg : C.badBg,
          border: `1px solid ${flash.kind === 'ok' ? C.okLine : C.badLine}`,
          color: flash.kind === 'ok' ? C.ok : C.bad,
        }}>{flash.text}</div>
      )}

      {orders.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <div style={{ fontSize: 11, color: C.mut, textTransform: 'uppercase', letterSpacing: .4, marginBottom: 6 }}>
            The desk
          </div>
          {orders.map(o => (
            <div key={o.orderId} style={{ border: `1px solid ${C.line}`, borderRadius: 10, padding: 12, marginBottom: 8 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
                <strong style={{ color: C.navy, fontSize: 13.5 }}>{o.title}</strong>
                <div style={{ display: 'flex', gap: 6 }}>
                  <Tag tone={STATUS_TONE[o.status]}>{o.status}</Tag>
                  <Tag>{money(o.feeINR)}</Tag>
                </div>
              </div>
              <div style={{ fontSize: 12, color: C.mut, marginTop: 4 }}>
                {propLabel(o.assetId)} · {o.category.replace(/_/g, ' ').toLowerCase()} · funded by {o.funder}
                {o.worker ? ` · delivered by ${o.worker}` : ' · nobody engaged yet'}
              </div>
              <div style={{ fontSize: 12, color: o.escrowed ? C.warn : C.mut, marginTop: 4 }}>
                Money: {ESCROW_NOTE[o.status] || '—'}
              </div>
              {o.deliverableHash && (
                <div style={{ fontSize: 11.5, color: C.mut, marginTop: 4, wordBreak: 'break-all' }}>
                  Deliverable hash {o.deliverableHash}
                  {o.blockHeight ? ` · block #${o.blockHeight}` : ''}
                </div>
              )}
              <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
                {o.status === 'CREATED' && (
                  <button onClick={() => fund(o.orderId)} disabled={busy} style={{ padding: '7px 12px', borderRadius: 8, border: 'none', background: C.navy, color: 'white', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}>
                    Reserve {money(o.feeINR)}
                  </button>
                )}
                {o.status === 'FUNDED' && (provider?.roster || []).length > 0 && (
                  <select defaultValue="" onChange={e => assign(o.orderId, e.target.value)} disabled={busy}
                    style={{ ...input, width: 'auto', fontSize: 12.5 }}>
                    <option value="">Engage a worker…</option>
                    {(provider.roster || []).map(w => (
                      <option key={w.workerId} value={w.workerId}>{w.name} — {w.city}, {w.rating}★</option>
                    ))}
                    {participants.filter(p => p !== o.funder).map(p => <option key={p} value={p}>{p}</option>)}
                  </select>
                )}
                {o.status === 'SUBMITTED' && (
                  <>
                    <button onClick={() => accept(o.orderId)} disabled={busy} style={{ padding: '7px 12px', borderRadius: 8, border: 'none', background: C.ok, color: 'white', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}>
                      Accept and release {money(o.feeINR)}
                    </button>
                    <button onClick={() => dispute(o.orderId)} disabled={busy} style={{ padding: '7px 12px', borderRadius: 8, border: `1px solid ${C.badLine}`, background: 'white', color: C.bad, fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}>
                      Dispute
                    </button>
                  </>
                )}
                {['FUNDED', 'ASSIGNED', 'DISPUTED'].includes(o.status) && (
                  <button onClick={() => refund(o.orderId)} disabled={busy} style={{ padding: '7px 12px', borderRadius: 8, border: `1px solid ${C.line}`, background: 'white', color: C.navy, fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}>
                    Refund the escrow
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
