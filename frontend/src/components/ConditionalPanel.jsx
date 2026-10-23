// Conditional settlement: cash locked against a named credential.
//
// A DvP settles when both parties are ready. Most real property deals are not
// like that: the buyer is ready, the seller is waiting on a registrar. This
// panel drives the Go condition desk (/api/umi/conditions/*). The buyer's
// money is reserved on the buyer's own wallet, and it moves only when the
// credential the agreement named is presented by the party entitled to assert
// it. Otherwise the deadline gives it back.
//
// All logic is in Go (drunix-gateway/conditional.go). This is a thin client.

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

const STATUS_TONE = { OPEN: 'warn', RELEASED: 'ok', REFUNDED: 'mut', EXPIRED: 'mut' }

// What the money is doing, in words rather than a status badge.
const CASH_NOTE = {
  OPEN: 'reserved on the buyer\'s wallet: spendable by nobody, owned by the buyer',
  RELEASED: 'paid to the seller in the same step the tokens moved',
  REFUNDED: 'unreserved and back with the buyer',
  EXPIRED: 'the deadline passed, so it was unreserved automatically',
}

const when = (iso) => {
  if (!iso) return ''
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })
}

function Tag({ tone = 'mut', children }) {
  const map = {
    ok: { c: C.ok, bg: C.okBg, b: C.okLine }, bad: { c: C.bad, bg: C.badBg, b: C.badLine },
    warn: { c: C.warn, bg: C.warnBg, b: C.warnLine }, mut: { c: C.mut, bg: '#F9FAFB', b: C.line },
  }[tone] || { c: C.mut, bg: '#F9FAFB', b: C.line }
  return <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: .3, color: map.c, background: map.bg, border: `1px solid ${map.b}`, borderRadius: 999, padding: '2px 9px', whiteSpace: 'nowrap' }}>{children}</span>
}

