// Private operator insights.
//
// Not linked from anywhere in the app and not part of the investor experience:
// you reach it at /insights and unlock it with the admin key. The key is held
// in sessionStorage only (gone when the tab closes) and sent as a header — it
// is never placed in the URL, where it would leak through browser history,
// server logs and Referer headers.

import React, { useCallback, useEffect, useState } from 'react'

const money = n => '₹' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })
const pct = n => `${Number(n || 0).toFixed(1)}%`
const card = { background: 'white', border: '1px solid #E5E7EB', borderRadius: 12, padding: 18, minWidth: 0 }
const KEY_STORE = 'aasthi_admin_key'

function Metric({ label, value, sub, color }) {
  return (
    <div style={card}>
      <div style={{ fontSize: 10, color: '#9CA3AF', textTransform: 'uppercase', fontWeight: 700, letterSpacing: '0.08em' }}>{label}</div>
      <div style={{ fontSize: 23, fontWeight: 800, color: color || '#111827', marginTop: 5, overflowWrap: 'anywhere' }}>{value}</div>
      {sub && <div style={{ fontSize: 11.5, color: '#6B7280', marginTop: 3 }}>{sub}</div>}
    </div>
  )
}

function Bars({ series }) {
  const max = Math.max(1, ...series.map(d => Math.max(d.blocks, d.settlements)))
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 4, height: 110, marginTop: 12 }}>
      {series.map(d => (
        <div key={d.date} style={{ flex: 1, textAlign: 'center', minWidth: 0 }} title={`${d.date} · ${d.blocks} blocks · ${d.settlements} settlements`}>
          <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'center', gap: 2, height: 86 }}>
            <div style={{ width: '42%', height: `${(d.blocks / max) * 100}%`, background: '#1E3A5F', borderRadius: '3px 3px 0 0', minHeight: d.blocks ? 2 : 0 }} />
            <div style={{ width: '42%', height: `${(d.settlements / max) * 100}%`, background: '#6D28D9', borderRadius: '3px 3px 0 0', minHeight: d.settlements ? 2 : 0 }} />
          </div>
          <div style={{ fontSize: 8.5, color: '#9CA3AF', marginTop: 4 }}>{d.date.slice(8)}</div>
        </div>
      ))}
    </div>
  )
}

