import React, { useState, useEffect, useCallback } from 'react'
import { Link } from 'react-router-dom'
import api from '../lib/api.js'

// A record of what you actually did. The wallet showed holdings, NAV, credit
// and swaps, but nothing anywhere answered "when did I buy this, from whom,
// and at what price?" — /api/transfers/history already paginated that data and
// no screen used it.

const C = {
  line: '#E5E7EB', head: '#111827', mut: '#6B7280', faint: '#9CA3AF',
  inBg: '#ECFDF5', inFg: '#065F46', outBg: '#FEF2F2', outFg: '#991B1B',
}

function fmtWhen(ts) {
  const d = new Date(ts)
  if (isNaN(d)) return '—'
  const mins = Math.round((Date.now() - d.getTime()) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs} hour${hrs === 1 ? '' : 's'} ago`
  const days = Math.round(hrs / 24)
  if (days <= 7) return `${days} day${days === 1 ? '' : 's'} ago`
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
}

function exactWhen(ts) {
  const d = new Date(ts)
  return isNaN(d) ? '' : d.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })
}

const Pill = ({ tone, children }) => (
  <span style={{
    fontSize: 10.5, fontWeight: 700, letterSpacing: 0.3, padding: '2px 7px', borderRadius: 999,
    background: tone === 'in' ? C.inBg : C.outBg, color: tone === 'in' ? C.inFg : C.outFg,
    whiteSpace: 'nowrap',
  }}>{children}</span>
)

export default function TransactionHistory({ identityId, titleFor = () => null, priceFor = () => 0, pageSize = 8 }) {
  const [rows, setRows] = useState([])
  const [bookmark, setBookmark] = useState('')
  const [hasMore, setHasMore] = useState(false)
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState(null)

  const load = useCallback(async (mark = '') => {
    if (!identityId) return
    mark ? setLoadingMore(true) : setLoading(true)
    setError(null)
    try {
      const r = await api.getTransferHistory('', identityId, pageSize, mark)
      const page = r.transfers || []
      // Append on "load more", replace on a fresh load, so paging cannot
      // duplicate rows if the component re-mounts mid-scroll.
      setRows(prev => (mark ? [...prev, ...page] : page))
      setBookmark(r.bookmark || '')
      setHasMore(Boolean(r.hasMore))
      setTotal(Number(r.total || page.length))
    } catch (e) {
      setError(e.message || 'Could not load your transaction history.')
    } finally {
      setLoading(false); setLoadingMore(false)
    }
  }, [identityId, pageSize])

  useEffect(() => { load('') }, [load])

  const card = {
    background: 'white', border: `1px solid ${C.line}`, borderRadius: 12,
    padding: 16, marginTop: 16,
  }

  return (
    <div style={card}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
        <h3 style={{ fontSize: 16, fontWeight: 700, color: C.head, margin: 0 }}>Transaction history</h3>
        {total > 0 && (
          <span style={{ fontSize: 12, color: C.mut }}>
            {rows.length} of {total.toLocaleString('en-IN')}
          </span>
        )}
      </div>
      <p style={{ fontSize: 12.5, color: C.mut, margin: '4px 0 0' }}>
        Every token movement in or out of your wallet, newest first. Each row is a committed
        ledger transaction.
      </p>

      {loading ? (
        <p style={{ fontSize: 13, color: C.mut, marginTop: 14 }}>Loading…</p>
      ) : error ? (
        <div style={{ marginTop: 12, fontSize: 13, color: C.outFg, background: C.outBg,
          border: '1px solid #FECACA', borderRadius: 8, padding: '10px 12px' }}>
          {error}{' '}
          <button onClick={() => load('')} style={{
            background: 'none', border: 'none', color: C.outFg, textDecoration: 'underline',
            cursor: 'pointer', padding: 0, fontSize: 13,
          }}>Retry</button>
        </div>
      ) : rows.length === 0 ? (
        <div style={{ marginTop: 14, fontSize: 13, color: C.mut }}>
          No transactions yet. Once you buy tokens they appear here with the counterparty,
          the price and the ledger reference.{' '}
          <Link to="/marketplace" style={{ color: '#1E3A5F', fontWeight: 600 }}>Browse properties →</Link>
        </div>
      ) : (
        <>
          <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {rows.map(t => {
              const incoming = t.toId === identityId
              const counterparty = incoming ? t.fromId : t.toId
              const tokens = Number(t.amount || 0)
              const price = Number(priceFor(t.assetId) || 0)
              const value = price > 0 ? tokens * price : 0
              const title = titleFor(t.assetId) || t.assetId

              return (
                <div key={t.transferId} style={{
                  border: `1px solid ${C.line}`, borderRadius: 10, padding: '10px 12px',
                  display: 'flex', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap',
                }}>
                  <div style={{ minWidth: 0, flex: '1 1 220px' }}>
                    <div style={{ display: 'flex', gap: 7, alignItems: 'center', flexWrap: 'wrap' }}>
                      <Pill tone={incoming ? 'in' : 'out'}>{incoming ? 'BOUGHT' : 'SOLD'}</Pill>
                      <Link
                        to={`/property/${encodeURIComponent(t.assetId)}`}
                        style={{ fontSize: 13.5, fontWeight: 600, color: C.head, overflowWrap: 'anywhere' }}
                      >{title}</Link>
                    </div>
                    <div style={{ fontSize: 12, color: C.mut, marginTop: 4 }}>
                      {incoming ? 'from' : 'to'} <strong style={{ color: '#374151' }}>{counterparty}</strong>
                      {' · '}<span title={exactWhen(t.txTimestamp)}>{fmtWhen(t.txTimestamp)}</span>
                      {t.status && t.status !== 'COMPLETED' ? ` · ${t.status}` : ''}
                    </div>
                    <div style={{ fontSize: 10.5, color: C.faint, marginTop: 3, overflowWrap: 'anywhere' }}>
                      ledger ref {t.transferId}
                    </div>
                  </div>
                  <div style={{ textAlign: 'right', marginLeft: 'auto', minWidth: 110 }}>
                    <div style={{ fontSize: 14, fontWeight: 700, color: incoming ? C.inFg : C.outFg }}>
                      {incoming ? '+' : '−'}{tokens.toLocaleString('en-IN')} tokens
                    </div>
                    {value > 0 && (
                      <div style={{ fontSize: 12, color: C.mut, marginTop: 2 }}>
                        ₹{value.toLocaleString('en-IN')} at ₹{price.toLocaleString('en-IN')}/token
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>

          {hasMore && (
            <button
              onClick={() => load(bookmark)}
              disabled={loadingMore}
              style={{
                marginTop: 12, width: '100%', padding: '9px 14px', borderRadius: 9,
                border: `1px solid ${C.line}`, background: loadingMore ? '#F9FAFB' : 'white',
                color: '#1E3A5F', fontWeight: 600, fontSize: 13,
                cursor: loadingMore ? 'default' : 'pointer',
              }}
            >{loadingMore ? 'Loading…' : `Load ${Math.min(pageSize, total - rows.length)} more`}</button>
          )}
        </>
      )}
    </div>
  )
}