export default function ConditionalPanel({ properties = [], participants = [], propLabel = (x) => x }) {
  const [conditions, setConditions] = useState([])
  const [summary, setSummary] = useState(null)
  const [credentials, setCredentials] = useState([])
  const [flash, setFlash] = useState(null)
  const [busy, setBusy] = useState(false)
  const [unavailable, setUnavailable] = useState(false)
  const [open, setOpen] = useState(false)

  const [assetId, setAssetId] = useState('')
  const [seller, setSeller] = useState('originator1')
  const [tokens, setTokens] = useState(10)
  const [price, setPrice] = useState(500)
  const [credentialType, setCredentialType] = useState('TitleValidationCredential')
  const [issuer, setIssuer] = useState('registrar1')
  const [window_, setWindow] = useState('24h')

  const refresh = useCallback(async () => {
    const list = await umiFetch('/conditions')
    if (list.status === 404) { setUnavailable(true); return }
    setUnavailable(false)
    if (list.ok) { setConditions(list.data.conditions || []); setSummary(list.data.summary || null) }
  }, [])

  useEffect(() => { refresh() }, [refresh])
  useEffect(() => { if (!assetId && properties.length) setAssetId(properties[0].assetId) }, [properties, assetId])
  useEffect(() => {
    let live = true
    if (!assetId) return undefined
    umiFetch('/credentials?assetId=' + encodeURIComponent(assetId)).then((r) => {
      if (live && r.ok) setCredentials(r.data.credentials || [])
    })
    return () => { live = false }
  }, [assetId, conditions])

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
    () => umiPost('/conditions', {
      assetId, seller, tokens: Number(tokens), pricePerTokenINR: Number(price),
      credentialType, issuer: issuer.trim(), window: window_,
    }),
    (d) => `${money(d.condition.cashINR)} reserved on your wallet until ${issuer || 'an issuer'} produces a ${credentialType}. Nothing has settled.`)

  const present = (id, credentialId) => credentialId && act(
    () => umiPost(`/conditions/${id}/present`, { credentialId }),
    (d) => d.condition.settlementNote || 'Released.')

  const cancel = (id) => act(() => umiPost(`/conditions/${id}/cancel`, {}),
    (d) => `Cancelled. ${money(d.condition.cashINR)} is unreserved and back with ${d.condition.buyer}.`)

  const candidates = (c) => credentials.filter((x) => !c.assetId || x.assetId === c.assetId)

  return (
    <section style={{ background: 'white', border: `1px solid ${C.line}`, borderRadius: 14, padding: 18, marginBottom: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h2 style={{ margin: 0, fontFamily: 'Fraunces, Georgia, serif', fontSize: 18, color: C.navy }}>
            13 · Conditional settlement: money that waits for a fact
          </h2>
          <p style={{ margin: '4px 0 0', fontSize: 12.5, color: C.mut, maxWidth: 760 }}>
            An atomic DvP needs both sides ready at the same instant. A property deal rarely is: the buyer is
            ready, the seller is waiting on a registrar. Here the buyer's cash is reserved on the buyer's own
            wallet against a named credential. When that credential is presented by the party entitled to
            assert it, the tokens and the cash move in one step. If it never arrives, the deadline unreserves
            the money without anyone having to ask.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <Tag>Go · conditional.go</Tag>
        </div>
      </div>

      {summary && (
        <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', marginTop: 14, fontSize: 13 }}>
          <div><strong style={{ color: C.warn }}>{money(summary.lockedINR)}</strong> <span style={{ color: C.mut }}>waiting on a condition</span></div>
          <div><strong style={{ color: C.navy }}>{summary.open}</strong> <span style={{ color: C.mut }}>open</span></div>
          <div><strong style={{ color: C.ok }}>{summary.released}</strong> <span style={{ color: C.mut }}>released on evidence</span></div>
          <div><strong style={{ color: C.mut }}>{(summary.refunded || 0) + (summary.expired || 0)}</strong> <span style={{ color: C.mut }}>given back</span></div>
          <div><strong style={{ color: C.mut }}>{summary.refusals}</strong> <span style={{ color: C.mut }}>presentations refused</span></div>
        </div>
      )}

      {summary && summary.conservation && (
        <p style={{ fontSize: 12, color: C.mut, marginTop: 10, marginBottom: 0 }}>{summary.conservation}</p>
      )}

      <button onClick={() => setOpen(o => !o)}
        style={{ marginTop: 12, padding: '8px 14px', borderRadius: 9, border: `1px solid ${C.line}`, background: 'white', color: C.navy, fontWeight: 600, fontSize: 13, cursor: 'pointer' }}>
        {open ? 'Close' : 'Agree a conditional purchase'}
      </button>

      {open && (
        <div style={{ marginTop: 14, display: 'grid', gap: 10, gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))' }}>
          <label style={{ display: 'block' }}>
            <span style={{ display: 'block', fontSize: 11.5, fontWeight: 700, color: C.navy, marginBottom: 4 }}>Property</span>
            {properties.length
              ? <select style={input} value={assetId} onChange={e => setAssetId(e.target.value)}>
                  {properties.map(p => <option key={p.assetId} value={p.assetId}>{propLabel(p.assetId)}</option>)}
                </select>
              : <input style={input} value={assetId} onChange={e => setAssetId(e.target.value)} />}
          </label>
          <label style={{ display: 'block' }}>
            <span style={{ display: 'block', fontSize: 11.5, fontWeight: 700, color: C.navy, marginBottom: 4 }}>Seller</span>
            {participants.length
              ? <select style={input} value={seller} onChange={e => setSeller(e.target.value)}>
                  {participants.map(p => <option key={p} value={p}>{p}</option>)}
                </select>
              : <input style={input} value={seller} onChange={e => setSeller(e.target.value)} />}
          </label>
          <label style={{ display: 'block' }}>
            <span style={{ display: 'block', fontSize: 11.5, fontWeight: 700, color: C.navy, marginBottom: 4 }}>Tokens</span>
            <input style={input} type="number" value={tokens} onChange={e => setTokens(e.target.value)} />
          </label>
          <label style={{ display: 'block' }}>
            <span style={{ display: 'block', fontSize: 11.5, fontWeight: 700, color: C.navy, marginBottom: 4 }}>Price per token (₹)</span>
            <input style={input} type="number" value={price} onChange={e => setPrice(e.target.value)} />
          </label>
          <label style={{ display: 'block' }}>
            <span style={{ display: 'block', fontSize: 11.5, fontWeight: 700, color: C.navy, marginBottom: 4 }}>Release when this is produced</span>
            <select style={input} value={credentialType} onChange={e => setCredentialType(e.target.value)}>
              <option value="TitleValidationCredential">a registrar's title validation</option>
              <option value="KYCStatusCredential">a KYC status credential</option>
            </select>
          </label>
          <label style={{ display: 'block' }}>
            <span style={{ display: 'block', fontSize: 11.5, fontWeight: 700, color: C.navy, marginBottom: 4 }}>Issued by (blank accepts any issuer)</span>
            <input style={input} value={issuer} onChange={e => setIssuer(e.target.value)} placeholder="registrar1" />
          </label>
          <label style={{ display: 'block' }}>
            <span style={{ display: 'block', fontSize: 11.5, fontWeight: 700, color: C.navy, marginBottom: 4 }}>Give them until</span>
            <select style={input} value={window_} onChange={e => setWindow(e.target.value)}>
              <option value="1h">1 hour from now</option>
              <option value="24h">24 hours from now</option>
              <option value="168h">7 days from now</option>
              <option value="720h">30 days from now</option>
            </select>
          </label>
          <div style={{ gridColumn: '1 / -1' }}>
            <button onClick={create} disabled={busy || !assetId || !seller || Number(tokens) <= 0}
              style={{ padding: '10px 16px', borderRadius: 10, border: 'none', background: (!assetId || !seller) ? '#9CA3AF' : C.navy, color: 'white', fontWeight: 600, fontSize: 13.5, cursor: busy ? 'wait' : 'pointer' }}>
              {busy ? 'Working…' : `Reserve ${money(Number(tokens) * Number(price))} against the condition`}
            </button>
            <span style={{ display: 'block', fontSize: 11.5, color: C.mut, marginTop: 6 }}>
              The money stays yours and stays in your wallet. It simply cannot be spent twice while the seller
              is proving their side.
            </span>
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

      {conditions.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <div style={{ fontSize: 11, color: C.mut, textTransform: 'uppercase', letterSpacing: .4, marginBottom: 6 }}>
            Conditional agreements
          </div>
          {conditions.map(c => (
            <div key={c.conditionId} style={{ border: `1px solid ${C.line}`, borderRadius: 10, padding: 12, marginBottom: 8 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
                <strong style={{ color: C.navy, fontSize: 13.5 }}>
                  {c.tokens} token(s) of {propLabel(c.assetId)} for {money(c.cashINR)}
                </strong>
                <div style={{ display: 'flex', gap: 6 }}>
                  <Tag tone={STATUS_TONE[c.status]}>{c.status}</Tag>
                  {c.openedBlock ? <Tag>block #{c.openedBlock}</Tag> : null}
                </div>
              </div>
              <div style={{ fontSize: 12, color: C.mut, marginTop: 4 }}>
                {c.buyer} buys from {c.seller} · releases on a {c.credentialType}
                {c.issuer ? ` issued by ${c.issuer}` : ' from any issuer'} · {c.asserter} presents it
              </div>
              <div style={{ fontSize: 12, color: c.status === 'OPEN' ? C.warn : C.mut, marginTop: 4 }}>
                Money: {CASH_NOTE[c.status] || 'not held'}
                {c.status === 'OPEN' && c.deadlineAt ? ` · returns by itself at ${when(c.deadlineAt)}` : ''}
              </div>
              {c.settlementNote && (
                <div style={{ fontSize: 12, color: C.ok, marginTop: 4 }}>{c.settlementNote}</div>
              )}
              {c.refusals > 0 && (
                <div style={{ fontSize: 11.5, color: C.mut, marginTop: 4 }}>
                  {c.refusals} presentation(s) refused{c.lastRefusal ? `, last: ${c.lastRefusal}` : ''}
                </div>
              )}
              {c.status === 'OPEN' && (
                <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap', alignItems: 'center' }}>
                  {candidates(c).length > 0 ? (
                    <select defaultValue="" onChange={e => present(c.conditionId, e.target.value)} disabled={busy}
                      style={{ ...input, width: 'auto', fontSize: 12.5 }}>
                      <option value="">Present a credential…</option>
                      {candidates(c).map(x => (
                        <option key={x.id || x.credentialId} value={x.id || x.credentialId}>
                          {(x.type || x.credentialType || 'credential')} &middot; {(x.id || x.credentialId || '').slice(-12)}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <span style={{ fontSize: 12, color: C.mut }}>
                      No credential of that kind exists for this property yet, so there is nothing to present.
                    </span>
                  )}
                  <button onClick={() => cancel(c.conditionId)} disabled={busy}
                    style={{ padding: '7px 12px', borderRadius: 8, border: `1px solid ${C.line}`, background: 'white', color: C.navy, fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}>
                    Cancel and unreserve
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <p style={{ fontSize: 11.5, color: C.mut, marginTop: 14, marginBottom: 0 }}>
        Boundary: the cash leg is simulated wholesale e₹, and the credential is one this deployment issued: a
        registrar's signature here is not a government record. What is real is the mechanism: the reservation,
        the verification of the signature against its anchor, the refusal, and the deadline.
      </p>
    </section>
  )
}