export default function Insights() {
  const [key, setKey] = useState(() => {
    try { return sessionStorage.getItem(KEY_STORE) || '' } catch { return '' }
  })
  const [input, setInput] = useState('')
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [enabled, setEnabled] = useState(true)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    fetch('/api/admin/insights/status')
      .then(r => r.json()).then(d => setEnabled(!!d.enabled)).catch(() => {})
  }, [])

  const load = useCallback(async (k) => {
    if (!k) return
    setBusy(true); setError('')
    try {
      const r = await fetch('/api/admin/insights', { headers: { 'x-admin-key': k } })
      const d = await r.json()
      if (!r.ok) {
        setError(d.message || d.error || 'Request failed')
        if (r.status === 401) { setData(null); setKey(''); try { sessionStorage.removeItem(KEY_STORE) } catch {} }
        return
      }
      setData(d)
    } catch (e) {
      setError('Could not reach the server: ' + e.message)
    } finally { setBusy(false) }
  }, [])

  useEffect(() => { if (key) load(key) }, [key, load])

  const unlock = e => {
    e.preventDefault()
    const k = input.trim()
    if (!k) return
    try { sessionStorage.setItem(KEY_STORE, k) } catch {}
    setKey(k); setInput('')
  }

  const lock = () => {
    try { sessionStorage.removeItem(KEY_STORE) } catch {}
    setKey(''); setData(null)
  }

  if (!key || !data) {
    return (
      <div style={{ maxWidth: 420, margin: '0 auto', padding: '64px 16px' }}>
        <div style={card}>
          <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '0.12em', color: '#9CA3AF', textTransform: 'uppercase' }}>Private</div>
          <h1 style={{ fontSize: 20, fontWeight: 800, color: '#111827', margin: '6px 0 4px' }}>Operator insights</h1>
          <p style={{ fontSize: 12.5, color: '#6B7280', lineHeight: 1.6 }}>
            {enabled
              ? 'Enter your admin key. It is kept in this tab only and sent as a header, never in the URL.'
              : 'This dashboard is disabled because ADMIN_DASHBOARD_KEY is not set on the server. Set it and reload.'}
          </p>
          {enabled && (
            <form onSubmit={unlock} style={{ marginTop: 12 }}>
              <input
                type="password" value={input} onChange={e => setInput(e.target.value)}
                placeholder="Admin key" autoFocus
                style={{ width: '100%', padding: '10px 12px', border: '1px solid #E5E7EB', borderRadius: 8, fontSize: 13, boxSizing: 'border-box' }}
              />
              <button type="submit" disabled={busy} style={{
                marginTop: 10, width: '100%', padding: '10px 14px', background: '#1E3A5F', color: 'white',
                border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer'
              }}>{busy ? 'Checking…' : 'Unlock'}</button>
            </form>
          )}
          {error && (
            <div style={{ marginTop: 10, padding: '9px 12px', borderRadius: 8, background: '#FEF2F2', border: '1px solid #FECACA', color: '#991B1B', fontSize: 12 }}>
              {error}
            </div>
          )}
        </div>
      </div>
    )
  }

  const s = data.settlement || {}
  const p = data.portfolio || {}
  const l = data.ledger || {}

  return (
    <div style={{ maxWidth: 1040, margin: '0 auto', padding: '24px 16px 60px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '0.12em', color: '#9CA3AF', textTransform: 'uppercase' }}>Private · operator only</div>
          <h1 style={{ fontSize: 26, fontWeight: 800, color: '#111827', margin: '6px 0 4px' }}>Insights</h1>
          <p style={{ fontSize: 12.5, color: '#6B7280' }}>
            Generated {new Date(data.generatedAt).toLocaleString('en-IN')}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={() => load(key)} disabled={busy} style={{ padding: '9px 14px', background: '#1E3A5F', color: 'white', border: 'none', borderRadius: 8, fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}>
            {busy ? 'Refreshing…' : 'Refresh'}
          </button>
          <button onClick={lock} style={{ padding: '9px 14px', background: 'white', color: '#374151', border: '1px solid #E5E7EB', borderRadius: 8, fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}>
            Lock
          </button>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(185px, 1fr))', gap: 12, marginTop: 18 }}>
        <Metric label="Settled value" value={s.available ? money(s.settledValueINR) : '—'} sub={s.available ? `${s.settled} settlements` : 'rail unreachable'} color="#065F46" />
        <Metric label="Success rate" value={s.available ? pct(s.successRatePct) : '—'} sub={s.available ? `${s.failed} failed` : ''} color={s.successRatePct >= 90 ? '#065F46' : '#92400E'} />
        <Metric label="Average ticket" value={s.available ? money(s.averageTicketINR) : '—'} sub="per settled instruction" />
        <Metric label="Cash in wallets" value={s.available ? money(s.cashInWalletsINR) : '—'} sub={s.available ? (s.conserved ? '✓ conserved' : '✗ NOT conserved') : ''} color={s.available && !s.conserved ? '#991B1B' : '#6D28D9'} />
        <Metric label="Properties" value={p.properties} sub={`${Number(p.tokensOutstanding || 0).toLocaleString('en-IN')} tokens outstanding`} />
        <Metric label="Holders" value={p.holders} sub={p.topHolder ? `top holder ${pct(p.topHolderShare)}` : ''} />
        <Metric label="Ledger blocks" value={l.railChainBlocks || l.appChainBlocks} sub={l.sealed ? '⚠ chain sealed' : l.durable ? 'durable · append-only' : 'in-memory'} color={l.sealed ? '#991B1B' : '#111827'} />
        <Metric label="KYC records" value={p.kycRecords} sub={`${p.transfers} transfers`} />
      </div>

      <div style={{ ...card, marginTop: 16 }}>
        <h2 style={{ fontSize: 15, fontWeight: 700, color: '#111827', margin: 0 }}>Activity · last 14 days</h2>
        <div style={{ fontSize: 11.5, color: '#6B7280', marginTop: 3 }}>
          <span style={{ color: '#1E3A5F', fontWeight: 700 }}>■</span> ledger blocks &nbsp;
          <span style={{ color: '#6D28D9', fontWeight: 700 }}>■</span> settlements
        </div>
        <Bars series={data.activity || []} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 12, marginTop: 16 }}>
        <div style={card}>
          <h2 style={{ fontSize: 15, fontWeight: 700, color: '#111827', margin: 0 }}>Properties by allocation</h2>
          {(data.properties || []).length === 0 ? (
            <p style={{ fontSize: 12.5, color: '#6B7280', marginTop: 8 }}>No properties yet.</p>
          ) : (
            <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 9 }}>
              {data.properties.slice(0, 8).map(r => (
                <div key={r.assetId}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 12.5 }}>
                    <span style={{ color: '#111827', fontWeight: 600, overflowWrap: 'anywhere' }}>{r.title}</span>
                    <span style={{ color: '#6B7280', flexShrink: 0 }}>{pct(r.pctAllocated)}</span>
                  </div>
                  <div style={{ height: 6, background: '#F3F4F6', borderRadius: 999, marginTop: 4, overflow: 'hidden' }}>
                    <div style={{ width: `${Math.min(100, r.pctAllocated)}%`, height: '100%', background: '#1E3A5F' }} />
                  </div>
                  <div style={{ fontSize: 10.5, color: '#9CA3AF', marginTop: 3 }}>
                    {Number(r.tokensHeld).toLocaleString('en-IN')} / {Number(r.totalTokens).toLocaleString('en-IN')} tokens
                    {r.valuationINR ? ` · ${money(r.valuationINR)}` : ''}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div style={card}>
          <h2 style={{ fontSize: 15, fontWeight: 700, color: '#111827', margin: 0 }}>Why settlements fail</h2>
          {!s.available ? (
            <p style={{ fontSize: 12.5, color: '#6B7280', marginTop: 8 }}>Settlement rail unreachable.</p>
          ) : (s.failureReasons || []).length === 0 ? (
            <p style={{ fontSize: 12.5, color: '#6B7280', marginTop: 8 }}>No failed settlements.</p>
          ) : (
            <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 7 }}>
              {s.failureReasons.map(f => (
                <div key={f.reason} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: 12.5,
                  border: '1px solid #F3F4F6', borderRadius: 8, padding: '8px 11px' }}>
                  <span style={{ color: '#374151', overflowWrap: 'anywhere' }}>{f.reason}</span>
                  <b style={{ color: '#991B1B' }}>{f.count}</b>
                </div>
              ))}
            </div>
          )}
          {s.available && (
            <div style={{ fontSize: 11, color: '#9CA3AF', marginTop: 10, lineHeight: 1.6 }}>
              Mode {s.mode} · persistence {s.persistence} · lifetime funded {money(s.lifetimeFundedINR)}
            </div>
          )}
        </div>
      </div>

      <div style={{ fontSize: 11, color: '#9CA3AF', marginTop: 16, lineHeight: 1.7 }}>
        {(data.notes || []).map((n, i) => <div key={i}>{n}</div>)}
      </div>
    </div>
  )
}
