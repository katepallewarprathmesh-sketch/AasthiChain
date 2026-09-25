import React, { useState, useEffect } from 'react'
import { useParams, Link } from 'react-router-dom'
import { useProperty } from '../hooks/useProperties.js'
import SimpleBuyFlow from '../components/SimpleBuyFlow.jsx'
import api from '../lib/api.js'
import { money } from '../lib/format.js'

export default function PropertyDetail({ user }) {
  const { id } = useParams()
  const { property, loading, error, refresh } = useProperty(id)
  const [balances, setBalances] = useState([])
  const [refreshKey, setRefreshKey] = useState(0)
  const [sub, setSub] = useState(null)
  const [showXfer, setShowXfer] = useState(false)
  const [xferTo, setXferTo] = useState('')
  const [xferAmt, setXferAmt] = useState('')
  const [xferMsg, setXferMsg] = useState(null)
  const [xferErr, setXferErr] = useState(null)
  const [showBuy, setShowBuy] = useState(false)

  useEffect(() => {
    if (!property) return
    const fetchBalances = async () => {
      // Preferred: server-computed holder list (includes the real listing owner,
      // whatever role they have — registrar-owned listings show correctly)
      try {
        const detail = await api.getProperty(property.assetId)
        setSub(detail?.subscription || null)
        const hs = detail?.holders
        if (Array.isArray(hs) && hs.length > 0) {
          setBalances(hs)
          return
        }
      } catch {}
      // Fallback for older servers: known demo identities
      const owners = ['originator1', 'investor1', 'investor2']
      const results = []
      for (const owner of owners) {
        try {
          const b = await api.getBalance(property.assetId, owner)
          if (b.balance > 0) results.push(b)
        } catch {}
      }
      setBalances(results)
    }
    fetchBalances()
  }, [property?.assetId, refreshKey])

  if (loading && !property) {
    return (
      <div style={{ padding: 40, textAlign: 'center' }}>
        <div style={{
          width: 32, height: 32,
          border: '3px solid #E5E7EB',
          borderTopColor: '#1E3A5F',
          borderRadius: '50%',
          animation: 'spin 0.8s linear infinite',
          margin: '0 auto'
        }}></div>
        <p style={{ color: '#6B7280', fontSize: 14, marginTop: 12 }}>Loading property details...</p>
      </div>
    )
  }

  if (error && !property) {
    return (
      <div style={{ padding: 20, maxWidth: 600, margin: '0 auto' }}>
        <Link to="/marketplace" style={{ fontSize: 13, color: '#1E3A5F', textDecoration: 'none' }}>← Back to Properties</Link>
        <div style={{ background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 12, padding: 20, marginTop: 16, textAlign: 'center' }}>
          <p style={{ fontSize: 14, color: '#991B1B' }}>{error}</p>
          <button onClick={refresh} style={{
            marginTop: 12,
            padding: '8px 16px',
            background: '#1E3A5F',
            color: 'white',
            border: 'none',
            borderRadius: 8,
            cursor: 'pointer'
          }}>
            Try Again
          </button>
        </div>
      </div>
    )
  }

  if (!property) return null

  const tokenPrice = property.totalTokens ? Math.floor(property.valuationINR / property.totalTokens) : 500
  const availableTokens = property.availableTokens ?? 0
  const ownerHeld = balances.find(b => b.ownerId === property.originatorId)?.balance || 0
  const soldShown = sub?.soldTokens ?? Math.max(0, (property.totalTokens || 0) - (property.availableTokens ?? ownerHeld))
  const soldPct = property.totalTokens ? Math.min(100, Math.round((soldShown / property.totalTokens) * 100)) : 0
  const myHeld = user ? (balances.find(b => b.ownerId === user.identityId)?.balance || 0) : 0
  const identityOptions = [['originator1', 'Property Owner'], ['registrar1', 'Registrar'], ['investor1', 'Investor 1'], ['investor2', 'Investor 2']].filter(([id]) => id !== user?.identityId)

  const doXfer = async () => {
    setXferMsg(null); setXferErr(null)
    try {
      const r = await api.transferTokens(property.assetId, user.identityId, xferTo, parseInt(xferAmt))
      setXferMsg(`Transferred ${r.amount} tokens to ${r.toId} — ledger TXN ${r.transferId}`)
      setXferAmt('')
      setRefreshKey(k => k + 1)
      refresh()
    } catch (e) {
      setXferErr(e.data?.message || e.message || 'Transfer failed')
    }
  }

  return (
    <div style={{ maxWidth: 1000, margin: '0 auto', padding: '0 16px' }}>
      <Link to="/marketplace" style={{ fontSize: 13, color: '#1E3A5F', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 6, fontWeight: 500 }}>
        ← Back to Properties
      </Link>

      <div style={{ marginTop: 20, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
        <div>
          <h1 style={{ fontSize: 28, fontWeight: 800, color: '#111827' }}>{property.title}</h1>
          <p style={{ color: '#6B7280', fontSize: 13, marginTop: 6 }}>
            📍 {property.location?.city || 'Pune'}, {property.location?.state || 'Maharashtra'} • Owner & seller: <strong>{property.originatorId || 'Owner'}</strong>
          </p>
        </div>
        <span style={{
          fontSize: 12,
          fontWeight: 600,
          padding: '6px 12px',
          borderRadius: 20,
          background: property.status === 'TOKENIZED' ? '#F0FDF4' : '#FFFBEB',
          color: property.status === 'TOKENIZED' ? '#059669' : '#D97706',
          border: `1px solid ${property.status === 'TOKENIZED' ? '#BBF7D0' : '#FDE68A'}`
        }}>
          {property.status === 'TOKENIZED' ? 'Available' : property.registrarValidationStatus || property.status}
        </span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, marginTop: 24 }}>
        <div style={{ background: 'white', border: '1px solid #E5E7EB', borderRadius: 12, padding: 20 }}>
          <h3 style={{ fontSize: 16, fontWeight: 700, color: '#111827' }}>Property Value</h3>
          <div style={{ fontSize: 32, fontWeight: 800, marginTop: 12, color: '#111827' }}>₹{valuationLakh}L</div>
          <div style={{ fontSize: 12, color: '#9CA3AF', marginTop: 4 }}>{money(property.valuationINR)} total value</div>

          <div style={{ height: 1, background: '#F3F4F6', margin: '20px 0' }}></div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
            <div>
              <div style={{ fontSize: 11, color: '#9CA3AF', textTransform: 'uppercase', fontWeight: 600 }}>Total Tokens</div>
              <div style={{ fontSize: 18, fontWeight: 700, marginTop: 4 }}>{(property.totalTokens || 0).toLocaleString('en-IN')}</div>
            </div>
            <div>
              <div style={{ fontSize: 11, color: '#9CA3AF', textTransform: 'uppercase', fontWeight: 600 }}>Price Per Token</div>
              <div style={{ fontSize: 18, fontWeight: 700, marginTop: 4, color: '#1E3A5F' }}>₹{tokenPrice.toLocaleString('en-IN')}</div>
            </div>
          </div>

          <div style={{ marginTop: 20 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 6 }}>
              <span style={{ color: '#6B7280' }}>{soldPct}% funded{sub?.fullySubscribed ? ' — primary sale closed' : ''}</span>
              <span style={{ color: '#6B7280' }}>{Number(soldShown || 0).toLocaleString('en-IN')} / {(property.totalTokens || 0).toLocaleString('en-IN')} tokens</span>
            </div>
            <div style={{ height: 8, background: '#F3F4F6', borderRadius: 4, overflow: 'hidden' }}>
              <div style={{ width: `${soldPct}%`, height: '100%', background: sub?.fullySubscribed ? '#16A34A' : '#1E3A5F', borderRadius: 4, transition: 'width 0.4s' }}></div>
            </div>
            {sub?.fullySubscribed && (
              <div style={{ fontSize: 11, color: '#16A34A', fontWeight: 600, marginTop: 6 }}>
                ✓ 100% Subscribed{sub.investorCount ? ` — ${sub.investorCount} investor${sub.investorCount === 1 ? '' : 's'} own this property` : ''}{sub.completedAt ? ` · completed ${new Date(sub.completedAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}` : ''}
              </div>
            )}
          </div>

          {sub?.fullySubscribed ? (
            <div style={{ marginTop: 20 }}>
              <div style={{ padding: '12px 14px', background: '#F0FDF4', border: '1px solid #BBF7D0', borderRadius: 10 }}>
                <div style={{ fontSize: 13.5, fontWeight: 700, color: '#166534' }}>🏠 Fully Subscribed — primary sale closed</div>
                <div style={{ fontSize: 12, color: '#3F6212', marginTop: 4, lineHeight: 1.6 }}>
                  Every token is owned. No new supply — this raise is permanently closed to new buys. Ownership lives on the Aasthi Drunix ledger.
                </div>
              </div>
              <div style={{ marginTop: 10, padding: '12px 14px', border: '1px solid #E5E7EB', borderRadius: 10, background: '#F9FAFB' }}>
                <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '0.1em', color: '#6B7280' }}>WHAT HAPPENS NEXT</div>
                <ul style={{ margin: '8px 0 0', paddingLeft: 16, fontSize: 12, color: '#374151', lineHeight: 1.8 }}>
                  <li><b>Live:</b> wallet-to-wallet secondary transfers on the same atomic ledger</li>
                  <li><b>Live:</b> every buy/sell TXN lands in the Regulator's audit trail</li>
                  <li><b>Planned:</b> pro-rata rental yield distribution to token holders</li>
                  <li><b>Planned:</b> registrar re-title with the full investor cap table</li>
                </ul>
              </div>
            </div>
          ) : !showBuy ? (
            <button
              onClick={() => setShowBuy(true)}
              style={{
                width: '100%',
                marginTop: 20,
                padding: '14px',
                background: '#1E3A5F',
                color: 'white',
                border: 'none',
                borderRadius: 8,
                fontSize: 14,
                fontWeight: 600,
                cursor: 'pointer'
              }}
            >
              Buy Tokens →
            </button>
          ) : (
            <button
              onClick={() => setShowBuy(false)}
              style={{
                width: '100%',
                marginTop: 20,
                padding: '10px',
                background: 'white',
                color: '#6B7280',
                border: '1px solid #E5E7EB',
                borderRadius: 8,
                fontSize: 13,
                cursor: 'pointer'
              }}
            >
              Hide Buy Options
            </button>
          )}

          <div style={{ fontSize: 11, color: '#9CA3AF', textAlign: 'center', marginTop: 10 }}>
            🔒 Secure payment • Instant transfer • No paperwork
          </div>

          {user && myHeld > 0 && identityOptions.length > 0 && (
            <div style={{ marginTop: 14, borderTop: '1px solid #F3F4F6', paddingTop: 12 }}>
              {!showXfer ? (
                <button onClick={() => { setShowXfer(true); setXferTo(identityOptions[0]?.[0] || ''); setXferMsg(null); setXferErr(null) }} style={{ width: '100%', padding: 10, background: 'white', border: '1px solid #E5E7EB', borderRadius: 8, fontSize: 12.5, fontWeight: 600, color: '#374151', cursor: 'pointer' }}>
                  ↔ Transfer your {Number(myHeld).toLocaleString('en-IN')} tokens (secondary)
                </button>
              ) : (
                <div>
                  <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '0.1em', color: '#6B7280', marginBottom: 8 }}>SECONDARY TRANSFER — SETTLES ATOMICALLY ON THE LEDGER</div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <select value={xferTo} onChange={e => setXferTo(e.target.value)} style={{ flex: 1, fontSize: 12.5, padding: '9px 10px', border: '1px solid #E5E7EB', borderRadius: 8 }}>
                      {identityOptions.map(([id, label]) => <option key={id} value={id}>{label} ({id})</option>)}
                    </select>
                    <input type="number" min="1" max={myHeld} value={xferAmt} onChange={e => setXferAmt(e.target.value)} placeholder="Tokens" style={{ width: 90, fontSize: 12.5, padding: '9px 10px', border: '1px solid #E5E7EB', borderRadius: 8 }} />
                  </div>
                  <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                    <button onClick={doXfer} disabled={!xferTo || !(parseInt(xferAmt) > 0)} style={{ flex: 1, padding: 10, background: '#1E3A5F', color: 'white', border: 'none', borderRadius: 8, fontSize: 12.5, fontWeight: 600, cursor: 'pointer', opacity: !xferTo || !(parseInt(xferAmt) > 0) ? 0.5 : 1 }}>Transfer</button>
                    <button onClick={() => setShowXfer(false)} style={{ padding: 10, background: 'white', color: '#6B7280', border: '1px solid #E5E7EB', borderRadius: 8, fontSize: 12.5, cursor: 'pointer' }}>Cancel</button>
                  </div>
                  {xferMsg && <div style={{ fontSize: 11.5, color: '#16A34A', marginTop: 8, lineHeight: 1.5 }}>✓ {xferMsg}</div>}
                  {xferErr && <div style={{ fontSize: 11.5, color: '#DC2626', marginTop: 8, lineHeight: 1.5 }}>✗ {xferErr}</div>}
                </div>
              )}
            </div>
          )}
        </div>

        <div style={{ background: 'white', border: '1px solid #E5E7EB', borderRadius: 12, padding: 20 }}>
          <h3 style={{ fontSize: 16, fontWeight: 700, color: '#111827' }}>Who Owns This?</h3>
          <p style={{ fontSize: 12, color: '#9CA3AF', marginTop: 4 }}>Current token holders</p>

          {balances.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '30px 0', color: '#6B7280' }}>
              <div style={{ fontSize: 24 }}>👥</div>
              <p style={{ fontSize: 13, marginTop: 8 }}>No investors yet</p>
              <p style={{ fontSize: 12, color: '#9CA3AF', marginTop: 4 }}>Be the first to invest</p>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 16 }}>
              {balances.map(b => {
                const pct = property.totalTokens ? ((b.balance / property.totalTokens) * 100).toFixed(1) : 0
                return (
                  <div key={b.ownerId} style={{
                    background: '#F9FAFB',
                    border: '1px solid #F3F4F6',
                    borderRadius: 8,
                    padding: 12,
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center'
                  }}>
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 600, color: '#111827' }}>{b.ownerId}</div>
                      <div style={{ fontSize: 11, color: '#6B7280' }}>{(b.balance || 0).toLocaleString('en-IN')} tokens</div>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <div style={{ fontSize: 14, fontWeight: 700, color: '#111827' }}>{pct}%</div>
                      <div style={{ fontSize: 11, color: '#6B7280' }}>{money((b.balance || 0) * tokenPrice)}</div>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>

      {showBuy && (
        <div style={{ marginTop: 20 }}>
          <SimpleBuyFlow
            assetId={property.assetId}
            tokenPrice={tokenPrice}
            recipient={property.originatorId}
            user={user}
            propertyTitle={property.title}
            valuationINR={property.valuationINR}
            totalTokens={property.totalTokens}
            availableTokens={availableTokens}
            onSuccess={() => {
              // Soft refresh: holders + availability update without a full reload
              setRefreshKey(k => k + 1)
              refresh()
            }}
          />
        </div>
      )}
    </div>
  )
}
